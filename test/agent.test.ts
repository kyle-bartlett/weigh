import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgent } from "../src/agent/main.ts";
import { runJob, uploadLabels } from "../src/agent/runner.ts";
import { HubClient } from "../src/agent/upload.ts";
import type { Log } from "../src/agent/checkout.ts";
import { startHub } from "../src/hub/server.ts";
import { runKey } from "../src/hub/store.ts";
import { readJudges } from "../src/report/build.ts";
import type { LabelRow } from "../src/judge.ts";

// Subprocess runs use the same budget as `bun test --timeout 60000`.
setDefaultTimeout(60_000);
const ROOT = join(import.meta.dir, "..");
const T = { admin: "admin-token", agent: "agent-token", read: "read-token" };

describe("labels upload after a finished run", () => {
  type Request = {
    method: string;
    path: string;
    body: { agent_id: string; labels?: LabelRow[]; check?: string };
  };
  let tmp: string;
  let checkout: string;
  let runDir: string;
  let stub: ReturnType<typeof Bun.serve>;
  let realHub: ReturnType<typeof startHub> | undefined;
  let client: HubClient;
  let requests: Request[];
  let logs: { level: string; message: string }[];
  let putStatuses: number[];
  let judgeStatuses: Record<string, number[]>;
  const log: Log = (level, message) => logs.push({ level, message });
  const rows: LabelRow[] = [
    { case_id: "c1", human: "pass", note: "reviewed" },
    {
      case_id: "c2",
      variant: "b",
      human: "fail",
      note: `Bearer ${"x".repeat(24)}`,
    },
  ];
  const meta = (labels: string | undefined = "labels.jsonl") => ({
    labels,
    candidate: "b",
    checks: [
      { id: "exact", kind: "code" },
      { id: "judge_a", kind: "judge" },
      { id: "judge_b", kind: "judge" },
      { id: "judge_silent", kind: "judge" },
    ],
  });
  const upload = () =>
    uploadLabels({
      hub: client,
      job: { suite: "demo", run_id: "r1" },
      agentId: "imac",
      checkout,
      runDir,
      log,
    });

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "weigh-label-upload-"));
    checkout = join(tmp, "checkout");
    runDir = join(tmp, "run");
    mkdirSync(checkout);
    mkdirSync(runDir);
    stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body = (await req.json()) as Request["body"];
        requests.push({ method: req.method, path, body });
        if (req.method === "PUT" && path.endsWith("/labels")) {
          const status = putStatuses.shift() ?? 200;
          return status === 200
            ? // One row is reported as already labelled, so the skipped count is read, not assumed.
              Response.json({
                inserted: body.labels!.length - 1,
                skipped: 1,
                total: body.labels!.length,
              })
            : new Response(`upload failed ${T.agent}`, { status });
        }
        const check = body.check!;
        const status =
          judgeStatuses[check]?.shift() ?? (check === "judge_b" ? 409 : 200);
        return status === 200
          ? Response.json({ joined: 2, check })
          : new Response(
              status === 409
                ? `no label matched a verdict of ${check}; nothing stored`
                : `validation failed ${T.agent}`,
              { status },
            );
      },
    });
    client = new HubClient(stub.url.toString(), T.agent);
  });
  beforeEach(() => {
    requests = [];
    logs = [];
    putStatuses = [];
    judgeStatuses = {};
    writeFileSync(join(runDir, "run.json"), JSON.stringify(meta()));
    writeFileSync(
      join(runDir, "traces.jsonl"),
      JSON.stringify({
        case_id: "c1",
        variant: "b",
        checks: { exact: true, judge_a: true, judge_b: false },
        unanswered: ["judge_silent"],
      }) + "\n",
    );
    writeFileSync(
      join(checkout, "labels.jsonl"),
      rows.map((row) => JSON.stringify(row)).join("\n"),
    );
  });
  afterAll(() => {
    stub?.stop(true);
    realHub?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("uploads scrubbed rows with candidate defaults, validates verdicts, and skips silent and refused judges", async () => {
    const outcome = await upload();
    expect(requests).toEqual([
      {
        method: "PUT",
        path: "/api/agent/runs/demo/r1/labels",
        body: {
          agent_id: "imac",
          labels: [
            { case_id: "c1", variant: "b", human: "pass", note: "reviewed" },
            {
              case_id: "c2",
              variant: "b",
              human: "fail",
              note: "Bearer <redacted>",
            },
          ],
        },
      },
      ...["judge_a", "judge_b"].map((check) => ({
        method: "POST",
        path: "/api/agent/runs/demo/r1/judges/validate",
        body: { agent_id: "imac", check },
      })),
    ]);
    expect(outcome).toMatchObject({
      uploaded: 1,
      unchanged: 1,
      validated: ["judge_a"],
      skipped: [
        { check: "judge_b", reason: expect.stringContaining("409") },
        { check: "judge_silent", reason: "no verdict in the traces" },
      ],
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        {
          level: "info",
          message:
            "labels: 1 rows uploaded from labels.jsonl, 1 already labelled (on the hub or earlier in the file) left unchanged",
        },
        {
          level: "info",
          message: "judge judge_a: validated (2 labels joined)",
        },
        {
          level: "info",
          message:
            "judge judge_silent: no verdict in the traces; validation skipped",
        },
        {
          level: "warn",
          message: expect.stringMatching(/judge_b:.*409.*skipped/),
        },
      ]),
    );
  });

  test("escaping, symlinked-out and missing labels paths each warn once without contacting the hub", async () => {
    // A link inside the checkout whose target is outside it passes a lexical check; the real path must not.
    const outside = join(tmp, "outside.jsonl");
    writeFileSync(outside, '{"case_id":"c1","variant":"b","human":"pass"}\n');
    symlinkSync(outside, join(checkout, "linked.jsonl"));
    for (const [labels, reason] of [
      ["../x.jsonl", "outside the checkout"],
      ["linked.jsonl", "outside the checkout"],
      ["missing.jsonl", "not found in the checkout"],
    ]) {
      logs = [];
      writeFileSync(join(runDir, "run.json"), JSON.stringify(meta(labels)));
      expect(await upload()).toHaveProperty("skipped");
      expect(logs).toEqual([
        { level: "warn", message: expect.stringContaining(reason!) },
      ]);
      expect(requests).toHaveLength(0);
    }
  });

  test("absent metadata or declaration is quiet and malformed files warn without requests", async () => {
    rmSync(join(runDir, "run.json"));
    expect(await upload()).toEqual({ skipped: "run.json missing" });
    writeFileSync(
      join(runDir, "run.json"),
      JSON.stringify({ ...meta(), labels: undefined }),
    );
    expect(await upload()).toEqual({ skipped: "no labels declared" });
    expect(logs).toHaveLength(0);
    writeFileSync(join(runDir, "run.json"), JSON.stringify(meta()));
    writeFileSync(
      join(checkout, "labels.jsonl"),
      '{"case_id":"c1","human":"maybe"}',
    );
    expect(await upload()).toEqual({
      skipped: "labels file could not be parsed",
    });
    expect(logs).toEqual([
      { level: "warn", message: expect.stringContaining("human must be") },
    ]);
    logs = [];
    writeFileSync(join(runDir, "run.json"), "{");
    expect(await upload()).toEqual({ skipped: "unexpected labels error" });
    expect(logs).toEqual([
      { level: "warn", message: expect.stringMatching(/labels:.*skipped/) },
    ]);
    expect(requests).toHaveLength(0);
  });

  test("retries transient failures at most three times, stops on 4xx, and continues after a judge fails", async () => {
    for (const [status, attempts] of [
      [503, 3],
      [403, 1],
    ] as const) {
      requests = [];
      putStatuses = Array(attempts).fill(status);
      expect(await upload()).toEqual({ skipped: "labels upload failed" });
      expect(requests).toHaveLength(attempts);
      expect(requests.every((request) => request.method === "PUT")).toBe(true);
    }
    requests = [];
    putStatuses = [503, 200];
    judgeStatuses = { judge_a: [503, 503, 503], judge_b: [200] };
    expect(await upload()).toMatchObject({
      uploaded: 1,
      unchanged: 1,
      validated: ["judge_b"],
      skipped: [
        {
          check: "judge_a",
          reason: expect.stringContaining("validation failed"),
        },
        { check: "judge_silent" },
      ],
    });
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(2);
    expect(requests.filter((r) => r.body.check === "judge_a")).toHaveLength(3);
    expect(requests.filter((r) => r.body.check === "judge_b")).toHaveLength(1);
    expect(logs.some((entry) => entry.message.includes(T.agent))).toBe(false);
  });

  test("a declared suite labels file reaches the real hub after runJob finishes", async () => {
    realHub = startHub({ port: 0, dbPath: join(tmp, "hub.db"), tokens: T });
    const repo = join(tmp, "demo-repo");
    const init = Bun.spawnSync([
      "bun",
      join(ROOT, "src", "cli.ts"),
      "init",
      repo,
      "--name",
      "demo",
    ]);
    expect(init.exitCode).toBe(0);
    const suiteFile = join(repo, "weigh", "demo.suite.ts");
    writeFileSync(
      suiteFile,
      `import { emptyUsage } from "./types.ts";
      export default {
        name: "demo", description: "Label upload tracer",
        cases: async () => [1, 2].map(n => ({ id: "c" + n, input: n })),
        variants: ["a", "b"].map(name => ({ name, description: "Deterministic",
          run: async c => ({ output: c.input, usage: emptyUsage("fake") }) })),
        checks: [
          { id: "exact", description: "Has output", kind: "code", test: () => true },
          { id: "judge_a", description: "First case passes", kind: "judge", test: c => c.input === 1 },
        ],
        baseline: "a", candidate: "b", labels: "weigh/labels/demo.jsonl",
      };`,
    );
    mkdirSync(join(repo, "weigh", "labels"));
    const labels: LabelRow[] = [
      { case_id: "c1", variant: "b", human: "pass" },
      { case_id: "c2", variant: "b", human: "fail" },
    ];
    writeFileSync(
      join(repo, "weigh", "labels", "demo.jsonl"),
      labels.map((row) => JSON.stringify(row)).join("\n"),
    );
    const hub = new HubClient(realHub.url, T.agent);
    await hub.register({
      agent_id: "imac",
      version: "test",
      projects: [
        {
          id: "demo",
          suites: [
            {
              name: "demo",
              path: "weigh/demo.suite.ts",
              description: "Label upload tracer",
              info: {},
            },
          ],
        },
      ],
    });
    const queued = await fetch(`${realHub.url}/api/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${T.admin}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        project: "demo",
        suite: "demo",
        run_id: "labels",
      }),
    });
    expect(queued.status).toBe(201);
    const job = await hub.claim("imac", 1);
    expect(job).toBeDefined();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const status = await runJob({
      hub,
      job: job!,
      agentId: "imac",
      suiteFile,
      checkout: repo,
      runsDir: join(tmp, "runs"),
      weighHome: ROOT,
      env: { ...env, WEIGH_AGENT_TOKEN: T.agent },
      heartbeatMs: 60_000,
      log,
    });
    expect(status).toBe("finished");
    const key = runKey("demo", "labels");
    expect(realHub.store.labels(key)).toMatchObject(labels);
    expect(realHub.store.judges(key)).toEqual([
      expect.objectContaining({ check: "judge_a", joined: labels.length }),
    ]);
    expect(logs.some((entry) => entry.message.includes(T.agent))).toBe(false);
  });
});

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

describe("agent re-registration", () => {
  type Registration = {
    projects: { id: string; suites: { name: string }[] }[];
  };
  let stub: ReturnType<typeof Bun.serve>;
  let tmp: string;
  let checkout: string;
  let config: string;
  let events: string[];
  let bodies: Registration[];
  let lines: string[];
  let statuses: number[];
  let registerCount: number;
  let moveOnFirst409: boolean;

  beforeAll(() => {
    process.env.WEIGH_AGENT_TOKEN = "agent-token";
  });
  afterAll(() => {
    delete process.env.WEIGH_AGENT_TOKEN;
  });
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "weigh-agent-reregister-"));
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
    events = [];
    bodies = [];
    lines = [];
    statuses = [];
    registerCount = 0;
    moveOnFirst409 = false;
    let known = false;
    let forgotStartup = false;
    let claimed = false;
    stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (req.method === "POST" && path === "/api/agent/register") {
          registerCount++;
          const body = (await req.json()) as Registration;
          bodies.push(body);
          const status = statuses.shift() ?? 200;
          events.push(`register:${status}`);
          if (status !== 200)
            return Response.json({ error: "hub rolling out" }, { status });
          known = true;
          if (!forgotStartup) {
            known = false;
            forgotStartup = true;
          }
          return Response.json({
            projects: body.projects.length,
            suites: body.projects.reduce((n, p) => n + p.suites.length, 0),
          });
        }
        if (req.method === "GET" && path === "/api/agent/jobs") {
          const status = known ? 204 : 409;
          events.push(`claim:${status}`);
          if (!claimed && status === 409 && moveOnFirst409)
            renameSync(checkout, `${checkout}-moved`);
          claimed = true;
          return known
            ? new Response(null, { status })
            : Response.json({ error: "register first" }, { status });
        }
        return new Response("not found", { status: 404 });
      },
    });
    config = join(tmp, "agent.json");
    writeFileSync(
      config,
      JSON.stringify({
        hub: stub.url.toString(),
        agent_id: "test-agent",
        weigh_home: ROOT,
        workdir: join(tmp, "work"),
        runs_dir: join(tmp, "runs"),
        projects: [{ id: "demo", path: checkout, pull: false }],
        poll_wait_s: 1,
      }),
    );
  });
  afterEach(() => {
    stub.stop(true);
    if (existsSync(`${checkout}-moved`))
      renameSync(`${checkout}-moved`, checkout);
    rmSync(tmp, { recursive: true, force: true });
  });

  const once = () =>
    startAgent(config, {
      once: true,
      retryDelayMs: 10,
      log: (s) => lines.push(s),
    });

  test("re-registers after a 409 before claiming again", async () => {
    await once();
    expect(events).toEqual([
      "register:200",
      "claim:409",
      "register:200",
      "claim:204",
    ]);
    expect(registerCount).toBe(2);
    expect(bodies[1]!.projects).toEqual([
      {
        id: "demo",
        suites: expect.arrayContaining([
          expect.objectContaining({ name: "demo" }),
        ]),
      },
    ]);
    expect(lines.filter((s) => s.startsWith("[warn] claim:"))).toEqual([
      expect.stringMatching(/409.*register first/),
    ]);
    expect(
      lines.filter((s) => /\[info\] registered 1 project\(s\) with /.test(s)),
    ).toHaveLength(2);
    expect(
      lines.filter((s) => s.startsWith("[info] demo @ ")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("a failed register during a rollout is logged and retried on the next loop", async () => {
    statuses = [200, 503, 200];
    await once();
    expect(events).toEqual([
      "register:200",
      "claim:409",
      "register:503",
      "claim:409",
      "register:200",
      "claim:204",
    ]);
    for (const [i, event] of events.entries())
      if (event === "claim:409") expect(events[i + 1]).toMatch(/^register:/);
    expect(lines.filter((s) => s.startsWith("[warn] register:"))).toEqual([
      expect.stringMatching(/503.*hub rolling out/),
    ]);
  });

  test("a checkout that fails during re-register keeps the previous registration instead of posting an empty list", async () => {
    moveOnFirst409 = true;
    await once();
    expect(registerCount).toBe(2);
    const first = bodies[0]!.projects;
    const second = bodies[1]!.projects;
    expect(
      first.map((p) => ({ id: p.id, names: p.suites.map((s) => s.name) })),
    ).toEqual([{ id: "demo", names: ["demo"] }]);
    expect(second).toEqual(first);
    expect(lines.filter((s) => s.startsWith("[warn] demo:"))).toEqual([
      expect.stringContaining("keeping its previous registration"),
    ]);
  });
});

describe("agent once with a missing checkout", () => {
  let hub: ReturnType<typeof startHub> | undefined;
  let tmp: string;
  let previousToken: string | undefined;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "weigh-agent-missing-"));
    previousToken = process.env.WEIGH_AGENT_TOKEN;
    process.env.WEIGH_AGENT_TOKEN = T.agent;
    hub = startHub({ port: 0, dbPath: join(tmp, "hub.db"), tokens: T });
  });
  afterAll(() => {
    if (previousToken === undefined) delete process.env.WEIGH_AGENT_TOKEN;
    else process.env.WEIGH_AGENT_TOKEN = previousToken;
    hub?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("settles after two register-first retries when registration keeps failing", async () => {
    const config = join(tmp, "agent.json");
    writeFileSync(
      config,
      JSON.stringify({
        hub: hub!.url,
        agent_id: "test-agent",
        weigh_home: ROOT,
        workdir: join(tmp, "work"),
        runs_dir: join(tmp, "runs"),
        projects: [{ id: "demo", path: join(tmp, "missing"), pull: false }],
        poll_wait_s: 1,
      }),
    );
    const lines: string[] = [];
    const ac = new AbortController();
    const agent = startAgent(config, {
      once: true,
      retryDelayMs: 10,
      log: (line) => lines.push(line),
      signal: ac.signal,
    }).then(() => "resolved");
    let outcome: string | undefined;
    try {
      outcome = await Promise.race([
        agent,
        Bun.sleep(5000).then(() => "timeout"),
      ]);
      expect(outcome).toBe("resolved");
      const claims = lines.filter((line) => line.startsWith("[warn] claim:"));
      expect(claims).toHaveLength(3);
      for (const claim of claims) expect(claim).toMatch(/register first/);
    } finally {
      ac.abort();
      if (outcome === "timeout") await agent;
    }
  });
});

describe("agent once with an unavailable hub", () => {
  let tmp: string;
  let previousToken: string | undefined;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "weigh-agent-offline-"));
    previousToken = process.env.WEIGH_AGENT_TOKEN;
    process.env.WEIGH_AGENT_TOKEN = T.agent;
  });
  afterAll(() => {
    if (previousToken === undefined) delete process.env.WEIGH_AGENT_TOKEN;
    else process.env.WEIGH_AGENT_TOKEN = previousToken;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("settles after a failed claim instead of retrying forever", async () => {
    const checkout = join(tmp, "demo-repo");
    const init = Bun.spawnSync([
      "bun",
      join(ROOT, "src", "cli.ts"),
      "init",
      checkout,
      "--name",
      "demo",
    ]);
    if (init.exitCode !== 0) throw new Error(init.stderr.toString());
    const s = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = s.port;
    s.stop(true);
    const config = join(tmp, "agent.json");
    writeFileSync(
      config,
      JSON.stringify({
        hub: `http://127.0.0.1:${port}`,
        agent_id: "test-agent",
        weigh_home: ROOT,
        workdir: join(tmp, "work"),
        runs_dir: join(tmp, "runs"),
        projects: [{ id: "demo", path: checkout, pull: false }],
        poll_wait_s: 1,
      }),
    );
    // Reach the claim seam instead of rejecting during startup registration.
    const register = spyOn(HubClient.prototype, "register").mockResolvedValue({
      projects: 1,
      suites: 1,
    });
    const lines: string[] = [];
    const ac = new AbortController();
    const agent = startAgent(config, {
      once: true,
      retryDelayMs: 10,
      log: (line) => lines.push(line),
      signal: ac.signal,
    }).then(
      () => "resolved",
      () => "rejected",
    );
    let outcome: string | undefined;
    try {
      outcome = await Promise.race([
        agent,
        Bun.sleep(5000).then(() => "timeout"),
      ]);
      expect(outcome).toBe("resolved");
      expect(register).toHaveBeenCalled();
      expect(
        lines.filter((line) => line.startsWith("[warn] claim:")),
      ).toHaveLength(1);
    } finally {
      ac.abort();
      if (outcome === "timeout") await agent;
      register.mockRestore();
    }
  });
});

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
    rmSync(tmp, { recursive: true, force: true });
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
    // Register the suites before enqueueing so this test can run first.
    await once();
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

  test("the recovery sweep uploads judges under the agent's id and finishes another agent's run without them", async () => {
    const records = readJudges(
      join(ROOT, "runs", "examples", "exchange-triage-2026-10-19"),
    );
    const client = new HubClient(hub.url, T.agent);
    const sweptDir = (runId: string): string => {
      const runDir = join(tmp, "runs", "demo", runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, ".hub-cursor"),
        JSON.stringify({ src_seq: 0, outputs_acked: [] }),
      );
      writeFileSync(
        join(runDir, "run.json"),
        JSON.stringify({ finished_at: "2026-10-22T00:00:00Z" }),
      );
      writeFileSync(
        join(runDir, "judges.json"),
        JSON.stringify(Object.fromEntries(records.map((j) => [j.check, j]))),
      );
      return runDir;
    };
    for (const [runId, owner] of [
      ["swept-own", "test-agent"],
      ["swept-other", "other-agent"],
    ] as const) {
      await client.createRun({
        project: "demo",
        suite: "demo",
        run_id: runId,
        agent_id: owner,
      });
      sweptDir(runId);
    }
    const lines: string[] = [];
    await startAgent(config, { once: true, log: (line) => lines.push(line) });
    const own = runKey("demo", "swept-own");
    expect(
      hub.store
        .judges(own)
        .map((j) => j.check)
        .sort(),
    ).toEqual(records.map((j) => j.check).sort());
    expect((await runJson("demo", "swept-own")).status).toBe("finished");
    expect(
      readFileSync(
        join(tmp, "runs", "demo", "swept-own", ".hub-cursor"),
        "utf8",
      ),
    ).toContain('"done":"finished"');
    // The hub refuses the judges of a run another agent owns; the sweep warns, finishes it and moves on.
    expect(hub.store.judges(runKey("demo", "swept-other"))).toEqual([]);
    expect((await runJson("demo", "swept-other")).status).toBe("finished");
    expect(
      readFileSync(
        join(tmp, "runs", "demo", "swept-other", ".hub-cursor"),
        "utf8",
      ),
    ).toContain('"done":"finished"');
    expect(
      lines.some((line) =>
        /\[warn\] judges: .*403.*not uploaded, finishing the run without them/.test(
          line,
        ),
      ),
    ).toBe(true);
    expect(lines.some((line) => line.includes(T.agent))).toBe(false);
  });
});
