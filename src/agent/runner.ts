import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseEvent, type RunEvent, type RunStatus } from "../events.ts";
import { readJudges } from "../report/build.ts";
import { scrub, scrubText } from "../scrub.ts";
import type { TraceLine } from "../types.ts";
import type { Log } from "./checkout.ts";
import { shortCommand, type HubClient, type Job } from "./upload.ts";

/**
 * One job: spawn the Weigh CLI on the suite, tail its events.jsonl to the hub in order, upload each
 * finished output, answer heartbeats (and stop on cancel), then finish. The cursor file records what
 * the hub has acknowledged so a hub outage mid-run costs nothing: the sweep at startup resumes it.
 */

export interface RunnerOptions {
  hub: HubClient;
  job: Job;
  suiteFile: string;
  checkout: string;
  runsDir: string;
  weighHome: string;
  env: Record<string, string>;
  heartbeatMs: number;
  log: Log;
}

export interface Cursor {
  src_seq: number;
  outputs_acked: string[];
  inputs_acked?: boolean;
  judges_acked?: boolean;
  done?: RunStatus;
}

export const cursorPath = (runDir: string) => join(runDir, ".hub-cursor");
export const readCursor = (runDir: string): Cursor =>
  existsSync(cursorPath(runDir))
    ? (JSON.parse(readFileSync(cursorPath(runDir), "utf8")) as Cursor)
    : { src_seq: 0, outputs_acked: [] };
export const writeCursor = (runDir: string, c: Cursor) =>
  writeFileSync(cursorPath(runDir), JSON.stringify(c));

/** Lines of events.jsonl after the first `skip` lines. A partial last line (still being written) is left for next time. */
function readNewEvents(path: string, skip: number): RunEvent[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop();
  return lines
    .filter((l) => l.trim())
    .slice(skip)
    .map((l) => parseEvent(JSON.parse(l)));
}

const retry = async <T>(
  fn: () => Promise<T>,
  log: Log,
  what: string,
  signal?: { stop: boolean },
): Promise<T> => {
  let delay = 1000;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (signal?.stop) throw e;
      log(
        "warn",
        `${what}: ${String(e instanceof Error ? e.message : e).slice(0, 200)}; retry in ${delay / 1000}s`,
      );
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
};

/**
 * Upload everything in a run directory the hub has not acknowledged yet: runner events (with the
 * attempt's seq offset), outputs for finished pairs, inputs, judges. Used live and by the recovery sweep.
 */
export async function syncRunDir(
  hub: HubClient,
  job: { suite: string; run_id: string; src_seq_base: number },
  runDir: string,
  log: Log,
  opts: { final?: RunStatus } = {},
): Promise<Cursor> {
  const cur = readCursor(runDir);
  const seen = cur.src_seq - job.src_seq_base;
  const fresh = readNewEvents(join(runDir, "events.jsonl"), Math.max(0, seen));
  for (let i = 0; i < fresh.length; i += 100) {
    const batch = fresh
      .slice(i, i + 100)
      .map((e) => scrub(prepare(e, job.src_seq_base)));
    const r = await retry(
      () => hub.postEvents(job.suite, job.run_id, batch),
      log,
      "events",
    );
    cur.src_seq = Math.max(cur.src_seq, r.last_src_seq, batch.at(-1)!.seq);
    writeCursor(runDir, cur);
  }
  const outputsDir = join(runDir, "outputs");
  if (existsSync(outputsDir)) {
    const acked = new Set(cur.outputs_acked);
    for (const f of readdirSync(outputsDir)) {
      if (!f.endsWith(".json") || acked.has(f)) continue;
      const m = f.match(/^(.+?)--(.+?)--([0-9a-f]{16})\.json$/);
      if (!m) continue;
      const raw = readFileSync(join(outputsDir, f), "utf8");
      const parsed = JSON.parse(raw) as { output?: unknown; error?: string };
      if (!parsed.output) {
        acked.add(f);
        continue;
      }
      await retry(
        () =>
          hub.putOutput(
            job.suite,
            job.run_id,
            m[1]!,
            m[2]!,
            m[3]!,
            scrubText(JSON.stringify(parsed.output)),
          ),
        log,
        `output ${f}`,
      );
      acked.add(f);
      cur.outputs_acked = [...acked];
      writeCursor(runDir, cur);
    }
  }
  const inputs = join(runDir, "inputs.json");
  if (!cur.inputs_acked && existsSync(inputs)) {
    await retry(
      () =>
        hub.putInputs(
          job.suite,
          job.run_id,
          scrub(JSON.parse(readFileSync(inputs, "utf8"))),
        ),
      log,
      "inputs",
    );
    cur.inputs_acked = true;
    writeCursor(runDir, cur);
  }
  if (opts.final) {
    const judges = readJudges(runDir);
    if (judges.length && !cur.judges_acked) {
      await retry(
        () =>
          hub.putJudges(
            job.suite,
            job.run_id,
            judges.map((j) => ({ ...j, labels: scrubText(j.labels) })),
          ),
        log,
        "judges",
      );
      cur.judges_acked = true;
      writeCursor(runDir, cur);
    }
    await retry(
      () => hub.finish(job.suite, job.run_id, opts.final!),
      log,
      "finish",
    );
    cur.done = opts.final;
    writeCursor(runDir, cur);
  }
  return cur;
}

/** A retried run restarts the runner's seq at 1; the hub keeps every attempt in one sequence via the offset. */
function prepare(e: RunEvent, base: number): RunEvent {
  const out = { ...e, seq: e.seq + base };
  if (out.type === "run_start")
    out.meta = { ...out.meta, command: shortCommand(out.meta.command) };
  return out;
}

export async function runJob(o: RunnerOptions): Promise<RunStatus> {
  const { hub, job, log } = o;
  const runDir = join(o.runsDir, job.suite, job.run_id);
  mkdirSync(runDir, { recursive: true });
  // The CLI starts a fresh events.jsonl; an earlier attempt's file must not be re-read with the new offset.
  rmSync(join(runDir, "events.jsonl"), { force: true });
  const args = [
    "bun",
    join(o.weighHome, "src", "cli.ts"),
    "run",
    o.suiteFile,
    "--run-id",
    job.run_id,
  ];
  const opt = job.options ?? {};
  if (Array.isArray(opt.variants) && opt.variants.length)
    args.push("--variants", opt.variants.join(","));
  if (Array.isArray(opt.cases) && opt.cases.length)
    args.push("--cases", opt.cases.join(","));
  if (typeof opt.concurrency === "number")
    args.push("--concurrency", String(opt.concurrency));
  log(
    "info",
    `spawn: ${args
      .slice(2)
      .map((a) => a.replace(o.checkout, "."))
      .join(" ")}`,
  );
  const child = Bun.spawn(args, {
    cwd: o.checkout,
    env: { ...o.env, WEIGH_RUNS: o.runsDir, WEIGH_HOME: o.weighHome },
    stdout: Bun.file(join(runDir, "runner.log")),
    stderr: Bun.file(join(runDir, "runner.log")),
  });
  let cancelled = false;
  let stop = false;
  const beat = setInterval(async () => {
    try {
      const r = await hub.heartbeat(job.suite, job.run_id, {
        finished: 0,
        total: 0,
        status: "running",
      });
      if (r.cancel && !cancelled) {
        cancelled = true;
        log("warn", "cancel requested; sending SIGTERM");
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!stop) child.kill("SIGKILL");
        }, 5 * 60_000);
      }
    } catch (e) {
      log(
        "warn",
        `heartbeat: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`,
      );
    }
  }, o.heartbeatMs);
  const sync = () => syncRunDir(hub, job, runDir, log);
  const tail = setInterval(() => void sync().catch(() => {}), 1000);
  const code = await child.exited;
  stop = true;
  clearInterval(tail);
  clearInterval(beat);
  const status: RunStatus =
    cancelled || code === 130
      ? "cancelled"
      : code === 0 || code === 1
        ? "finished"
        : "failed";
  if (status === "failed")
    log(
      "error",
      `runner exited ${code}: ${tailOf(join(runDir, "runner.log"))}`,
    );
  await syncRunDir(hub, job, runDir, log, { final: status });
  return status;
}

function tailOf(p: string): string {
  if (!existsSync(p) || !statSync(p).size) return "";
  return scrubText(readFileSync(p, "utf8").slice(-600));
}

export type { TraceLine };
