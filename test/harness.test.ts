import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  allIn,
  missing,
  noEmDash,
  setRecall,
  strings,
  zodParses,
} from "../src/checks.ts";
import {
  correctedFailRate,
  parseLabels,
  rates,
  validate,
} from "../src/judge.ts";
import { renderHtml } from "../src/report/html.ts";
import { renderMarkdown } from "../src/report/md.ts";
import { renderReview } from "../src/review.ts";
import { readMeta, readTraces, runSuite } from "../src/run.ts";
import { compare, gate } from "../src/stats.ts";
import { fromStages, matrix, toMarkdown } from "../src/transition.ts";
import { emptyUsage, type Suite, type VariantOutput } from "../src/types.ts";

const out = (output: unknown, prompt = 100): VariantOutput => ({
  output,
  usage: {
    ...emptyUsage("fake"),
    inputTokens: prompt,
    calls: 1,
    latencyMs: 5,
    costUsd: prompt / 1e6,
  },
});

describe("checks", () => {
  test("schema, recall, allowed set, em dash", () => {
    const schema = z.object({ items: z.array(z.string()) });
    const c = { id: "x", input: null, reference: ["a", "b"] };
    expect(zodParses("json", schema).test(c, out({ items: [] }))).toBe(true);
    expect(zodParses("json", schema).test(c, out({ nope: 1 }))).toBe(false);
    const recall = setRecall(
      "r",
      "all expected present",
      (cc) => cc.reference as string[],
      (o) => (o.output as { items: string[] }).items,
    );
    expect(recall.test(c, out({ items: ["a", "b", "c"] }))).toBe(true);
    expect(recall.test(c, out({ items: ["a"] }))).toBe(false);
    expect(
      allIn("cat", "allowed", ["x", "y"], (o) => o.output as string[]).test(
        c,
        out(["x", "x"]),
      ),
    ).toBe(true);
    expect(
      allIn("cat", "allowed", ["x", "y"], (o) => o.output as string[]).test(
        c,
        out(["z"]),
      ),
    ).toBe(false);
    expect(noEmDash().test(c, out({ a: ["fine", { b: "also fine" }] }))).toBe(
      true,
    );
    expect(noEmDash().test(c, out({ a: "not — fine" }))).toBe(false);
    expect(strings({ a: 1, b: ["x", { c: "y" }] })).toEqual(["x", "y"]);
    expect(missing(["a", "b"], ["b"])).toEqual(["a"]);
  });
});

describe("judge metrics", () => {
  test("TPR, TNR, Rogan-Gladen, label parsing and validation join", () => {
    const rows = [
      { human: "fail", judge: "fail" },
      { human: "fail", judge: "pass" },
      { human: "pass", judge: "pass" },
      { human: "pass", judge: "pass" },
      { human: "pass", judge: "fail" },
    ] as const;
    const r = rates([...rows]);
    expect(r.tpr).toBeCloseTo(0.5);
    expect(r.tnr).toBeCloseTo(2 / 3);
    expect(correctedFailRate(0.3, 0.9, 0.8)).toBeCloseTo((0.3 + 0.8 - 1) / 0.7);
    expect(() => correctedFailRate(0.3, 0.5, 0.5)).toThrow();
    const labels = parseLabels(
      '{"case_id":"a","human":"fail","split":"test"}\n{"case_id":"b","human":"pass"}\n{"case_id":"c","human":"pass"}\n',
    );
    expect(() => parseLabels('{"case_id":"a","human":"meh"}')).toThrow();
    const v = validate(
      labels,
      (l) =>
        (({ a: "fail", b: "fail" }) as Record<string, "pass" | "fail">)[
          l.case_id
        ],
    );
    expect(v.joined).toBe(2);
    expect(v.unmatched).toBe(1);
    expect(v.splits.find((s) => s.split === "test")!.tpr).toBe(1);
  });
});

describe("transition matrix", () => {
  test("first failure after last success, markdown table", () => {
    const rows = [
      fromStages("t1", [
        { name: "fetch", ok: true },
        { name: "extract", ok: false },
      ]),
      fromStages("t2", [
        { name: "fetch", ok: true },
        { name: "extract", ok: true },
      ]),
      fromStages("t3", [{ name: "fetch", ok: false }]),
    ];
    expect(rows[0]).toEqual({
      trace_id: "t1",
      last_success: "fetch",
      first_failure: "extract",
    });
    expect(rows[1]!.first_failure).toBeNull();
    const m = matrix(rows);
    expect(m.failures).toBe(2);
    expect(toMarkdown(m)).toContain("| fetch | 1 |");
    expect(toMarkdown(m)).toContain("2 of 3 traces failed a stage.");
  });
});

describe("runner and reports", () => {
  const suite: Suite = {
    name: "fake",
    description: "A fake suite for the harness test.",
    cases: async () => [
      { id: "c1", input: { text: "one" }, reference: ["x"] },
      { id: "c2", input: { text: "two" }, reference: ["y"] },
      { id: "c3", input: { text: "three" }, reference: [] },
    ],
    variants: [
      {
        name: "big",
        description: "returns everything",
        run: async (c) => ({
          ...out({ items: c.reference, note: "fine" }, 1000),
          stages: [
            { name: "fetch", ok: true },
            { name: "extract", ok: true },
          ],
        }),
      },
      {
        name: "lean",
        description: "drops y and throws on three",
        run: async (c) => {
          if (c.id === "c3") throw new Error("boom");
          return {
            ...out(
              {
                items: (c.reference as string[]).filter((r) => r !== "y"),
                note: "fine",
              },
              400,
            ),
            extra: { kept: 3 },
            stages: [
              { name: "fetch", ok: true },
              { name: "extract", ok: c.id !== "c2" },
            ],
          };
        },
      },
    ],
    checks: [
      zodParses(
        "json",
        z.object({ items: z.array(z.string()), note: z.string() }),
      ),
      setRecall(
        "recall",
        "every reference item present",
        (c) => c.reference as string[],
        (o) => (o.output as { items: string[] }).items,
      ),
      { ...noEmDash(), applies: (c) => c.id !== "c3" },
    ],
    baseline: "big",
    candidate: "lean",
    gate: { noRegressionOn: ["recall"] },
  };
  test("runs, caches, writes traces and renders both reports and the review page", async () => {
    const root = mkdtempSync(join(tmpdir(), "weigh-"));
    process.env.WEIGH_RUNS = root;
    const {
      runSuite: run,
      readMeta: meta,
      readTraces: traces,
    } = await import("../src/run.ts?" + Date.now());
    const dir = await run(suite, { runId: "t1", log: () => {} });
    const lines = traces(dir);
    expect(lines).toHaveLength(6);
    const m = meta(dir);
    expect(m.case_order).toEqual(["c1", "c2", "c3"]);
    const cmp = compare(
      lines,
      "big",
      "lean",
      ["json", "recall", "no_em_dash"],
      m.case_order,
    );
    expect(cmp.candidate.errors).toBe(1);
    expect(cmp.regressions.map((r) => r.case_id + ":" + r.check)).toContain(
      "c2:recall",
    );
    expect(cmp.promptTokens.n).toBe(3);
    const g = gate(cmp, m.gate);
    expect(g.pass).toBe(false);
    const html = renderHtml({
      meta: m,
      lines,
      cmp,
      gate: g,
      generatedAt: "2026-10-19T00:00:00Z",
    });
    expect(html).toContain("does not clear the gate");
    expect(html).toContain("c2");
    expect(html).not.toMatch(/[—]/);
    const md = renderMarkdown({ meta: m, lines, cmp, gate: g });
    expect(md).toContain("Gate failed");
    expect(md).toContain("| recall |");
    const review = renderReview({
      dir,
      meta: m,
      lines,
      baseline: "big",
      candidate: "lean",
      inputText: (id) =>
        JSON.parse(readFileSync(join(dir, "inputs.json"), "utf8"))[id],
    });
    expect(review).toContain("Export labels.jsonl");
    expect(review).toContain("two");
    // Second run with the same id spends nothing: every line comes from cache and nothing is appended twice.
    const dir2 = await run(suite, { runId: "t1", log: () => {} });
    expect(traces(dir2)).toHaveLength(6);
    expect(existsSync(join(dir, "outputs"))).toBe(true);
    delete process.env.WEIGH_RUNS;
  });
  test("exports used by the CLI are importable", () => {
    expect(typeof runSuite).toBe("function");
    expect(typeof readMeta).toBe("function");
    expect(typeof readTraces).toBe("function");
  });
});
