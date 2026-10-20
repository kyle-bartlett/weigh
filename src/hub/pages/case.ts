import { esc } from "../../report/html.ts";
import type { Project, Run } from "../store.ts";
import {
  promptTokens,
  type TraceLine,
  type VariantOutput,
} from "../../types.ts";
import { page, when } from "./layout.ts";

/** One case through every variant: the input the model saw, each output, its checks, usage and stages. */
export function casePage(
  project: Project,
  run: Run,
  caseId: string,
  input: string | undefined,
  lines: TraceLine[],
  outputs: Map<
    string,
    { output?: VariantOutput; truncated: boolean } | undefined
  >,
  opts: { generatedAt?: string } = {},
): string {
  const href = `/r/${esc(run.suite)}/${esc(run.run_id)}`;
  const checkIds = run.meta?.checks.map((c) => c.id) ?? [];
  const col = (l: TraceLine) => {
    const o = outputs.get(l.variant);
    const checks = checkIds
      .map((k) => {
        const v = l.checks[k];
        const state =
          v === undefined
            ? l.unanswered?.includes(k)
              ? "unanswered"
              : "not applicable"
            : v
              ? "pass"
              : "fail";
        return `<tr><td class="mono">${esc(k)}</td><td><span class="tag ${state === "pass" ? "green" : state === "fail" ? "amber" : ""}">${state}</span></td></tr>`;
      })
      .join("");
    const stages = l.stages?.length
      ? `<dt>stages</dt><dd>${l.stages.map((s) => `<span class="tag ${s.ok ? "green" : "amber"}" title="${esc(s.detail ?? "")}">${esc(s.name)}</span>`).join(" ")}</dd>`
      : "";
    const extra = l.extra
      ? Object.entries(l.extra)
          .map(
            ([k, v]) =>
              `<dt>${esc(k)}</dt><dd class="mono">${esc(typeof v === "object" ? JSON.stringify(v) : String(v))}</dd>`,
          )
          .join("")
      : "";
    const body = o?.output
      ? `<pre class="out">${esc(typeof o.output.output === "string" ? o.output.output : JSON.stringify(o.output.output, null, 1))}</pre>${o.truncated ? '<p class="notes">Output truncated at 256 KB when stored.</p>' : ""}`
      : l.ok
        ? '<p class="notes">Output not archived for this run.</p>'
        : `<pre class="out">${esc(l.error ?? "error")}</pre>`;
    return `<div><h3 class="mono">${esc(l.variant)}</h3>
<dl class="kv"><dt>result</dt><dd>${l.ok ? "ok" : '<span class="tag amber">error</span>'}${l.cached ? ' <span class="tag">cached</span>' : ""}</dd>
<dt>prompt tokens</dt><dd class="mono">${promptTokens(l.usage).toLocaleString("en-US")}</dd>
<dt>output tokens</dt><dd class="mono">${l.usage.outputTokens.toLocaleString("en-US")}</dd>
<dt>cost</dt><dd class="mono">$${l.usage.costUsd.toFixed(4)}${l.usage.metered ? "" : " (estimate)"}</dd>
<dt>latency</dt><dd class="mono">${Math.round(l.usage.latencyMs).toLocaleString("en-US")} ms · ${l.usage.calls} call${l.usage.calls === 1 ? "" : "s"}</dd>
<dt>at</dt><dd class="mono">${when(l.at)}</dd>${stages}${extra}</dl>
<table style="margin:14px 0"><thead><tr><th>check</th><th>verdict</th></tr></thead><tbody>${checks}</tbody></table>
${body}</div>`;
  };
  const body = `<h1 class="page display mono">${esc(caseId)}</h1>
<p class="lede">${esc(run.suite)} · run <a href="${href}" class="mono">${esc(run.run_id)}</a></p>
<section style="padding-top:0;border-top:0"><div class="sec-head"><h2 class="display">Input</h2><p>What every variant was given, as the suite chose to show it.</p></div>
${input ? `<pre class="out">${esc(input)}</pre>` : '<p class="empty">No input text stored.</p>'}</section>
<section><div class="sec-head"><h2 class="display">Outputs</h2><p>One column per variant. Checks are the suite's binary checks on this output; a judge that gave no verdict is unanswered and not counted.</p></div>
<div class="two" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">${lines.map(col).join("")}</div></section>`;
  return page({
    title: `${caseId} · ${run.suite} · Weigh`,
    body,
    crumbs: [
      { href: "/", text: "projects" },
      { href: `/p/${esc(project.id)}`, text: project.name },
      { href, text: `${run.suite} / ${run.run_id}` },
      { href: "", text: caseId },
    ],
    generatedAt: opts.generatedAt,
  });
}
