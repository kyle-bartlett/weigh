import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { casePage } from "../src/hub/pages/case.ts";
import { homePage, projectPage } from "../src/hub/pages/home.ts";
import { runPage } from "../src/hub/pages/run.ts";
import { Store, type Project, type Run } from "../src/hub/store.ts";
import { openDb } from "../src/hub/db.ts";
import { build, buildFrom } from "../src/report/build.ts";
import { runFragments } from "../src/hub/pages/run-sections.ts";
import type { VariantOutput } from "../src/types.ts";

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

  function landingStore() {
    const store = new Store(openDb(":memory:"));
    store.upsertProject(project);
    store.createRun(run);
    store.updateRun(run.key, run);
    for (const line of b.lines) store.upsertTrace(run.key, line);
    store.putJudges(run.key, b.judges);
    return store;
  }

  test("case compares stored fields and decisions, preserving every record in the drawer", () => {
    const lines = b.lines.filter((l) => l.case_id === "GOLD-01");
    const outputs = new Map<
      string,
      { output: VariantOutput; truncated: boolean }
    >();
    for (const line of lines)
      outputs.set(line.variant, {
        output: {
          output: {
            fields: [
              {
                field: "construction",
                expected: "Joisted Masonry",
                got:
                  line.variant === b.meta.baseline
                    ? "Frame"
                    : "Joisted Masonry",
                correct: true,
              },
            ],
            decision:
              line.variant === b.meta.baseline ? "INCOMPLETE" : "IN APPETITE",
            expectedDecision: "IN APPETITE",
            decisionCorrect: true,
          },
          usage: line.usage,
        },
        truncated: true,
      });
    const html = casePage(
      project,
      run,
      "GOLD-01",
      "BROKER EMAIL: hello",
      lines,
      outputs,
    );
    const [product, engineers] = html.split('<details id="engineers">');
    expect(product).toContain("What the broker wrote");
    expect(product).toContain("BROKER EMAIL: hello");
    expect(product).toContain("What each version answered");
    expect(product).toContain("Expected");
    expect(product).toContain("Current prompt");
    expect(product).toContain("New prompt");
    expect(product).toContain('class="table-scroll"');
    expect(product).toContain('data-different="true"');
    expect(product).toContain(
      '<td class="field-difference">Frame, differs from the expert</td>',
    );
    expect(product).toContain("Joisted Masonry, matches the expert");
    expect(product).toContain("follow up with the broker");
    expect(product).toContain("quote it");
    expect(product).toContain('class="tag"');
    expect(product).not.toContain("prompt tokens</dt>");
    expect(product).not.toContain("&quot;fields&quot;");
    expect(engineers).toContain("For engineers</summary>");
    for (const line of lines)
      expect(engineers).toContain(`<h3 class="mono">${line.variant}</h3>`);
    for (const text of [
      "prompt tokens",
      "output tokens",
      "latency",
      "cost",
      "at</dt>",
      "Trace line",
      "&quot;fields&quot;",
      "Output truncated",
      "decision_correct",
    ])
      expect(engineers).toContain(text);
    expect(html).toContain("/web/run.js");
    expect(html).toContain('data-live="false"');
    expect(html).not.toMatch(DASH);
  });

  test("case handles nulls, missing fields, invalid outputs and conflicting expert answers", () => {
    const lines = b.lines.filter((l) => l.case_id === "GOLD-01");
    const stored = (output: unknown) => ({
      output: { output, usage: lines[0]!.usage },
      truncated: false,
    });
    const outputs = new Map([
      [
        b.meta.baseline,
        stored({
          fields: [
            { field: "nullable", expected: null, got: null, correct: false },
            { field: "missing", expected: 0, got: 0, correct: true },
            { field: "conflict", expected: "A", got: "A", correct: true },
            { field: "<script>", expected: "<b>", got: "<b>", correct: true },
          ],
        }),
      ],
      [
        b.meta.candidate,
        stored({
          fields: [
            {
              field: "nullable",
              expected: null,
              got: "invented",
              correct: true,
            },
            { field: "conflict", expected: "B", got: "B", correct: true },
          ],
          decision: "REFERRED",
          expectedDecision: "REFERRED",
        }),
      ],
      ["untraced", stored("extra raw record")],
    ]);
    const html = casePage(project, run, "GOLD-01", undefined, lines, outputs);
    const [product, engineers] = html.split('<details id="engineers">');
    expect(product).toContain("Not provided, matches the expert");
    expect(product).toContain("invented, differs from the expert");
    expect(product).toContain("0, matches the expert");
    expect(product).toContain("No stored answer for this field.");
    expect(product).toContain("Stored expert answers differ.");
    expect(product).toContain("send to an underwriter");
    expect(product).toContain("&lt;script&gt;");
    expect(product).not.toContain("<b>, matches");
    expect(engineers).toContain("extra raw record");
    for (const malformed of [
      "plain answer",
      null,
      4,
      {},
      { fields: null },
      { fields: [null, "bad", { field: "bad", expected: {}, got: [] }] },
    ]) {
      const fallback = casePage(
        project,
        run,
        "GOLD-01",
        undefined,
        lines,
        new Map([[b.meta.baseline, stored(malformed)]]),
      );
      expect(fallback).toContain("Some field answers aren't available");
      expect(fallback.split('<details id="engineers">')[1]).toContain(
        "Full output record (JSON)",
      );
      expect(fallback).not.toContain("undefined, matches the expert");
    }
  });

  test("landing normalizes offset timestamps and version punctuation", () => {
    const store = landingStore();
    try {
      store.updateRun(run.key, { finished_at: "2026-10-20T01:30:00+03:00" });
      expect(homePage(store).includes(">2026-10-19 22:30 UTC</time>")).toBe(
        true,
      );
      const candidate = "new\u2013prompt 300+";
      store.updateRun(run.key, {
        meta: {
          ...b.meta,
          candidate,
          variants: b.meta.variants.map((v) =>
            v.name === b.meta.candidate ? { ...v, name: candidate } : v,
          ),
        },
      });
      for (const line of b.lines.filter((l) => l.variant === b.meta.candidate))
        store.upsertTrace(run.key, { ...line, variant: candidate });
      const html = homePage(store);
      expect(html).not.toMatch(DASH);
      expect(html.replace(/<[^>]*>/g, "")).not.toMatch(/\d\+/);
      expect(html).toContain("new, prompt 300 or more");
      expect(html).toContain('class="tag"');
    } finally {
      store.db.close();
    }
  });

  test("landing renders the approved copy, shared verdict story, steps and buttons", () => {
    const store = landingStore();
    try {
      const html = homePage(store);
      expect(html).toContain("Watch an AI get graded.</h1>");
      expect(html).toContain(
        "Weigh runs a new prompt against the old one on real cases, grades every answer, and shows the result as it happens. Built by Kyle Bartlett.",
      );
      const sentence = runFragments(run, b).verdict.match(
        /<h1[^>]*>(.*?)<\/h1>/s,
      )![1]!;
      expect(html).toContain(sentence);
      expect(html).toContain(
        "23 of 27 decisions right, unchanged from 23 of 27.",
      );
      expect(html).toContain("Costs 17.3% less per case (API-equivalent).");
      expect(html).toContain("Ship it.");
      for (const text of [
        "Queue a run from the browser.",
        "Watch cases grade themselves live from an always-on machine.",
        "Read the verdict and open any case to see what the model said.",
        "An AI that reads emails and makes decisions will be wrong sometimes. The question is whether you find out first. This is how.",
      ])
        expect(html).toContain(text);
      expect(html.match(/<svg /g)).toHaveLength(3);
      expect(html).toContain(`href="/r/${run.key}">watch the run</a>`);
      expect(html).toContain(
        `class="btn primary" href="/r/${run.key}">Watch a run</a>`,
      );
      expect(html).toContain(
        'href="mailto:kyle@bartlettlabs.io">Talk to Kyle</a>',
      );
      expect(html).toContain(`href="/p/${project.id}"`);
      expect(html.indexOf('id="projects"')).toBeGreaterThan(
        html.indexOf("Talk to Kyle"),
      );
      expect(html).not.toMatch(DASH);
      expect(html).not.toMatch(/\d\+/);
    } finally {
      store.db.close();
    }
  });

  test("landing trust reports the labels the graders were checked against, else the hub's labels", () => {
    const store = landingStore();
    try {
      const joined = Math.max(...b.judges.map((j) => j.joined));
      let html = homePage(store);
      // Judges carry their own validation count; the hub's labels table is empty here.
      expect(html).toContain(`graders checked against ${joined} human labels`);
      expect(html).toContain("27 cases");
      expect(html).toContain(`datetime="${run.finished_at}"`);
      expect(html).toContain('href="https://github.com/kyle-bartlett/weigh"');
      const labels = b.meta.case_order.slice(0, 3).map((case_id) => ({
        case_id,
        variant: b.meta.candidate,
        human: "pass" as const,
      }));
      store.upsertLabels(run, labels);
      store.upsertLabels(run, [{ ...labels[0]!, human: "fail" }]);
      html = homePage(store);
      expect(html).toContain(`graders checked against ${joined} human labels`);
      expect(html).not.toContain("3 human labels");
      store.db.run("DELETE FROM judges WHERE run_key = ?", [run.key]);
      html = homePage(store);
      expect(html).toContain(
        "3 human labels recorded; graders not checked yet.",
      );
      store.deleteLabel(run.key, labels[0]!.case_id, labels[0]!.variant);
      html = homePage(store);
      expect(html).toContain(
        "2 human labels recorded; graders not checked yet.",
      );
      store.db.run("DELETE FROM labels WHERE run_key = ?", [run.key]);
      expect(homePage(store)).toContain(
        "No human labels recorded for this run.",
      );
      store.db.run("DELETE FROM trace_lines WHERE run_key = ?", [run.key]);
      html = homePage(store);
      expect(html).toContain("This comparison has no graded cases.");
      expect(html).toContain("Case count not available.");
      expect(html).not.toContain("0 cases");
      expect(html).not.toMatch(DASH);
    } finally {
      store.db.close();
    }
  });

  test("landing selects by finish time, ignores active runs and hides private results", () => {
    const store = landingStore();
    try {
      const older = { ...run, key: "exchange-triage/older", run_id: "older" };
      store.createRun(older);
      store.updateRun(older.key, {
        ...older,
        finished_at: "2026-01-01T00:00:00Z",
      });
      // Enough queued runs to put the finished run beyond listRuns' default limit.
      for (let i = 0; i < 55; i++)
        store.createRun({
          ...run,
          key: `exchange-triage/queued-${i}`,
          run_id: `queued-${i}`,
          status: "queued",
        });
      store.upsertProject({ id: "private", public: false });
      const hidden = {
        ...run,
        key: "secret/hidden",
        suite: "secret",
        run_id: "hidden",
        project_id: "private",
      };
      store.createRun(hidden);
      store.updateRun(hidden.key, {
        ...hidden,
        finished_at: "2099-01-01T00:00:00Z",
      });
      store.upsertLabels(hidden, [
        { case_id: "private-case", variant: "v3", human: "pass" },
      ]);
      for (const line of b.lines) store.upsertTrace(hidden.key, line);
      expect(homePage(store)).toContain(
        `class="btn primary" href="/r/${run.key}"`,
      );
      expect(homePage(store)).not.toContain("secret/hidden");
      expect(homePage(store)).not.toContain(
        "graders checked against 1 human labels",
      );
      expect(homePage(store, { includePrivate: true })).toContain(
        'class="btn primary" href="/r/secret/hidden"',
      );
    } finally {
      store.db.close();
    }
  });

  test("landing without a finished run has no verdict or broken watch link", () => {
    const store = new Store(openDb(":memory:"));
    try {
      for (const status of [
        undefined,
        "queued",
        "running",
        "failed",
        "cancelled",
        "lost",
      ] as const) {
        if (status) {
          store.upsertProject(project);
          if (!store.getRun(run.key)) store.createRun({ ...run, status });
          store.updateRun(run.key, { status });
        }
        const html = homePage(store);
        expect(html).toContain("Watch an AI get graded.");
        expect(html).toContain("No finished run yet.");
        expect(html).not.toContain('data-section="latest-verdict"');
        expect(html).not.toContain('href="/r/');
        expect(html).not.toContain("Last run");
        expect(html).not.toContain("graders checked against");
        expect(html).toContain(
          'disabled aria-disabled="true">Watch a run</button>',
        );
        expect(html).toContain('href="mailto:kyle@bartlettlabs.io"');
        expect(html).toContain('href="https://github.com/kyle-bartlett/weigh"');
        expect(html).not.toMatch(DASH);
      }
    } finally {
      store.db.close();
    }
  });

  test("landing handles missing grades and uses the shared failed verdict", () => {
    const store = landingStore();
    try {
      store.updateRun(run.key, { meta: { ...b.meta, baseline: "v1" } });
      const html = homePage(store);
      expect(html).toContain("4 fewer decisions right");
      expect(html).toContain("Don't ship.");
      expect(html).not.toContain("Ship it.");
      store.db.run("DELETE FROM trace_lines WHERE run_key = ?", [run.key]);
      const empty = homePage(store);
      expect(empty).toContain("This comparison has no graded cases.");
      expect(empty).not.toContain("Ship it.");
      expect(empty).not.toMatch(/NaN|Infinity|undefined/);
      expect(empty).not.toMatch(DASH);
    } finally {
      store.db.close();
    }
  });

  test("verdict says who won, by how much, and whether to ship", () => {
    const html = runPage(project, run, b);
    expect(html).toContain('data-section="verdict"');
    expect(html).toContain("Ship it");
    expect(html).toContain('data-ship="true"');
    expect(html).toContain("more cases passed every check");
    expect(html).toContain("Decisions right");
    expect(html).toContain("Cost per case");
    expect(html).toContain("Anything smaller is not a real change.");
  });

  test("a failed comparison says not to ship and names the loss", () => {
    const html = runPage(project, run, build(example, { baseline: "v1" }));
    expect(html.includes("Don't ship")).toBe(true);
    expect(html.includes("Ship it")).toBe(false);
    expect(html.includes('data-ship="false"')).toBe(true);
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

  test("a finished run on a case subset still gets a verdict, and a lost run says so", () => {
    const lines = readFileSync(join(example, "traces.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const ids = new Set(b.meta.case_order.slice(0, 10));
    const subset = buildFrom(
      b.meta,
      lines.filter((l) => ids.has(l.case_id)),
      b.judges,
    );
    const html = runPage(project, { ...run, finished: 40, total: 40 }, subset);
    expect(html.includes('data-complete="true"')).toBe(true);
    expect(html.includes("still grading")).toBe(false);
    expect(/Ship it|Don't ship/.test(html)).toBe(true);
    const lost = runPage(project, { ...run, status: "lost", finished: 40 }, b);
    expect(
      lost.includes("Lost contact with the agent after 40 of 108 cases."),
    ).toBe(true);
    expect(lost.includes("Don't ship yet")).toBe(true);
    expect(lost.includes("Grading case")).toBe(false);
    expect(lost.includes('data-live="true"')).toBe(true);
  });

  test("plain sections keep case links, checked graders, details and all measurements", () => {
    const html = runPage(project, run, b);
    for (const copy of [
      "What changed, in words",
      "cases fixed.",
      "case broke.",
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
    const store = landingStore();
    const home = homePage(store);
    store.db.close();
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
