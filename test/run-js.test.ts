import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient, importRunDir } from "../src/agent/upload.ts";
import { startHub } from "../src/hub/server.ts";
import { openPage } from "./run-page.ts";

const example = join(
  import.meta.dir,
  "..",
  "runs",
  "examples",
  "exchange-triage-2026-10-19",
);
const T = { admin: "admin-token", agent: "agent-token", read: "read-token" };

describe("run.js against a live hub", () => {
  let hub: ReturnType<typeof startHub>;
  let client: HubClient;
  let n = 0;
  beforeAll(() => {
    hub = startHub({
      port: 0,
      dbPath: join(mkdtempSync(join(tmpdir(), "weigh-runjs-")), "hub.db"),
      tokens: T,
    });
    client = new HubClient(hub.url, T.agent);
  });
  afterAll(() => hub.stop());

  /** Opens a run page while the run is still claimed, then lets the agent push the whole run through the live stream. */
  async function watchLiveRun(reducedMotion = false) {
    // Run keys are global, so every page gets its own copy of the example under a fresh run id.
    const runId = `live-${++n}`;
    const dir = mkdtempSync(join(tmpdir(), "weigh-runjs-run-"));
    cpSync(example, dir, { recursive: true });
    for (const file of ["run.json", "traces.jsonl"]) {
      const path = join(dir, file);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replaceAll("2026-10-19-prompts", runId),
      );
    }
    const fetchHub = (url: string, init?: RequestInit) =>
      fetch(hub.url + url, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          authorization: `Bearer ${T.read}`,
        },
      });
    await client.createRun({
      project: "live",
      suite: "exchange-triage",
      run_id: runId,
    });
    const page = openPage({
      run: `exchange-triage/${runId}`,
      fetch: fetchHub,
      reducedMotion,
    });
    const stream = page.es.connect();
    await importRunDir(client, dir, { project: "live" });
    await stream;
    return page;
  }

  test("completion: the live stream counts every case, closes on the finished status, and the final refresh fills the page", async () => {
    const page = await watchLiveRun();
    expect(page.es.url).toBe("/api/runs/exchange-triage/live-1/events?since=0");
    // The finished status closed the stream; the run_start and 108 job_done frames before it drove the count.
    expect(page.es.closed).toBe(true);
    expect(page.progress.textContent).toBe(
      "Graded 108 of 108 cases. Finishing the comparison.",
    );
    expect(page.status.className).toBe("status finished");
    expect(page.bar.style.transform).toBe("scaleX(1)");
    expect(page.share.hidden).toBe(true);
    expect(page.dispatched).toEqual([]);
    // Completion does not wait for another event: one refresh is queued.
    expect(page.pending()).toEqual([400]);

    await page.fire();
    expect(page.sections.get("verdict")!.innerHTML).toContain(
      'data-complete="true"',
    );
    expect(page.sections.get("checks")!.innerHTML).not.toBe("");
    expect(page.share.hidden).toBe(false);
    expect(page.progress.textContent).toBe("Graded 108 of 108 cases.");
    expect(page.dispatched).toEqual(["weigh:run-finished"]);
    expect(page.pending()).toEqual([]);
  });
});
