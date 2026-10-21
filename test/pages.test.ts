import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { casePage } from "../src/hub/pages/case.ts";
import { homePage, projectPage } from "../src/hub/pages/home.ts";
import { runPage } from "../src/hub/pages/run.ts";
import type { Project, Run } from "../src/hub/store.ts";
import { build, buildFrom } from "../src/report/build.ts";
import { runFragments } from "../src/hub/pages/run-sections.ts";

const example = join(
  import.meta.dir,
  "..",
  "runs",
  "examples",
  "exchange-triage-2026-10-19",
);
const DASH = /[—–]/;

const project: Project = {
  id: "exchange-triage",
  name: "Exchange Triage",
  description: "Insurance submission triage",
  repo_url: "https://github.com/kyle-bartlett/exchange-triage",
  branch: "main",
  public: true,
  created_at: "2026-10-20T00:00:00Z",
};

describe("hub pages", () => {
  const b = build(example);
  const run: Run = {
    key: "exchange-triage/2026-10-19-prompts",
    project_id: project.id,
    suite: "exchange-triage",
    run_id: "2026-10-19-prompts",
    status: "finished",
    requested_at: b.meta.started_at,
    started_at: b.meta.started_at,
    finished_at: b.meta.finished_at,
    cancel_requested: false,
    options: {},
    meta: b.meta,
    summary: {
      pass: b.gate.pass,
      reasons: b.gate.reasons,
      baseline_pass_all: b.cmp.baseline.passAll.rate,
      candidate_pass_all: b.cmp.candidate.passAll.rate,
      prompt_tokens_pct: b.cmp.promptTokens.pctChange,
      paired_n: 27,
      at: b.meta.finished_at!,
    },
    finished: 108,
    total: 108,
    last_seq: 110,
    last_src_seq: 110,
  };

  test("verdict says who won, by how much, and whether to ship", () => {
    const html = runPage(project, run, b);
    expect(html).toContain('data-section="verdict"');
    expect(html).toContain("Ship it");
    expect(html).toContain("more cases passed every check");
    expect(html).toContain("Decisions right");
    expect(html).toContain("Cost per case");
    expect(html).toContain("Anything smaller is not a real change.");
  });

  test("a failed comparison says not to ship and names the loss", () => {
    const html = runPage(project, run, build(example, { baseline: "v1" }));
    expect(html.includes("Don't ship")).toBe(true);
    expect(html.includes("Keep the current prompt")).toBe(true);
    expect(html.includes("4 fewer decisions right")).toBe(true);
  });

  test("unfinished and stopped runs never announce a winner or ship", () => {
    for (const status of [
      "queued",
      "running",
      "failed",
      "cancelled",
    ] as const) {
      const html = runPage(
        project,
        { ...run, status, finished: 40 },
        status === "queued" ? undefined : b,
      );
      expect(html.includes("Don't ship yet")).toBe(true);
      expect(html.includes('data-complete="true"')).toBe(false);
      if (status === "running")
        expect(html.includes("Grading case 41 of 108")).toBe(true);
    }
  });

  test("plain sections keep case links, checked graders, details and all measurements", () => {
    const html = runPage(project, run, b);
    for (const copy of [
      "What changed, in words",
      "cases fixed.",
      "cases broke.",
      "What we grade",
      "Every case",
      "Wrong decision",
      "Grader flagged a source",
      "quote it",
      "follow up with the broker",
      'id="engineers"',
      "For engineers",
      "Where runs fail",
      "Method",
      "Wrongly flags",
      "likely range",
      "cache",
      "JSON",
    ])
      expect(html.includes(copy)).toBe(true);
    expect(html.includes('<details id="engineers" open')).toBe(false);
    expect(html.includes("/c/GOLD-")).toBe(true);
    expect(html.includes("/web/run.js")).toBe(true);
    expect(html).not.toMatch(/\d\+|[—–]/);
  });

  test("live fragments retain unpaired rows and explain unanswered checks without claiming validation", () => {
    const before = {
      ...b.lines.find((l) => l.variant === b.meta.baseline)!,
      checks: { decision_correct: true },
    };
    const after = {
      ...before,
      variant: b.meta.candidate,
      checks: { decision_correct: true },
      unanswered: ["attribution_jev"],
    };
    const partial = buildFrom(b.meta, [before, after], []);
    const f = runFragments({ ...run, status: "running" }, partial);
    expect(f.verdict.includes("No winner yet")).toBe(true);
    expect(f.ledger.includes("Passed the answered checks")).toBe(true);
    expect(
      f.ledger.includes("the grader gave no verdict, so it is left out"),
    ).toBe(true);
    expect(f.checks.includes("without human validation recorded")).toBe(true);
    const unpaired = runFragments(
      { ...run, status: "running" },
      buildFrom(b.meta, [before], []),
    );
    expect(unpaired.ledger.match(/data-case="/g)).toHaveLength(1);
    expect(unpaired.ledger.includes("Waiting for this prompt")).toBe(true);
  });

  test("the engineers drawer retains the full computed comparison and selected reproduce command", () => {
    const other = build(example, { baseline: "v1" });
    const f = runFragments(run, other);
    const json = f.engineers.match(
      /All comparison measurements \(JSON\)<\/summary><pre>(.*?)<\/pre>/s,
    )![1]!;
    const decoded = JSON.parse(
      json
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    );
    // JSON serializes unavailable numeric rates as null, just like the API does.
    expect(decoded).toEqual(
      JSON.parse(
        JSON.stringify({
          comparison: other.cmp,
          noise: other.noise,
          gate: other.gate,
          judges: other.judges,
        }),
      ),
    );
    expect(f.engineers.includes("--baseline v1 --candidate v3")).toBe(true);
    expect(f.engineers.includes("?baseline=v1&amp;candidate=v3")).toBe(true);
  });

  test("every page renders without an em or en dash and carries what the live module patches", () => {
    const home = homePage([{ project, suites: [], latest: run }]);
    const suite = {
      project_id: project.id,
      name: "exchange-triage",
      description: "four prompts",
      path: "weigh/exchange-triage.suite.ts",
      info: { variants: [1, 2, 3, 4], checks: [1, 2, 3, 4, 5, 6, 7] },
      registered_at: "2026-10-20T00:00:00Z",
    };
    const proj = projectPage(project, [suite], [run], { admin: true });
    const page = runPage(project, run, b);
    const waiting = runPage(
      project,
      { ...run, status: "queued", meta: undefined, finished: 0, total: 0 },
      undefined,
    );
    const live = runPage(
      project,
      { ...run, status: "running", finished: 40 },
      b,
    );
    const c = casePage(
      project,
      run,
      "GOLD-01",
      "BROKER EMAIL: hello",
      b.lines.filter((l) => l.case_id === "GOLD-01"),
      new Map(),
    );
    for (const html of [home, proj, page, waiting, live, c])
      expect(html).not.toMatch(DASH);
    expect(page).toContain("Ship it");
    expect(page.match(/data-case="/g)).toHaveLength(27);
    expect(page).toContain("/web/run.js");
    expect(live).toContain("/web/run.js");
    expect(live).toContain('data-section="ledger"');
    expect(waiting).toContain("waiting for the agent");
    expect(proj).toContain("Run now");
    expect(projectPage(project, [suite], [run])).not.toContain("Run now");
    expect(c).toContain("v3");
  });

  test("no source file under src/hub, web, templates or the README carries an em or en dash", () => {
    const root = join(import.meta.dir, "..");
    const files: string[] = ["README.md"];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    for (const d of ["src/hub", "src/agent", "web", "templates"]) {
      try {
        walk(join(root, d));
      } catch {
        /* a directory that does not exist yet */
      }
    }
    const bad = files.filter((f) =>
      DASH.test(readFileSync(f.startsWith("/") ? f : join(root, f), "utf8")),
    );
    expect(bad).toEqual([]);
  });
});
