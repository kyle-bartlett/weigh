import type { SQLQueryBindings } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENT_BATCH,
  HubClient,
  HubHttpError,
  importRunDir,
} from "../src/agent/upload.ts";
import { eventsFromTraces } from "../src/events.ts";
import { readMeta, readTraces } from "../src/run.ts";
import { startHub } from "../src/hub/server.ts";
import { runKey } from "../src/hub/store.ts";
import { readJudges } from "../src/report/build.ts";

const example = join(
  import.meta.dir,
  "..",
  "runs",
  "examples",
  "exchange-triage-2026-10-19",
);
const T = { admin: "admin-token", agent: "agent-token", read: "read-token" };

describe("hub", () => {
  let hub: ReturnType<typeof startHub>;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "weigh-hub-"));
    hub = startHub({
      port: 0,
      dbPath: join(dir, "hub.db"),
      tokens: T,
    });
  });
  afterAll(() => {
    try {
      hub?.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const get = (path: string, token?: string) =>
    fetch(hub.url + path, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  test("import replays the committed run; the pages and API show it; a second import changes nothing", async () => {
    const client = new HubClient(hub.url, T.agent);
    const r = await importRunDir(client, example, {
      project: "exchange-triage",
    });
    expect(r.suite).toBe("exchange-triage");
    expect(r.events).toBe(110);
    expect(r.outputs).toBe(0);
    expect(r.judges).toBe(2);

    expect(await (await get("/")).text()).not.toContain(
      'href="/p/exchange-triage"',
    );
    expect(await (await get("/", T.read)).text()).toContain(
      'href="/p/exchange-triage"',
    );

    // Private until an admin flips it.
    expect((await get("/r/exchange-triage/2026-10-19-prompts")).status).toBe(
      404,
    );
    expect(
      (await get("/api/runs/exchange-triage/2026-10-19-prompts")).status,
    ).toBe(404);
    expect(
      (await get("/r/exchange-triage/2026-10-19-prompts", T.read)).status,
    ).toBe(200);
    const noAuth = await fetch(hub.url + "/api/projects", {
      method: "POST",
      body: JSON.stringify({ id: "exchange-triage", public: true }),
    });
    expect(noAuth.status).toBe(401);
    const wrong = await fetch(hub.url + "/api/projects", {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: JSON.stringify({ id: "exchange-triage", public: true }),
    });
    expect(wrong.status).toBe(401);
    const ok = await fetch(hub.url + "/api/projects", {
      method: "POST",
      headers: { authorization: `Bearer ${T.admin}` },
      body: JSON.stringify({
        id: "exchange-triage",
        name: "Exchange Triage",
        description: "Insurance submission triage prompts",
        public: true,
      }),
    });
    expect(ok.status).toBe(201);

    const run = (await (
      await get("/api/runs/exchange-triage/2026-10-19-prompts")
    ).json()) as {
      status: string;
      finished: number;
      total: number;
      meta: { case_order: string[] };
      summary: { pass: boolean; paired_n: number };
    };
    expect(run.status).toBe("finished");
    expect(run.total).toBe(108);
    expect(run.finished).toBe(108);
    expect(run.meta.case_order).toHaveLength(27);
    expect(run.summary.pass).toBe(true);
    expect(run.summary.paired_n).toBe(27);

    const page = await (
      await get("/r/exchange-triage/2026-10-19-prompts")
    ).text();
    expect(page).toContain("Ship it");
    expect(page.match(/data-case="/g)).toHaveLength(27);
    expect(page).not.toMatch(/[—–]/);
    expect(page).toContain("attribution_jev");
    const home = await (await get("/")).text();
    expect(home).toContain("Exchange Triage");
    const proj = await (await get("/p/exchange-triage")).text();
    expect(proj).toContain("2026-10-19-prompts");
    const casePage = await (
      await get("/r/exchange-triage/2026-10-19-prompts/c/GOLD-01")
    ).text();
    expect(casePage).toContain("Output not archived");
    // An archived output renders on the case page as the model's text.
    await client.putOutput(
      "exchange-triage",
      "2026-10-19-prompts",
      "v3",
      "GOLD-01",
      "abc",
      JSON.stringify({
        output: {
          fields: [
            {
              field: "construction",
              expected: "Joisted Masonry",
              got: "Joisted Masonry",
              correct: true,
            },
          ],
          decision: "IN APPETITE",
          expectedDecision: "IN APPETITE",
          decisionCorrect: true,
          note: "archived output text",
        },
        usage: {},
      }),
    );
    const withOutput = await (
      await get("/r/exchange-triage/2026-10-19-prompts/c/GOLD-01")
    ).text();
    expect(withOutput).toContain("archived output text");
    expect(withOutput.split('<details id="engineers">')[0]).toContain(
      'Joisted Masonry<span class="field-verdict">Matches the expert</span>',
    );
    expect(casePage).toContain("Maple Row Apartments");
    expect(
      (await get("/r/exchange-triage/2026-10-19-prompts/report.html")).status,
    ).toBe(200);
    const frag = (await (
      await get("/r/exchange-triage/2026-10-19-prompts/fragments")
    ).json()) as Record<string, string>;
    expect(frag.verdict).toContain("Ship it");
    expect(frag.ledger!.match(/data-case="/g)).toHaveLength(27);
    expect((await get("/web/run.js")).status).toBe(200);
    const fromV1 = await (
      await get("/r/exchange-triage/2026-10-19-prompts?baseline=v1")
    ).text();
    expect(fromV1).toContain("Don't ship");

    // SSE on a finished run replays run_start through run_done, then the hub's summary and status, then ends.
    const sse = await (
      await get("/api/runs/exchange-triage/2026-10-19-prompts/events")
    ).text();
    const types = [...sse.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
    expect(types[0]).toBe("run_start");
    expect(types.filter((t) => t === "job_done")).toHaveLength(108);
    expect(types).toContain("run_done");
    expect(types).toContain("summary");
    for (const frame of sse.split("\n\n")) {
      if (!/^event: summary$/m.test(frame)) continue;
      const payload: Record<string, unknown> = JSON.parse(
        frame.match(/^data: (.+)$/m)![1]!,
      );
      expect(payload).not.toHaveProperty("html");
      for (const key of ["cmp", "gate", "paired_n"])
        expect(payload).toHaveProperty(key);
    }
    expect(types.at(-1)).toBe("end");
    const ids = [...sse.matchAll(/^id: (\d+)/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual(ids.map((_, i) => i + 1));

    const again = await importRunDir(client, example, {
      project: "exchange-triage",
    });
    expect(again.accepted).toBe(0);
    const after = (await (
      await get("/api/runs/exchange-triage/2026-10-19-prompts")
    ).json()) as { last_seq: number };
    expect(after.last_seq).toBe(ids.at(-1)!);
  });

  test("agent endpoints refuse the read token and public pages reject unknown routes", async () => {
    const res = await fetch(hub.url + "/api/agent/runs", {
      method: "POST",
      headers: { authorization: `Bearer ${T.read}` },
      body: JSON.stringify({ project: "x", suite: "y", run_id: "z" }),
    });
    expect(res.status).toBe(401);
    expect((await get("/nope")).status).toBe(404);
    expect((await get("/mcp")).status).toBe(405);
    expect((await get("/healthz")).status).toBe(200);
  });
});

describe("hub labels", () => {
  let hub: ReturnType<typeof startHub>;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "weigh-hub-labels-"));
    hub = startHub({ port: 0, dbPath: join(dir, "hub.db"), tokens: T });
    await importRunDir(new HubClient(hub.url, T.agent), example, {
      project: "exchange-triage",
    });
  });
  afterAll(() => {
    try {
      hub?.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const get = (path: string, token?: string) =>
    fetch(hub.url + path, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  test("labels upsert on the hub and judge validation reproduces the committed numbers", async () => {
    const rows = readFileSync(
      join(import.meta.dir, "..", "suites", "exchange-triage.labels.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const put = await fetch(
      hub.url + "/api/runs/exchange-triage/2026-10-19-prompts/labels",
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${T.admin}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ labels: rows }),
      },
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { total: number }).total).toBe(54);
    const again = await fetch(
      hub.url + "/api/runs/exchange-triage/2026-10-19-prompts/labels",
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${T.admin}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ labels: [{ ...rows[0], note: "changed" }] }),
      },
    );
    expect(((await again.json()) as { total: number }).total).toBe(54);
    const v = await fetch(
      hub.url + "/api/runs/exchange-triage/2026-10-19-prompts/judges/validate",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${T.admin}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ check: "attribution_jev" }),
      },
    );
    expect(v.status).toBe(200);
    const rec = (await v.json()) as {
      joined: number;
      splits: { split: string; tpr: number; tnr: number; n: number }[];
    };
    const all = rec.splits.find((s) => s.split === "all")!;
    expect(rec.joined).toBe(54);
    expect(all.n).toBe(54);
    expect(all.tpr).toBeCloseTo(0.5);
    expect(all.tnr).toBeCloseTo(1);
    expect(
      (await get("/r/exchange-triage/2026-10-19-prompts/labels", T.read))
        .status,
    ).toBe(401);
    const page = await (
      await get("/r/exchange-triage/2026-10-19-prompts/labels", T.admin)
    ).text();
    expect(page).toContain("labels-data");
    expect(page).toContain("/web/labels.js");
  });
});

describe("hub legacy summary replay", () => {
  let hub: ReturnType<typeof startHub>;
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "weigh-hub-legacy-"));
    hub = startHub({ port: 0, dbPath: join(tmp, "hub.db"), tokens: T });
  });
  afterAll(() => {
    hub?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("omits pre-#7 HTML from SSE without rewriting the stored summary", async () => {
    const suite = "legacy";
    const runId = "old-run";
    const key = `${suite}/${runId}`;
    hub.store.upsertProject({ id: "legacy", public: true });
    hub.store.createRun({
      key,
      project_id: "legacy",
      suite,
      run_id: runId,
      status: "finished",
    });
    const legacy = {
      type: "summary",
      cmp: { baseline: "a", candidate: "b" },
      gate: { pass: true, reasons: [] },
      paired_n: 2,
      at: "2026-10-19T00:00:00.000Z",
      html: {
        verdict: "<b>v</b>",
        proof: "<p>p</p>",
        checks: "<table></table>",
      },
    };
    const payloadJson = JSON.stringify(legacy);
    hub.store.db.run(
      "INSERT INTO events (run_key, seq, source, src_seq, type, at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [key, 1, "hub", 1, legacy.type, legacy.at, payloadJson],
    );
    const response = await fetch(
      `${hub.url}/api/runs/${suite}/${runId}/events`,
      { headers: { authorization: `Bearer ${T.read}` } },
    );
    expect(response.status).toBe(200);
    const summary = (await response.text())
      .split("\n\n")
      .find((frame) => /^event: summary$/m.test(frame));
    expect(summary).toBeDefined();
    const payload: Record<string, unknown> = JSON.parse(
      summary!.match(/^data: (.+)$/m)![1]!,
    );
    expect(payload).not.toHaveProperty("html");
    expect(payload.cmp).toEqual(legacy.cmp);
    expect(payload.gate).toEqual(legacy.gate);
    expect(payload.paired_n).toBe(legacy.paired_n);
    const stored = hub.store.db
      .query<
        { payload_json: string },
        [string]
      >("SELECT payload_json FROM events WHERE run_key = ? AND seq = 1")
      .get(key);
    expect(stored?.payload_json).toBe(payloadJson);
    expect(JSON.parse(stored!.payload_json).html).toEqual(legacy.html);
  });
});

describe("agent labels and judge validation", () => {
  let hub: ReturnType<typeof startHub>;
  let client: HubClient;
  const dir = mkdtempSync(join(tmpdir(), "weigh-agent-labels-"));
  const suite = "exchange-triage";
  const check = "attribution_jev";
  const rows: unknown[] = readFileSync(
    join(import.meta.dir, "..", "suites", "exchange-triage.labels.jsonl"),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.trim())
    .map((line): unknown => JSON.parse(line));
  const operations = [
    { method: "PUT", suffix: "/labels", body: { labels: rows } },
    { method: "POST", suffix: "/judges/validate", body: { check } },
  ];
  const call = (
    method: string,
    path: string,
    body?: unknown,
    token: string = T.agent,
  ): Promise<Response> =>
    fetch(hub.url + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const path = (runId: string, suffix: string, agent = true): string =>
    `/api/${agent ? "agent/" : ""}runs/${suite}/${runId}${suffix}`;
  const snapshot = (runId: string) => {
    const key = runKey(suite, runId);
    return {
      labels: hub.store.labels(key),
      judges: hub.store.judges(key),
      run: hub.store.getRun(key),
    };
  };
  const claimedRun = async (runId: string): Promise<void> => {
    const queued = await call(
      "POST",
      "/api/runs",
      {
        project: "demo",
        suite,
        run_id: runId,
      },
      T.admin,
    );
    expect(queued.status).toBe(201);
    const job = await client.claim("imac", 1);
    expect(job?.run_id).toBe(runId);
    expect(hub.store.getRun(runKey(suite, runId))?.agent_id).toBe("imac");
    // The committed example has no events.jsonl; use the importer's trace replay fallback.
    const events = eventsFromTraces(
      { ...readMeta(example), run_id: runId },
      readTraces(example).map((line) => ({ ...line, run_id: runId })),
    );
    for (let i = 0; i < events.length; i += EVENT_BATCH) {
      const batch = events.slice(i, i + EVENT_BATCH);
      // Ingest may store derived events next to the batch, so accepted can exceed its length.
      expect(
        (await client.postEvents(suite, runId, batch)).accepted,
      ).toBeGreaterThanOrEqual(batch.length);
    }
    expect(hub.store.getRun(runKey(suite, runId))?.agent_id).toBe("imac");
    expect(
      hub.store
        .traces(runKey(suite, runId))
        .some(
          (line) =>
            line.run_id === runId && typeof line.checks[check] === "boolean",
        ),
    ).toBe(true);
  };

  beforeAll(async () => {
    hub = startHub({ port: 0, dbPath: join(dir, "hub.db"), tokens: T });
    client = new HubClient(hub.url, T.agent);
    await client.register({
      agent_id: "imac",
      version: "t",
      projects: [
        {
          id: "demo",
          suites: [
            {
              name: suite,
              path: "weigh/x.suite.ts",
              description: "d",
              info: {},
            },
          ],
        },
      ],
    });
    await claimedRun("owned");
  });
  afterAll(() => {
    try {
      hub?.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("owner uploads labels and validates joined verdicts through both client methods", async () => {
    const put = await call("PUT", path("owned", "/labels"), {
      agent_id: "imac",
      labels: [
        ...rows,
        null,
        {},
        { case_id: "bad", variant: "v", human: "maybe" },
      ],
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ inserted: 54, skipped: 0, total: 54 });
    expect(snapshot("owned").labels).toHaveLength(54);
    const validated = await call("POST", path("owned", "/judges/validate"), {
      agent_id: "imac",
      check,
    });
    expect(validated.status).toBe(200);
    const record = (await validated.json()) as Record<string, unknown>;
    expect(record.joined).toBe(54);
    expect<unknown>(
      snapshot("owned").judges.find((j) => j.check === check),
    ).toEqual(record);
    // A repeat upload leaves every existing row alone.
    expect(await client.putLabels(suite, "owned", "imac", rows)).toEqual({
      inserted: 0,
      skipped: 54,
      total: 54,
    });
    const clientRecord = await client.validateJudge(
      suite,
      "owned",
      "imac",
      check,
    );
    expect(clientRecord.joined).toBe(54);
    expect<unknown>(
      snapshot("owned").judges.find((j) => j.check === check),
    ).toEqual(clientRecord);
  });

  test("another agent and an unowned run reject both writes without side effects", async () => {
    await client.createRun({ project: "demo", suite, run_id: "unowned" });
    expect(snapshot("unowned").run?.agent_id).toBeFalsy();
    for (const [runId, agentId] of [
      ["owned", "other"],
      ["unowned", "imac"],
    ] as const) {
      const before = snapshot(runId);
      for (const op of operations) {
        const response = await call(op.method, path(runId, op.suffix), {
          ...op.body,
          agent_id: agentId,
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: "run belongs to another agent",
        });
        expect(snapshot(runId)).toEqual(before);
      }
    }
  });

  test("read and anonymous callers get 401 before body or run validation", async () => {
    const before = snapshot("owned");
    for (const token of [T.read, ""]) {
      for (const runId of ["owned", "missing"]) {
        for (const op of operations) {
          const response = await call(
            op.method,
            path(runId, op.suffix),
            { agent_id: "Bad ID" },
            token,
          );
          expect(response.status).toBe(401);
          expect(await response.json()).toEqual({ error: "unauthorized" });
          expect(snapshot("owned")).toEqual(before);
          expect(snapshot("missing").run).toBeUndefined();
        }
      }
    }
  });

  test("missing, malformed and non-string agent ids get 400 without writes", async () => {
    const before = snapshot("owned");
    for (const agentId of [
      undefined,
      null,
      "",
      "IMAC",
      "-imac",
      "im_ac",
      123,
      ["imac"],
    ]) {
      for (const op of operations) {
        const response = await call(op.method, path("owned", op.suffix), {
          ...op.body,
          agent_id: agentId,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "agent_id must be a slug",
        });
        expect(snapshot("owned")).toEqual(before);
      }
    }
  });

  test("authorized callers get 404 for a missing run without creating one", async () => {
    const before = snapshot("owned");
    for (const token of [T.agent, T.admin]) {
      for (const op of operations) {
        const response = await call(
          op.method,
          path("missing", op.suffix),
          { ...op.body, agent_id: "imac" },
          token,
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "no such run" });
        expect(snapshot("missing").run).toBeUndefined();
        expect(snapshot("missing").labels).toEqual([]);
        expect(snapshot("missing").judges).toEqual([]);
        expect(snapshot("owned")).toEqual(before);
      }
    }
  });

  test("admins bypass agent identity and ownership on the new routes", async () => {
    const { run_id: runId } = await importRunDir(client, example, {
      project: "demo",
    });
    expect(snapshot(runId).run?.agent_id).toBeFalsy();
    for (const [i, agentId] of [undefined, "Bad ID", "other"].entries()) {
      const put = await call(
        "PUT",
        path(runId, "/labels"),
        { agent_id: agentId, labels: rows },
        T.admin,
      );
      expect(put.status).toBe(200);
      // The agent route only inserts, whoever calls it: later passes find every row already there.
      expect(await put.json()).toEqual(
        i === 0
          ? { inserted: 54, skipped: 0, total: 54 }
          : { inserted: 0, skipped: 54, total: 54 },
      );
      expect(snapshot(runId).labels).toHaveLength(54);
      const validated = await call(
        "POST",
        path(runId, "/judges/validate"),
        { agent_id: agentId, check },
        T.admin,
      );
      expect(validated.status).toBe(200);
      const record = (await validated.json()) as Record<string, unknown>;
      expect(record.joined).toBe(54);
      expect<unknown>(
        snapshot(runId).judges.find((j) => j.check === check),
      ).toEqual(record);
    }
  });

  test("unknown and missing checks return identical 400 errors on admin and agent routes", async () => {
    const before = snapshot("owned");
    for (const agent of [true, false]) {
      for (const invalid of ["missing-check", "", undefined]) {
        const response = await call(
          "POST",
          path("owned", "/judges/validate", agent),
          { agent_id: "imac", check: invalid },
          agent ? T.agent : T.admin,
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "check must name a check of this run",
        });
        expect(snapshot("owned")).toEqual(before);
      }
    }
  });

  test("both conflict paths preserve records and reach clients as HubHttpError 409", async () => {
    await claimedRun("conflict");
    await client.putJudges(suite, "conflict", readJudges(example));
    for (const absent of [false, true]) {
      if (absent) {
        expect(
          await client.putLabels(suite, "conflict", "imac", [
            { case_id: "GOLD-01", variant: "absent", human: "pass" },
          ]),
        ).toEqual({ inserted: 1, skipped: 0, total: 1 });
      }
      const before = snapshot("conflict");
      const message = absent
        ? `no label matched a verdict of ${check}; nothing stored`
        : "no labels on this run";
      for (const agent of [true, false]) {
        const response = await call(
          "POST",
          path("conflict", "/judges/validate", agent),
          { agent_id: "imac", check },
          agent ? T.agent : T.admin,
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: message });
        expect(snapshot("conflict")).toEqual(before);
      }
      const error: unknown = await client
        .validateJudge(suite, "conflict", "imac", check)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(HubHttpError);
      if (!(error instanceof HubHttpError))
        throw new Error("expected HubHttpError");
      expect(error.status).toBe(409);
      expect(error.message).toBe(
        `POST ${path("conflict", "/judges/validate")}: 409 ${JSON.stringify({ error: message })}`,
      );
      expect(snapshot("conflict")).toEqual(before);
    }
  });

  test("the agent never overwrites a person's label, even to move its split", async () => {
    await claimedRun("guarded");
    const person = {
      case_id: "GOLD-01",
      variant: "v3",
      human: "pass",
      note: "admin reviewed",
      split: "test",
    };
    const admin = await call(
      "PUT",
      path("guarded", "/labels", false),
      { labels: [person] },
      T.admin,
    );
    expect(admin.status).toBe(200);
    const before = snapshot("guarded").labels;
    expect(before).toEqual([expect.objectContaining(person)]);
    for (const split of [undefined, "train"]) {
      const put = await call("PUT", path("guarded", "/labels"), {
        agent_id: "imac",
        labels: [{ case_id: "GOLD-01", variant: "v3", human: "fail", split }],
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ inserted: 0, skipped: 1, total: 1 });
      expect(snapshot("guarded").labels).toEqual(before);
    }
  });

  test("admin labels round trip with null splits while preserving existing splits", async () => {
    const runId = "null-splits";
    await claimedRun(runId);
    const person = {
      case_id: "GOLD-01",
      variant: "v3",
      human: "pass",
      note: "admin reviewed",
      split: "dev",
    };
    const put = await call(
      "PUT",
      path(runId, "/labels", false),
      { labels: [person] },
      T.admin,
    );
    expect(put.status).toBe(200);
    const get = await call(
      "GET",
      path(runId, "/labels", false),
      undefined,
      T.admin,
    );
    expect(get.status).toBe(200);
    const body = (await get.json()) as (typeof person)[];
    for (const labels of [body.map((row) => ({ ...row, split: null })), body]) {
      const response = await call(
        "PUT",
        path(runId, "/labels", false),
        { labels },
        T.admin,
      );
      expect(response.status).toBe(200);
      expect(snapshot(runId).labels).toEqual([expect.objectContaining(person)]);
    }
    const fresh = {
      case_id: "GOLD-02",
      variant: "v3",
      human: "fail",
      note: "new label",
    };
    const added = await call(
      "PUT",
      path(runId, "/labels", false),
      { labels: [{ ...fresh, split: null }] },
      T.admin,
    );
    expect(added.status).toBe(200);
    expect(snapshot(runId).labels).toEqual([
      expect.objectContaining(person),
      expect.objectContaining({ ...fresh, split: undefined }),
    ]);
  });

  test("labels with an unknown split are refused on both routes", async () => {
    await claimedRun("splits");
    for (const split of ["all", "bogus"]) {
      const row = { case_id: "GOLD-02", variant: "v3", human: "pass", split };
      const agent = await call("PUT", path("splits", "/labels"), {
        agent_id: "imac",
        labels: [row],
      });
      expect(agent.status).toBe(400);
      const admin = await call(
        "PUT",
        path("splits", "/labels", false),
        { labels: [row] },
        T.admin,
      );
      expect(admin.status).toBe(400);
    }
    expect(snapshot("splits").labels).toEqual([]);
  });

  test("existing admin write routes still reject the agent token", async () => {
    const before = snapshot("owned");
    for (const op of operations) {
      const response = await call(op.method, path("owned", op.suffix, false), {
        ...op.body,
        agent_id: "imac",
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(snapshot("owned")).toEqual(before);
    }
  });
});

describe("hub judge records", () => {
  let hub: ReturnType<typeof startHub>;
  let dir: string;
  const runPath = "/api/runs/exchange-triage/2026-10-19-prompts";
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "weigh-hub-"));
    hub = startHub({
      port: 0,
      dbPath: join(dir, "hub.db"),
      tokens: T,
    });
    await importRunDir(new HubClient(hub.url, T.agent), example, {
      project: "exchange-triage",
    });
  });
  afterAll(() => {
    try {
      hub?.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetch(hub.url + runPath + path, {
      method,
      headers: {
        authorization: `Bearer ${T.admin}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const snapshot = (): (() => void) => {
    const key = runKey("exchange-triage", "2026-10-19-prompts");
    const db = hub.store.db;
    const tables = (["labels", "judges"] as const).map((table) => ({
      table,
      rows: db
        .query<
          Record<string, SQLQueryBindings>,
          [string]
        >(`SELECT * FROM ${table} WHERE run_key = ?`)
        .all(key),
    }));
    return db.transaction(() => {
      for (const { table, rows } of tables) {
        db.run(`DELETE FROM ${table} WHERE run_key = ?`, [key]);
        for (const row of rows) {
          const columns = Object.keys(row);
          db.run(
            `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
            Object.values(row),
          );
        }
      }
    });
  };

  const judges = async () =>
    (
      (await (await call("GET", "/summary")).json()) as {
        judges: { check: string; joined: number }[];
      }
    ).judges;

  test("validate refuses a check no label joined and keeps the stored record", async () => {
    const restore = snapshot();
    try {
      const before = await judges();
      expect(before.find((j) => j.check === "attribution_jev")?.joined).toBe(
        54,
      );
      // A label on a variant with no trace has no verdict to join, like an all-unanswered judge.
      const put = await call("PUT", "/labels", {
        labels: [{ case_id: "GOLD-01", variant: "absent", human: "pass" }],
      });
      expect(put.status).toBe(200);
      const v = await call("POST", "/judges/validate", {
        check: "attribution_jev",
      });
      expect(v.status).toBe(409);
      expect(await v.text()).toContain("attribution_jev");
      expect(await judges()).toEqual(before);
    } finally {
      restore();
    }
  });

  test("DELETE removes one judge record, then reports nothing left to remove", async () => {
    const restore = snapshot();
    try {
      const del = await call("DELETE", "/judges/attribution_jev");
      expect(del.status).toBe(200);
      expect(await del.json()).toEqual({ ok: true, removed: 1 });
      expect((await judges()).map((j) => j.check)).toEqual([
        "attribution_claude",
      ]);
      const before = (await (await call("GET", "")).json()) as {
        last_seq: number;
      };
      const again = await call("DELETE", "/judges/attribution_jev");
      expect(await again.json()).toEqual({ ok: true, removed: 0 });
      const after = (await (await call("GET", "")).json()) as {
        last_seq: number;
      };
      expect(after.last_seq).toBe(before.last_seq);
      const asRead = await fetch(
        hub.url + runPath + "/judges/attribution_claude",
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${T.read}` },
        },
      );
      expect(asRead.status).toBe(401);
      expect((await judges()).map((j) => j.check)).toEqual([
        "attribution_claude",
      ]);
    } finally {
      restore();
    }
  });

  test("agent uploads keep checked records and warn about dropped records without overwriting", async () => {
    const restore = snapshot();
    try {
      const { key } = (await (await call("GET", "")).json()) as { key: string };
      const before = hub.store.judges(key);
      const original = before[0]!;
      const upload = (records: unknown[]) =>
        fetch(
          hub.url +
            runPath.replace("/api/runs/", "/api/agent/runs/") +
            "/judges",
          {
            method: "PUT",
            headers: {
              authorization: `Bearer ${T.agent}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ records }),
          },
        );
      const zero = { ...original, check: "zero_joined", joined: 0 };
      const mixed = await upload([original, zero]);
      expect(mixed.status).toBe(200);
      expect(await mixed.json()).toEqual({
        stored: 1,
        dropped: [zero.check],
        warn: "dropped 1 judge record(s) that joined no human label: zero_joined",
      });
      expect((await judges()).some((j) => j.check === zero.check)).toBe(false);
      expect(hub.store.judges(key)).toEqual(before);

      const dropped = await upload([
        { ...original, joined: 0 },
        { ...original, check: "string_joined", joined: "1" },
        { ...original, check: "missing_joined", joined: undefined },
        { ...original, check: "negative_joined", joined: -1 },
      ]);
      expect(await dropped.json()).toEqual({
        stored: 0,
        dropped: [
          original.check,
          "string_joined",
          "missing_joined",
          "negative_joined",
        ],
        warn: `dropped 4 judge record(s) that joined no human label: ${original.check}, string_joined, missing_joined, negative_joined`,
      });
      expect(hub.store.judges(key)).toEqual(before);
      const kept = await upload([original, { check: "bad_shape" }]);
      expect(await kept.json()).toEqual({ stored: 1 });
    } finally {
      restore();
    }
  });

  test("summary omits legacy zero-joined records stored directly", async () => {
    const restore = snapshot();
    try {
      const { key } = (await (await call("GET", "")).json()) as { key: string };
      const before = hub.store.judges(key);
      const zero = { ...before[0]!, check: "legacy_zero", joined: 0 };
      hub.store.putJudges(key, [zero]);
      expect(await judges()).toEqual(before);
      expect(hub.store.judges(key)).toContainEqual(zero);
    } finally {
      restore();
    }
  });

  test("DELETE rejects malformed check, case and variant path parameters", async () => {
    for (const [path, name] of [
      ["/judges/%E0%A4%A", "check"],
      ["/labels/%E0%A4%A/v3", "case"],
      ["/labels/GOLD-01/%E0%A4%A", "variant"],
    ]) {
      const response = await call("DELETE", path!);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(`malformed ${name} in path`);
    }
  });
});
