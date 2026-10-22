import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSuite } from "../src/cli.ts";
import { sanitizeSuiteText, textRuleReason } from "../src/suite-text.ts";

const dirs: string[] = [];
const suiteName = "naming-suite";
const rule =
  'variant names may not contain an en dash or em dash or end with "+"';

interface SuiteText {
  labels?: string;
  description?: string;
  variantDescriptions?: readonly string[];
  checks?: readonly { id: string; description: string }[];
  skipped?: readonly { id: string; reason: string }[];
  timeline?: readonly { version: string; headline: string; number: string }[];
}

function suiteFile(names: string[], text: SuiteText = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "weigh-suite-load-"));
  dirs.push(dir);
  const file = join(dir, "suite.ts");
  writeFileSync(
    file,
    `export default {
      name: ${JSON.stringify(suiteName)},
      description: ${JSON.stringify(text.description ?? "Variant naming validation")},
      cases: async () => [],
      variants: ${JSON.stringify(names)}.map((name, i) => ({
        name, description: ${JSON.stringify(text.variantDescriptions ?? [])}[i] ?? "Test variant", run: async () => ({ text: "" })
      })),
      checks: ${JSON.stringify(text.checks ?? [])}.map(check => ({
        ...check, kind: "code", test: () => true
      })),
      ${text.skipped ? `skipped: () => ${JSON.stringify(text.skipped)},` : ""}
      ${text.timeline ? `timeline: ${JSON.stringify(text.timeline)},` : ""}
      ${text.labels !== undefined ? `labels: ${JSON.stringify(text.labels)},` : ""}
      baseline: ${JSON.stringify(names[0])},
      candidate: ${JSON.stringify(names[1])}
    };`,
  );
  return file;
}

afterAll(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function freshRun() {
  const root = mkdtempSync(join(tmpdir(), "weigh-suite-run-"));
  dirs.push(root);
  const previous = process.env.WEIGH_RUNS;
  process.env.WEIGH_RUNS = root;
  try {
    const runner = (await import(
      "../src/run.ts?" + Date.now() + Math.random()
    )) as typeof import("../src/run.ts");
    return { root, ...runner };
  } finally {
    if (previous === undefined) delete process.env.WEIGH_RUNS;
    else process.env.WEIGH_RUNS = previous;
  }
}

describe("suite text", () => {
  const textRule =
    'suite text may not contain an en dash or em dash or a number followed by "+"';

  test("labels accepts relative paths without text rules and rejects absolute or empty paths", async () => {
    for (const labels of [
      "weigh/labels/x.jsonl",
      "weigh/labels/300+\u2014x.jsonl",
    ]) {
      expect(
        (await loadSuite(suiteFile(["v2", "v3"], { labels }))).labels,
      ).toBe(labels);
    }
    for (const labels of ["/tmp/labels.jsonl", ""]) {
      await expect(
        loadSuite(suiteFile(["v2", "v3"], { labels })),
      ).rejects.toThrow("labels:");
    }
  });

  test("run metadata records labels and rescore refreshes or removes the declaration", async () => {
    const suite = await loadSuite(
      suiteFile(["v2", "v3"], { labels: "weigh/labels/x.jsonl" }),
    );
    const { runSuite, readMeta, rescore } = await freshRun();
    const dir = await runSuite(suite, { runId: "labels", log: () => {} });
    expect(readMeta(dir).labels).toBe(suite.labels);
    suite.labels = "weigh/labels/new.jsonl";
    await rescore(suite, dir);
    expect(readMeta(dir).labels).toBe(suite.labels);
    delete suite.labels;
    await rescore(suite, dir);
    expect(readMeta(dir).labels).toBeUndefined();
  });

  test.each([
    {
      text: { description: "Triage — the 300+ submissions" },
      path: "description",
      field: "description",
      reason: "contains an en dash or em dash",
    },
    {
      text: { variantDescriptions: ["clean", "handles 300+ rows"] },
      path: "variants.1.description",
      field: 'variant "v3" description',
      reason: 'contains a number followed by "+"',
    },
    {
      text: { checks: [{ id: "shape", description: "flags the – case" }] },
      path: "checks.0.description",
      field: 'check "shape" description',
      reason: "contains an en dash or em dash",
    },
    {
      text: {
        timeline: [
          { version: "v3", headline: "Handled 300+ submissions", number: "5" },
        ],
      },
      path: "timeline.0.headline",
      field: "timeline step 1 headline",
      reason: 'contains a number followed by "+"',
    },
  ])("rejects $path", async ({ text, path, field, reason }) => {
    const file = suiteFile(["v2", "v3"], text);
    await expect(loadSuite(file)).rejects.toHaveProperty(
      "message",
      `${file} is not a valid suite:\n  ${path}: ${field} in suite "${suiteName}" ${reason}; rewrite it (${textRule})`,
    );
  });

  test("reports one issue per bad text field", async () => {
    const file = suiteFile(["v2", "v3"], {
      description: "v3 has 5+",
      variantDescriptions: ["old—prompt", "new–prompt"],
      checks: [{ id: "shape", description: "300+ rows" }],
    });
    const issues = [
      ["description", "description", 'contains a number followed by "+"'],
      [
        "variants.0.description",
        'variant "v2" description',
        "contains an en dash or em dash",
      ],
      [
        "variants.1.description",
        'variant "v3" description',
        "contains an en dash or em dash",
      ],
      [
        "checks.0.description",
        'check "shape" description',
        'contains a number followed by "+"',
      ],
    ];
    await expect(loadSuite(file)).rejects.toHaveProperty(
      "message",
      `${file} is not a valid suite:\n` +
        issues
          .map(
            ([path, field, reason]) =>
              `  ${path}: ${field} in suite "${suiteName}" ${reason}; rewrite it (${textRule})`,
          )
          .join("\n"),
    );
  });

  test("rejects the first bad skipped reason before creating the run directory", async () => {
    const { root, runSuite } = await freshRun();
    for (const skipped of [
      [{ id: "c1", reason: "over 300+ pages" }],
      [
        { id: "c0", reason: "too long to run" },
        { id: "c1", reason: "too long — 300+ pages" },
        { id: "c2", reason: "over 300+ pages" },
      ],
    ]) {
      const suite = await loadSuite(suiteFile(["v2", "v3"], { skipped }));
      const reason =
        skipped.length === 1
          ? 'contains a number followed by "+"'
          : "contains an en dash or em dash";
      let calls = 0;
      suite.skipped = () => {
        calls++;
        return skipped;
      };
      await expect(
        runSuite(suite, { runId: "r1", log: () => {} }),
      ).rejects.toHaveProperty(
        "message",
        `skipped case "c1" reason in suite "${suiteName}" ${reason}; rewrite it (${textRule})`,
      );
      expect(calls).toBe(1);
      expect(existsSync(join(root, suiteName, "r1"))).toBe(false);
    }
  });

  test("loads clean text and records skipped reasons from one call", async () => {
    const skipped = [{ id: "c1", reason: "too long to run" }];
    const suite = await loadSuite(
      suiteFile(["v2", "v3"], {
        description: "Triage the submissions",
        variantDescriptions: ["Handles rows", "Handles more rows"],
        checks: [{ id: "shape", description: "C++ handles 1+1 and v3+beta" }],
        skipped,
      }),
    );
    const { runSuite, readMeta } = await freshRun();
    let calls = 0;
    // Like the Repo Scout suite, skipped fills only while cases() runs.
    const filled: { id: string; reason: string }[] = [];
    suite.cases = async () => {
      filled.splice(0, filled.length, ...skipped);
      return [];
    };
    suite.skipped = () => {
      calls++;
      return [...filled];
    };
    const dir = await runSuite(suite, { runId: "clean", log: () => {} });
    expect(calls).toBe(1);
    expect(readMeta(dir).skipped).toEqual(skipped);
    delete suite.skipped;
    const emptyDir = await runSuite(suite, { runId: "empty", log: () => {} });
    expect(readMeta(emptyDir).skipped).toEqual([]);
  });
});

describe("loadSuite variant names", () => {
  test.each([
    ["new–prompt", "contains an en dash or em dash"],
    ["new—prompt", "contains an en dash or em dash"],
    ["v3+", 'ends with "+"'],
    ["v3+ \t\n", 'ends with "+"'],
    ["new–prompt+", "contains an en dash or em dash"],
  ])("rejects candidate %j", async (name, reason) => {
    const file = suiteFile(["v2", name]);
    await expect(loadSuite(file)).rejects.toThrow(
      `${file} is not a valid suite:\n  variants.1.name: variant "${name}" in suite "${suiteName}" ${reason}; rename it (${rule})`,
    );
  });

  test("loads ordinary names and a plus in the middle", async () => {
    const names = ["v2", "v3", "c++-style"];
    const suite = await loadSuite(suiteFile(names));
    expect(suite.variants.map((v) => v.name)).toEqual(names);
  });

  test("reports one issue per offending variant, including non-candidates", async () => {
    const names = ["old—prompt+", "v3+", "extra–prompt"];
    const file = suiteFile(names);
    const message = await loadSuite(file).then(
      () => "loaded",
      (error: Error) => error.message,
    );
    expect(message).toBe(
      `${file} is not a valid suite:\n` +
        names
          .map(
            (name, i) =>
              `  variants.${i}.name: variant "${name}" in suite "${suiteName}" ${i === 1 ? 'ends with "+"' : "contains an en dash or em dash"}; rename it (${rule})`,
          )
          .join("\n"),
    );
  });
});

describe("runtime-sourced suite text", () => {
  test("sanitizeSuiteText turns dashes into hyphens and drops the plus after a number", () => {
    const cases: [string, string][] = [
      [
        "ERROR: video unavailable \u2014 retry later",
        "ERROR: video unavailable - retry later",
      ],
      ["pages 3\u20135", "pages 3-5"],
      ["1+ formats failed", "1 formats failed"],
      ["seen 300+", "seen 300"],
      ["tried 2++ times.", "tried 2 times."],
      ["(10+)", "(10)"],
      ["C++ and 1+1 and v2+beta stay", "C++ and 1+1 and v2+beta stay"],
      ["plain text", "plain text"],
    ];
    for (const [input, expected] of cases) {
      const out = sanitizeSuiteText(input);
      expect(out).toBe(expected);
      expect(textRuleReason(out)).toBeUndefined();
    }
    // Author text keeps failing loudly: the rule itself is unchanged.
    expect(textRuleReason("seen 300+")).toBe(
      'contains a number followed by "+"',
    );
    expect(textRuleReason("a \u2014 b")).toBe("contains an en dash or em dash");
  });
});
