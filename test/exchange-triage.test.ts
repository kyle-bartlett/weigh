import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { firstJson, parseEnvelope } from "../src/claude-cli.ts";
import type { Output } from "../suites/exchange-triage.ts";

const ET =
  process.env.ET_CHECKOUT ?? join(homedir(), "wildcard/exchange-triage");
const have = existsSync(join(ET, "lib/pipeline/run.ts"));

describe("claude-cli envelope", () => {
  test("parses the CLI JSON envelope and rejects anything else", () => {
    const env = parseEnvelope(
      '{"result":"hi","total_cost_usd":0.0011,"usage":{"input_tokens":12,"output_tokens":3}}',
    );
    expect(env?.result).toBe("hi");
    expect(env?.total_cost_usd).toBe(0.0011);
    expect(parseEnvelope("not json")).toBeNull();
  });
  test("firstJson finds the first object in prose", () => {
    expect(firstJson('Sure: {"verdict":"PASS","field":""} done')).toEqual({
      verdict: "PASS",
      field: "",
    });
    expect(firstJson("no json here")).toBeUndefined();
  });
});

describe.skipIf(!have)("exchange-triage suite", async () => {
  const m = await import("../suites/exchange-triage.ts");
  const output = (over: Partial<Output> = {}): Output => ({
    decision: "IN APPETITE",
    expectedDecision: "IN APPETITE",
    decisionCorrect: true,
    fitScore: 80,
    confidence: 0.9,
    reasons: [],
    extraction: null,
    extracted: [],
    fields: [
      { field: "tiv", expected: 1000, got: 1000, correct: true },
      { field: "state", expected: "TX", got: "TX", correct: true },
    ],
    retries: 0,
    guardrails: [],
    flags: [],
    ...over,
  });

  test("stagesFor names the first stage that went wrong", () => {
    const wrongField = m.stagesFor(
      output({
        extraction: {} as never,
        fields: [{ field: "tiv", expected: 1000, got: 900, correct: false }],
      }),
    );
    expect(wrongField.find((s) => s.name === "extraction")?.ok).toBe(false);
    expect(wrongField.find((s) => s.name === "extraction")?.detail).toBe("tiv");
    const falseAlarm = m.stagesFor(
      output({
        extraction: {} as never,
        flags: [{ field: "state", issue: "ambiguous", detail: "" }],
      }),
    );
    expect(falseAlarm.find((s) => s.name === "grounding")?.ok).toBe(false);
    expect(falseAlarm.find((s) => s.name === "appetite")?.ok).toBe(true);
  });

  test("extractedPairs keeps non-null fields with their claimed source", () => {
    const pairs = m.extractedPairs({
      tiv: { value: 1000, confidence: 0.9, source: "email" },
      county: { value: null, confidence: 0.1, source: null },
      units: { value: 12, confidence: 0.8 },
    } as never);
    expect(pairs).toEqual([
      { field: "tiv", value: 1000, source: "email" },
      { field: "units", value: 12, source: null },
    ]);
  });

  test("judgeState shows only the source text and the pairs; judgeKey changes with the values", () => {
    const pairs: Output["extracted"] = [
      { field: "tiv", value: 1000, source: "email" },
    ];
    const state = m.judgeState(
      { submissionId: "x", broker: "b", emailText: "TIV $1,000,000" } as never,
      pairs,
    );
    expect(state).toContain("BROKER EMAIL:\nTIV $1,000,000");
    expect(state).toContain("- tiv = 1000 (source: email)");
    expect(state).not.toContain("ATTACHMENT");
    expect(m.judgeKey("c1", pairs)).not.toBe(
      m.judgeKey("c1", [{ ...pairs[0]!, value: 2000 }]),
    );
    expect(m.judgeKey("c1", pairs)).toBe(m.judgeKey("c1", pairs));
  });

  test("nulls_stay_null and fields_correct read the app's field scorer", async () => {
    const suite = m.default;
    const check = (id: string) => suite.checks.find((c) => c.id === id)!;
    const c = {
      id: "t",
      input: {},
      reference: {
        expected: {
          fields: { tiv: null, state: "TX" },
          decision: "IN APPETITE",
        },
      },
    };
    const good = {
      output: output({
        fields: [
          { field: "tiv", expected: null, got: null, correct: true },
          { field: "state", expected: "TX", got: "TX", correct: true },
        ],
      }),
      usage: {} as never,
    };
    const guessed = {
      output: output({
        fields: [
          { field: "tiv", expected: null, got: 5, correct: false },
          { field: "state", expected: "TX", got: "TX", correct: true },
        ],
      }),
      usage: {} as never,
    };
    expect(check("nulls_stay_null").applies?.(c as never)).toBe(true);
    expect(await check("nulls_stay_null").test(c as never, good as never)).toBe(
      true,
    );
    expect(
      await check("nulls_stay_null").test(c as never, guessed as never),
    ).toBe(false);
    expect(
      await check("fields_correct").test(c as never, guessed as never),
    ).toBe(false);
  });
});
