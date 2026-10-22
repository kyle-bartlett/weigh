import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HubClient,
  IMPORT_AGENT_ID,
  importRunDir,
} from "../src/agent/upload.ts";
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
  const temps: string[] = [];
  const temp = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
  };
  beforeAll(() => {
    hub = startHub({
      port: 0,
      dbPath: join(temp("weigh-runjs-"), "hub.db"),
      tokens: T,
    });
    client = new HubClient(hub.url, T.agent);
  });
  afterAll(() => {
    hub.stop();
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  /** Opens a run page while the run is still claimed, then lets the agent push the whole run through the live stream. */
  async function watchLiveRun(reducedMotion = false) {
    // Run keys are global, so every page gets its own copy of the example under a fresh run id.
    const runId = `live-${++n}`;
    const dir = temp("weigh-runjs-run-");
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
    // Created under the importer's id, as the import below would, so its judges upload is accepted.
    await client.createRun({
      project: "live",
      suite: "exchange-triage",
      run_id: runId,
      agent_id: IMPORT_AGENT_ID,
    });
    const page = openPage({
      run: `exchange-triage/${runId}`,
      fetch: fetchHub,
      reducedMotion,
    });
    const stream = page.es.connect();
    await importRunDir(client, dir, { project: "live" });
    await stream;
    return { page, runId };
  }

  test("completion: the live stream counts every case, closes on the finished status, and the final refresh fills the page", async () => {
    const { page, runId } = await watchLiveRun();
    expect(page.es.url).toBe(
      `/api/runs/exchange-triage/${runId}/events?since=0`,
    );
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

  test("count-up: each counted cell climbs from zero to its value over 600 ms, keeping the real number as its label", async () => {
    const { page } = await watchLiveRun();
    page.clock = 1000;
    await page.fire();
    const cells = page.cells();
    expect(cells.length).toBeGreaterThan(0);
    const finals = cells.map((c) => c.textContent);
    expect(cells.map((c) => c.attributes.get("aria-label"))).toEqual(finals);
    const at = (fraction: number) =>
      cells.map(
        (c) =>
          c.dataset.prefix +
          (Number(c.dataset.count) * fraction).toLocaleString("en-US", {
            minimumFractionDigits: Number(c.dataset.digits),
            maximumFractionDigits: Number(c.dataset.digits),
          }),
      );
    page.frame(1000);
    expect(cells.map((c) => c.textContent)).toEqual(at(0));
    page.frame(1300);
    expect(cells.map((c) => c.textContent)).toEqual(at(0.5));
    expect(page.frames()).toBe(1);
    page.frame(1600);
    expect(cells.map((c) => c.textContent)).toEqual(finals);
    expect(page.frames()).toBe(0);
  });

  test("count-up: reduced motion completes the page without animating a number", async () => {
    const { page } = await watchLiveRun(true);
    await page.fire();
    expect(page.dispatched).toEqual(["weigh:run-finished"]);
    expect(page.frames()).toBe(0);
    expect(page.cells()).toEqual([]);
  });
});

describe("run.js against scripted fragments", () => {
  const fragments = (status: string, finished: number, total: number) =>
    Response.json({ verdict: `<p>${status}</p>`, status, finished, total });

  /** A live page whose fragment fetches answer with whatever the test sets next. */
  function scripted() {
    const calls: string[] = [];
    let answer: () => Promise<Response> = () => Promise.reject(new Error());
    const page = openPage({
      run: "demo/r1",
      fetch: (url) => {
        calls.push(url);
        return answer();
      },
    });
    return {
      page,
      calls,
      reply: (fn: () => Response | Promise<Response>) => {
        answer = async () => fn();
      },
    };
  }

  test("a lost run keeps the stream open and says so; once the agent heartbeats again the count resumes and the run still completes", async () => {
    const { page, reply } = scripted();
    page.es.emit("run_start", { total: 4, resumed: 0 });
    page.es.emit("job_done", { finished: 1, total: 4, line: { case_id: "a" } });
    expect(page.progress.textContent).toBe("Grading case 2 of 4");
    // The 400 ms refresh runs long before the hub's lease sweep declares the run lost.
    reply(() => fragments("running", 1, 4));
    await page.fire();
    expect(page.pending()).toEqual([]);

    page.es.emit("status", { status: "lost" });
    expect(page.status.className).toBe("status lost");
    expect(page.status.lastChild.textContent).toBe("lost");
    expect(page.progress.textContent).toBe(
      "Lost contact with the agent after 1 of 4 cases.",
    );
    expect(page.es.closed).toBe(false);
    expect(page.pending()).toEqual([]);
    expect(page.dispatched).toEqual([]);

    // The agent heartbeats again: the hub sends running, then the next case.
    page.es.emit("status", { status: "running" });
    expect(page.status.className).toBe("status running");
    expect(page.progress.textContent).toBe("Grading case 2 of 4");
    page.es.emit("job_done", { finished: 2, total: 4, line: { case_id: "b" } });
    expect(page.progress.textContent).toBe("Grading case 3 of 4");

    page.es.emit("job_done", { finished: 4, total: 4, line: { case_id: "d" } });
    page.es.emit("status", { status: "finished" });
    expect(page.es.closed).toBe(true);
    reply(() => fragments("finished", 4, 4));
    await page.fire();
    expect(page.progress.textContent).toBe("Graded 4 of 4 cases.");
    expect(page.dispatched).toEqual(["weigh:run-finished"]);
  });

  test("a resumed run counts its cached cases as finished", () => {
    const { page } = scripted();
    // The runner restarts with 3 cases left and 1 already cached; its job_done counts only this attempt.
    page.es.emit("run_start", { total: 3, resumed: 1 });
    expect(page.progress.textContent).toBe("Grading case 2 of 4");
    page.es.emit("job_done", { finished: 1, total: 3, line: { case_id: "b" } });
    expect(page.progress.textContent).toBe("Grading case 3 of 4");
    expect(page.bar.style.transform).toBe("scaleX(0.5)");
  });

  test("fragment retries back off from 3 s to a 30 s cap and give up after nine misses", async () => {
    const { page, calls, reply } = scripted();
    reply(() => Promise.reject(new TypeError("network down")));
    page.es.emit("summary");
    expect(page.pending()).toEqual([400]);
    await page.fire();
    reply(() => new Response("busy", { status: 503 }));
    const delays: number[] = [];
    while (page.pending().length) {
      delays.push(...page.pending());
      await page.fire();
    }
    expect(delays).toEqual([
      3000, 6000, 12000, 24000, 30000, 30000, 30000, 30000,
    ]);
    expect(calls).toHaveLength(9);
    // Giving up on fragments is not giving up on the run: the stream stays open for the next event.
    expect(page.es.closed).toBe(false);
  });

  test("a good fetch resets the backoff, and a deleted run (404 or 410) stops polling and closes the stream", async () => {
    for (const gone of [404, 410]) {
      const { page, calls, reply } = scripted();
      reply(() => new Response("busy", { status: 503 }));
      page.es.emit("summary");
      await page.fire();
      await page.fire();
      expect(page.pending()).toEqual([6000]);
      reply(() => fragments("running", 1, 4));
      await page.fire();
      expect(page.pending()).toEqual([]);
      expect(page.progress.textContent).toBe("Grading case 2 of 4");

      reply(() => new Response("busy", { status: 503 }));
      page.es.emit("summary");
      await page.fire();
      expect(page.pending()).toEqual([3000]);
      reply(() => new Response("gone", { status: gone }));
      await page.fire();
      expect(page.pending()).toEqual([]);
      expect(page.es.closed).toBe(true);
      expect(calls).toHaveLength(5);
      // Nothing restarts a run that is gone.
      page.es.emit("summary");
      expect(page.pending()).toEqual([]);
    }
  });
});
