import type { Built } from "../../report/build.ts";
import {
  caseLedger,
  checksSection,
  esc,
  headline,
  judgeSection,
  lede,
  methodSection,
  proofStrip,
  tokensSection,
  transitionsSection,
  verdictBand,
} from "../../report/html.ts";
import type { Project, Run } from "../store.ts";
import { TERMINAL } from "../store.ts";
import { page, statusTag, when } from "./layout.ts";

/**
 * The run page is the report, rearranged for a page that may still be filling in: status and
 * progress first, then the verdict, proof strip, checks, ledger and the rest. Every section that
 * the live module patches carries a data-section attribute.
 */
export function runPage(
  project: Project,
  run: Run,
  built: Built | undefined,
  opts: {
    pick?: { baseline?: string; candidate?: string };
    generatedAt?: string;
  } = {},
): string {
  const live = !TERMINAL.has(run.status);
  const href = `/r/${esc(run.suite)}/${esc(run.run_id)}`;
  const meta = run.meta;
  const picker =
    meta && meta.variants.length > 2
      ? `<form class="inline" method="get" style="margin:0 0 18px"><label>baseline <select name="baseline" class="txt" style="min-width:0">${meta.variants.map((v) => `<option ${v.name === (opts.pick?.baseline ?? meta.baseline) ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label><label>candidate <select name="candidate" class="txt" style="min-width:0">${meta.variants.map((v) => `<option ${v.name === (opts.pick?.candidate ?? meta.candidate) ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label><button class="btn" type="submit">Compare</button></form>`
      : "";
  const progress = `<div class="row" style="display:flex;justify-content:space-between;gap:12px;align-items:center;font-size:14px;color:var(--ink2);margin:18px 0 0">${statusTag(run.status)}<span class="mono" data-progress>${run.total ? `${run.finished} of ${run.total} pairs` : run.status === "queued" ? "waiting for the agent" : ""}</span><span class="mono">${run.started_at ? `started ${when(run.started_at)}` : `requested ${when(run.requested_at)}`}${run.finished_at ? ` · ended ${when(run.finished_at)}` : ""}</span></div>
<div class="progress"><i data-progress-bar style="width:${run.total ? Math.round((100 * run.finished) / run.total) : 0}%"></i></div>`;
  const body = built
    ? `<h1 class="page display" data-section="headline">${headline(built)}</h1>
<p class="lede" data-section="lede">${lede(built)}</p>
${progress}
${picker}
<div data-section="verdict">${verdictBand(built)}</div>
<div data-section="proof">${proofStrip(built)}</div>
<div data-section="checks">${checksSection(built)}</div>
${tokensSection(built)}
<div data-section="ledger">${caseLedger(built, (id) => `${href}/c/${encodeURIComponent(id)}`)}</div>
${judgeSection(built)}
${transitionsSection(built)}
${methodSection(built)}
<p class="notes" style="margin-top:24px"><a href="${href}/report.html">Static report</a> · <a href="${href}/summary.md">Summary (Markdown)</a> · <a href="${href}/traces.jsonl">Trace lines</a></p>`
    : `<h1 class="page display" data-section="headline">${esc(run.suite)} <span class="mono" style="font-size:.5em;color:var(--ink3)">${esc(run.run_id)}</span></h1>
<p class="lede" data-section="lede">${meta ? esc(meta.description) : "The agent has not picked this run up yet. This page fills in on its own once it does."}</p>
${progress}
<div data-section="verdict"></div><div data-section="proof"></div><div data-section="checks"></div><div data-section="ledger"><p class="empty">No finished pair yet.</p></div>`;
  return page({
    title: `${run.suite} ${run.run_id} · Weigh`,
    body,
    crumbs: [
      { href: "/", text: "projects" },
      { href: `/p/${esc(project.id)}`, text: project.name },
      { href: "", text: `${run.suite} / ${run.run_id}` },
    ],
    live: live ? { key: run.key, since: run.last_seq } : undefined,
    generatedAt: opts.generatedAt,
  });
}
