import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgent } from "../src/agent/main.ts";
import { startHub } from "../src/hub/server.ts";

// Subprocess runs use the same budget as `bun test --timeout 60000`.
setDefaultTimeout(60_000);
const ROOT = join(import.meta.dir, "..");
const T = { admin: "admin-token", agent: "agent-token", read: "read-token" };

const SLOW_SUITE = `import type { Suite } from "./types.ts";
import { emptyUsage } from "./types.ts";
const out = (n: number) => ({ output: { n }, usage: { ...emptyUsage("fake"), inputTokens: n, calls: 1, latencyMs: 1 } });
const suite: Suite = {
  name: "slow",
  description: "six cases that take a while",
  cases: async () => [1, 2, 3, 4, 5, 6].map((n) => ({ id: "c" + n, input: n })),
  variants: [
    { name: "a", description: "", run: async (c) => { await Bun.sleep(350); return out(c.input as number); } },
    { name: "b", description: "", run: async (c) => { await Bun.sleep(350); return out((c.input as number) * 2); } },
  ],
  checks: [{ id: "positive", description: "", kind: "code", test: (_c, o) => (o.output as { n: number }).n > 0 }],
  baseline: "a",
  candidate: "b",
  concurrency: 1,
};
export default suite;
`;

describe("agent", () => {
  let hub: ReturnType<typeof startHub>;
  let tmp: string;
  let checkout: string;
  let config: string;
  const get = (path: string, token = T.admin, init: RequestInit = {}) =>
    fetch(hub.url + path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const runJson = async (suite: string, id: string) =>
    (await (await get(`/api/runs/${suite}/${id}`)).json()) as {
      status: string;
      finished: number;
      total: number;
      last_seq: number;
    };
  const once = () => startAgent(config, { once: true, log: () => {} });

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "weigh-agent-"));
    hub = startHub({ port: 0, dbPath: join(tmp, "hub.db"), tokens: T });
    checkout = join(tmp, "demo-repo");
    const init = Bun.spawnSync([
      "bun",
      join(ROOT, "src", "cli.ts"),
      "init",
      checkout,
      "--name",
      "demo",
    ]);
    if (init.exitCode !== 0) throw new Error(init.stderr.toString());
    writeFileSync(join(checkout, "weigh", "slow.suite.ts"), SLOW_SUITE);
    config = join(tmp, "agent.json");
    writeFileSync(
      config,
      JSON.stringify({
        hub: hub.url,
        agent_id: "test-agent",
        weigh_home: ROOT,
        workdir: join(tmp, "work"),
        runs_dir: join(tmp, "runs"),
        projects: [{ id: "demo", path: checkout, pull: false }],
        heartbeat_s: 1,
        poll_wait_s: 1,
      }),
    );
    process.env.WEIGH_AGENT_TOKEN = T.agent;
  });
  afterAll(() => {
    hub.stop();
    delete process.env.WEIGH_AGENT_TOKEN;
  });

  test("registers both suites, claims a queued run, streams it and finishes with outputs on the hub", async () => {
    await once();
    const project = (await (await get("/api/projects/demo")).json()) as {
      suites: { name: string; path: string }[];
    };
    expect(project.suites.map((s) => s.name).sort()).toEqual(["demo", "slow"]);
    expect(project.suites.find((s) => s.name === "demo")!.path).toBe(
      "weigh/demo.suite.ts",
    );

    const enq = await get("/api/runs", T.admin, {
      method: "POST",
      body: JSON.stringify({ project: "demo", suite: "demo", run_id: "r1" }),
    });
    expect(enq.status).toBe(201);
    expect((await runJson("demo", "r1")).status).toBe("queued");
    await once();
    const run = await runJson("demo", "r1");
    expect(run.status).toBe("finished");
    expect(run.finished).toBe(4);
    expect(run.total).toBe(4);
    const sse = await (
      await fetch(`${hub.url}/api/runs/demo/r1/events`, {
        headers: { authorization: `Bearer ${T.read}` },
      })
    ).text();
    const types = [...sse.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
    expect(types).toContain("log");
    expect(types.filter((t) => t === "job_done")).toHaveLength(4);
    expect(types).toContain("summary");
    expect(types.at(-1)).toBe("end");
    const ids = [...sse.matchAll(/^id: (\d+)/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual(ids.map((_, i) => i + 1));
    const page = await (await get("/r/demo/r1/c/example-1", T.read)).text();
    expect(page).toContain("baseline:");
    expect(
      readFileSync(join(tmp, "runs", "demo", "r1", ".hub-cursor"), "utf8"),
    ).toContain('"done":"finished"');
  });

  test("cancel stops the run after the pair in flight; retry resumes it in one event sequence", async () => {
    const enq = await get("/api/runs", T.admin, {
      method: "POST",
      body: JSON.stringify({ project: "demo", suite: "slow", run_id: "s1" }),
    });
    expect(enq.status).toBe(201);
    const running = once();
    for (let i = 0; i < 80; i++) {
      await Bun.sleep(100);
      const r = await runJson("slow", "s1");
      if (r.status === "running" && r.finished >= 1) break;
    }
    expect(
      (
        await get("/api/runs/slow/s1/cancel", T.admin, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(200);
    await running;
    const cancelled = await runJson("slow", "s1");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.finished).toBeGreaterThanOrEqual(1);
    expect(cancelled.finished).toBeLessThan(12);
    expect(existsSync(join(tmp, "runs", "slow", "s1", "outputs"))).toBe(true);

    expect(
      (
        await get("/api/runs/slow/s1/retry", T.admin, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(200);
    expect((await runJson("slow", "s1")).status).toBe("queued");
    await once();
    const done = await runJson("slow", "s1");
    expect(done.status).toBe("finished");
    expect(done.finished).toBe(12);
    expect(done.total).toBe(12);
    const sse = await (
      await fetch(`${hub.url}/api/runs/slow/s1/events`, {
        headers: { authorization: `Bearer ${T.read}` },
      })
    ).text();
    const starts = [...sse.matchAll(/^event: run_start\ndata: (.*)$/gm)].map(
      (m) => JSON.parse(m[1]!) as { resumed: number },
    );
    expect(starts).toHaveLength(2);
    expect(starts[1]!.resumed).toBeGreaterThanOrEqual(1);
    const ids = [...sse.matchAll(/^id: (\d+)/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual(ids.map((_, i) => i + 1));
    expect([...sse.matchAll(/^event: job_done/gm)]).toHaveLength(12);
  });
});
