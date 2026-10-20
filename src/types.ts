/**
 * Weigh's shapes. A suite names its cases, two or more variants that turn a case into an output,
 * and binary checks over (case, output). Everything else is derived from trace lines.
 */

/** What one model call (or a whole variant run) consumed. `metered` is false when the numbers are estimates. */
export interface Usage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  calls: number;
  metered: boolean;
  provider: string;
}

export const emptyUsage = (provider = "none"): Usage => ({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  latencyMs: 0,
  calls: 0,
  metered: true,
  provider,
});

/** Sum usages. The sum is metered only when every part was. */
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
    latencyMs: a.latencyMs + b.latencyMs,
    calls: a.calls + b.calls,
    metered: a.metered && b.metered,
    provider:
      a.provider === b.provider || a.calls === 0
        ? b.provider
        : `${a.provider}+${b.provider}`,
  };
}

/** Prompt tokens a model actually read: fresh plus cached. Cached tokens are cheaper, not free. */
export const promptTokens = (u: Usage) =>
  u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;

export interface Case {
  id: string;
  input: unknown;
  reference?: unknown;
  tags?: string[];
}

/** A pipeline stage inside one variant run, for the transition failure matrix. */
export interface Stage {
  name: string;
  ok: boolean;
  detail?: unknown;
}

export interface VariantOutput {
  output: unknown;
  usage: Usage;
  /** Anything the report should show per case beyond the output (chunks kept, chars before and after). */
  extra?: Record<string, number | string | boolean | null>;
  stages?: Stage[];
}

export interface Variant {
  name: string;
  description: string;
  run: (c: Case) => Promise<VariantOutput>;
}

export interface Check {
  id: string;
  description: string;
  /** code: a deterministic assertion. judge: a classifier whose verdicts must be validated against human labels. */
  kind: "code" | "judge";
  /** true passes, false fails. null means the check could not be evaluated for this case (a judge did not
   *  answer); the case is left out of the check's rate and named in the trace line's `unanswered`, so a
   *  silent judge is never scored as a failure. */
  test: (c: Case, o: VariantOutput) => boolean | null | Promise<boolean | null>;
  /** When given and false for a case, the check is not run there and the case is left out of its rate. */
  applies?: (c: Case) => boolean;
}

export interface Gate {
  /** Candidate pass-all rate must be at least baseline pass-all minus this (0 = no regression). */
  maxPassAllDrop?: number;
  /** Checks whose rate may not be lower on the candidate than on the baseline. */
  noRegressionOn?: string[];
}

export interface Suite {
  name: string;
  description: string;
  cases: () => Promise<Case[]>;
  variants: Variant[];
  checks: Check[];
  baseline: string;
  candidate: string;
  gate?: Gate;
  /** A variant that is the baseline run again. Its distance from the baseline is the noise floor the report shows next to the candidate's change. */
  noise?: string;
  /** Parallel variant runs. Default 2. */
  concurrency?: number;
  /** Short text of a case for the review page. Default: the input as JSON, trimmed to 4,000 characters. */
  inputText?: (c: Case) => string;
  /** Cases the suite could not build (no captions, fetch failed), read after cases() and listed in the report. */
  skipped?: () => { id: string; reason: string }[];
}

/** One line in traces.jsonl: one case through one variant. Full output lives in outputs/<hash>.json. */
export interface TraceLine {
  run_id: string;
  suite: string;
  case_id: string;
  variant: string;
  at: string;
  ok: boolean;
  error?: string;
  usage: Usage;
  checks: Record<string, boolean>;
  /** Checks that could not be evaluated for this case (a judge gave no verdict). Not counted either way. */
  unanswered?: string[];
  extra?: VariantOutput["extra"];
  stages?: Stage[];
  output_hash: string;
  cached?: boolean;
}

export interface RunMeta {
  run_id: string;
  suite: string;
  description: string;
  started_at: string;
  finished_at?: string;
  /** Set when checks were re-run over cached outputs after the run. */
  rescored_at?: string;
  cases: number;
  skipped: { id: string; reason: string }[];
  variants: { name: string; description: string }[];
  checks: { id: string; description: string; kind: Check["kind"] }[];
  baseline: string;
  candidate: string;
  gate?: Gate;
  noise?: string;
  command: string;
}
