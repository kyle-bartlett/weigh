import type { Built } from "../../report/build.ts";
import { esc } from "../../report/html.ts";
import type { Project, Run } from "../store.ts";
import { TERMINAL } from "../store.ts";
import { page, statusTag, when } from "./layout.ts";
import { runFragments } from "./run-sections.ts";

/** The page and live endpoint share these fragments, including unfinished verdicts. */
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
  const meta = run.meta;
  const picker =
    meta && meta.variants.length > 2
      ? `<form class="inline comparison-picker" method="get"><label>Current prompt <select name="baseline" class="txt">${meta.variants.map((v) => `<option ${v.name === (opts.pick?.baseline ?? meta.baseline) ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label><label>New prompt <select name="candidate" class="txt">${meta.variants.map((v) => `<option ${v.name === (opts.pick?.candidate ?? meta.candidate) ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label><button class="btn" type="submit">Compare</button></form>`
      : "";
  const progress = `<div class="run-progress">${statusTag(run.status)}<span data-progress role="status">${run.total ? (live ? (run.finished < run.total ? `Grading case ${run.finished + 1} of ${run.total}` : `Graded ${run.finished} of ${run.total} cases. Finishing the comparison.`) : `Graded ${run.finished} of ${run.total} cases.`) : "waiting for the agent"}</span><span class="mono">${run.started_at ? `started ${when(run.started_at)}` : `requested ${when(run.requested_at)}`}${run.finished_at ? ` · ended ${when(run.finished_at)}` : ""}</span></div>
<div class="progress"><i data-progress-bar style="transform:scaleX(${run.total ? Math.min(1, Math.max(0, run.finished / run.total)) : 0})"></i></div>
<p class="noise-note">Progress counts each case once for each prompt being graded.</p>`;
  const f = runFragments(run, built);
  const body = `<main class="run-page">
<div data-section="verdict">${f.verdict}</div>
${progress}${picker}
<div data-section="changed">${f.changed}</div>
<div data-section="checks">${f.checks}</div>
<div data-section="ledger">${f.ledger}</div>
<div data-section="cost">${f.cost}</div>
<details id="engineers"><summary>For engineers</summary><div data-section="engineers">${f.engineers}</div></details>
</main>`;
  return page({
    title: `${run.suite} ${run.run_id} · Weigh`,
    body,
    crumbs: [
      { href: "/", text: "projects" },
      { href: `/p/${project.id}`, text: project.name },
      { href: "", text: `${run.suite} / ${run.run_id}` },
    ],
    runScript: {
      key: run.key,
      since: run.last_seq,
      live,
      finished: run.finished,
      total: run.total,
    },
    generatedAt: opts.generatedAt,
  });
}
