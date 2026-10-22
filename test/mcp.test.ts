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

describe("mcp", () => {
  let hub: ReturnType<typeof startHub>;
  beforeAll(async () => {
    hub = startHub({
      port: 0,
      dbPath: join(mkdtempSync(join(tmpdir(), "weigh-mcp-")), "hub.db"),
      tokens: T,
    });
    await importRunDir(new HubClient(hub.url, T.agent), example, {
      project: "exchange-triage",
    });
  });
  afterAll(() => hub.stop());

  const rpc = async (path: string, body: unknown, token?: string) =>
    fetch(hub.url + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2099-01-01",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  test("initialize, tools/list and tools/call over the bearer and the path token; 401 without either", async () => {
    expect(
      (
        await rpc("/mcp", {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        })
      ).status,
    ).toBe(401);
    const init = await (
      await rpc(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        },
        T.read,
      )
    ).json();
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.serverInfo.name).toBe("weigh");
    expect(
      (
        await rpc(
          "/mcp",
          { jsonrpc: "2.0", method: "notifications/initialized" },
          T.read,
        )
      ).status,
    ).toBe(202);
    const list = await (
      await rpc(`/mcp/${T.read}`, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      })
    ).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "list_projects",
      "list_runs",
      "get_run_summary",
      "get_run_checks",
      "get_run_cases",
      "get_judges",
    ]);
    const call = async (name: string, args: unknown) => {
      const r = await (
        await rpc(`/mcp/${T.read}`, {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name, arguments: args },
        })
      ).json();
      return {
        isError: r.result.isError,
        data: JSON.parse(r.result.content[0].text),
      };
    };
    const summary = await call("get_run_summary", {
      run: "exchange-triage/2026-10-19-prompts",
    });
    expect(summary.data.gate.pass).toBe(true);
    expect(summary.data.paired_cases).toBe(27);
    const checks = await call("get_run_checks", {
      run: "exchange-triage/2026-10-19-prompts",
    });
    expect(checks.data).toHaveLength(7);
    const failing = await call("get_run_cases", {
      run: "exchange-triage/2026-10-19-prompts",
      variant: "v3",
      failing_only: true,
    });
    expect(
      failing.data.every((r: { variant: string }) => r.variant === "v3"),
    ).toBe(true);
    const key = "exchange-triage/2026-10-19-prompts";
    const checked = hub.store.judges(key);
    hub.store.putJudges(key, [
      { ...checked[0]!, check: "legacy_zero", joined: 0 },
    ]);
    try {
      const judges = await call("get_judges", {
        run: "exchange-triage/2026-10-19-prompts",
      });
      expect(judges.data.map((j: { check: string }) => j.check).sort()).toEqual(
        ["attribution_claude", "attribution_jev"],
      );
      expect(judges.data).toEqual(checked);
    } finally {
      hub.store.deleteJudge(key, "legacy_zero");
    }
    const bad = await (
      await rpc(`/mcp/${T.read}`, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_run_summary", arguments: { run: "nope" } },
      })
    ).json();
    expect(bad.result.isError).toBe(true);
    const unknown = await (
      await rpc(`/mcp/${T.read}`, {
        jsonrpc: "2.0",
        id: 5,
        method: "resources/list",
      })
    ).json();
    expect(unknown.error.code).toBe(-32601);
    expect((await fetch(hub.url + "/mcp")).status).toBe(405);
  });
});
