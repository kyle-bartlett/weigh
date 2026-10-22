import { CSS, esc, FONTS } from "../../report/html.ts";
import type { RunStatus } from "../../events.ts";

/**
 * Every hub page shares the report's fonts, tokens and CSS, plus a small set of hub-only rules for
 * navigation, status tags and the live cells. Rendered server side; the only script is the live
 * run module, included when a page asks for it.
 */

export const HUB_CSS = `
.phone-ready{overflow-wrap:anywhere}
.phone-ready .cards{grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))}
.phone-ready .card .row{flex-wrap:wrap}
.phone-ready button,.phone-ready select,.phone-ready summary{min-height:44px;min-width:44px;max-width:100%}
.phone-ready a{max-width:100%}
@media(pointer:coarse){.phone-ready a:not(.btn):not(.card){padding-block:10px}}
.phone-ready summary{padding-block:10px;cursor:pointer}
.phone-ready .comparison-picker label{min-width:0;max-width:100%}
.phone-ready .table-scroll{min-width:0}
.project-page .version-timeline{list-style:none;padding:0;display:grid;gap:20px}
.project-page .version-timeline li{border-left:2px solid var(--line);padding-left:20px}
.project-page .version-timeline p{margin:6px 0}
@media(max-width:600px){.phone-ready .case-page .kv{grid-template-columns:minmax(0,1fr) minmax(0,2fr)}}
nav.crumbs{display:flex;gap:10px;align-items:baseline;font-size:14px;color:var(--ink3);margin:28px 0 0;flex-wrap:wrap}
nav.crumbs a{color:var(--ink2);text-decoration:none}nav.crumbs a:hover{text-decoration:underline}
h1.page{font-size:clamp(30px,3.6vw,48px);margin:16px 0 14px}
.status{display:inline-flex;align-items:center;gap:7px;font-family:"IBM Plex Mono",monospace;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;padding:3px 9px;border-radius:3px;background:var(--bg2);color:var(--ink2)}
.status i{width:8px;height:8px;border-radius:50%;background:var(--ink3);display:inline-block}
.status.running i{background:var(--live);box-shadow:0 0 0 3px var(--live-soft);animation:pulse 1.6s ease-in-out infinite}
.status.finished i{background:var(--live)}.status.failed i,.status.cancelled i,.status.lost i{background:var(--gate)}
.status.queued i,.status.claimed i{background:var(--gate)}
@keyframes pulse{0%,100%{box-shadow:0 0 0 3px var(--live-soft)}50%{box-shadow:0 0 0 6px transparent}}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-top:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;box-shadow:var(--shadow);padding:18px 20px;text-decoration:none;color:inherit;display:block}
.card h3{margin:0 0 4px}.card p{margin:0 0 10px;color:var(--ink2);font-size:14px}
.card .row{display:flex;justify-content:space-between;gap:12px;font-size:13px;color:var(--ink3);align-items:center}
.progress{height:6px;background:var(--bg2);border-radius:3px;overflow:hidden;margin:14px 0 6px}
.progress i{display:block;width:100%;height:100%;background:var(--live);transform-origin:left;transition:transform .3s}
.empty{padding:36px 0;color:var(--ink2)}
td.chk-cell .pending{display:inline-block;width:10px;height:10px;border-radius:50%;border:1px dashed var(--line);margin-right:4px;vertical-align:middle}
tr.live-new td{animation:flash 1.2s ease-out}
@keyframes flash{0%{background:var(--live-soft)}100%{background:transparent}}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;font-size:14px}
.kv dt{color:var(--ink3);font-family:"IBM Plex Mono",monospace;font-size:12px;letter-spacing:.08em;text-transform:uppercase}
.kv dd{margin:0}
pre.out{max-height:60vh;white-space:pre-wrap;word-break:break-word}
.btn{font:inherit;font-size:14px;padding:8px 14px;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--ink);cursor:pointer}
.btn.primary{background:var(--live);border-color:var(--live);color:#fff}
form.inline{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.landing{overflow-wrap:anywhere}.landing .cards{grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}
.landing .latest-verdict{margin-bottom:32px}.latest-verdict .landing-story{font-size:clamp(18px,2vw,24px);color:var(--ink);max-width:48em;margin:12px 0}.landing .tag{text-transform:none;letter-spacing:0}
.landing-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:32px;margin:24px 0 0;padding-left:24px}.landing-steps li{padding-left:4px}.landing-steps svg{display:block;color:var(--live);margin-bottom:12px}.landing-steps p{margin:0;color:var(--ink2)}
.trust-strip{display:flex;flex-wrap:wrap;gap:12px 28px;border-block:1px solid var(--line);padding:20px 0;font-size:13px;color:var(--ink2)}
.landing-actions{display:flex;flex-wrap:wrap;gap:12px;padding:24px 0 36px}.landing-actions .btn{display:inline-flex;align-items:center;min-height:44px;text-decoration:none}.landing-actions button:disabled{opacity:.6;cursor:default}
@media(max-width:600px){.landing-steps,.landing .sec-head{grid-template-columns:1fr}.landing-steps{gap:24px}.landing .sec-head{gap:12px}.landing .card .row{flex-wrap:wrap}.landing-actions .btn{justify-content:center}}
input.txt{font:inherit;font-size:14px;padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--ink);min-width:220px}
.verdict-card{padding:20px 0 24px}.verdict-card h1{margin-top:0;line-height:1.12}
.verdict-card h1 .tag{vertical-align:middle;text-transform:none;letter-spacing:0}
.ship{margin:12px 0 20px}.ship b{color:var(--live)}
.verdict-card[data-ship="false"] .ship b{color:var(--gate)}
.verdict-numbers{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-block:1px solid var(--line);gap:20px;padding:20px 0}
.verdict-numbers .n{font-size:clamp(23px,3vw,36px);line-height:1.2;margin-bottom:8px}
.verdict-numbers p{color:var(--ink2);font-size:13px;margin:6px 0 0}.verdict-numbers b{font-size:14px;font-weight:500}
.noise-note{font-size:13px;color:var(--ink2);margin:14px 0 0}
.run-page{overflow-wrap:anywhere}.run-progress{display:flex;flex-wrap:wrap;gap:10px 20px;align-items:center;color:var(--ink2);font-size:13px}
.comparison-picker{margin:24px 0}.comparison-picker select{max-width:100%}
.check-row{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,1fr);gap:24px;border-top:1px solid var(--line2);padding:18px 0}.check-row p{margin:6px 0;color:var(--ink2);font-size:14px}
.case-decision{display:block;font-size:13px;color:var(--ink2);margin-top:6px}.case-table td{overflow-wrap:anywhere}.case-table details{font-size:13px;margin-top:8px}.case-table ul{padding-left:16px}
.run-page summary{cursor:pointer}.run-page summary:focus-visible,.run-page .tag:focus-visible{outline:2px solid var(--live);outline-offset:3px}
#engineers{border-top:1px solid var(--line);margin:20px 0}#engineers>summary{font-size:24px;padding:24px 0;font-weight:600}
.table-scroll{overflow-x:auto;max-width:100%}.table-scroll table{min-width:650px}.run-page pre{white-space:pre-wrap;overflow-wrap:anywhere}
.case-page{overflow-wrap:anywhere}.case-page .tag{text-transform:none;letter-spacing:0}
@media(max-width:600px){.case-page .sec-head{grid-template-columns:1fr;gap:12px}}
.field-table .field-difference{background:var(--gate-soft)}.field-table .field-verdict{display:block;font-size:12.5px;color:var(--ink3);margin-top:2px}.field-table .field-disagree{display:block;margin-top:4px;font-size:10.5px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--ink2)}
.case-records{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:24px}.case-records>div{min-width:0}.case-page .kv{grid-template-columns:minmax(0,max-content) minmax(0,1fr)}.case-page summary{cursor:pointer}
.run-page .tag{text-transform:none;letter-spacing:0}.run-page h1 .tag{font-size:.4em}
@media(prefers-reduced-motion:reduce){.status.running i,tr.live-new td{animation:none}.progress i{transition:none}}
@media(max-width:600px){.check-row{grid-template-columns:1fr;gap:0}.check-counts{display:block}.case-table thead{display:none}.case-table,.case-table tbody,.case-table tr,.case-table td{display:block;width:100%}.case-table tr{border-top:1px solid var(--line);padding:12px 0}.case-table td{border:0;padding:5px 0}.case-table td[data-label]::before{content:attr(data-label);display:block;font-size:12px;color:var(--ink3);font-weight:400}.run-page .sec-head{gap:12px}}
@media(max-width:600px){.runs-table thead{display:none}.runs-table,.runs-table tbody,.runs-table tr,.runs-table td{display:block;width:100%}.runs-table tr{border-top:1px solid var(--line);padding:12px 0}.runs-table td{border:0;padding:5px 0;text-align:left}.runs-table td[data-label]::before{content:attr(data-label);display:block;font-size:12px;color:var(--ink3);font-weight:400}}
@media(max-width:600px){.verdict-numbers{gap:12px;grid-template-columns:1fr;padding:12px 0}.verdict-numbers>div{display:grid;grid-template-columns:116px 1fr;column-gap:10px}.verdict-numbers .n{grid-row:1/3;font-size:23px;margin:0}.verdict-numbers p{margin-top:2px}.verdict-card h1{font-size:28px}.verdict-card{padding-top:16px}.ship{margin:10px 0 12px}}
`;

/**
 * Read once by startHub. Empty disables tracking. s.js drops any code that is not 18 hex
 * characters without a word, so a malformed one is refused here with a warning instead of
 * relaxing the CSP for a tracker that records nothing.
 */
export const readAnalyticsSite = (value = process.env.WEIGH_ANALYTICS_SITE) => {
  const site = value?.trim();
  if (!site) return undefined;
  if (/^[0-9a-f]{18}$/.test(site)) return site;
  console.warn(
    "weigh hub: WEIGH_ANALYTICS_SITE is not an 18-character hex site code; analytics stay off",
  );
  return undefined;
};

/** Shared head decoration at the HTML response boundary keeps error pages untracked. */
export function withAnalytics(
  html: string,
  site?: string,
  status = 200,
): string {
  if (!site?.trim() || status < 200 || status >= 300) return html;
  return html.replace(
    "</head>",
    `<script defer data-site="${esc(site)}" src="https://www.staats.ai/s.js"></script><script defer src="/web/analytics.js"></script></head>`,
  );
}

export interface PageOpts {
  title: string;
  body: string;
  crumbs?: { href: string; text: string }[];
  /** Loads web/run.js with the run key, for a page that should fill in live. */
  live?: { key: string; since: number };
  runScript?: {
    key: string;
    since: number;
    live: boolean;
    finished: number;
    total: number;
  };
  generatedAt?: string;
  social?: { title: string; description: string; image: string };
  tour?: boolean;
}

export function page(o: PageOpts): string {
  const phonePage =
    /<main class="(?:landing|project-page|run-page|case-page)"/.test(o.body);
  const crumbs = o.crumbs?.length
    ? `<nav class="crumbs">${o.crumbs.map((c) => (c.href ? `<a href="${esc(c.href)}">${esc(c.text)}</a>` : `<span>${esc(c.text)}</span>`)).join('<span aria-hidden="true">/</span>')}</nav>`
    : "";
  const live = o.runScript
    ? `<script type="module" src="/web/run.js" data-run="${esc(o.runScript.key)}" data-since="${o.runScript.since}" data-live="${o.runScript.live}" data-finished="${o.runScript.finished}" data-total="${o.runScript.total}"></script>`
    : o.live
      ? `<script type="module" src="/web/run.js" data-run="${esc(o.live.key)}" data-since="${o.live.since}"></script>`
      : "";
  const social = o.social
    ? `<meta property="og:title" content="${esc(o.social.title)}"><meta property="og:description" content="${esc(o.social.description)}"><meta property="og:image" content="${esc(o.social.image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(o.social.image)}">`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title>${social}${FONTS}${o.tour ? '<link rel="stylesheet" href="/web/tour.css">' : ""}<style>${CSS}${HUB_CSS}</style></head><body${phonePage ? ' class="phone-ready"' : ""}><div class="wrap">
<div class="top"><div><a href="/" style="text-decoration:none"><span class="name">Weigh</span></a> <span class="meta">evals you can watch</span></div><div class="meta mono">${esc((o.generatedAt ?? new Date().toISOString()).slice(0, 16).replace("T", " "))} UTC</div></div>
${crumbs}
${o.body}
<footer>Weigh, by Kyle Bartlett. Every number on this page maps to a stored trace line; the report and the summary come from the same code.</footer>
</div>${live}${o.tour ? '<script type="module" src="/web/tour.js"></script>' : ""}</body></html>`;
}

export const statusTag = (s: RunStatus) =>
  `<span class="status ${esc(s)}" data-status><i></i>${esc(s)}</span>`;

export const when = (iso?: string) =>
  iso ? esc(iso.slice(0, 16).replace("T", " ")) : "";
