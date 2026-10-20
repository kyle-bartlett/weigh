import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

/**
 * The agent's own config, on the machine that runs the suites. Nothing in it ever comes from the hub:
 * which remotes may be cloned, what install command runs and which environment a suite sees are all
 * decided here, so a leaked hub token can never become code execution on the iMac.
 */

const ProjectSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase slug"),
    /** Git URL to clone into <workdir>/<id>. Must match allowed_remotes. */
    remote: z.string().optional(),
    /** An existing checkout to use as is (no clone). */
    path: z.string().optional(),
    branch: z.string().default("main"),
    /** git pull --ff-only before each run when using `path`. Remotes always fetch. */
    pull: z.boolean().default(true),
    /** Run once after clone and whenever the lockfile changes. Always add --ignore-scripts. */
    install: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).default({}),
  })
  .refine((p) => !!p.remote !== !!p.path, {
    message: "give exactly one of remote or path",
  });

export const AgentConfigSchema = z.object({
  hub: z.string().url(),
  token_file: z.string().default("~/.config/weigh/agent.token"),
  agent_id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .default("agent"),
  /** The Weigh checkout whose CLI runs the suites. */
  weigh_home: z.string(),
  workdir: z.string().default("~/weigh-projects"),
  runs_dir: z.string().default("~/weigh-projects/runs"),
  /** Prepended to PATH for the runner (bun, claude, git live outside the launchd PATH). */
  path_extra: z.array(z.string()).default([]),
  allowed_remotes: z.array(z.string()).default([]),
  projects: z.array(ProjectSchema).min(1),
  heartbeat_s: z.number().int().positive().default(20),
  poll_wait_s: z.number().int().positive().default(25),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type ProjectConfig = AgentConfig["projects"][number];

export const expand = (p: string) =>
  p.startsWith("~/") ? join(homedir(), p.slice(2)) : p === "~" ? homedir() : p;

export function loadConfig(path: string): AgentConfig {
  const file = resolve(expand(path));
  if (!existsSync(file)) throw new Error(`no agent config at ${file}`);
  const r = AgentConfigSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!r.success)
    throw new Error(
      `${file} is not a valid agent config:\n` +
        r.error.issues
          .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  const c = r.data;
  for (const k of ["token_file", "weigh_home", "workdir", "runs_dir"] as const)
    c[k] = resolve(expand(c[k]));
  for (const p of c.projects) {
    if (p.path) p.path = resolve(expand(p.path));
    if (p.remote && !c.allowed_remotes.some((a) => p.remote!.startsWith(a)))
      throw new Error(
        `project ${p.id}: remote ${p.remote} is not under allowed_remotes`,
      );
    if (p.install && !p.install.includes("--ignore-scripts"))
      throw new Error(`project ${p.id}: install must include --ignore-scripts`);
  }
  return c;
}

export function readToken(c: AgentConfig): string {
  const t =
    process.env.WEIGH_AGENT_TOKEN ??
    (existsSync(c.token_file) ? readFileSync(c.token_file, "utf8").trim() : "");
  if (!t)
    throw new Error(`no agent token in ${c.token_file} or WEIGH_AGENT_TOKEN`);
  return t;
}

export const checkoutDir = (c: AgentConfig, p: ProjectConfig) =>
  p.path ?? join(c.workdir, p.id);

export const isAbs = isAbsolute;
