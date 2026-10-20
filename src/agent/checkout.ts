import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentConfig, ProjectConfig } from "./config.ts";
import { checkoutDir } from "./config.ts";

/**
 * Keeps a project's checkout current. A remote is cloned once and reset to origin/<branch> before every
 * run; a path is pulled fast-forward only. The install command runs after a clone and whenever the
 * lockfile content changes, never on every run.
 */

export type Log = (level: "info" | "warn" | "error", text: string) => void;

export function sh(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): { code: number; out: string } {
  const r = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: opts.env ?? (process.env as Record<string, string>),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    out: (r.stdout.toString() + r.stderr.toString()).trim(),
  };
}

const must = (r: { code: number; out: string }, what: string) => {
  if (r.code !== 0)
    throw new Error(`${what} failed (${r.code}): ${r.out.slice(-800)}`);
  return r.out;
};

export function ensureCheckout(
  c: AgentConfig,
  p: ProjectConfig,
  log: Log,
  env: Record<string, string>,
): string {
  const dir = checkoutDir(c, p);
  if (p.remote) {
    if (!existsSync(join(dir, ".git"))) {
      mkdirSync(dirname(dir), { recursive: true });
      log("info", `git clone ${p.remote} (${p.branch})`);
      must(
        sh(["git", "clone", "--quiet", "--branch", p.branch, p.remote, dir], {
          env,
        }),
        "git clone",
      );
    } else {
      log("info", `git fetch ${p.id}`);
      must(
        sh(["git", "fetch", "--quiet", "origin", p.branch], { cwd: dir, env }),
        "git fetch",
      );
      must(
        sh(["git", "checkout", "--quiet", p.branch], { cwd: dir, env }),
        "git checkout",
      );
      must(
        sh(["git", "reset", "--quiet", "--hard", `origin/${p.branch}`], {
          cwd: dir,
          env,
        }),
        "git reset",
      );
    }
  } else if (p.pull && existsSync(join(dir, ".git"))) {
    const r = sh(["git", "pull", "--quiet", "--ff-only"], { cwd: dir, env });
    if (r.code !== 0)
      log(
        "warn",
        `git pull in ${p.id} failed, running what is checked out: ${r.out.slice(-300)}`,
      );
  }
  if (!existsSync(dir))
    throw new Error(`project ${p.id}: ${dir} does not exist`);
  if (p.install) maybeInstall(dir, p, log, env);
  return dir;
}

/** Runs the install command when the lockfile hash differs from the one recorded after the last install. */
function maybeInstall(
  dir: string,
  p: ProjectConfig,
  log: Log,
  env: Record<string, string>,
) {
  const lock = [
    "bun.lock",
    "bun.lockb",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
  ]
    .map((f) => join(dir, f))
    .find(existsSync);
  const stamp = join(dir, ".weigh-install-stamp");
  const h = lock
    ? createHash("sha256").update(readFileSync(lock)).digest("hex")
    : "nolock";
  if (
    existsSync(stamp) &&
    readFileSync(stamp, "utf8").trim() === h &&
    existsSync(join(dir, "node_modules"))
  )
    return;
  log("info", `install: ${p.install!.join(" ")}`);
  must(sh(p.install!, { cwd: dir, env }), "install");
  writeFileSync(stamp, h);
}

export function headSha(
  dir: string,
  env: Record<string, string>,
): string | undefined {
  const r = sh(["git", "rev-parse", "--short", "HEAD"], { cwd: dir, env });
  return r.code === 0 ? r.out : undefined;
}
