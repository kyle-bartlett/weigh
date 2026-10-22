import { readFileSync } from "node:fs";
import { wilson, type Interval } from "./stats.ts";

/**
 * Judge validation. "Positive" means a failure is present (the evals FAQ convention). A judge
 * earns its place only when its TPR and TNR on a locked test split are known; until then its
 * verdicts are a signal to look at traces, not a number to report.
 */

export type Verdict = "pass" | "fail";
export interface LabelRow {
  case_id: string;
  variant?: string;
  human: Verdict;
  judge?: Verdict;
  split?: "train" | "dev" | "test";
  note?: string;
}

export interface JudgeRates {
  n: number;
  humanFails: number;
  humanPasses: number;
  tpr: number;
  tnr: number;
  tprCi: Interval;
  tnrCi: Interval;
}

export function rates(rows: { human: Verdict; judge: Verdict }[]): JudgeRates {
  const fails = rows.filter((r) => r.human === "fail");
  const passes = rows.filter((r) => r.human === "pass");
  const tp = fails.filter((r) => r.judge === "fail").length;
  const tn = passes.filter((r) => r.judge === "pass").length;
  return {
    n: rows.length,
    humanFails: fails.length,
    humanPasses: passes.length,
    tpr: fails.length ? tp / fails.length : NaN,
    tnr: passes.length ? tn / passes.length : NaN,
    tprCi: wilson(tp, fails.length),
    tnrCi: wilson(tn, passes.length),
  };
}

/** Rogan-Gladen: the true failure rate behind a judge's observed failure rate on unlabeled traffic. */
export function correctedFailRate(observed: number, tpr: number, tnr: number) {
  const denom = tpr + tnr - 1;
  if (!(denom > 0))
    throw new Error(
      "TPR + TNR <= 1: the judge is no better than chance, fix it before correcting",
    );
  return Math.min(1, Math.max(0, (observed + tnr - 1) / denom));
}

/** The only split names a label may carry; "all" is computed, never stored. */
export const SPLITS: readonly string[] = ["train", "dev", "test"];

export function parseLabels(text: string): LabelRow[] {
  return text
    .split("\n")
    .map((l, i) => [l.trim(), i + 1] as const)
    .filter(([l]) => l)
    .map(([l, line]) => {
      const r = JSON.parse(l) as LabelRow;
      if (r.human !== "pass" && r.human !== "fail")
        throw new Error(`line ${line}: human must be "pass" or "fail"`);
      if (r.judge !== undefined && r.judge !== "pass" && r.judge !== "fail")
        throw new Error(`line ${line}: judge must be "pass" or "fail"`);
      if (!r.case_id) throw new Error(`line ${line}: case_id missing`);
      if (r.split !== undefined && !SPLITS.includes(r.split))
        throw new Error(`line ${line}: split must be train, dev or test`);
      return r;
    });
}

/**
 * Join human labels with a judge check's verdicts from a run's trace lines and report per split.
 * A trace check value of true is a judge "pass"; false is "fail".
 */
export function validate(
  labels: LabelRow[],
  judgeOf: (r: LabelRow) => Verdict | undefined,
) {
  const joined = labels
    .map((r) => ({ ...r, judge: r.judge ?? judgeOf(r) }))
    .filter((r): r is LabelRow & { judge: Verdict } => r.judge !== undefined);
  const splits = new Map<string, (LabelRow & { judge: Verdict })[]>([
    ["all", joined],
  ]);
  for (const r of joined)
    if (r.split) splits.set(r.split, [...(splits.get(r.split) ?? []), r]);
  return {
    joined: joined.length,
    unmatched: labels.length - joined.length,
    splits: [...splits].map(([name, rs]) => ({ split: name, ...rates(rs) })),
  };
}

export function readLabels(path: string) {
  return parseLabels(readFileSync(path, "utf8"));
}
