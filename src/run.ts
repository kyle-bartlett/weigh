import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RunnerEvent } from "./events.ts";
import { textRuleMessage, textRuleReason } from "./suite-text.ts";
import type {
  Case,
  RunMeta,
  Suite,
  TraceLine,
  Variant,
  VariantOutput,
} from "./types.ts";

/**
 * The runner. Every (variant, case) result is cached under the run directory by a hash of the
 * variant name and the case input, so a crashed or interrupted run resumes without spending a
 * model call twice. One trace line per (case, variant) lands in traces.jsonl as it finishes.
 */

/** An event before the runner stamps seq and at. Distributes over the union so each variant keeps its own fields. */
type Unstamped<T> = T extends unknown ? Omit<T, "seq" | "at"> : never;

export const RUNS_DIR =
  process.env.WEIGH_RUNS ?? join(import.meta.dir, "..", "runs");

export const runDir = (suite: string, runId: string) =>
  join(RUNS_DIR, suite, runId);

export function newRunId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export const hash = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);

export interface RunOptions {
  runId?: string;
  /** Run only these variants (names). Default: all in the suite. */
  variants?: string[];
  /** Run only these case ids. */
  cases?: string[];
  concurrency?: number;
  command?: string;
  log?: (s: string) => void;
  /** Every runner event in order (run_start, job_start, job_done, run_done or run_cancelled, run_error). */
  onEvent?: (e: RunnerEvent) => void;
  /** Abort stops workers from taking another pair; the pair in flight finishes and is kept. */
  signal?: AbortSignal;
}

async function runChecks(suite: Suite, c: Case, o: VariantOutput) {
  const out: Record<string, boolean> = {};
  const unanswered: string[] = [];
  for (const ch of suite.checks) {
    if (ch.applies && !ch.applies(c)) continue;
    try {
      const r = await ch.test(c, o);
      if (r === null) unanswered.push(ch.id);
      else out[ch.id] = r;
    } catch {
      out[ch.id] = false;
    }
  }
  return {
    checks: out,
    unanswered: unanswered.length ? unanswered : undefined,
  };
}

async function runOne(
  suite: Suite,
  v: Variant,
  c: Case,
  dir: string,
  meta: RunMeta,
): Promise<TraceLine> {
  const key = hash({ variant: v.name, input: c.input });
  const outputsDir = join(dir, "outputs");
  const cachePath = join(outputsDir, `${v.name}--${c.id}--${key}.json`);
  let o: VariantOutput | undefined;
  let error: string | undefined;
  let cached = false;
  if (existsSync(cachePath)) {
    const saved = JSON.parse(readFileSync(cachePath, "utf8")) as {
      output?: VariantOutput;
      error?: string;
    };
    if (saved.output) {
      o = saved.output;
      cached = true;
    } else error = saved.error;
  }
  if (!o && !cached) {
    try {
      o = await v.run(c);
      writeFileSync(cachePath, JSON.stringify({ output: o }, null, 1));
    } catch (e) {
      error = String(e instanceof Error ? e.message : e).slice(0, 500);
      writeFileSync(cachePath, JSON.stringify({ error }, null, 1));
    }
  }
  const line: TraceLine = {
    run_id: meta.run_id,
    suite: suite.name,
    case_id: c.id,
    variant: v.name,
    at: new Date().toISOString(),
    ok: !!o,
    error,
    usage: o?.usage ?? {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
      calls: 0,
      metered: true,
      provider: "none",
    },
    ...(o ? await runChecks(suite, c, o) : { checks: {} }),
    extra: o?.extra,
    stages: o?.stages,
    output_hash: key,
    cached,
  };
  appendFileSync(join(dir, "traces.jsonl"), JSON.stringify(line) + "\n");
  return line;
}

/** Run the suite. Returns the run directory. Case order is preserved in run.json for paired statistics. */
export async function runSuite(suite: Suite, opts: RunOptions = {}) {
  const runId = opts.runId ?? newRunId();
  const dir = runDir(suite.name, runId);
  // Suites may fill skipped while building cases, so read it only after cases().
  const all = await suite.cases();
  const skipped = suite.skipped?.() ?? [];
  for (const entry of skipped) {
    const reason = textRuleReason(entry.reason);
    if (reason)
      throw new Error(
        textRuleMessage(
          `skipped case "${entry.id}" reason`,
          suite.name,
          reason,
        ),
      );
  }
  mkdirSync(join(dir, "outputs"), { recursive: true });
  const log = opts.log ?? ((s: string) => console.error(s));
  let seq = 0;
  const emit = (e: Unstamped<RunnerEvent>) =>
    opts.onEvent?.({
      ...e,
      seq: ++seq,
      at: new Date().toISOString(),
    } as RunnerEvent);
  const cases = opts.cases
    ? all.filter((c) => opts.cases!.includes(c.id))
    : all;
  const variants = opts.variants
    ? suite.variants.filter((v) => opts.variants!.includes(v.name))
    : suite.variants;
  const meta: RunMeta = {
    run_id: runId,
    suite: suite.name,
    description: suite.description,
    started_at: new Date().toISOString(),
    cases: cases.length,
    skipped,
    // Every suite variant is listed, even when --variants ran a subset: later runs with the same id fill the rest.
    variants: suite.variants.map((v) => ({
      name: v.name,
      description: v.description,
    })),
    checks: suite.checks.map((c) => ({
      id: c.id,
      description: c.description,
      kind: c.kind,
    })),
    baseline: suite.baseline,
    candidate: suite.candidate,
    gate: suite.gate,
    noise: suite.noise,
    moneyFields: suite.moneyFields,
    labels: suite.labels,
    command: opts.command ?? `bun src/cli.ts run suites/${suite.name}.ts`,
  };
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({ ...meta, case_order: all.map((c) => c.id) }, null, 1),
  );
  const inputText =
    suite.inputText ??
    ((c: Case) => JSON.stringify(c.input, null, 1).slice(0, 4000));
  writeFileSync(
    join(dir, "inputs.json"),
    JSON.stringify(Object.fromEntries(cases.map((c) => [c.id, inputText(c)]))),
  );
  // Existing trace lines from an earlier attempt of the same run id are kept; the cache makes reruns free.
  // A trace line whose cached output has been deleted is stale (someone threw the result out on
  // purpose) and is dropped here so the pair runs again instead of being counted as done.
  const kept = readTraces(dir).filter((l) => {
    const c = all.find((x) => x.id === l.case_id);
    return (
      !!c &&
      existsSync(
        join(
          dir,
          "outputs",
          `${l.variant}--${l.case_id}--${hash({ variant: l.variant, input: c.input })}.json`,
        ),
      )
    );
  });
  writeFileSync(
    join(dir, "traces.jsonl"),
    kept.map((l) => JSON.stringify(l) + "\n").join(""),
  );
  const done = new Set(kept.map((l) => `${l.variant}\u0000${l.case_id}`));
  const jobs: { v: Variant; c: Case }[] = [];
  for (const c of cases)
    for (const v of variants)
      if (!done.has(`${v.name}\u0000${c.id}`)) jobs.push({ v, c });
  const width = opts.concurrency ?? suite.concurrency ?? 2;
  const total = jobs.length;
  let finished = 0;
  emit({
    type: "run_start",
    run_id: runId,
    suite: suite.name,
    meta,
    case_order: all.map((c) => c.id),
    total,
    resumed: kept.length,
  });
  const worker = async () => {
    for (let j = jobs.shift(); j && !opts.signal?.aborted; j = jobs.shift()) {
      emit({ type: "job_start", variant: j.v.name, case_id: j.c.id });
      const line = await runOne(suite, j.v, j.c, dir, meta);
      finished++;
      emit({ type: "job_done", line, finished, total });
      log(
        `${String(finished).padStart(3)}/${jobs.length + finished} ${j.v.name.padEnd(12)} ${j.c.id.padEnd(14)} ${line.ok ? "ok " : "ERR"} ${Object.values(line.checks).filter((x) => !x).length} failing  ${line.usage.inputTokens + line.usage.cacheReadTokens + line.usage.cacheCreationTokens} prompt tok${line.cached ? "  (cached)" : ""}`,
      );
    }
  };
  try {
    await Promise.all(Array.from({ length: width }, worker));
  } catch (e) {
    emit({
      type: "run_error",
      error: String(e instanceof Error ? e.message : e).slice(0, 500),
    });
    throw e;
  }
  if (opts.signal?.aborted && finished < total) {
    meta.cancelled_at = new Date().toISOString();
    emit({ type: "run_cancelled", finished, total });
  } else {
    meta.finished_at = new Date().toISOString();
    emit({ type: "run_done", finished_at: meta.finished_at });
  }
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({ ...meta, case_order: all.map((c) => c.id) }, null, 1),
  );
  return dir;
}

/**
 * Re-run the suite's checks over a run's cached outputs and rewrite the trace lines. No model call is
 * repeated, so a check can be fixed or added after the fact and the whole run re-scored for free.
 * run.json is refreshed from the suite (checks, variants, gate, baseline, candidate) and stamped.
 */
export async function rescore(suite: Suite, dir: string) {
  const cases = new Map((await suite.cases()).map((c) => [c.id, c]));
  const lines = readTraces(dir);
  let changed = 0;
  let scored = 0;
  for (const l of lines) {
    const c = cases.get(l.case_id);
    const o = l.ok ? readOutput(dir, l) : undefined;
    if (!c || !o) continue;
    const { checks, unanswered } = await runChecks(suite, c, o);
    if (JSON.stringify(checks) !== JSON.stringify(l.checks)) changed++;
    l.checks = checks;
    l.unanswered = unanswered;
    scored++;
  }
  writeFileSync(
    join(dir, "traces.jsonl"),
    lines.map((l) => JSON.stringify(l) + "\n").join(""),
  );
  const meta = readMeta(dir);
  meta.checks = suite.checks.map((c) => ({
    id: c.id,
    description: c.description,
    kind: c.kind,
  }));
  meta.variants = suite.variants.map((v) => ({
    name: v.name,
    description: v.description,
  }));
  meta.baseline = suite.baseline;
  meta.candidate = suite.candidate;
  meta.gate = suite.gate;
  meta.noise = suite.noise;
  meta.moneyFields = suite.moneyFields;
  meta.labels = suite.labels;
  meta.rescored_at = new Date().toISOString();
  writeFileSync(join(dir, "run.json"), JSON.stringify(meta, null, 1));
  return { lines: lines.length, scored, changed };
}

export function readTraces(dir: string): TraceLine[] {
  const p = join(dir, "traces.jsonl");
  if (!existsSync(p)) return [];
  const out: TraceLine[] = [];
  for (const l of readFileSync(p, "utf8").split("\n"))
    if (l.trim()) out.push(JSON.parse(l));
  return out;
}

export function readMeta(dir: string): RunMeta & { case_order: string[] } {
  return JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
}

export function readOutput(
  dir: string,
  line: TraceLine,
): VariantOutput | undefined {
  const p = join(
    dir,
    "outputs",
    `${line.variant}--${line.case_id}--${line.output_hash}.json`,
  );
  if (!existsSync(p)) return undefined;
  return (JSON.parse(readFileSync(p, "utf8")) as { output?: VariantOutput })
    .output;
}

/** Latest run directory for a suite, or the one named. */
export function resolveRun(suite: string, runId?: string) {
  if (runId) return runDir(suite, runId);
  const base = join(RUNS_DIR, suite);
  if (!existsSync(base)) throw new Error(`no runs for ${suite}`);
  const ids = readdirSync(base)
    .filter((d) => existsSync(join(base, d, "run.json")))
    .sort();
  if (!ids.length) throw new Error(`no runs for ${suite}`);
  return join(base, ids.at(-1)!);
}
