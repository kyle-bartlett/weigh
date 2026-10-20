import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "../events.ts";
import { ensureCheckout, headSha, type Log } from "./checkout.ts";
import {
  type AgentConfig,
  checkoutDir,
  loadConfig,
  readToken,
} from "./config.ts";
import { discoverSuites } from "./discover.ts";
import { readCursor, runJob, syncRunDir } from "./runner.ts";
import { HubClient, type Job } from "./upload.ts";

/**
 * The agent loop: register what this machine can run, finish any upload a previous process left
 * behind, then claim jobs one at a time (long poll) and run them. Everything outbound; no port.
 */

export const AGENT_VERSION = "0.2.0";

export function agentEnv(
  c: AgentConfig,
  extra: Record<string, string> = {},
): Record<string, string> {
  const home = process.env.HOME ?? "";
  const path = [
    ...c.path_extra,
    join(home, ".bun", "bin"),
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  return {
    HOME: home,
    PATH: path,
    USER: process.env.USER ?? "",
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    ...extra,
  };
}

export async function startAgent(
  configPath: string,
  opts: { once?: boolean; log?: (s: string) => void } = {},
) {
  const c = loadConfig(configPath);
  const print =
    opts.log ??
    ((s: string) => console.error(`${new Date().toISOString()} ${s}`));
  const hub = new HubClient(c.hub, readToken(c));
  const env = agentEnv(c);
  let agentSeq = 0;
  const agentLog =
    (suite?: string, runId?: string): Log =>
    (level, text) => {
      print(`[${level}] ${text}`);
      if (suite && runId) {
        const e: RunEvent = {
          type: "log",
          level,
          text,
          seq: ++agentSeq,
          at: new Date().toISOString(),
        };
        hub.postEvents(suite, runId, [e], "agent").catch(() => {});
      }
    };
  const log = agentLog();

  // Register: checkouts current, suites discovered, hub told.
  const registered: {
    id: string;
    suites: ReturnType<typeof discoverSuites>["suites"];
  }[] = [];
  for (const p of c.projects) {
    try {
      const dir = ensureCheckout(c, p, log, { ...env, ...p.env });
      const { suites, errors } = discoverSuites(dir, c.weigh_home, {
        ...env,
        ...p.env,
      });
      for (const e of errors) log("warn", `${p.id}/${e.path}: ${e.error}`);
      log(
        "info",
        `${p.id} @ ${headSha(dir, env) ?? "no git"}: ${suites.map((s) => s.name).join(", ") || "no suites"}`,
      );
      registered.push({ id: p.id, suites });
    } catch (e) {
      log("error", `${p.id}: ${String(e instanceof Error ? e.message : e)}`);
    }
  }
  await hub.register({
    agent_id: c.agent_id,
    version: AGENT_VERSION,
    projects: registered,
  });
  log("info", `registered ${registered.length} project(s) with ${c.hub}`);

  // Recovery sweep: any run dir with a cursor that never reached done.
  if (existsSync(c.runs_dir))
    for (const suite of readdirSync(c.runs_dir))
      for (const runId of existsSync(join(c.runs_dir, suite))
        ? readdirSync(join(c.runs_dir, suite))
        : []) {
        const dir = join(c.runs_dir, suite, runId);
        if (!existsSync(join(dir, ".hub-cursor")) || readCursor(dir).done)
          continue;
        log("info", `resuming upload of ${suite}/${runId}`);
        try {
          const meta = existsSync(join(dir, "run.json"))
            ? (JSON.parse(await Bun.file(join(dir, "run.json")).text()) as {
                finished_at?: string;
                cancelled_at?: string;
              })
            : {};
          await syncRunDir(
            hub,
            { suite, run_id: runId, src_seq_base: 0 },
            dir,
            log,
            {
              final: meta.cancelled_at
                ? "cancelled"
                : meta.finished_at
                  ? "finished"
                  : "failed",
            },
          );
        } catch (e) {
          log(
            "warn",
            `resume ${suite}/${runId}: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`,
          );
        }
      }

  // Claim and run, one at a time. Every REREGISTER_EVERY empty polls the checkouts are refreshed and
  // suites rediscovered, so a suite pushed to a repo shows up without restarting the agent.
  const REREGISTER_EVERY = 20;
  let idle = 0;
  for (;;) {
    let job: Job | undefined;
    if (idle >= REREGISTER_EVERY) {
      idle = 0;
      const again: typeof registered = [];
      for (const p of c.projects)
        try {
          const dir = ensureCheckout(c, p, log, { ...env, ...p.env });
          again.push({
            id: p.id,
            suites: discoverSuites(dir, c.weigh_home, { ...env, ...p.env })
              .suites,
          });
        } catch (e) {
          log(
            "warn",
            `${p.id}: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`,
          );
        }
      await hub
        .register({
          agent_id: c.agent_id,
          version: AGENT_VERSION,
          projects: again,
        })
        .catch(() => {});
    }
    try {
      job = await hub.claim(c.agent_id, c.poll_wait_s);
    } catch (e) {
      log(
        "warn",
        `claim: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`,
      );
      await Bun.sleep(5000);
      continue;
    }
    if (!job) idle++;
    if (job) {
      idle = 0;
      const p = c.projects.find((x) => x.id === job!.project_id);
      const jlog = agentLog(job.suite, job.run_id);
      if (!p) {
        jlog("error", `no local project ${job.project_id}`);
        await hub.finish(job.suite, job.run_id, "failed").catch(() => {});
      } else {
        try {
          const dir = ensureCheckout(c, p, jlog, { ...env, ...p.env });
          const status = await runJob({
            hub,
            job,
            suiteFile: join(dir, job.suite_path),
            checkout: dir,
            runsDir: c.runs_dir,
            weighHome: c.weigh_home,
            env: { ...env, ...p.env },
            heartbeatMs: c.heartbeat_s * 1000,
            log: jlog,
          });
          jlog("info", `run ${job.suite}/${job.run_id} ${status}`);
        } catch (e) {
          jlog(
            "error",
            String(e instanceof Error ? e.message : e).slice(0, 500),
          );
          await hub.finish(job.suite, job.run_id, "failed").catch(() => {});
        }
      }
    }
    if (opts.once) return;
  }
}

export { checkoutDir };
