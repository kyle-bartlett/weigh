import { CSS, esc, FONTS } from "../../report/html.ts";
import type { RunStatus } from "../../events.ts";

/**
 * Every hub page shares the report's fonts, tokens and CSS, plus a small set of hub-only rules for
 * navigation, status tags and the live cells. Rendered server side; the only script is the live
 * run module, included when a page asks for it.
 */

export const HUB_CSS = `
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
.progress i{display:block;height:100%;background:var(--live);transition:width .3s}
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
input.txt{font:inherit;font-size:14px;padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--ink);min-width:220px}
`;

export interface PageOpts {
  title: string;
  body: string;
  crumbs?: { href: string; text: string }[];
  /** Loads web/run.js with the run key, for a page that should fill in live. */
  live?: { key: string; since: number };
  generatedAt?: string;
}

export function page(o: PageOpts): string {
  const crumbs = o.crumbs?.length
    ? `<nav class="crumbs">${o.crumbs.map((c) => (c.href ? `<a href="${esc(c.href)}">${esc(c.text)}</a>` : `<span>${esc(c.text)}</span>`)).join('<span aria-hidden="true">/</span>')}</nav>`
    : "";
  const live = o.live
    ? `<script type="module" src="/web/run.js" data-run="${esc(o.live.key)}" data-since="${o.live.since}"></script>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title>${FONTS}<style>${CSS}${HUB_CSS}</style></head><body><div class="wrap">
<div class="top"><div><a href="/" style="text-decoration:none"><span class="name">Weigh</span></a> <span class="meta">evals you can watch</span></div><div class="meta mono">${esc((o.generatedAt ?? new Date().toISOString()).slice(0, 16).replace("T", " "))} UTC</div></div>
${crumbs}
${o.body}
<footer>Weigh, by Kyle Bartlett. Every number on this page maps to a stored trace line; the report and the summary come from the same code.</footer>
</div>${live}</body></html>`;
}

export const statusTag = (s: RunStatus) =>
  `<span class="status ${esc(s)}" data-status><i></i>${esc(s)}</span>`;

export const when = (iso?: string) =>
  iso ? esc(iso.slice(0, 16).replace("T", " ")) : "";
