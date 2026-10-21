import { esc } from "../../report/html.ts";
import type { Project, Run } from "../store.ts";
import {
  promptTokens,
  type TraceLine,
  type VariantOutput,
} from "../../types.ts";
import { page, when } from "./layout.ts";
import { productDecisionValue, version } from "./run-sections.ts";

type FieldValue = string | number | null;
type Field = { field: string; expected: FieldValue; got: FieldValue };
type StoredOutputs = Map<
  string,
  { output?: VariantOutput; truncated: boolean } | undefined
>;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fieldValue = (value: unknown): value is FieldValue =>
  value === null ||
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value));

function answer(output: unknown) {
  const fields = new Map<string, Field>();
  let unavailable =
    !record(output) || !Array.isArray(output.fields) || !output.fields.length;
  if (record(output) && Array.isArray(output.fields)) {
    for (const field of output.fields) {
      if (
        record(field) &&
        typeof field.field === "string" &&
        field.field &&
        fieldValue(field.expected) &&
        fieldValue(field.got)
      ) {
        fields.set(field.field, {
          field: field.field,
          expected: field.expected,
          got: field.got,
        });
      } else unavailable = true;
    }
  }
  const decision =
    record(output) &&
    fieldValue(output.decision) &&
    fieldValue(output.expectedDecision)
      ? {
          field: "Decision",
          expected: output.expectedDecision,
          got: output.decision,
        }
      : undefined;
  return { fields, decision, unavailable };
}

function fieldTable(run: Run, outputs: StoredOutputs): string {
  const current = run.meta?.baseline;
  const next = run.meta?.candidate;
  const before = answer(
    current ? outputs.get(current)?.output?.output : undefined,
  );
  const after = answer(next ? outputs.get(next)?.output?.output : undefined);
  const value = (v: FieldValue, decision: boolean) =>
    v === null ? "Not provided" : decision ? productDecisionValue(v) : esc(v);
  const row = (name: string, a?: Field, b?: Field, decision = false) => {
    const cell = (field?: Field) =>
      !field
        ? "<td>No stored answer for this field.</td>"
        : `<td${field.got !== field.expected ? ' class="field-difference"' : ""}>${value(field.got, decision)}, ${field.got === field.expected ? "matches" : "differs from"} the expert</td>`;
    const expected =
      a && b && a.expected !== b.expected
        ? `Current prompt: ${value(a.expected, decision)}<br>New prompt: ${value(b.expected, decision)}<br>Stored expert answers differ.`
        : value((a ?? b)!.expected, decision);
    const differs = a && b && a.got !== b.got;
    return `<tr${differs ? ' data-different="true"' : ""}><th scope="row">${esc(name)}${differs ? '<span class="case-decision">Versions disagree</span>' : ""}</th><td>${expected}</td>${cell(a)}${cell(b)}</tr>`;
  };
  const rows =
    [...new Set([...before.fields.keys(), ...after.fields.keys()])]
      .map((name) =>
        row(
          name.replace(/_/g, " "),
          before.fields.get(name),
          after.fields.get(name),
        ),
      )
      .join("") +
    (before.decision || after.decision
      ? row("Decision", before.decision, after.decision, true)
      : "");
  const notice =
    before.unavailable || after.unavailable
      ? '<p class="notes">Some field answers aren\'t available for this comparison. Open For engineers for the stored records.</p>'
      : "";
  return `${notice}${rows ? `<div class="table-scroll" role="region" aria-label="Field comparison" tabindex="0"><table class="field-table"><thead><tr><th scope="col">Field</th><th scope="col">Expected</th><th scope="col">${version(current ?? "pending", "Current prompt")}</th><th scope="col">${version(next ?? "pending", "New prompt")}</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}`;
}

/** One case through every variant: the input the model saw, each output, its checks, usage and stages. */
export function casePage(
  project: Project,
  run: Run,
  caseId: string,
  input: string | undefined,
  lines: TraceLine[],
  outputs: StoredOutputs,
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
${body}
<details><summary>Trace line (JSON)</summary><pre class="out">${esc(JSON.stringify(l, null, 2))}</pre></details>
${o?.output !== undefined ? `<details><summary>Full output record (JSON)</summary><pre class="out">${esc(JSON.stringify(o.output, null, 2))}</pre></details>` : ""}</div>`;
  };
  const untraced = [...outputs]
    .filter(([name]) => !lines.some((l) => l.variant === name))
    .map(
      ([name, o]) =>
        `<div><h3 class="mono">${esc(name)}</h3><p>No trace line stored.</p><pre class="out">${esc(JSON.stringify(o?.output, null, 2) ?? "Output not archived for this run.")}</pre>${o?.truncated ? '<p class="notes">Output truncated at 256 KB when stored.</p>' : ""}</div>`,
    )
    .join("");
  const body = `<main class="case-page"><h1 class="page display mono">${esc(caseId)}</h1>
<p class="lede">${esc(run.suite)} · run <a href="${href}" class="mono">${esc(run.run_id)}</a></p>
<section style="padding-top:0;border-top:0"><div class="sec-head"><h2 class="display">What the broker wrote</h2><p>What every version was given, as the suite chose to show it.</p></div>
${input ? `<pre class="out">${esc(input)}</pre>` : '<p class="empty">No input text stored.</p>'}</section>
<section><div class="sec-head"><h2 class="display">What each version answered</h2><p>Compare each answer with the expert's answer. Highlighted cells differ from the expert; marked rows show where the versions disagree.</p></div>
${fieldTable(run, outputs)}</section>
<details id="engineers"><summary>For engineers</summary><p>Checks are the suite's binary checks on each output; a judge that gave no verdict is unanswered and not counted.</p><div class="case-records">${lines.map(col).join("")}${untraced}</div></details></main>`;
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
    runScript: {
      key: run.key,
      since: run.last_seq,
      live: false,
      finished: run.finished,
      total: run.total,
    },
  });
}
