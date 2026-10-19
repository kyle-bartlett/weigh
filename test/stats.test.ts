import { describe, expect, test } from "bun:test";
import {
  bootstrapMean,
  compare,
  gate,
  median,
  paired,
  wilson,
} from "../src/stats.ts";
import { emptyUsage, type TraceLine } from "../src/types.ts";

const line = (
  variant: string,
  id: string,
  checks: Record<string, boolean>,
  prompt: number,
  ok = true,
): TraceLine => ({
  run_id: "r",
  suite: "s",
  case_id: id,
  variant,
  at: "2026-10-19T00:00:00Z",
  ok,
  usage: {
    ...emptyUsage("test"),
    inputTokens: prompt,
    calls: 1,
    latencyMs: 10,
    costUsd: prompt / 1e6,
  },
  checks,
  output_hash: "h",
});

describe("wilson", () => {
  test("brackets the point estimate and stays inside [0,1]", () => {
    const w = wilson(9, 10);
    expect(w.lo).toBeLessThan(0.9);
    expect(w.hi).toBeGreaterThan(0.9);
    expect(w.hi).toBeLessThanOrEqual(1);
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
});

describe("paired and bootstrap", () => {
  test("median and paired deltas", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    const p = paired([100, 200, 300], [50, 100, 150]);
    expect(p.pctChange).toBeCloseTo(-0.5);
    expect(p.meanDelta).toBe(-100);
    expect(p.n).toBe(3);
  });
  test("bootstrap is deterministic and contains the mean", () => {
    const d = [-10, -12, -8, -11, -9, -13, -7];
    const a = bootstrapMean(d),
      b = bootstrapMean(d);
    expect(a).toEqual(b);
    expect(a.lo).toBeLessThanOrEqual(-10);
    expect(a.hi).toBeGreaterThanOrEqual(-10);
    expect(Number.isNaN(bootstrapMean([1]).lo)).toBe(true);
  });
});

describe("compare and gate", () => {
  const order = ["a", "b", "c"];
  const lines = [
    line("full", "a", { json: true, recall: true }, 1000),
    line("full", "b", { json: true, recall: true }, 2000),
    line("full", "c", { json: true, recall: false }, 3000),
    line("lean", "a", { json: true, recall: true }, 500),
    line("lean", "b", { json: true, recall: false }, 900),
    line("lean", "c", { json: true, recall: false }, 1200),
  ];
  test("pairs only cases both variants ran, computes rates, deltas and regressions", () => {
    const cmp = compare(
      [...lines, line("lean", "zzz", { json: true, recall: true }, 1)],
      "full",
      "lean",
      ["json", "recall"],
      [...order, "zzz"],
    );
    expect(cmp.promptTokens.n).toBe(3);
    expect(cmp.baseline.passAll.passed).toBe(2);
    expect(cmp.candidate.passAll.passed).toBe(1);
    expect(cmp.promptTokens.pctChange).toBeCloseTo((2600 - 6000) / 6000);
    expect(cmp.checks.find((c) => c.id === "json")!.saturated).toBe(true);
    expect(cmp.regressions).toEqual([{ case_id: "b", check: "recall" }]);
  });
  test("gate fails on a pass-all drop or a guarded check regression and names why", () => {
    const cmp = compare(lines, "full", "lean", ["json", "recall"], order);
    const g = gate(cmp, { noRegressionOn: ["recall"] });
    expect(g.pass).toBe(false);
    expect(g.reasons.join(" ")).toContain("pass-all fell");
    expect(g.reasons.join(" ")).toContain("recall fell");
    expect(gate(cmp, { maxPassAllDrop: 0.5 }).pass).toBe(true);
    expect(gate(cmp, { noRegressionOn: ["nope"] }).reasons.join(" ")).toContain(
      "unknown check",
    );
  });
  test("a check that did not apply is left out of its rate and does not fail pass-all", () => {
    const l = [
      line("full", "a", { json: true }, 10),
      line("lean", "a", { json: true }, 5),
      line("full", "b", { json: true, recall: false }, 10),
      line("lean", "b", { json: true, recall: true }, 5),
    ];
    const cmp = compare(l, "full", "lean", ["json", "recall"], ["a", "b"]);
    expect(cmp.baseline.checks.find((c) => c.id === "recall")).toMatchObject({
      passed: 0,
      n: 1,
    });
    expect(cmp.baseline.passAll.passed).toBe(1);
    expect(cmp.candidate.passAll.passed).toBe(2);
  });
  test("an errored line counts against pass-all and every check", () => {
    const l = [
      line("full", "a", { json: true }, 10),
      line("lean", "a", {}, 0, false),
    ];
    const cmp = compare(l, "full", "lean", ["json"], ["a"]);
    expect(cmp.candidate.errors).toBe(1);
    expect(cmp.candidate.passAll.passed).toBe(0);
    expect(cmp.regressions).toEqual([{ case_id: "a", check: "json" }]);
  });
});
