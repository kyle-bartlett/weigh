import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  build,
  buildFrom,
  readJudges,
  summaryLine,
} from "../src/report/build.ts";
import { readMeta, readTraces } from "../src/run.ts";

const example = join(
  import.meta.dir,
  "..",
  "runs",
  "examples",
  "exchange-triage-2026-10-19",
);

describe("build", () => {
  test("buildFrom over the committed Exchange Triage run reproduces the report's verdict", () => {
    const r = buildFrom(
      readMeta(example),
      readTraces(example),
      readJudges(example),
    );
    expect(r.gate.pass).toBe(true);
    expect(r.cmp.promptTokens.n).toBe(27);
    expect(r.meta.checks).toHaveLength(7);
    expect(r.judges.map((j) => j.check).sort()).toEqual([
      "attribution_claude",
      "attribution_jev",
    ]);
    expect(r.noise?.variant).toBe("v2-repeat");
    expect(summaryLine(r)).toStartWith("GATE PASS");
    // build(dir) is the same computation read from disk; a pick overrides the pair without touching the stored meta.
    expect(build(example).gate).toEqual(r.gate);
    const fromV1 = build(example, { baseline: "v1" });
    expect(fromV1.meta.baseline).toBe("v1");
    expect(readMeta(example).baseline).toBe("v2");
    expect(fromV1.gate.pass).toBe(false);
  });
});
