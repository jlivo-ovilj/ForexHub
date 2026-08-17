/* ForexHub data + AI proxy — Cloudflare Worker
   17.8.26 rebuild: the price feed kept dying because every request went straight to
   Yahoo with no edge cache and no retry, so a burst of page traffic (ticker + heat map
   + calculator + briefing all at once) tripped Yahoo's rate limiter and the whole site
   showed "No live data returned". Now:
     • every upstream response is edge-cached (cacheTtl), so repeat requests never touch Yahoo
     • query1 → query2 → retry with backoff before a pair is given up on
     • the response reports which pairs failed instead of silently dropping them
     • /calendar proxies the real Forex Factory calendar feed (cached 15 min)          */

const YF_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// Hoisted: building an Intl formatter per bar burned the worker's CPU budget on big requests
const NY_HOUR_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
const nyHour = function (t) { return Number(NY_HOUR_FMT.format(new Date(t * 1000))); };
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

/* Yahoo chart fetch: mirror fallback + one backoff retry + edge cache. */
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

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(req.url);
    const J = function (obj, status) {
      return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, cors)
      });
    };

    /* ── Health check: GET /health → which upstreams are actually answering ── */
    if (url.pathname === "/health") {
      const t0 = Date.now();
      const y = await yChart("EURUSD=X", "1d", "5m", 30);
      let cal = false;
      try { const r = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { headers: { "User-Agent": UA }, cf: { cacheTtl: 900, cacheEverything: true } }); cal = r.ok; } catch (e) { }
      return J({ yahoo: !!y, calendar: cal, ms: Date.now() - t0, ts: new Date().toISOString() });
    }

    /* ── Economic calendar: GET /calendar?w=thisweek|nextweek|thismonth ──
       Proxies the Forex Factory feed (the site the app is checked against) and adds
       CORS + a 15-minute edge cache. Returns the feed rows verbatim. */
    if (url.pathname === "/calendar" && req.method === "GET") {
      const w = (url.searchParams.get("w") || "thisweek").replace(/[^a-z]/g, "");
      const allowed = ["thisweek", "nextweek", "lastweek", "thismonth", "nextmonth", "today", "tomorrow"];
      const which = allowed.indexOf(w) > -1 ? w : "thisweek";
      const src = "https://nfs.faireconomy.media/ff_calendar_" + which + ".json";
      try {
        const r = await fetch(src, { headers: { "User-Agent": UA, "Accept": "application/json" }, cf: { cacheTtl: 900, cacheEverything: true } });
        if (!r.ok) return J({ events: [], error: "upstream HTTP " + r.status }, 200);
        const d = await r.json();
        const events = Array.isArray(d) ? d : [];
        return J({ events: events, week: which, count: events.length, ts: new Date().toISOString() });
      } catch (e) {
        return J({ events: [], error: e.message }, 200);
      }
    }

    /* ── Live FX quotes: GET /price?pairs=EURUSD,USDJPY ──
       Daily (td/dp) and today's hi/lo anchor to the 5pm-New-York rollover (≈7am Brisbane). */
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
              yChart(sym, "2d", "5m", 60),     // intraday, cached 1 min
              yChart(sym, "3mo", "1d", 1800)   // daily history, cached 30 min
            ]);
            const intra = series(both[0]), daily = series(both[1]);
            const ib = intra.bars, db = daily.bars, meta = intra.meta || {};
            const price = meta.regularMarketPrice != null ? meta.regularMarketPrice
              : (ib.length ? ib[ib.length - 1].c : (db.length ? db[db.length - 1].c : null));
            if (price == null) { failed.push(p); return; }
            const pip = pipOf(p);
            // Rollover bar: the latest bar starting the 17:00 New-York hour
            let roIdx = -1;
            for (let z = ib.length - 1; z > 0; z--) {
              if (nyHour(ib[z].t) === 17 && nyHour(ib[z - 1].t) !== 17) { roIdx = z; break; }
            }
            const ref = roIdx > 0 ? ib[roIdx - 1].c
              : (meta.chartPreviousClose != null ? meta.chartPreviousClose : (ib.length ? ib[0].c : price));
            let span;
            if (roIdx > 0) span = ib.slice(roIdx);
            else {
              const lastT = ib.length ? ib[ib.length - 1].t : 0;
              span = ib.filter(function (b) { return lastT - b.t <= 86400; });
              if (!span.length) span = ib;
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
              mp: mRef != null ? r1((price - mRef) / pip) : null
            };
          } catch (e) { failed.push(p); }
        }));
        return J({ quotes: out, missing: failed, ts: new Date().toISOString() });
      } catch (e) {
        return J({ error: e.message, quotes: {} }, 500);
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
            try {
              const hb = hh.bars;
              const ro = [];
              for (let z = 1; z < hb.length; z++) { if (nyHour(hb[z].t) === 17 && nyHour(hb[z - 1].t) !== 17) ro.push(z); }
              if (ro.length) {
                const z1 = ro[ro.length - 1];
                gapPips = (hb[z1].o - hb[z1 - 1].c) / pip;
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
            if (gapPips == null) { const next = bars[j + 1]; gapPips = next ? (next.o - prev.c) / pip : null; }
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
              gapPips: r1(gapPips)
            };
          } catch (e) { failed.push(p); }
        }));
        return J({ stats: stats, missing: failed, ts: new Date().toISOString() });
      } catch (e) {
        return J({ error: e.message, stats: {} }, 500);
      }
    }

    /* ── Anthropic proxy: POST /api ── */
    if (url.pathname === "/api" && req.method === "POST") {
      try {
        const body = await req.json();
        let messageContent;
        if (body.image) {
          messageContent = [
            { type: "image", source: { type: "base64", media_type: body.mimeType || "image/png", data: body.image } },
            { type: "text", text: body.prompt || "Analyse this image." }
          ];
        } else {
          messageContent = body.prompt || "test";
        }
        const maxTokens = Math.max(500, Math.min(4000, parseInt(body.maxTokens, 10) || 2000));
        const ALLOWED = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-sonnet-5"];
        const model = ALLOWED.indexOf(body.model) > -1 ? body.model : "claude-haiku-4-5";
        const useSearch = body.webSearch === true && !body.image;
        const tools = useSearch ? [{ type: "web_search_20250305", name: "web_search" }] : [];

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
        return J({ text: text, usage: data.usage || null, model: model, searched: useSearch });
      } catch (e) {
        return J({ error: e.message }, 500);
      }
    }

    return J({ text: "" });
  }
};
