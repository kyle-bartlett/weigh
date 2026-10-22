import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eventsFromTraces, parseEvent, type RunEvent } from "../events.ts";
import { readJudges } from "../report/build.ts";
import { readMeta, readOutput, readTraces } from "../run.ts";
import { scrub, scrubText } from "../scrub.ts";
import type { RunStatus } from "../events.ts";
import type { TraceLine } from "../types.ts";

/**
 * The client side of the agent API. The agent and `weigh import` both go through it, so an imported
 * run is a replayed live run and nothing else. Everything is scrubbed before it leaves the machine.
 */

export const OUTPUT_RAW_CAP = 1 << 20;
export const OUTPUT_KEEP = 256 << 10;
export const EVENT_BATCH = 100;

export class HubHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class HubClient {
  constructor(
    readonly base: string,
    readonly token: string,
    readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(
    method: string,
    path: string,
    body?: BodyInit,
    headers: Record<string, string> = {},
  ) {
    const res = await this.fetchImpl(new URL(path, this.base), {
      method,
      body,
      headers: { authorization: `Bearer ${this.token}`, ...headers },
    });
    if (!res.ok)
      throw new HubHttpError(
        res.status,
        `${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    return res;
  }
  private json(method: string, path: string, body: unknown) {
    return this.call(method, path, JSON.stringify(body), {
      "content-type": "application/json",
    }).then((r) => r.json());
  }

  register(body: {
    agent_id: string;
    version: string;
    projects: {
      id: string;
      suites: {
        name: string;
        path: string;
        description: string;
        info: Record<string, unknown>;
      }[];
    }[];
  }) {
    return this.json("POST", "/api/agent/register", body) as Promise<{
      projects: number;
      suites: number;
    }>;
  }
  /** Long-poll for the next queued run; undefined when none within `waitS`. */
  async claim(agentId: string, waitS: number): Promise<Job | undefined> {
    const res = await this.call(
      "GET",
      `/api/agent/jobs?agent=${enc(agentId)}&wait=${waitS}`,
    );
    if (res.status === 204) return undefined;
    return (await res.json()) as Job;
  }
  heartbeat(
    suite: string,
    runId: string,
    body: { finished: number; total: number; status: string },
  ) {
    return this.json(
      "POST",
      `/api/agent/runs/${enc(suite)}/${enc(runId)}/heartbeat`,
      body,
    ) as Promise<{ cancel: boolean }>;
  }
  createRun(r: { project: string; suite: string; run_id: string }) {
    return this.json("POST", "/api/agent/runs", r) as Promise<{
      key: string;
      created: boolean;
    }>;
  }
  postEvents(
    suite: string,
    runId: string,
    events: RunEvent[],
    source: "runner" | "agent" = "runner",
  ) {
    return this.json(
      "POST",
      `/api/agent/runs/${enc(suite)}/${enc(runId)}/events`,
      { events, source },
    ) as Promise<{ accepted: number; last_src_seq: number }>;
  }
  async putOutput(
    suite: string,
    runId: string,
    variant: string,
    caseId: string,
    outputHash: string,
    raw: string,
  ) {
    const bytes = Buffer.from(raw);
    const truncated = bytes.length > OUTPUT_RAW_CAP;
    const gz = Bun.gzipSync(truncated ? bytes.subarray(0, OUTPUT_KEEP) : bytes);
    await this.call(
      "PUT",
      `/api/agent/runs/${enc(suite)}/${enc(runId)}/outputs/${enc(variant)}/${enc(caseId)}`,
      gz,
      {
        "content-type": "application/gzip",
        "x-output-hash": outputHash,
        "x-raw-bytes": String(bytes.length),
        "x-truncated": truncated ? "1" : "0",
      },
    );
  }
  putInputs(suite: string, runId: string, texts: Record<string, string>) {
    return this.json(
      "PUT",
      `/api/agent/runs/${enc(suite)}/${enc(runId)}/inputs`,
      texts,
    );
  }
  putJudges(suite: string, runId: string, records: unknown[]) {
    return this.json(
      "PUT",
      `/api/agent/runs/${enc(suite)}/${enc(runId)}/judges`,
      { records },
    );
  }
  putLabels(
    suite: string,
    runId: string,
    agentId: string,
    labels: unknown[],
  ): Promise<{ inserted: number; skipped: number; total: number }> {
    return this.json(
      "PUT",
      `/api/agent/runs/${enc(suite)}/${enc(runId)}/labels`,
      { agent_id: agentId, labels },
    );
  }
  validateJudge(
    suite: string,
    runId: string,
    agentId: string,
    check: string,
  ): Promise<Record<string, unknown>> {
    return this.json(
      "POST",
      `/api/agent/runs/${enc(suite)}/${enc(runId)}/judges/validate`,
      { agent_id: agentId, check },
    );
  }
  finish(suite: string, runId: string, status: RunStatus, exitCode?: number) {
    return this.json(
      "POST",
      `/api/agent/runs/${enc(suite)}/${enc(runId)}/finish`,
      { status, exit_code: exitCode },
    );
  }
}

const enc = encodeURIComponent;

/** What the hub hands an agent when it claims a queued run. */
export interface Job {
  key: string;
  project_id: string;
  suite: string;
  run_id: string;
  suite_path: string;
  options: { variants?: string[]; cases?: string[]; concurrency?: number };
  /** Runner seq offset for this attempt so retries extend one sequence instead of colliding. */
  src_seq_base: number;
}

/** Scrub a trace line and normalize nothing else; the hub scrubs again on ingest. */
export const outboundLine = (l: TraceLine): TraceLine => scrub(l);

/**
 * Push a finished run directory to the hub as if the agent had run it: events (from events.jsonl or
 * synthesized from the traces), inputs, outputs, judges, then finish. Idempotent: the hub ignores
 * events it already has and overwrites outputs with the same content.
 */
export async function importRunDir(
  client: HubClient,
  dir: string,
  opts: { project: string; log?: (s: string) => void },
) {
  const log = opts.log ?? (() => {});
  const meta = readMeta(dir);
  const lines = readTraces(dir);
  const eventsPath = join(dir, "events.jsonl");
  let events: RunEvent[] = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => parseEvent(JSON.parse(l)))
    : eventsFromTraces(meta, lines);
  // A live run that ended without a terminal event (crash, power) is still importable as finished.
  const last = events.at(-1)?.type;
  if (last && !["run_done", "run_cancelled", "run_error"].includes(last))
    events = eventsFromTraces(meta, lines);
  events = events.map((e) =>
    e.type === "run_start"
      ? { ...e, meta: { ...e.meta, command: shortCommand(e.meta.command) } }
      : e,
  );
  const { created } = await client.createRun({
    project: opts.project,
    suite: meta.suite,
    run_id: meta.run_id,
  });
  log(
    `${created ? "created" : "updating"} ${meta.suite}/${meta.run_id}: ${events.length} events, ${lines.length} trace lines`,
  );
  let accepted = 0;
  for (let i = 0; i < events.length; i += EVENT_BATCH) {
    const r = await client.postEvents(
      meta.suite,
      meta.run_id,
      events.slice(i, i + EVENT_BATCH),
    );
    accepted += r.accepted;
  }
  const inputsPath = join(dir, "inputs.json");
  if (existsSync(inputsPath))
    await client.putInputs(
      meta.suite,
      meta.run_id,
      scrub(JSON.parse(readFileSync(inputsPath, "utf8"))),
    );
  let outputs = 0;
  for (const l of lines) {
    if (!l.ok) continue;
    const o = readOutput(dir, l);
    if (!o) continue;
    await client.putOutput(
      meta.suite,
      meta.run_id,
      l.variant,
      l.case_id,
      l.output_hash,
      scrubText(JSON.stringify(o)),
    );
    outputs++;
  }
  const judges = readJudges(dir);
  if (judges.length)
    await client.putJudges(
      meta.suite,
      meta.run_id,
      judges.map((j) => ({ ...j, labels: scrubText(j.labels) })),
    );
  const status: RunStatus = meta.cancelled_at ? "cancelled" : "finished";
  await client.finish(meta.suite, meta.run_id, status);
  log(
    `done: ${accepted} new events, ${outputs} outputs, ${judges.length} judges, status ${status}`,
  );
  return {
    suite: meta.suite,
    run_id: meta.run_id,
    events: events.length,
    accepted,
    outputs,
    judges: judges.length,
    status,
  };
}

/** `bun /abs/path/src/cli.ts run /abs/checkout/weigh/x.suite.ts --run-id r` becomes the short form the README shows. */
export function shortCommand(cmd: string): string {
  return scrubText(cmd).replace(
    /^bun\s+\S*cli\.ts\s+run\s+\S*?([^\s/]+\.ts)/,
    "bun src/cli.ts run $1",
  );
}
