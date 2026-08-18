/* ForexHub data + AI proxy — Cloudflare Worker
   v9.0 19.8.26: cost + abuse hardening, calendar failover.
     • /api is no longer an open Anthropic relay: it requires the app key AND an
       allow-listed Origin, and it stops dead at a hard daily budget.
     • AI replies are cached in KV, so the same prompt is billed once per period
       across every device and browser instead of once per localStorage.
     • The calendar keeps its last-known-good copy in KV (global, unlike the edge
       Cache API which is per-colo) and backs off when Forex Factory rate-limits.
   Bindings required: ANTHROPIC_API_KEY (secret), FH_APP_KEY (secret), FH_KV (KV).  */

const WORKER_VERSION = "9.0";
const YF_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const NY_HOUR_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
const nyHour = function (t) { return Number(NY_HOUR_FMT.format(new Date(t * 1000))); };
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

/* Only these origins may use the app. Anything else gets no CORS grant, so a
   third-party page cannot spend the Anthropic key from a visitor's browser. */
const ALLOWED_ORIGINS = [
  "https://jlivo-ovilj.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
];

/* Hard ceilings. Nothing here can be raised by the client — the point is that a
   leaked app key costs a known, small amount rather than an open-ended bill. */
const BUDGET = {
  calls: 150,        // Anthropic requests per Brisbane day (cache hits are free)
  searches: 25,      // web-search-enabled requests per day (these are the pricey ones)
  inTokens: 600000,  // cumulative input tokens per day
  outTokens: 120000, // cumulative output tokens per day
  ipCallsPerHour: 45,
  maxPromptChars: 24000,
  maxImageBytes: 1400000 // ~1.4MB of base64 ≈ a full-page screenshot; bigger is refused
};

/* How long a cached AI reply stays valid, by cache-key prefix. Mirrors how often
   each panel is actually worth refreshing, so repeat views are free. */
const AI_TTL = [
  ["scan:", 1800],        // trade scanner — 30 min
  ["pullback:", 3600],
  ["d:", 43200],          // daily analysis — half a day
  ["4h:", 14400],
  ["w:", 259200],         // weekly outlook — 3 days
  ["sent:", 86400],
  ["cal-ai:", 21600],
  ["brief-news2:", 21600]
];
const ttlFor = function (key) {
  for (let i = 0; i < AI_TTL.length; i++) if (key.indexOf(AI_TTL[i][0]) === 0) return AI_TTL[i][1];
  return 10800;
};

const brisbaneDay = function () {
  return new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10);
};
const brisbaneHour = function () {
  return new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 13);
};
async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("").slice(0, 40);
}

async function yChart(sym, range, interval, ttl) {
  const q = "/v8/finance/chart/" + sym + "?interval=" + interval + "&range=" + range;
  const opts = { headers: { "User-Agent": UA, "Accept": "application/json" }, cf: { cacheTtl: ttl, cacheEverything: true } };
  for (let attempt = 0; attempt < 2; attempt++) {
    for (let h = 0; h < YF_HOSTS.length; h++) {
      try {
        const r = await fetch(YF_HOSTS[h] + q, opts);
        if (r.ok) {
          const j = await r.json();
          if (j && j.chart && j.chart.result && j.chart.result[0]) return j;
        }
      } catch (e) { /* try the next host */ }
    }
    if (attempt === 0) await sleep(220);
  }
  return null;
}

const pipOf = function (p) { return p.indexOf("JPY") > -1 ? 0.01 : (p.indexOf("XAU") > -1 ? 0.1 : 0.0001); };
const r1 = function (x) { return x == null ? null : Number(x.toFixed(1)); };
const pctOf = function (now, ref) { return (ref == null || !ref) ? null : Number(((now - ref) / ref * 100).toFixed(2)); };

function series(d) {
  const res0 = d && d.chart && d.chart.result && d.chart.result[0];
  if (!res0) return { meta: {}, bars: [] };
  const q = (res0.indicators && res0.indicators.quote && res0.indicators.quote[0]) || {};
  const closes = q.close || [], ts = res0.timestamp || [], bars = [];
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] != null) bars.push({
      t: ts[i] || 0,
      h: q.high && q.high[i] != null ? q.high[i] : closes[i],
      l: q.low && q.low[i] != null ? q.low[i] : closes[i],
      o: q.open && q.open[i] != null ? q.open[i] : closes[i],
      c: closes[i]
    });
  }
  return { meta: res0.meta || {}, bars: bars };
}

/* ── Calendar failover source ──────────────────────────────────────────────────
   Forex Factory rate-limits Cloudflare's shared egress addresses almost permanently
   (its own limit is ~2 weekly-file pulls per 5 min per IP), so the worker frequently
   cannot reach it even when the feed is perfectly healthy from a home connection.
   TradingView's public economic-calendar endpoint has no such restriction, so it is
   mapped into the same row shape the app already renders. Same events, same times —
   only the impact wording differs, which the mapper normalises. */
const TV_CCY = { US: "USD", EU: "EUR", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", GB: "GBP", JP: "JPY", AU: "AUD", NZ: "NZD", CA: "CAD", CH: "CHF", CN: "CNY" };
const TV_COUNTRIES = "US,EU,GB,JP,AU,NZ,CA,CH,CN,DE,FR,IT,ES";

/* Forex Factory weeks run Sunday→Saturday. Return the UTC bounds for a week label. */
function weekBounds(which) {
  const now = new Date();
  const sunday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - now.getUTCDay()));
  const shift = which === "nextweek" ? 7 : (which === "lastweek" ? -7 : 0);
  let from = new Date(sunday.getTime() + shift * 86400000);
  let days = 7;
  if (which === "today") { from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); days = 1; }
  else if (which === "tomorrow") { from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)); days = 1; }
  else if (which === "thismonth") { from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); days = 32; }
  else if (which === "nextmonth") { from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)); days = 32; }
  return { from: from.toISOString(), to: new Date(from.getTime() + days * 86400000).toISOString() };
}

async function tvCalendar(which) {
  const b = weekBounds(which);
  const src = "https://economic-calendar.tradingview.com/events?from=" + b.from + "&to=" + b.to + "&countries=" + TV_COUNTRIES;
  const r = await fetch(src, {
    headers: { "User-Agent": UA, "Accept": "application/json", "Origin": "https://www.tradingview.com", "Referer": "https://www.tradingview.com/" },
    cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 900, "400-599": 0 } }
  });
  if (!r.ok) throw new Error("fallback HTTP " + r.status);
  const d = await r.json();
  const rows = (d && Array.isArray(d.result)) ? d.result : [];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i];
    const ccy = TV_CCY[String(e.country || "").toUpperCase()];
    if (!ccy || !e.title || !e.date) continue;
    const imp = e.importance >= 1 ? "High" : (e.importance === 0 ? "Medium" : "Low");
    const num = function (v) { return (v === null || v === undefined || v === "") ? "" : String(v); };
    out.push({
      title: String(e.title) + (e.period ? " (" + e.period + ")" : ""),
      country: ccy,
      date: e.date,
      impact: imp,
      forecast: num(e.forecast),
      previous: num(e.previous),
      actual: num(e.actual)
    });
  }
  out.sort(function (a, b2) { return new Date(a.date) - new Date(b2.date); });
  return out;
}

/* Pull the first complete JSON object/array out of a model reply, tolerating
```json fences and any narration before or after it. Returns null if nothing
   parses — callers treat null as "fall back", never as empty data. */
function extractJson(raw) {
  if (!raw) return null;
  let s = String(raw);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch (e) { s = fence[1]; } }
  try { return JSON.parse(s.trim()); } catch (e) { /* scan for an embedded value */ }
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "{" && ch !== "[") continue;
    const close = ch === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let k = i; k < s.length; k++) {
      const c = s[k];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === ch) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(i, k + 1)); } catch (e) { break; }
        }
      }
    }
  }
  return null;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const originOk = ALLOWED_ORIGINS.indexOf(origin) > -1;
    /* Data endpoints stay open (they cost nothing but Yahoo bandwidth). The paid
       endpoint reflects only allow-listed origins, so other sites can't read it. */
    const cors = {
      "Access-Control-Allow-Origin": originOk ? origin : "*",
      "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-FH-App",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(req.url);
    const J = function (obj, status) {
      return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, cors)
      });
    };
    const KV = env.FH_KV || null;

    /* ── Version: GET /version — lets the app show which proxy build it is talking to ── */
    if (url.pathname === "/version") {
      return J({ version: WORKER_VERSION, ts: new Date().toISOString() });
    }

    /* ── Health check ── */
    if (url.pathname === "/health") {
      const t0 = Date.now();
      const y = await yChart("EURUSD=X", "1d", "5m", 30);
      let cal = false, calNote = "";
      try {
        const r = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { headers: { "User-Agent": UA }, cf: { cacheTtl: 900, cacheEverything: true } });
        cal = r.ok; if (!r.ok) calNote = "HTTP " + r.status;
      } catch (e) { calNote = "unreachable"; }
      let budget = null;
      if (KV) { try { budget = JSON.parse((await KV.get("budget:" + brisbaneDay())) || "null"); } catch (e) { } }
      return J({
        version: WORKER_VERSION,
        yahoo: !!y, calendar: cal, calendarNote: calNote, kv: !!KV,
        appKeySet: !!env.FH_APP_KEY, budgetToday: budget, limits: BUDGET,
        ms: Date.now() - t0, ts: new Date().toISOString()
      });
    }

    /* ── Economic calendar: GET /calendar?w=thisweek|nextweek|thismonth ──
       D2/D11: Forex Factory allows only ~2 weekly-file downloads per 5 minutes per
       IP, and Workers egress from shared addresses, so on-demand fetching sat on a
       permanent 429 and the calendar was blank. The feed is now pulled at most once
       per REFRESH_S, kept in KV (global — the edge Cache API is per-colo, so a
       copy warmed in Sydney did nothing for a request served from Brisbane), and a
       429 starts a cooldown instead of triggering more doomed retries. */
    if (url.pathname === "/calendar" && req.method === "GET") {
      const w = (url.searchParams.get("w") || "thisweek").replace(/[^a-z]/g, "");
      const allowed = ["thisweek", "nextweek", "lastweek", "thismonth", "nextmonth", "today", "tomorrow"];
      const which = allowed.indexOf(w) > -1 ? w : "thisweek";
      const src = "https://nfs.faireconomy.media/ff_calendar_" + which + ".json";
      const REFRESH_S = 1800;      // don't ask upstream more than twice an hour
      const COOLDOWN_S = 600;      // after a 429, don't ask again for 10 minutes
      const kvKey = "cal:" + which;
      const coolKey = "calcool:" + which;

      let stored = null;
      if (KV) { try { stored = JSON.parse((await KV.get(kvKey)) || "null"); } catch (e) { } }
      const ageS = stored && stored.ts ? (Date.now() - new Date(stored.ts).getTime()) / 1000 : Infinity;
      const fresh = stored && stored.events && stored.events.length && ageS < REFRESH_S;
      if (fresh) {
        return J({ events: stored.events, week: which, count: stored.events.length, ts: stored.ts, stale: false, src: "cache" });
      }

      let cooling = false;
      if (KV) { try { cooling = !!(await KV.get(coolKey)); } catch (e) { } }
      /* Failover ladder: Forex Factory → TradingView → last-known-good KV copy. */
      const serveStored = async function (why) {
        try {
          const alt = await tvCalendar(which);
          if (alt.length) {
            const ts2 = new Date().toISOString();
            if (KV) {
              try { await KV.put(kvKey, JSON.stringify({ events: alt, ts: ts2, src: "tradingview" }), { expirationTtl: 14 * 86400 }); } catch (e) { }
            }
            return J({ events: alt, week: which, count: alt.length, ts: ts2, stale: false, src: "tradingview", note: why });
          }
        } catch (e) { /* fall through to the stored copy */ }
        if (stored && stored.events && stored.events.length) {
          return J({ events: stored.events, week: which, count: stored.events.length, ts: stored.ts, stale: true, error: why, src: "stale" });
        }
        return J({ events: [], week: which, count: 0, error: why, src: "none" }, 200);
      };
      if (cooling) return await serveStored("primary provider rate-limited");

      try {
        const r = await fetch(src, {
          headers: { "User-Agent": UA, "Accept": "application/json" },
          cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": REFRESH_S, "300-399": 0, "400-499": 0, "500-599": 0 } }
        });
        if (!r.ok) {
          if (KV && (r.status === 429 || r.status >= 500)) {
            try { await KV.put(coolKey, "1", { expirationTtl: COOLDOWN_S }); } catch (e) { }
          }
          return await serveStored("primary provider HTTP " + r.status);
        }
        const d = await r.json();
        const events = Array.isArray(d) ? d : [];
        if (!events.length) return await serveStored("primary provider returned no events");
        const ts = new Date().toISOString();
        if (KV) {
          try { await KV.put(kvKey, JSON.stringify({ events: events, ts: ts, src: "forexfactory" }), { expirationTtl: 14 * 86400 }); } catch (e) { }
        }
        return J({ events: events, week: which, count: events.length, ts: ts, stale: false, src: "forexfactory" });
      } catch (e) {
        return await serveStored(e.message || "primary provider unreachable");
      }
    }

    /* ── Historical rates for the correlation matrix: GET /fx?start=&end= ── */
    if (url.pathname === "/fx" && req.method === "GET") {
      const clean = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || "") ? s : null; };
      const start = clean(url.searchParams.get("start")), end = clean(url.searchParams.get("end"));
      if (!start || !end) return J({ error: "start and end must be YYYY-MM-DD" }, 400);
      const base = (url.searchParams.get("from") || "EUR").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 3) || "EUR";
      try {
        const r = await fetch("https://api.frankfurter.dev/v1/" + start + ".." + end + "?from=" + base,
          { headers: { "Accept": "application/json" }, cf: { cacheTtl: 3600, cacheEverything: true } });
        if (!r.ok) return J({ error: "rates provider returned HTTP " + r.status, rates: null }, 200);
        const d = await r.json();
        if (!d || !d.rates) return J({ error: "rates provider returned no data", rates: null }, 200);
        return J({ rates: d.rates, base: d.base || base, ts: new Date().toISOString() });
      } catch (e) {
        return J({ error: "could not reach the rates provider", rates: null }, 200);
      }
    }

    /* ── Live FX quotes: GET /price?pairs=EURUSD,USDJPY ── */
    if (url.pathname === "/price" && req.method === "GET") {
      try {
        const pairsParam = url.searchParams.get("pairs") || url.searchParams.get("pair") || "";
        const pairs = pairsParam.split(",").map(function (p) { return p.trim().toUpperCase(); }).filter(Boolean).slice(0, 15);
        const out = {}, failed = [];
        const today = new Date().toISOString().slice(0, 10);
        const dayStr = function (t) { return new Date(t * 1000).toISOString().slice(0, 10); };
        await Promise.all(pairs.map(async function (p) {
          try {
            const sym = p.replace("/", "") + "=X";
            const both = await Promise.all([
              yChart(sym, "2d", "5m", 60),
              yChart(sym, "3mo", "1d", 1800)
            ]);
            const intra = series(both[0]), daily = series(both[1]);
            const ib = intra.bars, db = daily.bars, meta = intra.meta || {};
            const price = meta.regularMarketPrice != null ? meta.regularMarketPrice
              : (ib.length ? ib[ib.length - 1].c : (db.length ? db[db.length - 1].c : null));
            if (price == null) { failed.push(p); return; }
            const pip = pipOf(p);
            let roIdx = -1;
            for (let z = ib.length - 1; z > 0; z--) {
              if (nyHour(ib[z].t) === 17 && nyHour(ib[z - 1].t) !== 17) { roIdx = z; break; }
            }
            // D6: record WHICH reference we actually used, so the UI can label the
            // figure honestly instead of hardcoding "since the 7am AEST rollover".
            let refSrc;
            let ref;
            if (roIdx > 0) { ref = ib[roIdx - 1].c; refSrc = "rollover"; }
            else if (meta.chartPreviousClose != null) { ref = meta.chartPreviousClose; refSrc = "prevClose"; }
            else if (ib.length) { ref = ib[0].c; refSrc = "windowStart"; }
            else { ref = price; refSrc = "none"; }
            let span, spanSrc;
            if (roIdx > 0) { span = ib.slice(roIdx); spanSrc = "session"; }
            else {
              spanSrc = "trailing24h";
              const lastT = ib.length ? ib[ib.length - 1].t : 0;
              span = ib.filter(function (b) { return lastT - b.t <= 86400; });
              if (!span.length) { span = ib; spanSrc = "wholeWindow"; }
            }
            let hi = price, lo = price;
            for (let y = 0; y < span.length; y++) { if (span[y].h > hi) hi = span[y].h; if (span[y].l < lo) lo = span[y].l; }
            const chg = pctOf(price, ref);
            const t4h = ib.length > 48 ? pctOf(price, ib[ib.length - 1 - 48].c) : null;
            let j = -1;
            for (let k = db.length - 1; k >= 0; k--) { if (dayStr(db[k].t) < today) { j = k; break; } }
            if (j < 0) j = db.length - 1;
            const wRef = j - 4 >= 0 ? db[j - 4].c : null;
            const mRef = j - 20 >= 0 ? db[j - 20].c : null;
            out[p] = {
              p: price, hi: hi, lo: lo, chg: chg, t4h: t4h, td: chg,
              tw: pctOf(price, wRef), tm: pctOf(price, mRef),
              dp: r1((price - ref) / pip),
              wp: wRef != null ? r1((price - wRef) / pip) : null,
              mp: mRef != null ? r1((price - mRef) / pip) : null,
              refSrc: refSrc,   // rollover | prevClose | windowStart | none
              spanSrc: spanSrc  // session | trailing24h | wholeWindow
            };
          } catch (e) { failed.push(p); }
        }));
        return J({ quotes: out, missing: failed, src: "yahoo", ts: new Date().toISOString() });
      } catch (e) {
        return J({ error: e.message, quotes: {}, missing: [] }, 500);
      }
    }

    /* ── Morning-briefing daily stats: GET /briefing?pairs=... ── */
    if (url.pathname === "/briefing" && req.method === "GET") {
      try {
        const bp = (url.searchParams.get("pairs") || "").split(",").map(function (p) { return p.trim().toUpperCase(); }).filter(Boolean).slice(0, 15);
        const stats = {}, failed = [];
        const today = new Date().toISOString().slice(0, 10);
        const dayStr = function (t) { return new Date(t * 1000).toISOString().slice(0, 10); };
        await Promise.all(bp.map(async function (p) {
          try {
            const sym = p.replace("/", "") + "=X";
            const two = await Promise.all([
              yChart(sym, "3mo", "1d", 1800),
              yChart(sym, "5d", "60m", 300)
            ]);
            const dd = series(two[0]), hh = series(two[1]);
            const bars = dd.bars, meta = dd.meta || {};
            if (bars.length < 3) { failed.push(p); return; }
            const pip = pipOf(p);
            let j = -1;
            for (let k = bars.length - 1; k >= 0; k--) { if (dayStr(bars[k].t) < today) { j = k; break; } }
            if (j < 1) j = bars.length - 2;
            const prev = bars[j], prior = bars[j - 1];
            const rangePips = (prev.h - prev.l) / pip;
            let n = 0, sum = 0;
            for (let m2 = j; m2 > j - 14 && m2 >= 0; m2--) { sum += (bars[m2].h - bars[m2].l) / pip; n++; }
            const atr = n ? sum / n : rangePips;
            let gapPips = null, sessionMovePips = null, prevDayMovePips = null, prevDayRangePips = null;
            let gapSrc = null, gapMeasurable = false;
            try {
              const hb = hh.bars;
              /* D7: Yahoo's 60m FX bars are stitched contiguous — every bar opens exactly
                 where the last one closed — so a "gap" computed from them is always ~0 and
                 means "this feed cannot see gaps", NOT "there was no gap". Detect that up
                 front so the UI can say so instead of printing a fake "No gap". */
              let joins = 0, flat = 0;
              for (let s = Math.max(1, hb.length - 40); s < hb.length; s++) {
                joins++;
                if (Math.abs(hb[s].o - hb[s - 1].c) < pip * 0.05) flat++;
              }
              gapMeasurable = !(joins >= 10 && flat / joins > 0.9);
              const ro = [];
              for (let z = 1; z < hb.length; z++) { if (nyHour(hb[z].t) === 17 && nyHour(hb[z - 1].t) !== 17) ro.push(z); }
              if (ro.length) {
                const z1 = ro[ro.length - 1];
                gapPips = (hb[z1].o - hb[z1 - 1].c) / pip;
                gapSrc = "hourly";
                const livePrice = meta.regularMarketPrice != null ? meta.regularMarketPrice : prev.c;
                sessionMovePips = r1((livePrice - hb[z1 - 1].c) / pip);
                if (ro.length >= 2) {
                  const z0 = ro[ro.length - 2];
                  prevDayMovePips = r1((hb[z1 - 1].c - hb[z0 - 1].c) / pip);
                  let phi = null, plo = null;
                  for (let w = z0; w < z1; w++) { if (phi == null || hb[w].h > phi) phi = hb[w].h; if (plo == null || hb[w].l < plo) plo = hb[w].l; }
                  if (phi != null && plo != null) prevDayRangePips = r1((phi - plo) / pip);
                }
              }
            } catch (e) { /* fall back to daily */ }
            if (gapPips == null) {
              const next = bars[j + 1];
              gapPips = next ? (next.o - prev.c) / pip : null;
              if (gapPips != null) { gapSrc = "daily"; gapMeasurable = false; }
            }
            stats[p] = {
              price: meta.regularMarketPrice != null ? meta.regularMarketPrice : prev.c,
              prevClose: prev.c,
              prevDate: dayStr(prev.t),
              movePips: r1((prev.c - prior.c) / pip),
              sessionMovePips: sessionMovePips,
              prevDayMovePips: prevDayMovePips,
              prevDayRangePips: prevDayRangePips,
              rangePips: r1(rangePips),
              atrPips: r1(atr),
              activity: atr ? Number((rangePips / atr).toFixed(2)) : null,
              gapPips: r1(gapPips),
              gapSrc: gapSrc,               // hourly | daily | null
              gapMeasurable: gapMeasurable, // false ⇒ feed is stitched, gap cannot be seen
              // D6: which window sessionMove/prevDayMove actually came from
              moveSrc: sessionMovePips != null ? "session7am"
                : (prevDayMovePips != null ? "prevSession7am" : "dailyClose")
            };
          } catch (e) { failed.push(p); }
        }));
        return J({ stats: stats, missing: failed, ts: new Date().toISOString() });
      } catch (e) {
        return J({ error: e.message, stats: {}, missing: [] }, 500);
      }
    }

    /* ── Anthropic proxy: POST /api ──
       D12 (19.8.26): this used to be an unauthenticated relay with
       Access-Control-Allow-Origin:* — anyone who read the page source could spend
       the Anthropic key. Three layers now stand in front of it:
         1. app key header + allow-listed Origin
         2. per-IP hourly cap
         3. a hard daily budget on calls, searches and tokens
       Layer 3 is the one that matters: even a leaked key cannot produce an
       open-ended bill. KV-cached replies bypass all of it — they cost nothing. */
    if (url.pathname === "/api" && req.method === "POST") {
      try {
        if (!env.FH_APP_KEY) return J({ error: "Proxy is not configured (missing app key)." }, 503);
        const key = req.headers.get("X-FH-App") || "";
        if (key !== env.FH_APP_KEY) return J({ error: "Not authorised for this proxy." }, 401);
        if (origin && !originOk) return J({ error: "Origin not allowed." }, 403);

        const body = await req.json();
        const prompt = typeof body.prompt === "string" ? body.prompt : "test";
        if (prompt.length > BUDGET.maxPromptChars) return J({ error: "Prompt too long." }, 413);
        if (body.image && String(body.image).length > BUDGET.maxImageBytes) {
          return J({ error: "That image is too large — please crop or downscale it below about 1MB." }, 413);
        }
        const maxTokens = Math.max(300, Math.min(3000, parseInt(body.maxTokens, 10) || 1200));
        const ALLOWED = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-sonnet-5"];
        const model = ALLOWED.indexOf(body.model) > -1 ? body.model : "claude-haiku-4-5";
        const useSearch = body.webSearch === true && !body.image;
        const tools = useSearch ? [{ type: "web_search_20250305", name: "web_search" }] : [];
        const wantJson = body.expectJson === true;

        /* ── Shared reply cache (the main saving) ──────────────────────────────
           Keyed by the exact prompt, so the daily analysis you already paid for on
           your phone is free on your laptop, and clearing your browser no longer
           re-bills it. Images are never cached (large, and always one-off). */
        const ck = typeof body.ck === "string" ? body.ck.slice(0, 80).replace(/[^\w:.\-]/g, "") : "";
        let cacheKey = null;
        if (KV && !body.image && body.noCache !== true) {
          cacheKey = "ai:" + (ck ? ck + ":" : "") + model + ":" + (useSearch ? "s" : "n") + ":" + (await sha256(prompt));
          try {
            const hit = await KV.get(cacheKey, { type: "json" });
            if (hit && (hit.text || hit.json != null)) {
              return J({
                text: hit.text || "", json: hit.json != null ? hit.json : null, jsonError: null,
                usage: null, model: hit.model || model, searched: !!hit.searched, cached: true
              });
            }
          } catch (e) { /* a cache miss must never block the call */ }
        }

        /* ── Budget + rate limit ── */
        const day = brisbaneDay(), bKey = "budget:" + day;
        let spend = { calls: 0, searches: 0, inTokens: 0, outTokens: 0 };
        if (KV) {
          try { spend = Object.assign(spend, JSON.parse((await KV.get(bKey)) || "{}")); } catch (e) { }
          if (spend.calls >= BUDGET.calls) {
            return J({ error: "Daily AI budget reached (" + BUDGET.calls + " calls). Cached panels still work; the budget resets at midnight AEST." }, 429);
          }
          if (useSearch && spend.searches >= BUDGET.searches) {
            return J({ error: "Daily web-search budget reached. Try again after midnight AEST, or refresh a panel that does not need live search." }, 429);
          }
          if (spend.inTokens >= BUDGET.inTokens || spend.outTokens >= BUDGET.outTokens) {
            return J({ error: "Daily AI token budget reached. It resets at midnight AEST." }, 429);
          }
          const ip = req.headers.get("CF-Connecting-IP") || "unknown";
          const ipKey = "ipq:" + (await sha256(ip)).slice(0, 16) + ":" + brisbaneHour();
          let ipCount = 0;
          try { ipCount = parseInt((await KV.get(ipKey)) || "0", 10) || 0; } catch (e) { }
          if (ipCount >= BUDGET.ipCallsPerHour) {
            return J({ error: "Too many AI requests from this connection in the last hour. Please wait a few minutes." }, 429);
          }
          try { await KV.put(ipKey, String(ipCount + 1), { expirationTtl: 7200 }); } catch (e) { }
        }

        let messageContent;
        if (body.image) {
          messageContent = [
            { type: "image", source: { type: "base64", media_type: body.mimeType || "image/png", data: body.image } },
            { type: "text", text: prompt || "Analyse this image." }
          ];
        } else {
          messageContent = prompt;
        }

        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "web-search-2025-03-05"
          },
          body: JSON.stringify({ model: model, max_tokens: maxTokens, tools: tools, messages: [{ role: "user", content: messageContent }] })
        });
        const data = await resp.json();

        /* Record the spend before anything can throw, so a failed parse still counts. */
        if (KV) {
          const u = (data && data.usage) || {};
          const next = {
            calls: (spend.calls || 0) + 1,
            searches: (spend.searches || 0) + (useSearch ? 1 : 0),
            inTokens: (spend.inTokens || 0) + (u.input_tokens || 0),
            outTokens: (spend.outTokens || 0) + (u.output_tokens || 0),
            ts: new Date().toISOString()
          };
          try { await KV.put(bKey, JSON.stringify(next), { expirationTtl: 40 * 86400 }); } catch (e) { }
        }

        if (data && data.error) return J({ error: data.error.message }, 400);
        let text = "";
        if (data && data.content && Array.isArray(data.content)) {
          let lastNonText = -1;
          for (let i = 0; i < data.content.length; i++) if (data.content[i].type !== "text") lastNonText = i;
          for (let i2 = lastNonText + 1; i2 < data.content.length; i2++) if (data.content[i2].type === "text") text += data.content[i2].text;
          if (text.replace(/\s/g, "") === "") {
            for (let i3 = 0; i3 < data.content.length; i3++) if (data.content[i3].type === "text") text += data.content[i3].text;
          }
        }
        /* D3: when the caller asks for structured output (body.expectJson), pull the
           JSON value out of the reply and return it parsed. This is the real fix for
           AI narration and [cite_start]/[1] tags leaking into the news list: the news
           renderer consumes `json`, never the prose. Regex-stripping prose was tried
           in earlier revisions and does not hold — do not go back to it. */
        let parsed = null, jsonError = null;
        if (wantJson) {
          parsed = extractJson(text);
          if (parsed == null) jsonError = "model did not return parsable JSON";
        }

        /* Only cache a usable reply — never a refusal or an unparsable one, or the
           cache would serve the failure for hours and hide the real answer. */
        const usable = wantJson ? (parsed != null) : (text && text.replace(/\s/g, "").length > 40);
        if (KV && cacheKey && usable) {
          try {
            await KV.put(cacheKey, JSON.stringify({ text: text, json: parsed, model: model, searched: useSearch }),
              { expirationTtl: ttlFor(ck) });
          } catch (e) { /* best effort */ }
        }

        return J({
          text: text, json: parsed, jsonError: jsonError,
          usage: data.usage || null, model: model, searched: useSearch, cached: false
        });
      } catch (e) {
        return J({ error: e.message }, 500);
      }
    }

    return J({ error: "unknown endpoint: " + url.pathname }, 404);
  }
};
