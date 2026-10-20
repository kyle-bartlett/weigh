import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { casePage } from "../src/hub/pages/case.ts";
import { homePage, projectPage } from "../src/hub/pages/home.ts";
import { runPage } from "../src/hub/pages/run.ts";
import type { Project, Run } from "../src/hub/store.ts";
import { build } from "../src/report/build.ts";

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
    expect(page).toContain("Gate passed");
    expect(page.match(/data-case="/g)).toHaveLength(27);
    expect(page).not.toContain("/web/run.js");
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
