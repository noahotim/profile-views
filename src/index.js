const ONE_MINUTE = 60;

const EMPTY = () => ({
  total: 0,
  uniques: 0,
  countries: {},
  days: {},
  uniqDays: {},
  live: {},
  recent: [],
  seen: {},
  lastSeen: null,
  lastCountry: null,
});

export class ProfileStats {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.data = null;
    this.loading = null;
  }

  async ready() {
    if (this.data) return;
    if (!this.loading) {
      this.loading = this.state.storage.get("data").then((stored) => {
        this.data = stored || EMPTY();
      });
    }
    await this.loading;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/visit") {
      const visit = await request.json();
      await this.ready();
      await this.record(visit);
      return Response.json({ ok: true, total: this.data.total });
    }

    if (url.pathname === "/stats") {
      await this.ready();
      return Response.json(this.snapshot());
    }

    return new Response("not found", { status: 404 });
  }

  async record(visit) {
    const d = this.data;
    const isTest = visit.source === "test";

    if (!isTest) {
      const day = visit.ts.slice(0, 10);
      const minute = Math.floor(Date.now() / (ONE_MINUTE * 1000));

      d.total += 1;
      d.countries[visit.country] = (d.countries[visit.country] || 0) + 1;
      d.days[day] = (d.days[day] || 0) + 1;
      d.live[minute] = (d.live[minute] || 0) + 1;
      d.lastSeen = visit.ts;
      d.lastCountry = visit.country;

      const hash = visit.visitorHash;
      if (hash) {
        const prevDay = d.seen[hash];
        if (prevDay !== day) {
          d.uniqDays[day] = (d.uniqDays[day] || 0) + 1;
          if (!prevDay) d.uniques += 1;
          d.seen[hash] = day;
        }
      }
    }

    d.recent.unshift(visit);
    if (d.recent.length > 100) d.recent.length = 100;

    this.prune();
    await this.state.storage.put("data", d);
  }

  prune() {
    const d = this.data;
    const minute = Math.floor(Date.now() / (ONE_MINUTE * 1000));
    for (const key of Object.keys(d.live)) {
      if (Number(key) < minute - 30) delete d.live[key];
    }
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    for (const key of Object.keys(d.days)) {
      if (key < cutoff) {
        delete d.days[key];
        delete d.uniqDays[key];
      }
    }
    const seenKeys = Object.keys(d.seen);
    if (seenKeys.length > 20000) {
      const keep = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      for (const key of seenKeys) {
        if (d.seen[key] < keep) delete d.seen[key];
      }
    }
  }

  snapshot() {
    const d = this.data;
    const minute = Math.floor(Date.now() / (ONE_MINUTE * 1000));

    let live = 0;
    for (let i = 0; i < 5; i++) live += d.live[minute - i] || 0;

    const countries = Object.entries(d.countries)
      .map(([code, views]) => ({ code, name: countryName(code), flag: flagEmoji(code), views }))
      .filter((c) => c.views > 0)
      .sort((a, b) => b.views - a.views);

    const days = [];
    for (let i = 13; i >= 0; i--) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - i);
      const key = date.toISOString().slice(0, 10);
      days.push({ day: key, views: d.days[key] || 0, uniques: d.uniqDays[key] || 0 });
    }

    return {
      total: d.total,
      uniques: d.uniques,
      live,
      lastSeen: d.lastSeen,
      lastCountry: d.lastCountry,
      countries,
      days,
      recent: d.recent.slice(0, 60),
      generatedAt: new Date().toISOString(),
    };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (path === "/") {
      return json({ ok: true, service: "profile-views", badge: "/badge", dashboard: "/dashboard" }, cors);
    }

    if (path === "/badge" || path === "/badge.svg") {
      return handleBadge(request, env);
    }

    if (path === "/api/track") {
      const source = url.searchParams.get("src") || "site";
      ctx.waitUntil(
        (async () => {
          const visit = await buildVisit(request, env, source);
          await ingest(env, visit);
        })().catch(() => {})
      );
      return json({ ok: true }, cors);
    }

    if (path === "/api/stats") {
      if (!isAuthorized(url, env)) {
        return json({ error: "unauthorized" }, cors, 401);
      }
      const stats = await readStats(env);
      return json(stats, cors);
    }

    if (path === "/dashboard") {
      return handleDashboard(request, env, url);
    }

    return new Response("Not found", { status: 404 });
  },
};

function stub(env) {
  return env.STATS.get(env.STATS.idFromName("global"));
}

async function ingest(env, visit) {
  const res = await stub(env).fetch("https://do/visit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(visit),
  });
  return res.json();
}

async function readStats(env) {
  const res = await stub(env).fetch("https://do/stats");
  return res.json();
}

function json(body, headers = {}, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function isAuthorized(url, env) {
  const key = url.searchParams.get("key");
  return !!env.DASHBOARD_KEY && key === env.DASHBOARD_KEY;
}

async function sha256(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function parseUA(ua) {
  const s = ua || "";
  let browser = "Unknown";
  let os = "Unknown";
  let device = "Desktop";

  const edge = s.match(/Edg(?:e|A|iOS)?\/([\d.]+)/);
  const opera = s.match(/OPR\/([\d.]+)/);
  const chrome = s.match(/Chrome\/([\d.]+)/);
  const firefox = s.match(/Firefox\/([\d.]+)/);
  const safari = s.match(/Version\/([\d.]+).*Safari/);
  const curl = s.match(/^curl\/([\d.]+)/i);

  if (edge) browser = `Edge ${edge[1].split(".")[0]}`;
  else if (opera) browser = `Opera ${opera[1].split(".")[0]}`;
  else if (/camo/i.test(s)) browser = "GitHub Camo";
  else if (curl) browser = `curl ${curl[1]}`;
  else if (firefox) browser = `Firefox ${firefox[1].split(".")[0]}`;
  else if (chrome && !/Chromium/.test(s)) browser = `Chrome ${chrome[1].split(".")[0]}`;
  else if (safari) browser = `Safari ${safari[1].split(".")[0]}`;
  else if (/WinHttp|Microsoft/i.test(s)) browser = "Windows";

  if (/Windows NT 10/.test(s)) os = "Windows 10/11";
  else if (/Windows NT/.test(s)) os = "Windows";
  else if (/CrOS/.test(s)) os = "ChromeOS";
  else if (/Android/.test(s)) os = "Android";
  else if (/iPhone|iPad|iPod/.test(s)) os = "iOS";
  else if (/Mac OS X|Macintosh/.test(s)) os = "macOS";
  else if (/Linux/.test(s)) os = "Linux";

  if (/iPad|Tablet/.test(s)) device = "Tablet";
  else if (/Mobile|Android|iPhone/i.test(s)) device = "Mobile";

  return { browser, os, device };
}

async function buildVisit(request, env, source) {
  const url = new URL(request.url);
  const cf = request.cf || {};
  const country = (cf.country || "XX").toUpperCase();
  const ip =
    request.headers.get("cf-connecting-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "0.0.0.0";

  const headerUa = request.headers.get("user-agent") || "";
  const clientUa = url.searchParams.get("ua");
  const rawUa = (clientUa && clientUa.length > 4 ? clientUa : headerUa) || "";
  const parsed = parseUA(rawUa);

  const hint = (name, max) => {
    const value = url.searchParams.get(name);
    return value ? value.slice(0, max) : null;
  };

  const visitorHash = await sha256(`${ip}|${rawUa}`);

  return {
    ts: new Date().toISOString(),
    source,
    path: source === "site" || source === "test" ? url.searchParams.get("path") || "/" : "profile-badge",
    ref: source === "site" || source === "test" ? url.searchParams.get("ref") || "" : request.headers.get("referer") || "",
    ip,
    country,
    city: cf.city || null,
    region: cf.region || null,
    org: cf.asOrganization || null,
    asn: cf.asn || null,
    tz: cf.timezone || null,
    browser: hint("b", 60) || parsed.browser,
    os: hint("o", 40) || parsed.os,
    device: hint("d", 20) || parsed.device,
    ua: rawUa.slice(0, 220),
    visitorHash,
  };
}

async function handleBadge(request, env) {
  let total = 0;
  try {
    const visit = await buildVisit(request, env, "badge");
    const result = await ingest(env, visit);
    total = result.total || 0;
  } catch {
    total = 0;
  }

  const svg = badgeSvg("profile views", formatNumber(total));
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "no-cache, no-store, max-age=0, must-revalidate",
    },
  });
}

async function handleDashboard(request, env, url) {
  if (!env.DASHBOARD_KEY) {
    return new Response(lockPage("Dashboard key not configured", "Run: npx wrangler secret put DASHBOARD_KEY"), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (!isAuthorized(url, env)) {
    return new Response(
      lockPage("Private dashboard", "Add ?key=YOUR_SECRET to the URL. The key is the DASHBOARD_KEY secret you set."),
      { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
    );
  }

  const key = url.searchParams.get("key");
  return new Response(dashboardHtml(env.GITHUB_USERNAME || "profile", key), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function badgeSvg(label, value) {
  const charWidth = 6.6;
  const pad = 10;
  const lw = Math.round(label.length * charWidth + pad * 2);
  const vw = Math.round(value.length * charWidth + pad * 2);
  const w = lw + vw;
  const h = 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <title>${esc(label)}: ${esc(value)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${w}" height="${h}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="${h}" fill="#555"/>
    <rect x="${lw}" width="${vw}" height="${h}" fill="#2ea44f"/>
    <rect width="${w}" height="${h}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text>
    <text x="${lw / 2}" y="14">${esc(label)}</text>
    <text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(value)}</text>
    <text x="${lw + vw / 2}" y="14">${esc(value)}</text>
  </g>
</svg>`;
}

function formatNumber(n) {
  return (n || 0).toLocaleString("en-GB");
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function flagEmoji(code) {
  if (!/^[A-Z]{2}$/.test(code)) return "🏳️";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

const COUNTRY_NAMES = {
  US: "United States", GB: "United Kingdom", UG: "Uganda", KE: "Kenya", TZ: "Tanzania",
  NG: "Nigeria", ZA: "South Africa", GH: "Ghana", RW: "Rwanda", ET: "Ethiopia",
  EG: "Egypt", MA: "Morocco", DZ: "Algeria", TN: "Tunisia", SN: "Senegal",
  CM: "Cameroon", CI: "Côte d'Ivoire", ZM: "Zambia", ZW: "Zimbabwe", MW: "Malawi",
  CA: "Canada", AU: "Australia", NZ: "New Zealand", IE: "Ireland", IN: "India",
  PK: "Pakistan", BD: "Bangladesh", LK: "Sri Lanka", NP: "Nepal", CN: "China",
  JP: "Japan", KR: "South Korea", SG: "Singapore", MY: "Malaysia", ID: "Indonesia",
  PH: "Philippines", TH: "Thailand", VN: "Vietnam", AE: "United Arab Emirates",
  SA: "Saudi Arabia", QA: "Qatar", KW: "Kuwait", TR: "Türkiye", IL: "Israel",
  DE: "Germany", FR: "France", ES: "Spain", IT: "Italy", PT: "Portugal",
  NL: "Netherlands", BE: "Belgium", CH: "Switzerland", AT: "Austria", SE: "Sweden",
  NO: "Norway", DK: "Denmark", FI: "Finland", PL: "Poland", CZ: "Czechia",
  RO: "Romania", GR: "Greece", HU: "Hungary", UA: "Ukraine", RU: "Russia",
  BR: "Brazil", MX: "Mexico", AR: "Argentina", CL: "Chile", CO: "Colombia",
  PE: "Peru", VE: "Venezuela", EC: "Ecuador", UY: "Uruguay", CR: "Costa Rica",
  XX: "Unknown",
};

function countryName(code) {
  return COUNTRY_NAMES[code] || code;
}

function lockPage(title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>${esc(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .box{max-width:420px;text-align:center;padding:40px}
  h1{font-size:20px;margin:0 0 10px}
  p{color:#8b949e;font-size:14px;line-height:1.5;margin:0}
</style></head><body><div class="box"><h1>${esc(title)}</h1><p>${esc(message)}</p></div></body></html>`;
}

function dashboardHtml(username, key) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>${esc(username)} · profile views</title>
<style>
  :root{--bg:#0d1117;--card:#161b22;--border:#30363d;--muted:#8b949e;--text:#e6edf3;--accent:#2ea44f;--accent2:#58a6ff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:32px 20px}
  .wrap{max-width:1000px;margin:0 auto}
  header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px;flex-wrap:wrap}
  h1{font-size:18px;margin:0;font-weight:600}
  .sub{color:var(--muted);font-size:13px;margin-top:4px}
  .live{display:inline-flex;align-items:center;gap:8px;background:rgba(46,164,79,.12);color:var(--accent);
        padding:6px 12px;border-radius:999px;font-size:13px;font-weight:600}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 1.6s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px}
  .card .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
  .card .value{font-size:30px;font-weight:700;margin-top:8px}
  .card.accent .value{color:var(--accent)}
  section{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:24px;overflow-x:auto}
  section h2{font-size:14px;margin:0 0 16px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
  .row{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)}
  .row:last-child{border-bottom:0}
  .flag{font-size:20px;width:26px;text-align:center}
  .cname{flex:1;font-size:14px}
  .cviews{color:var(--muted);font-variant-numeric:tabular-nums}
  .bar{height:9px;border-radius:6px;background:linear-gradient(90deg,var(--accent),var(--accent2));min-width:3px}
  .days{display:flex;align-items:flex-end;gap:6px;height:120px}
  .daycol{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;height:100%}
  .daybar{width:100%;background:linear-gradient(180deg,var(--accent2),var(--accent));border-radius:4px;min-height:3px}
  .daylabel{font-size:10px;color:var(--muted);white-space:nowrap}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--muted);font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.06em;padding:6px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
  td{padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
  tr:last-child td{border-bottom:0}
  .tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
  .tag.site{background:rgba(46,164,79,.15);color:#3fb950}
  .tag.badge{background:rgba(88,166,255,.15);color:#58a6ff}
  .tag.test{background:rgba(210,153,34,.15);color:#d29922}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  footer{color:var(--muted);font-size:12px;text-align:center}
  .err{color:#f85149;font-size:13px;margin-top:12px}
</style></head>
<body><div class="wrap">
  <header>
    <div>
      <h1>${esc(username)} · profile views</h1>
      <div class="sub" id="stamp">Loading…</div>
    </div>
    <div class="live"><span class="dot"></span><span id="live">0</span> viewing now</div>
  </header>

  <div class="grid">
    <div class="card accent"><div class="label">Total views</div><div class="value" id="total">–</div></div>
    <div class="card"><div class="label">Unique visitors</div><div class="value" id="uniques">–</div></div>
    <div class="card"><div class="label">Live (5 min)</div><div class="value" id="live2">–</div></div>
    <div class="card"><div class="label">Countries</div><div class="value" id="ccount">–</div></div>
  </div>

  <section>
    <h2>Recent activity</h2>
    <div id="recent"><div class="err">No visits yet.</div></div>
  </section>

  <section>
    <h2>Top countries</h2>
    <div id="countries"><div class="err">No data yet.</div></div>
  </section>

  <section>
    <h2>Last 14 days</h2>
    <div class="days" id="days"></div>
  </section>

  <footer>Live, updates every 4s · private to you · bookmark this URL</footer>
  <div class="err" id="err"></div>
</div>

<script>
  const KEY = ${JSON.stringify(key)};
  const fmt = (n) => (n || 0).toLocaleString("en-GB");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function timeAgo(iso) {
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return sec + "s ago";
    if (sec < 3600) return Math.floor(sec / 60) + "m ago";
    if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
    return Math.floor(sec / 86400) + "d ago";
  }

  function renderRecent(list) {
    if (!list || !list.length) return '<div class="err">No visits yet.</div>';
    return '<table><thead><tr><th>When</th><th>Source</th><th>Browser</th><th>OS</th><th>Device</th><th>Location</th><th>IP</th><th>Network</th></tr></thead><tbody>'
      + list.map(function (v) {
          const loc = [v.city, v.region, v.country].filter(Boolean).join(", ");
          const tagLabel = v.source === "site" ? "site" : v.source === "test" ? "test" : "badge";
          const tag = '<span class="tag ' + tagLabel + '">' + tagLabel + '</span>';
          return "<tr>"
            + '<td title="' + esc(new Date(v.ts).toLocaleString("en-GB")) + '">' + timeAgo(v.ts) + "</td>"
            + "<td>" + tag + "</td>"
            + '<td title="' + esc(v.ua || "") + '">' + esc(v.browser) + "</td>"
            + "<td>" + esc(v.os) + "</td>"
            + "<td>" + esc(v.device) + "</td>"
            + "<td>" + esc(loc) + "</td>"
            + '<td class="mono">' + esc(v.ip) + "</td>"
            + "<td>" + esc(v.org || v.asn || "") + "</td>"
            + "</tr>";
        }).join("")
      + "</tbody></table>";
  }

  async function refresh() {
    try {
      const res = await fetch("/api/stats?key=" + encodeURIComponent(KEY), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const d = await res.json();
      document.getElementById("total").textContent = fmt(d.total);
      document.getElementById("uniques").textContent = fmt(d.uniques);
      document.getElementById("live").textContent = fmt(d.live);
      document.getElementById("live2").textContent = fmt(d.live);
      document.getElementById("ccount").textContent = fmt(d.countries.length);
      document.getElementById("stamp").textContent = "Updated " + new Date(d.generatedAt).toLocaleTimeString("en-GB");
      document.getElementById("err").textContent = "";

      document.getElementById("recent").innerHTML = renderRecent(d.recent);

      const max = d.countries.length ? d.countries[0].views : 1;
      document.getElementById("countries").innerHTML = d.countries.length
        ? d.countries.map(function (c) {
            const pct = Math.max(3, Math.round((c.views / max) * 100));
            return '<div class="row"><div class="flag">' + c.flag + '</div>'
              + '<div class="cname">' + c.name + '</div>'
              + '<div class="bar" style="width:' + (pct * 0.5) + 'px"></div>'
              + '<div class="cviews">' + fmt(c.views) + '</div></div>';
          }).join("")
        : '<div class="err">No data yet.</div>';

      const dayMax = Math.max.apply(null, d.days.map(function (x) { return x.views; }).concat([1]));
      document.getElementById("days").innerHTML = d.days.map(function (x) {
        const h = Math.max(3, Math.round((x.views / dayMax) * 100));
        return '<div class="daycol" title="' + x.day + ': ' + fmt(x.views) + ' views, ' + fmt(x.uniques) + ' unique">'
          + '<div class="daybar" style="height:' + h + '%"></div>'
          + '<div class="daylabel">' + x.day.slice(5) + '</div></div>';
      }).join("");
    } catch (e) {
      document.getElementById("err").textContent = "Could not load stats: " + e.message;
    }
  }

  refresh();
  setInterval(refresh, 4000);
</script>
</body></html>`;
}
