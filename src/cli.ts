#!/usr/bin/env bun
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { timelineSchema } from "./timeline.ts";
import { readLabels, validate } from "./judge.ts";
import { build, type JudgeRecord, summaryLine } from "./report/build.ts";
import { renderHtml } from "./report/html.ts";
import { renderMarkdown } from "./report/md.ts";
import { renderReview } from "./review.ts";
import {
  newRunId,
  readMeta,
  readTraces,
  rescore,
  resolveRun,
  runDir,
  runSuite,
} from "./run.ts";
import { pct } from "./stats.ts";
import { textRuleMessage, textRuleReason } from "./suite-text.ts";
import type { Suite, TraceLine } from "./types.ts";

/**
 *   weigh run <suite.ts> [--variants a,b] [--cases id,id] [--concurrency N] [--run-id ID]
 *   weigh report <suite> [run-id]          write report.html and summary.md for a run (default: latest)
 *   weigh gate <suite> [run-id]            exit 1 unless the candidate clears the suite's gate
 *   weigh review <suite> [run-id]          write review.html for open coding
 *   weigh judge-validate <suite> <labels.jsonl> --check <id> [run-id]
 */

const usage = `usage:
  weigh run <suite.ts> [--variants a,b] [--cases id,id] [--concurrency N] [--run-id ID] [--events path | --no-events]
  weigh report <suite> [run-id] [--candidate name] [--baseline name]
  weigh gate <suite> [run-id] [--candidate name] [--baseline name]
  weigh review <suite> [run-id]
  weigh judge-validate <suite> <labels.jsonl> --check <id> [run-id]
  weigh cases <suite.ts>                  build and list the cases (fetches and caches inputs)
  weigh suite-info <suite.ts>             print the suite's name, variants, checks and gate as JSON (no cases built)
  weigh rescore <suite.ts> [run-id]       re-run the checks over a run's cached outputs (no model calls)
  weigh hub [--port N] [--db path]         serve the dashboard (tokens from WEIGH_ADMIN_TOKEN, WEIGH_AGENT_TOKEN, WEIGH_READ_TOKEN)
  weigh import <run-dir> --hub <url> --project <id> [--agent id] [--token-file path | --token t]
                                          push a finished run directory to a hub (a new run is owned by --agent, default "import")
  weigh agent [--config ~/.config/weigh/agent.json] [--once]
                                          run suites for a hub on this machine
  weigh init <repo-dir> [--name <suite>]  add weigh/<suite>.suite.ts and weigh/types.ts to a project`;

/** Flags that take no value. Everything else starting with -- consumes the next argument. */
const BOOL_FLAGS = new Set(["--no-events", "--once"]);

function flag(args: string[], name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const positional = (args: string[]) =>
  args.filter(
    (a, i) =>
      !a.startsWith("--") &&
      !(
        i > 0 &&
        args[i - 1]!.startsWith("--") &&
        !BOOL_FLAGS.has(args[i - 1]!)
      ),
  );

const isFn = z.custom<(...a: never[]) => unknown>(
  (v) => typeof v === "function",
  "must be a function",
);

/** The shape a suite module must have. Errors name the field, so a repo author fixes it without reading Weigh. */
export const SuiteSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase slug"),
    description: z.string(),
    timeline: timelineSchema.optional(),
    cases: isFn,
    variants: z
      .array(
        z.object({
          name: z.string().min(1),
          description: z.string(),
          run: isFn,
        }),
      )
      .min(1),
    checks: z.array(
      z.object({
        id: z.string().min(1),
        description: z.string(),
        kind: z.enum(["code", "judge"]),
        test: isFn,
        applies: isFn.optional(),
      }),
    ),
    baseline: z.string().min(1),
    candidate: z.string().min(1),
    gate: z
      .object({
        maxPassAllDrop: z.number().min(0).max(1).optional(),
        noRegressionOn: z.array(z.string()).optional(),
      })
      .optional(),
    noise: z.string().optional(),
    moneyFields: z.array(z.string().min(1)).optional(),
    labels: z
      .string()
      .min(1)
      .refine(
        (p) => !isAbsolute(p),
        "must be a path relative to the repo, not absolute",
      )
      .optional(),
    concurrency: z.number().int().positive().optional(),
    inputText: isFn.optional(),
    skipped: isFn.optional(),
  })
  .superRefine((s, ctx) => {
    for (const [i, variant] of s.variants.entries()) {
      const reason = /[\u2013\u2014]/.test(variant.name)
        ? "contains an en dash or em dash"
        : /\+\s*$/.test(variant.name)
          ? 'ends with "+"'
          : undefined;
      if (reason)
        ctx.addIssue({
          code: "custom",
          path: ["variants", i, "name"],
          message: `variant "${variant.name}" in suite "${s.name}" ${reason}; rename it (variant names may not contain an en dash or em dash or end with "+")`,
        });
    }
    const checkText = (
      text: string,
      field: string,
      path: (string | number)[],
    ) => {
      const reason = textRuleReason(text);
      if (reason)
        ctx.addIssue({
          code: "custom",
          path,
          message: textRuleMessage(field, s.name, reason),
        });
    };
    checkText(s.description, "description", ["description"]);
    for (const [i, variant] of s.variants.entries())
      checkText(variant.description, `variant "${variant.name}" description`, [
        "variants",
        i,
        "description",
      ]);
    for (const [i, check] of s.checks.entries())
      checkText(check.description, `check "${check.id}" description`, [
        "checks",
        i,
        "description",
      ]);
    for (const [i, step] of (s.timeline ?? []).entries())
      for (const key of ["version", "headline", "number"] as const)
        checkText(step[key], `timeline step ${i + 1} ${key}`, [
          "timeline",
          i,
          key,
        ]);
    const names = new Set(s.variants.map((v) => v.name));
    for (const k of ["baseline", "candidate", "noise"] as const) {
      const v = s[k];
      if (v && !names.has(v))
        ctx.addIssue({
          code: "custom",
          path: [k],
          message: `names no variant (have ${[...names].join(", ")})`,
        });
    }
    const ids = new Set(s.checks.map((c) => c.id));
    for (const id of s.gate?.noRegressionOn ?? [])
      if (!ids.has(id))
        ctx.addIssue({
          code: "custom",
          path: ["gate", "noRegressionOn"],
          message: `${id} is not a check id`,
        });
  });

export async function loadSuite(path: string): Promise<Suite> {
  const mod = (await import(resolve(path))) as {
    default?: Suite;
    suite?: Suite;
  };
  const s = mod.default ?? mod.suite;
  if (!s)
    throw new Error(`${path} exports no suite (default or named "suite")`);
  const r = SuiteSchema.safeParse(s);
  if (!r.success)
    throw new Error(
      `${path} is not a valid suite:\n` +
        r.error.issues
          .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  return s;
}

/** What the agent needs to register a suite with the hub, without building a single case. */
export const suiteInfo = (s: Suite) => ({
  timeline: s.timeline,
  name: s.name,
  description: s.description,
  variants: s.variants.map((v) => ({
    name: v.name,
    description: v.description,
  })),
  checks: s.checks.map((c) => ({
    id: c.id,
    description: c.description,
    kind: c.kind,
  })),
  baseline: s.baseline,
  candidate: s.candidate,
  gate: s.gate,
  noise: s.noise,
  concurrency: s.concurrency,
});

function writeReports(
  dir: string,
  pick: { baseline?: string; candidate?: string } = {},
) {
  const def = readMeta(dir);
  // A non-default pair gets its own files, so report.html always means the suite's own baseline and candidate.
  const tag = [
    pick.baseline && pick.baseline !== def.baseline
      ? `from-${pick.baseline}`
      : "",
    pick.candidate && pick.candidate !== def.candidate ? pick.candidate : "",
  ]
    .filter(Boolean)
    .map((x) => "-" + x)
    .join("");
  const r = build(dir, pick);
  const html = join(dir, `report${tag}.html`);
  writeFileSync(html, renderHtml(r));
  writeFileSync(join(dir, `summary${tag}.md`), renderMarkdown(r));
  return { ...r, html };
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const pos = positional(rest);
  if (cmd === "run") {
    const path = pos[0];
    if (!path) throw new Error(usage);
    const suite = await loadSuite(path);
    const runId = flag(rest, "--run-id") ?? newRunId();
    // Events go to <run dir>/events.jsonl unless told otherwise; the agent tails that file to the hub.
    const eventsPath = rest.includes("--no-events")
      ? undefined
      : (flag(rest, "--events") ??
        join(runDir(suite.name, runId), "events.jsonl"));
    if (eventsPath) {
      mkdirSync(dirname(eventsPath), { recursive: true });
      writeFileSync(eventsPath, "");
    }
    const ac = new AbortController();
    const stop = () => ac.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const dir = await runSuite(suite, {
      variants: flag(rest, "--variants")?.split(","),
      cases: flag(rest, "--cases")?.split(","),
      concurrency: Number(flag(rest, "--concurrency")) || undefined,
      runId,
      command: `bun src/cli.ts run ${path}${rest.filter((a) => a !== path).length ? " " + rest.filter((a) => a !== path).join(" ") : ""}`,
      signal: ac.signal,
      onEvent: eventsPath
        ? (e) => appendFileSync(eventsPath, JSON.stringify(e) + "\n")
        : undefined,
    });
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    if (ac.signal.aborted) {
      console.error(
        `cancelled; partial run kept at ${dir} (rerun the same --run-id to resume)`,
      );
      return 130;
    }
    const r = writeReports(dir);
    console.log(summaryLine(r));
    console.log(`report: ${join(dir, "report.html")}`);
    return r.gate.pass ? 0 : 1;
  }
  if (cmd === "hub") {
    const { startHub } = await import("./hub/server.ts");
    const h = startHub({
      port: Number(flag(rest, "--port")) || Number(process.env.PORT) || 8787,
      dbPath:
        flag(rest, "--db") ??
        process.env.WEIGH_DB ??
        join(import.meta.dir, "..", "data", "weigh.db"),
    });
    console.error(`weigh hub listening on ${h.url}`);
    await new Promise(() => {});
    return 0;
  }
  if (cmd === "agent") {
    const { startAgent } = await import("./agent/main.ts");
    await startAgent(flag(rest, "--config") ?? "~/.config/weigh/agent.json", {
      once: rest.includes("--once"),
    });
    return 0;
  }
  if (cmd === "init") {
    const repo = pos[0];
    if (!repo) throw new Error(usage);
    const name = flag(rest, "--name") ?? "main";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
      throw new Error("--name must be a lowercase slug");
    const dir = join(resolve(repo), "weigh");
    mkdirSync(dir, { recursive: true });
    const types = join(dir, "types.ts");
    writeFileSync(
      types,
      readFileSync(join(import.meta.dir, "types.ts"), "utf8"),
    );
    const suite = join(dir, `${name}.suite.ts`);
    if (existsSync(suite)) throw new Error(`${suite} already exists`);
    writeFileSync(
      suite,
      readFileSync(
        join(import.meta.dir, "..", "templates", "weigh.suite.ts"),
        "utf8",
      ).replaceAll("__NAME__", name),
    );
    console.log(`wrote ${types}\nwrote ${suite}`);
    return 0;
  }
  if (cmd === "import") {
    const dir = pos[0];
    const hub = flag(rest, "--hub");
    const project = flag(rest, "--project");
    const tokenFile = flag(rest, "--token-file");
    const token =
      flag(rest, "--token") ??
      (tokenFile ? readFileSync(tokenFile, "utf8").trim() : undefined) ??
      process.env.WEIGH_AGENT_TOKEN ??
      process.env.WEIGH_ADMIN_TOKEN;
    const agentId = flag(rest, "--agent");
    if (!dir || !hub || !project || !token) throw new Error(usage);
    if (agentId !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(agentId))
      throw new Error("--agent must be a lowercase slug");
    const { HubClient, importRunDir } = await import("./agent/upload.ts");
    const r = await importRunDir(new HubClient(hub, token), resolve(dir), {
      project,
      agentId,
      log: (s) => console.error(s),
    });
    console.log(`${hub.replace(/\/$/, "")}/r/${r.suite}/${r.run_id}`);
    return 0;
  }
  if (cmd === "suite-info") {
    const path = pos[0];
    if (!path) throw new Error(usage);
    console.log(JSON.stringify(suiteInfo(await loadSuite(path)), null, 1));
    return 0;
  }
  if (cmd === "cases") {
    const path = pos[0];
    if (!path) throw new Error(usage);
    const suite = await loadSuite(path);
    const cases = await suite.cases();
    for (const c of cases)
      console.log(`${c.id.padEnd(16)} ${(c.tags ?? []).join(",")}`);
    for (const s of suite.skipped?.() ?? [])
      console.log(`skipped ${s.id.padEnd(16)} ${s.reason}`);
    console.log(`${cases.length} cases`);
    return 0;
  }
  if (cmd === "report" || cmd === "gate" || cmd === "review") {
    const suite = pos[0];
    if (!suite) throw new Error(usage);
    const dir = resolveRun(suite, pos[1]);
    const pick = {
      baseline: flag(rest, "--baseline"),
      candidate: flag(rest, "--candidate"),
    };
    if (cmd === "review") {
      const meta = readMeta(dir);
      const inputs = join(dir, "inputs.json");
      const texts: Record<string, string> = existsSync(inputs)
        ? JSON.parse(readFileSync(inputs, "utf8"))
        : {};
      writeFileSync(
        join(dir, "review.html"),
        renderReview({
          dir,
          meta,
          lines: readTraces(dir),
          baseline: meta.baseline,
          candidate: meta.candidate,
          inputText: (id) => texts[id] ?? "",
        }),
      );
      console.log(`review: ${join(dir, "review.html")}`);
      return 0;
    }
    const r = writeReports(dir, pick);
    console.log(summaryLine(r));
    if (cmd === "report") console.log(`report: ${r.html}`);
    return r.gate.pass ? 0 : 1;
  }
  if (cmd === "rescore") {
    const path = pos[0];
    if (!path) throw new Error(usage);
    const suite = await loadSuite(path);
    const dir = resolveRun(suite.name, pos[1]);
    const res = await rescore(suite, dir);
    console.error(
      `rescored ${res.scored} of ${res.lines} trace lines, ${res.changed} changed`,
    );
    const r = writeReports(dir);
    console.log(summaryLine(r));
    console.log(`report: ${r.html}`);
    return r.gate.pass ? 0 : 1;
  }
  if (cmd === "judge-validate") {
    const [suite, labelsPath, runId] = pos;
    const check = flag(rest, "--check");
    if (!suite || !labelsPath || !check) throw new Error(usage);
    const dir = resolveRun(suite, runId);
    const meta = readMeta(dir);
    const lines = readTraces(dir);
    const byKey = new Map<string, TraceLine>(
      lines.map((l) => [`${l.variant}\u0000${l.case_id}`, l]),
    );
    const labels = readLabels(labelsPath);
    const result = validate(labels, (r) => {
      const l = byKey.get(`${r.variant ?? meta.candidate}\u0000${r.case_id}`);
      const v = l?.checks[check];
      return v === undefined ? undefined : v ? "pass" : "fail";
    });
    if (result.joined === 0)
      throw new Error(
        `no label matched a verdict of ${check}; judges.json not written`,
      );
    console.log(
      "| split | n | human fails | human passes | TPR | TNR |\n|---|---|---|---|---|---|",
    );
    for (const s of result.splits)
      console.log(
        `| ${s.split} | ${s.n} | ${s.humanFails} | ${s.humanPasses} | ${pct(s.tpr)} | ${pct(s.tnr)} |`,
      );
    console.log(
      `${result.joined} labels matched a judge verdict; ${result.unmatched} did not.`,
    );
    const p = join(dir, "judges.json");
    const all = existsSync(p)
      ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, JudgeRecord>)
      : {};
    all[check] = {
      ...result,
      check,
      labels: labelsPath,
      at: new Date().toISOString(),
    };
    writeFileSync(p, JSON.stringify(all, null, 1));
    writeReports(dir);
    return 0;
  }
  throw new Error(usage);
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(2);
    });
}
