import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { validate } from "../judge.ts";
import { readMeta, readTraces } from "../run.ts";
import {
  compare,
  gate as gateOf,
  noiseFloor,
  pct,
  signedPct,
} from "../stats.ts";
import type { RunMeta, TraceLine } from "../types.ts";

/**
 * Everything a report (or a hub page, or a summary event) needs, computed once from the trace lines.
 * build() reads a run directory; buildFrom() takes the same data from memory so the hub can recompute
 * after every job without touching disk.
 */

export type JudgeRecord = ReturnType<typeof validate> & {
  check: string;
  labels: string;
  at: string;
};

export type Pick = { baseline?: string; candidate?: string };

// A record that joined no human label validated nothing.
export const checkedJudges = <J extends { joined: number }>(judges: J[]): J[] =>
  judges.filter((j) => typeof j.joined === "number" && j.joined > 0);

export function buildFrom(
  metaIn: RunMeta & { case_order: string[] },
  lines: TraceLine[],
  judges: JudgeRecord[] = [],
  pick: Pick = {},
) {
  const meta = { ...metaIn };
  if (pick.baseline) meta.baseline = pick.baseline;
  if (pick.candidate) meta.candidate = pick.candidate;
  const ids = meta.checks.map((c) => c.id);
  const cmp = compare(
    lines,
    meta.baseline,
    meta.candidate,
    ids,
    meta.case_order,
  );
  const noise =
    meta.noise &&
    meta.noise !== meta.candidate &&
    lines.some((l) => l.variant === meta.noise)
      ? noiseFloor(
          cmp,
          compare(lines, meta.baseline, meta.noise, ids, meta.case_order),
          meta.gate?.noRegressionOn ?? [],
        )
      : undefined;
  return { meta, lines, cmp, gate: gateOf(cmp, meta.gate), noise, judges };
}

export type Built = ReturnType<typeof buildFrom>;

export function build(dir: string, pick: Pick = {}): Built {
  return buildFrom(readMeta(dir), readTraces(dir), readJudges(dir), pick);
}

/** Validated judges live in <run dir>/judges.json keyed by check, so every later report shows all of them. */
export function readJudges(dir: string): JudgeRecord[] {
  const p = join(dir, "judges.json");
  if (!existsSync(p)) return [];
  const rec = JSON.parse(readFileSync(p, "utf8")) as Record<
    string,
    JudgeRecord
  >;
  return Object.values(rec).sort((a, b) => a.check.localeCompare(b.check));
}

export function summaryLine(r: Built) {
  const { cmp, gate } = r;
  return `${gate.pass ? "GATE PASS" : "GATE FAIL"}  pass-all ${pct(cmp.baseline.passAll.rate)} -> ${pct(cmp.candidate.passAll.rate)}  prompt tokens ${signedPct(cmp.promptTokens.pctChange)}  cost ${signedPct(cmp.costUsd.pctChange)}  latency ${signedPct(cmp.latencyMs.pctChange)}  n=${cmp.promptTokens.n}${gate.pass ? "" : "  (" + gate.reasons.join("; ") + ")"}${r.noise ? `  noise floor: ${r.noise.within ? "within" : "beyond"} (${r.noise.variant} moved pass-all ${signedPct(-r.noise.passAllDrop)})` : ""}`;
}
