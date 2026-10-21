import { describe, expect, setDefaultTimeout, test } from "bun:test";

// CLI subprocess checks use the same budget as `bun test --timeout 60000`.
setDefaultTimeout(60_000);
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  eventsFromTraces,
  parseEvent,
  type RunnerEvent,
} from "../src/events.ts";
import { emptyUsage, type Suite, type VariantOutput } from "../src/types.ts";

const out = (output: unknown, prompt = 100): VariantOutput => ({
  output,
  usage: { ...emptyUsage("fake"), inputTokens: prompt, calls: 1, latencyMs: 1 },
});

const suite: Suite = {
  name: "ev",
  description: "three cases, two variants",
  cases: async () => [
    { id: "c1", input: 1 },
    { id: "c2", input: 2 },
    { id: "c3", input: 3 },
  ],
  variants: [
    { name: "a", description: "", run: async (c) => out(c.input) },
    {
      name: "b",
      description: "",
      run: async (c) => out((c.input as number) * 2, 50),
    },
  ],
  checks: [
    {
      id: "even",
      description: "",
      kind: "code",
      test: (_, o) => (o.output as number) % 2 === 0,
    },
  ],
  baseline: "a",
  candidate: "b",
};

async function freshRun() {
  const root = mkdtempSync(join(tmpdir(), "weigh-ev-"));
  process.env.WEIGH_RUNS = root;
  const m = (await import(
    "../src/run.ts?" + Date.now() + Math.random()
  )) as typeof import("../src/run.ts");
  return { root, ...m };
}

describe("runner events", () => {
  test("arrive in order with increasing seq, matching counts, and replay from traces equals live", async () => {
    const { runSuite, readTraces, readMeta } = await freshRun();
    const events: RunnerEvent[] = [];
    const dir = await runSuite(suite, {
      runId: "e1",
      log: () => {},
      concurrency: 1,
      onEvent: (e) => events.push(e),
    });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0]!.type).toBe("run_start");
    expect(events.at(-1)!.type).toBe("run_done");
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "job_start")).toHaveLength(6);
    expect(types.filter((t) => t === "job_done")).toHaveLength(6);
    const first = events[0] as Extract<RunnerEvent, { type: "run_start" }>;
    expect(first.total).toBe(6);
    expect(first.resumed).toBe(0);
    expect(first.case_order).toEqual(["c1", "c2", "c3"]);
    const dones = events.filter((e) => e.type === "job_done") as Extract<
      RunnerEvent,
      { type: "job_done" }
    >[];
    expect(dones.map((d) => d.finished)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(dones.every((d) => d.total === 6)).toBe(true);
    for (const e of events)
      expect(() => parseEvent(JSON.parse(JSON.stringify(e)))).not.toThrow();
    // Replay from the written traces gives the same job_done lines in the same order.
    const replay = eventsFromTraces(readMeta(dir), readTraces(dir));
    const replayLines = replay
      .filter((e) => e.type === "job_done")
      .map((e) => (e as Extract<RunnerEvent, { type: "job_done" }>).line);
    expect(replayLines).toEqual(dones.map((d) => d.line));
    expect(replay[0]!.type).toBe("run_start");
    expect(replay.at(-1)!.type).toBe("run_done");
    // A second attempt of the same run id reports everything as resumed and runs nothing.
    const again: RunnerEvent[] = [];
    await runSuite(suite, {
      runId: "e1",
      log: () => {},
      onEvent: (e) => again.push(e),
    });
    expect(again.map((e) => e.type)).toEqual(["run_start", "run_done"]);
    expect(
      (again[0] as Extract<RunnerEvent, { type: "run_start" }>).resumed,
    ).toBe(6);
    delete process.env.WEIGH_RUNS;
  });

  test("abort after the first pair ends the run with run_cancelled and stamps cancelled_at", async () => {
    const { runSuite, readMeta } = await freshRun();
    const ac = new AbortController();
    const events: RunnerEvent[] = [];
    const dir = await runSuite(suite, {
      runId: "e2",
      log: () => {},
      concurrency: 1,
      signal: ac.signal,
      onEvent: (e) => {
        events.push(e);
        if (e.type === "job_start") ac.abort();
      },
    });
    expect(events.map((e) => e.type)).toEqual([
      "run_start",
      "job_start",
      "job_done",
      "run_cancelled",
    ]);
    const last = events.at(-1) as Extract<
      RunnerEvent,
      { type: "run_cancelled" }
    >;
    expect(last.finished).toBe(1);
    expect(last.total).toBe(6);
    const meta = readMeta(dir);
    expect(meta.cancelled_at).toBeString();
    expect(meta.finished_at).toBeUndefined();
    delete process.env.WEIGH_RUNS;
  });

  test("the CLI writes events.jsonl beside traces.jsonl, suite-info prints JSON, a bad suite names its field", () => {
    const root = mkdtempSync(join(tmpdir(), "weigh-cli-"));
    const suitePath = join(root, "ev.suite.ts");
    writeFileSync(
      suitePath,
      `export default {
  name: "evcli", description: "cli", baseline: "a", candidate: "b",
  cases: async () => [{ id: "c1", input: 1 }, { id: "c2", input: 2 }],
  variants: [
    { name: "a", description: "", run: async (c) => ({ output: c.input, usage: { inputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, calls: 1, metered: true, provider: "fake" } }) },
    { name: "b", description: "", run: async (c) => ({ output: c.input, usage: { inputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, calls: 1, metered: true, provider: "fake" } }) },
  ],
  checks: [{ id: "ok", description: "", kind: "code", test: () => true }],
};`,
    );
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const env = { ...process.env, WEIGH_RUNS: root };
    const run = Bun.spawnSync(
      ["bun", cli, "run", suitePath, "--run-id", "r1"],
      { env },
    );
    expect(run.exitCode).toBe(0);
    const events = readFileSync(
      join(root, "evcli", "r1", "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => parseEvent(JSON.parse(l)));
    expect(events[0]!.type).toBe("run_start");
    expect(events.filter((e) => e.type === "job_done")).toHaveLength(4);
    expect(events.at(-1)!.type).toBe("run_done");
    const info = Bun.spawnSync(["bun", cli, "suite-info", suitePath], { env });
    const parsed = JSON.parse(info.stdout.toString());
    expect(parsed.name).toBe("evcli");
    expect(parsed.variants.map((v: { name: string }) => v.name)).toEqual([
      "a",
      "b",
    ]);
    expect(parsed.checks[0].id).toBe("ok");
    writeFileSync(
      join(root, "bad.suite.ts"),
      `export default { name: "bad", description: "", cases: async () => [], variants: [{ name: "a", description: "", run: async () => ({}) }], checks: [], baseline: "a", candidate: "zzz" };`,
    );
    const bad = Bun.spawnSync(
      ["bun", cli, "suite-info", join(root, "bad.suite.ts")],
      { env },
    );
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toString()).toContain("candidate: names no variant");
  });
});
