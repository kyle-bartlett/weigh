import type { Stage, TraceLine } from "./types.ts";

/**
 * Transition failure matrix: rows are the last stage that succeeded, columns the first that failed.
 * Reading the matrix tells you where in a pipeline to look first, before any judge is built.
 */

export interface TransitionRow {
  trace_id: string;
  last_success: string;
  first_failure: string | null;
}

export function fromStages(traceId: string, stages: Stage[]): TransitionRow {
  let last = "start";
  for (const s of stages) {
    if (!s.ok)
      return { trace_id: traceId, last_success: last, first_failure: s.name };
    last = s.name;
  }
  return { trace_id: traceId, last_success: last, first_failure: null };
}

export function fromTraces(
  lines: TraceLine[],
  variant: string,
): TransitionRow[] {
  return lines
    .filter((l) => l.variant === variant && l.stages?.length)
    .map((l) => fromStages(`${l.variant}:${l.case_id}`, l.stages!));
}

export interface Matrix {
  from: string[];
  to: string[];
  counts: Map<string, number>;
  failures: number;
  total: number;
}

export function matrix(rows: TransitionRow[]): Matrix {
  const counts = new Map<string, number>();
  const from: string[] = [];
  const to: string[] = [];
  let failures = 0;
  for (const r of rows) {
    if (!r.first_failure) continue;
    failures++;
    if (!from.includes(r.last_success)) from.push(r.last_success);
    if (!to.includes(r.first_failure)) to.push(r.first_failure);
    const key = `${r.last_success}\u0000${r.first_failure}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { from, to, counts, failures, total: rows.length };
}

export const cell = (m: Matrix, from: string, to: string) =>
  m.counts.get(`${from}\u0000${to}`) ?? 0;

export function toMarkdown(m: Matrix) {
  if (!m.failures) return `No failed stages in ${m.total} traces.`;
  const head = `| last success \\ first failure | ${m.to.join(" | ")} |`;
  const sep = `|---|${m.to.map(() => "---").join("|")}|`;
  const body = m.from.map(
    (f) => `| ${f} | ${m.to.map((t) => cell(m, f, t) || "").join(" | ")} |`,
  );
  return [
    head,
    sep,
    ...body,
    "",
    `${m.failures} of ${m.total} traces failed a stage.`,
  ].join("\n");
}
