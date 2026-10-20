import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient, importRunDir } from "../src/agent/upload.ts";
import { startHub } from "../src/hub/server.ts";

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
  beforeAll(() => {
    hub = startHub({
      port: 0,
      dbPath: join(mkdtempSync(join(tmpdir(), "weigh-hub-")), "hub.db"),
      tokens: T,
    });
  });
  afterAll(() => hub.stop());

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
    expect(page).toContain("Gate passed");
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
    expect(casePage).toContain("Maple Row Apartments");
    expect(
      (await get("/r/exchange-triage/2026-10-19-prompts/report.html")).status,
    ).toBe(200);
    const fromV1 = await (
      await get("/r/exchange-triage/2026-10-19-prompts?baseline=v1")
    ).text();
    expect(fromV1).toContain("does not clear the gate");

    // SSE on a finished run replays run_start through run_done, then the hub's summary and status, then ends.
    const sse = await (
      await get("/api/runs/exchange-triage/2026-10-19-prompts/events")
    ).text();
    const types = [...sse.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
    expect(types[0]).toBe("run_start");
    expect(types.filter((t) => t === "job_done")).toHaveLength(108);
    expect(types).toContain("run_done");
    expect(types).toContain("summary");
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
