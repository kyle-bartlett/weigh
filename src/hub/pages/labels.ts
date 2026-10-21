import { esc } from "../../report/html.ts";
import type { TraceLine } from "../../types.ts";
import type { Project, Run } from "../store.ts";
import { page } from "./layout.ts";

/**
 * Open coding in the browser. One case at a time, the candidate's output beside the baseline's,
 * the checks, a note. p and f label, n and b move, / focuses the note. Labels save to the hub
 * as they are given; the Judges section of the run page validates any judge check against them.
 */
export function labelsPage(
  project: Project,
  run: Run,
  lines: TraceLine[],
  inputs: Record<string, string>,
  labels: {
    case_id: string;
    variant: string;
    human: "pass" | "fail";
    note: string;
    split?: string;
  }[],
  opts: { generatedAt?: string } = {},
): string {
  const meta = run.meta;
  const href = `/r/${esc(run.suite)}/${esc(run.run_id)}`;
  const candidate = meta?.candidate ?? "";
  const baseline = meta?.baseline ?? "";
  const order = (meta?.case_order ?? []).filter((id) =>
    lines.some((l) => l.case_id === id && l.variant === candidate),
  );
  const data = {
    suite: run.suite,
    run_id: run.run_id,
    candidate,
    baseline,
    checks: meta?.checks.map((c) => c.id) ?? [],
    cases: order.map((id) => ({
      id,
      input: inputs[id] ?? "",
      lines: Object.fromEntries(
        lines
          .filter((l) => l.case_id === id)
          .map((l) => [
            l.variant,
            {
              ok: l.ok,
              error: l.error,
              checks: l.checks,
              unanswered: l.unanswered,
              extra: l.extra,
            },
          ]),
      ),
    })),
    labels: labels.filter((l) => l.variant === candidate),
    splits: ["train", "dev", "test"],
  };
  const done = order.filter((id) =>
    data.labels.some((l) => l.case_id === id),
  ).length;
  const body = `<h1 class="page display">Label ${esc(run.suite)} <span class="mono" style="font-size:.5em;color:var(--ink3)">${esc(run.run_id)}</span></h1>
<p class="lede">Labels go on the candidate (<b class="mono">${esc(candidate)}</b>). Press <b>p</b> to pass, <b>f</b> to fail, <b>n</b> for next, <b>b</b> for back, or <b>/</b> to write a note. Progress: <span data-progress class="mono">${done} of ${order.length}</span>. <a href="${href}">Back to the run</a>.</p>
<progress data-label-progress aria-label="Labels completed" aria-valuetext="${done} of ${order.length} labelled" value="${done}" max="${Math.max(1, order.length)}" style="display:block;width:100%;height:12px;margin-bottom:20px;accent-color:var(--live)"></progress>
<div data-labels-app>${order.length ? "" : '<p class="empty">No candidate outputs yet.</p>'}</div>
<script id="labels-data" type="application/json">${esc(JSON.stringify(data)).replace(/&quot;/g, '"')}</script>`;
  return page({
    title: `Label ${run.suite} ${run.run_id} · Weigh`,
    body,
    crumbs: [
      { href: "/", text: "projects" },
      { href: `/p/${esc(project.id)}`, text: project.name },
      { href, text: `${run.suite} / ${run.run_id}` },
      { href: "", text: "labels" },
    ],
    generatedAt: opts.generatedAt,
  }).replace(
    "</body>",
    '<script type="module" src="/web/labels.js"></script></body>',
  );
}
