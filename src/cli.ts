#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readLabels, validate } from "./judge.ts";
import { renderHtml } from "./report/html.ts";
import { renderMarkdown } from "./report/md.ts";
import { renderReview } from "./review.ts";
import { readMeta, readTraces, resolveRun, runSuite, rescore } from "./run.ts";
import {
  compare,
  gate as gateOf,
  noiseFloor,
  pct,
  signedPct,
} from "./stats.ts";
import type { Suite, TraceLine } from "./types.ts";

/**
 *   weigh run <suite.ts> [--variants a,b] [--cases id,id] [--concurrency N] [--run-id ID]
 *   weigh report <suite> [run-id]          write report.html and summary.md for a run (default: latest)
 *   weigh gate <suite> [run-id]            exit 1 unless the candidate clears the suite's gate
 *   weigh review <suite> [run-id]          write review.html for open coding
 *   weigh judge-validate <suite> <labels.jsonl> --check <id> [run-id]
 */

const usage = `usage:
  weigh run <suite.ts> [--variants a,b] [--cases id,id] [--concurrency N] [--run-id ID]
  weigh report <suite> [run-id] [--candidate name] [--baseline name]
  weigh gate <suite> [run-id] [--candidate name] [--baseline name]
  weigh review <suite> [run-id]
  weigh judge-validate <suite> <labels.jsonl> --check <id> [run-id]
  weigh cases <suite.ts>                  build and list the cases (fetches and caches inputs)
  weigh rescore <suite.ts> [run-id]       re-run the checks over a run's cached outputs (no model calls)`;

function flag(args: string[], name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const positional = (args: string[]) =>
  args.filter(
    (a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")),
  );

async function loadSuite(path: string): Promise<Suite> {
  const mod = (await import(resolve(path))) as {
    default?: Suite;
    suite?: Suite;
  };
  const s = mod.default ?? mod.suite;
  if (!s)
    throw new Error(`${path} exports no suite (default or named "suite")`);
  return s;
}

function build(
  dir: string,
  pick: { baseline?: string; candidate?: string } = {},
) {
  const meta = readMeta(dir);
  if (pick.baseline) meta.baseline = pick.baseline;
  if (pick.candidate) meta.candidate = pick.candidate;
  const lines = readTraces(dir);
  const cmp = compare(
    lines,
    meta.baseline,
    meta.candidate,
    meta.checks.map((c) => c.id),
    meta.case_order,
  );
  const noise =
    meta.noise &&
    meta.noise !== meta.candidate &&
    lines.some((l) => l.variant === meta.noise)
      ? noiseFloor(
          cmp,
          compare(
            lines,
            meta.baseline,
            meta.noise,
            meta.checks.map((c) => c.id),
            meta.case_order,
          ),
          meta.gate?.noRegressionOn ?? [],
        )
      : undefined;
  return { meta, lines, cmp, gate: gateOf(cmp, meta.gate), noise };
}

function writeReports(
  dir: string,
  extra: { judge?: Parameters<typeof renderHtml>[0]["judge"] } = {},
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
  const r = { ...build(dir, pick), ...extra };
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
    const dir = await runSuite(suite, {
      variants: flag(rest, "--variants")?.split(","),
      cases: flag(rest, "--cases")?.split(","),
      concurrency: Number(flag(rest, "--concurrency")) || undefined,
      runId: flag(rest, "--run-id"),
      command: `bun src/cli.ts run ${path}${rest.filter((a) => a !== path).length ? " " + rest.filter((a) => a !== path).join(" ") : ""}`,
    });
    const r = writeReports(dir);
    console.log(summaryLine(r));
    console.log(`report: ${join(dir, "report.html")}`);
    return r.gate.pass ? 0 : 1;
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
    const r = writeReports(dir, {}, pick);
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
    writeReports(dir, { judge: { ...result, check } });
    return 0;
  }
  throw new Error(usage);
}

function summaryLine(r: ReturnType<typeof build>) {
  const { cmp, gate } = r;
  return `${gate.pass ? "GATE PASS" : "GATE FAIL"}  pass-all ${pct(cmp.baseline.passAll.rate)} -> ${pct(cmp.candidate.passAll.rate)}  prompt tokens ${signedPct(cmp.promptTokens.pctChange)}  cost ${signedPct(cmp.costUsd.pctChange)}  latency ${signedPct(cmp.latencyMs.pctChange)}  n=${cmp.promptTokens.n}${gate.pass ? "" : "  (" + gate.reasons.join("; ") + ")"}${r.noise ? `  noise floor: ${r.noise.within ? "within" : "beyond"} (${r.noise.variant} moved pass-all ${signedPct(-r.noise.passAllDrop)})` : ""}`;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(2);
    });
}
