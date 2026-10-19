import { promptTokens, type TraceLine } from "./types.ts";

/**
 * Counts and intervals, no p-values. Rates get Wilson intervals; paired differences get a seeded
 * bootstrap interval on the mean so two runs of the report agree to the digit.
 */

export interface Interval {
  lo: number;
  hi: number;
}

/** Wilson score interval for a proportion, 95%. Handles n = 0 by returning [0, 1]. */
export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** Deterministic PRNG (mulberry32) so bootstrap intervals are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
export function median(xs: number[]) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Percentile bootstrap interval on the mean of paired differences. */
export function bootstrapMean(
  diffs: number[],
  resamples = 2000,
  seed = 20261019,
): Interval {
  if (diffs.length < 2) return { lo: NaN, hi: NaN };
  const next = rng(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < diffs.length; i++)
      s += diffs[Math.floor(next() * diffs.length)]!;
    means.push(s / diffs.length);
  }
  means.sort((a, b) => a - b);
  return {
    lo: means[Math.floor(resamples * 0.025)]!,
    hi: means[Math.min(resamples - 1, Math.ceil(resamples * 0.975))]!,
  };
}

export interface Paired {
  n: number;
  baselineMean: number;
  candidateMean: number;
  meanDelta: number;
  medianDelta: number;
  /** candidate over baseline, as a fraction of the baseline mean: -0.42 means 42% less. */
  pctChange: number;
  ci: Interval;
}

export function paired(baseline: number[], candidate: number[]): Paired {
  const n = Math.min(baseline.length, candidate.length);
  const diffs = Array.from(
    { length: n },
    (_, i) => candidate[i]! - baseline[i]!,
  );
  const b = mean(baseline.slice(0, n));
  return {
    n,
    baselineMean: b,
    candidateMean: mean(candidate.slice(0, n)),
    meanDelta: mean(diffs),
    medianDelta: median(diffs),
    pctChange: b ? mean(diffs) / b : NaN,
    ci: bootstrapMean(diffs),
  };
}

export interface CheckRate {
  id: string;
  passed: number;
  n: number;
  rate: number;
  ci: Interval;
}

export interface VariantSummary {
  variant: string;
  n: number;
  errors: number;
  passAll: CheckRate;
  checks: CheckRate[];
  usage: {
    promptTokens: number[];
    outputTokens: number[];
    costUsd: number[];
    latencyMs: number[];
    metered: boolean;
    providers: string[];
  };
}

function rate(id: string, passed: number, n: number): CheckRate {
  return { id, passed, n, rate: n ? passed / n : NaN, ci: wilson(passed, n) };
}

/** Per-variant roll-up over the trace lines of one run. Cases are ordered by `caseOrder` so paired stats line up. */
export function summarize(
  lines: TraceLine[],
  variant: string,
  checkIds: string[],
  caseOrder: string[],
): VariantSummary {
  const byCase = new Map(
    lines.filter((l) => l.variant === variant).map((l) => [l.case_id, l]),
  );
  const rows = caseOrder
    .map((id) => byCase.get(id))
    .filter((l): l is TraceLine => !!l);
  // A check absent from a line did not apply to that case; pass-all is over the checks that did.
  const passAll = rows.filter(
    (l) => l.ok && checkIds.every((c) => l.checks[c] !== false),
  ).length;
  return {
    variant,
    n: rows.length,
    errors: rows.filter((l) => !l.ok).length,
    passAll: rate("pass_all", passAll, rows.length),
    checks: checkIds.map((c) => {
      const applicable = rows.filter((l) => !l.ok || l.checks[c] !== undefined);
      return rate(
        c,
        applicable.filter((l) => l.ok && l.checks[c] === true).length,
        applicable.length,
      );
    }),
    usage: {
      promptTokens: rows.map((l) => promptTokens(l.usage)),
      outputTokens: rows.map((l) => l.usage.outputTokens),
      costUsd: rows.map((l) => l.usage.costUsd),
      latencyMs: rows.map((l) => l.usage.latencyMs),
      metered: rows.every((l) => l.usage.metered),
      providers: [...new Set(rows.map((l) => l.usage.provider))],
    },
  };
}

export interface Comparison {
  baseline: VariantSummary;
  candidate: VariantSummary;
  passAllDelta: Paired;
  promptTokens: Paired;
  outputTokens: Paired;
  costUsd: Paired;
  latencyMs: Paired;
  checks: {
    id: string;
    baseline: CheckRate;
    candidate: CheckRate;
    delta: number;
    saturated: boolean;
  }[];
  /** Cases the baseline passed on a check and the candidate failed: the regressions a reviewer reads first. */
  regressions: { case_id: string; check: string }[];
}

/** Cases both variants completed, in suite order, so every paired number has the same n. */
export function pairedCases(
  lines: TraceLine[],
  baseline: string,
  candidate: string,
  caseOrder: string[],
): string[] {
  const has = (v: string) =>
    new Set(lines.filter((l) => l.variant === v).map((l) => l.case_id));
  const b = has(baseline),
    c = has(candidate);
  return caseOrder.filter((id) => b.has(id) && c.has(id));
}

export function compare(
  lines: TraceLine[],
  baseline: string,
  candidate: string,
  checkIds: string[],
  caseOrder: string[],
): Comparison {
  const order = pairedCases(lines, baseline, candidate, caseOrder);
  const b = summarize(lines, baseline, checkIds, order);
  const c = summarize(lines, candidate, checkIds, order);
  const passVec = (s: VariantSummary, v: string) => {
    const byCase = new Map(
      lines.filter((l) => l.variant === v).map((l) => [l.case_id, l]),
    );
    return order.map((id) => {
      const l = byCase.get(id)!;
      return l.ok && checkIds.every((k) => l.checks[k] !== false) ? 1 : 0;
    });
  };
  const bl = new Map(
    lines.filter((l) => l.variant === baseline).map((l) => [l.case_id, l]),
  );
  const cl = new Map(
    lines.filter((l) => l.variant === candidate).map((l) => [l.case_id, l]),
  );
  const regressions: Comparison["regressions"] = [];
  for (const id of order)
    for (const k of checkIds) {
      const bb = bl.get(id)!,
        cc = cl.get(id)!;
      if (bb.ok && bb.checks[k] === true && (!cc.ok || cc.checks[k] === false))
        regressions.push({ case_id: id, check: k });
    }
  return {
    baseline: b,
    candidate: c,
    passAllDelta: paired(passVec(b, baseline), passVec(c, candidate)),
    promptTokens: paired(b.usage.promptTokens, c.usage.promptTokens),
    outputTokens: paired(b.usage.outputTokens, c.usage.outputTokens),
    costUsd: paired(b.usage.costUsd, c.usage.costUsd),
    latencyMs: paired(b.usage.latencyMs, c.usage.latencyMs),
    checks: checkIds.map((id, i) => {
      const bc = b.checks[i]!,
        cc = c.checks[i]!;
      return {
        id,
        baseline: bc,
        candidate: cc,
        delta: cc.rate - bc.rate,
        saturated: bc.n > 0 && bc.rate === 1 && cc.rate === 1,
      };
    }),
    regressions,
  };
}

export interface GateResult {
  pass: boolean;
  reasons: string[];
}

/** The gate rule, spelled out so the report can quote it. */
/**
 * The noise floor: how far the baseline moved against itself. A candidate drop no larger than this on
 * pass-all and on every guarded check is not evidence of a regression, whatever the gate says.
 */
export interface NoiseFloor {
  variant: string;
  passAllDrop: number;
  candidatePassAllDrop: number;
  checks: { id: string; noiseDrop: number; candidateDrop: number }[];
  within: boolean;
}
export function noiseFloor(
  cmp: Comparison,
  noise: Comparison,
  guarded: string[],
): NoiseFloor {
  const drop = (c: Comparison) =>
    c.baseline.passAll.rate - c.candidate.passAll.rate;
  const checks = guarded.flatMap((id) => {
    const a = cmp.checks.find((c) => c.id === id);
    const b = noise.checks.find((c) => c.id === id);
    return a && b ? [{ id, noiseDrop: -b.delta, candidateDrop: -a.delta }] : [];
  });
  const within =
    drop(cmp) <= drop(noise) + 1e-9 &&
    checks.every((c) => c.candidateDrop <= c.noiseDrop + 1e-9);
  return {
    variant: noise.candidate.variant,
    passAllDrop: drop(noise),
    candidatePassAllDrop: drop(cmp),
    checks,
    within,
  };
}

export function gate(
  cmp: Comparison,
  g: { maxPassAllDrop?: number; noRegressionOn?: string[] } = {},
): GateResult {
  const reasons: string[] = [];
  const drop = g.maxPassAllDrop ?? 0;
  if (cmp.candidate.n === 0) reasons.push("no paired cases");
  if (cmp.candidate.passAll.rate < cmp.baseline.passAll.rate - drop - 1e-9)
    reasons.push(
      `pass-all fell from ${pct(cmp.baseline.passAll.rate)} to ${pct(cmp.candidate.passAll.rate)} (allowed drop ${pct(drop)})`,
    );
  for (const id of g.noRegressionOn ?? []) {
    const row = cmp.checks.find((c) => c.id === id);
    if (!row) reasons.push(`gate names unknown check ${id}`);
    else if (row.candidate.rate < row.baseline.rate - 1e-9)
      reasons.push(
        `${id} fell from ${pct(row.baseline.rate)} to ${pct(row.candidate.rate)}`,
      );
  }
  return { pass: reasons.length === 0, reasons };
}

export const pct = (x: number, digits = 1) =>
  Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(digits)}%`;
export const signedPct = (x: number) =>
  Number.isNaN(x) ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
