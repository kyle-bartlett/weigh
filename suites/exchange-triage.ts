/**
 * Exchange Triage: the extraction prompt versions, measured against each other.
 *
 * Exchange Triage (triage.bartlettlabs.io) reads a broker's commercial-property submission and
 * decides IN APPETITE, INCOMPLETE, REFERRED or DECLINED through five nodes: intake, Claude
 * extraction, source grounding, deterministic appetite rules with a Claude fit score, and a
 * writer. Three extraction prompts exist. v1 is the frozen plain prompt. v2 added canonical
 * construction classes and the broker-working-value rule after measured v1 failures. v3 is
 * production: it fixed an over-extraction Arize caught live (a subclass invented from "commercial
 * property") and tied every `source` attribution to a citable span.
 *
 * The suite imports the production pipeline, prompts, golden set and field scorer from the
 * exchange-triage checkout (ET_CHECKOUT, default ~/wildcard/exchange-triage), so what it
 * measures is what ships. Model calls go through the subscription path (src/claude-cli.ts),
 * never the SDK the app itself uses; the app's own `callClaude` is never invoked here.
 *
 * Checks: code assertions first (schema, fields, canonical construction class, expected nulls
 * stay null, decision). Then two judges for the one property code cannot check, truthful
 * `source` attribution, so the report can show which judge earns trust against human labels.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { callClaudeCli, firstJson } from "../src/claude-cli.ts";
import {
  addUsage,
  emptyUsage,
  type Case,
  type Check,
  type Stage,
  type Suite,
  type Usage,
  type VariantOutput,
} from "../src/types.ts";

const HOME = homedir();
const ET = process.env.ET_CHECKOUT ?? join(HOME, "wildcard/exchange-triage");
const JEV_KIT = process.env.JEV_KIT_DIR ?? join(HOME, ".claude/jev-kit");
const DATA = join(import.meta.dir, "..", "data", "exchange-triage");
const MODEL = "sonnet";

// ── Exchange Triage, by path ───────────────────────────────────────────────────────────────

type Decision = "IN APPETITE" | "INCOMPLETE" | "REFERRED" | "DECLINED";
type Field = { value: unknown; confidence: number; source: string | null };
type Extraction = Record<string, Field>;
interface GoldenCase {
  id: string;
  submissionId?: string;
  source?: { broker: string; emailText: string; attachmentText?: string };
  expected: {
    fields?: Record<string, string | number | null>;
    decision: Decision;
  };
}
interface TriageInput {
  submissionId: string;
  broker: string;
  emailText: string;
  attachmentText?: string;
}
type Event = { type: string; [k: string]: unknown };
interface RunResult {
  decision: Decision;
  fitScore: number | null;
  confidence: number;
  reasons: string[];
  extraction: Extraction | null;
  events: Event[];
}
interface ModelCall {
  system?: string;
  prompt: string;
  onToken?: (t: string) => void;
}
interface ModelReply {
  text: string;
  inTokens: number;
  outTokens: number;
  ms: number;
  costUsd: number;
}
interface ScoredField {
  field: string;
  expected: string | number | null;
  got: string | number | null;
  correct: boolean;
}

const runMod = (await import(join(ET, "lib/pipeline/run.ts"))) as {
  runTriage: (
    input: TriageInput,
    opts: {
      promptVersion: "v1" | "v2" | "v3";
      notify: boolean;
      draft: boolean;
      model: (c: ModelCall) => Promise<ModelReply>;
    },
  ) => Promise<RunResult>;
};
const anthropicMod = (await import(join(ET, "lib/anthropic.ts"))) as {
  ModelUnavailableError: new (m: string) => Error;
};
const scoreMod = (await import(join(ET, "evals/score.ts"))) as {
  scoreCase: (
    id: string,
    expected: GoldenCase["expected"],
    extraction: Extraction | null,
    decision: Decision,
    telemetry: {
      inTokens: number;
      outTokens: number;
      costUsd: number;
      ms: number;
    },
  ) => { decisionCorrect: boolean; fields: ScoredField[] };
};
const caseMod = (await import(join(ET, "evals/case.ts"))) as {
  caseInput: (c: GoldenCase) => TriageInput;
};
const golden = JSON.parse(
  readFileSync(join(ET, "evals/golden/golden-set.json"), "utf8"),
) as { cases: GoldenCase[] };

// ── The model seam: the app's pipeline, our metered call ──────────────────────────────────

/** An adapter for one pipeline run. Every call it makes is summed into `acc`. */
/** Retry delays for a failed CLI call. The first run lost 21 of 108 cases to one transient
 *  outage window; the app routes a model failure to referral, which then scores as a wrong
 *  decision, so the harness must not hand it a failure the CLI would have recovered from. */
const RETRY_WAIT_MS = [5_000, 20_000];

function meteredModel(acc: { usage: Usage; errors: string[] }) {
  return async (c: ModelCall): Promise<ModelReply> => {
    let r = await callClaudeCli({
      system: c.system ?? "",
      user: c.prompt,
      model: MODEL,
    });
    acc.usage = addUsage(acc.usage, r.usage);
    for (const wait of RETRY_WAIT_MS) {
      if (r.ok) break;
      acc.errors.push(r.error ?? "cli failed");
      await new Promise((res) => setTimeout(res, wait));
      r = await callClaudeCli({
        system: c.system ?? "",
        user: c.prompt,
        model: MODEL,
      });
      acc.usage = addUsage(acc.usage, r.usage);
    }
    if (!r.ok) {
      acc.errors.push(r.error ?? "cli failed");
      throw new anthropicMod.ModelUnavailableError(r.error ?? "cli failed");
    }
    c.onToken?.(r.text);
    return {
      text: r.text,
      inTokens:
        r.usage.inputTokens +
        r.usage.cacheReadTokens +
        r.usage.cacheCreationTokens,
      outTokens: r.usage.outputTokens,
      ms: r.usage.latencyMs,
      costUsd: r.usage.costUsd,
    };
  };
}

// ── Output shape and stages ────────────────────────────────────────────────────────────────

export interface Output {
  decision: Decision;
  expectedDecision: Decision;
  decisionCorrect: boolean;
  fitScore: number | null;
  confidence: number;
  reasons: string[];
  extraction: Extraction | null;
  /** Non-null fields with the source the model claimed for each. */
  extracted: { field: string; value: unknown; source: string | null }[];
  fields: ScoredField[];
  retries: number;
  guardrails: { node: string; guardrail: string; status: string }[];
  flags: { field: string; issue: string; detail: string }[];
}

export function extractedPairs(e: Extraction | null) {
  return Object.entries(e ?? {})
    .filter(([, f]) => f && f.value != null)
    .map(([field, f]) => ({ field, value: f.value, source: f.source ?? null }));
}

/**
 * Stages read against the reference, so the matrix says where a wrong answer first went wrong:
 * extraction (a scored field is off), grounding (the verifier disputed a correct value), or
 * appetite (right fields, wrong decision).
 */
export function stagesFor(o: Output): Stage[] {
  const wrong = o.fields.filter((f) => !f.correct).map((f) => f.field);
  const correct = new Set(
    o.fields.filter((f) => f.correct).map((f) => f.field),
  );
  const falseAlarms = o.flags
    .filter((f) => f.issue === "ambiguous" && correct.has(f.field))
    .map((f) => f.field);
  return [
    { name: "intake", ok: true },
    {
      name: "extraction",
      ok: o.extraction !== null && wrong.length === 0,
      detail:
        o.extraction === null
          ? "schema failed twice"
          : wrong.join(", ") || undefined,
    },
    {
      name: "grounding",
      ok: o.extraction !== null && falseAlarms.length === 0,
      detail: falseAlarms.join(", ") || undefined,
    },
    {
      name: "appetite",
      ok: o.decisionCorrect,
      detail: o.decisionCorrect
        ? undefined
        : `${o.decision} (want ${o.expectedDecision})`,
    },
  ];
}

async function runVersion(
  c: Case,
  version: "v1" | "v2" | "v3",
): Promise<VariantOutput> {
  const gc = c.reference as GoldenCase;
  const acc = { usage: emptyUsage("claude-cli"), errors: [] as string[] };
  const r = await runMod.runTriage(c.input as TriageInput, {
    promptVersion: version,
    notify: false,
    draft: false,
    model: meteredModel(acc),
  });
  const score = scoreMod.scoreCase(
    gc.id,
    gc.expected,
    r.extraction,
    r.decision,
    {
      inTokens: 0,
      outTokens: 0,
      costUsd: 0,
      ms: 0,
    },
  );
  const output: Output = {
    decision: r.decision,
    expectedDecision: gc.expected.decision,
    decisionCorrect: score.decisionCorrect,
    fitScore: r.fitScore,
    confidence: r.confidence,
    reasons: r.reasons,
    extraction: r.extraction,
    extracted: extractedPairs(r.extraction),
    fields: score.fields,
    retries: r.events.filter((e) => e.type === "node_retry").length,
    guardrails: r.events
      .filter((e) => e.type === "guardrail")
      .map((e) => ({
        node: String(e.node),
        guardrail: String(e.guardrail),
        status: String(e.status),
      })),
    flags: r.events
      .filter((e) => e.type === "field_flag")
      .map((e) => ({
        field: String(e.field),
        issue: String(e.issue),
        detail: String(e.detail),
      })),
  };
  return {
    output,
    usage: acc.usage,
    extra: {
      decision: r.decision,
      fitScore: r.fitScore,
      retries: output.retries,
      fieldsWrong: output.fields.filter((f) => !f.correct).length,
      modelErrors: acc.errors.join(" | ").slice(0, 400),
    },
    stages: stagesFor(output),
  };
}

// ── Judges: truthful source attribution ────────────────────────────────────────────────────

const ATTRIBUTION_RULE =
  'Every extracted field whose source is "email", "attachment" or "both" must have its value stated in that document. ' +
  'A canonical restatement of a stated value counts as stated: an abbreviation expanded, a construction class named for the broker\'s wording, a state code for a stated city and state, a number with its units normalised, or a working figure the broker lands on ("call it 2006"). ' +
  "A value not stated anywhere in the named document, including a plausible default, a value taken from a different field, or a value only inferable with outside knowledge, is a false attribution. " +
  "Fields with source null are exempt.";

export function judgeState(input: TriageInput, extracted: Output["extracted"]) {
  const lines = extracted.map(
    (p) =>
      `- ${p.field} = ${JSON.stringify(p.value)} (source: ${p.source ?? "null"})`,
  );
  return (
    `BROKER EMAIL:\n${input.emailText}\n\n` +
    (input.attachmentText ? `ATTACHMENT:\n${input.attachmentText}\n\n` : "") +
    `EXTRACTED FIELDS:\n${lines.join("\n") || "(none)"}`
  );
}

export function judgeKey(caseId: string, extracted: Output["extracted"]) {
  return createHash("sha256")
    .update(caseId)
    .update("\u0000")
    .update(JSON.stringify(extracted))
    .digest("hex")
    .slice(0, 20);
}

interface JudgeRecord {
  jev?: number | null;
  jevError?: string;
  claude?: { verdict: "PASS" | "FAIL"; field?: string; reason?: string } | null;
}

/** Verdicts are cached per (case, extracted values): rescore never re-spends a judge call. */
const cachePath = join(DATA, "judges.json");
const cache: Record<string, JudgeRecord> = existsSync(cachePath)
  ? (JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, JudgeRecord>)
  : {};
function saveCache() {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 1));
}

type Jev = {
  jevEvaluate: (o: {
    caller: string;
    state: string;
    questions: Record<string, { type: "noul"; instructions: string }>;
    timeoutMs?: number;
  }) => Promise<{ answers: Record<string, { noul?: unknown } | undefined> }>;
  prob: (x: unknown) => number | null;
};
let jev: Promise<Jev> | undefined;

/** A Jev probability, or null when Jev did not answer twice (the error is kept beside it, never scored). */
async function jevVerdict(key: string, state: string): Promise<number | null> {
  if (typeof cache[key]?.jev === "number") return cache[key].jev!;
  const j = await (jev ??= import(join(JEV_KIT, "lib/jev.ts")) as Promise<Jev>);
  let p: number | null = null;
  let error: string | undefined;
  for (let attempt = 0; attempt < 2 && p === null; attempt++) {
    if (attempt) await new Promise((res) => setTimeout(res, 3_000));
    try {
      const r = await j.jevEvaluate({
        caller: "weigh-exchange-triage",
        state,
        questions: {
          q: {
            type: "noul",
            instructions: `${ATTRIBUTION_RULE} Is every source attribution in EXTRACTED FIELDS truthful?`,
          },
        },
        timeoutMs: 60_000,
      });
      p = j.prob(r.answers.q?.noul);
      if (p === null) error = "no probability in reply";
    } catch (e) {
      error = String(e instanceof Error ? e.message : e).slice(0, 200);
    }
  }
  cache[key] = {
    ...cache[key],
    jev: p,
    jevError: p === null ? error : undefined,
  };
  saveCache();
  return p;
}

const CLAUDE_JUDGE_SYSTEM =
  "You audit source attributions in an insurance submission extractor's output. " +
  ATTRIBUTION_RULE +
  ' Check each field in turn against the named document. Return only JSON: {"verdict":"PASS"|"FAIL","field":"<first falsely attributed field or empty>","reason":"<one sentence>"}. PASS means every attribution is truthful.';

/** The Haiku judge's verdict, or null when two calls produced no parseable verdict. */
async function claudeVerdict(key: string, state: string) {
  if (cache[key]?.claude) return cache[key].claude!;
  let j: { verdict?: string; field?: string; reason?: string } | undefined;
  for (let attempt = 0; attempt < 2 && !j?.verdict; attempt++) {
    const r = await callClaudeCli({
      system: CLAUDE_JUDGE_SYSTEM,
      user: state,
      model: "haiku",
      timeoutMs: 90_000,
    });
    j = firstJson(r.text) as typeof j;
  }
  const verdict: JudgeRecord["claude"] =
    j?.verdict === "PASS" || j?.verdict === "FAIL"
      ? {
          verdict: j.verdict as "PASS" | "FAIL",
          field: j.field,
          reason: j.reason,
        }
      : null;
  cache[key] = { ...cache[key], claude: verdict };
  saveCache();
  return verdict;
}

// ── Checks ─────────────────────────────────────────────────────────────────────────────────

const out = (o: VariantOutput) => o.output as Output;
const expectedFields = (c: Case) =>
  (c.reference as GoldenCase).expected.fields ?? {};

const checks: Check[] = [
  {
    id: "extraction_schema",
    kind: "code",
    description:
      "Extraction JSON matched the schema within the pipeline's two attempts.",
    test: (_c, o) => out(o).extraction !== null,
  },
  {
    id: "fields_correct",
    kind: "code",
    description:
      "Every labelled field matches the golden value under the app's own field scorer (0.5% on dollar amounts, canonical construction class, null means null).",
    applies: (c) => Object.keys(expectedFields(c)).length > 0,
    test: (_c, o) => out(o).fields.every((f) => f.correct),
  },
  {
    id: "construction_canonical",
    kind: "code",
    description:
      "constructionType is the canonical ISO class the appetite rules consume, not the broker's wording.",
    applies: (c) => "constructionType" in expectedFields(c),
    test: (_c, o) =>
      out(o).fields.find((f) => f.field === "constructionType")?.correct ===
      true,
  },
  {
    id: "nulls_stay_null",
    kind: "code",
    description:
      "Fields the source never states come back null (no guessed TIV, year built, state or subclass).",
    applies: (c) => Object.values(expectedFields(c)).some((v) => v === null),
    test: (c, o) =>
      Object.entries(expectedFields(c))
        .filter(([, v]) => v === null)
        .every(
          ([k]) => out(o).fields.find((f) => f.field === k)?.correct === true,
        ),
  },
  {
    id: "decision_correct",
    kind: "code",
    description: "The routing decision matches the golden label.",
    test: (_c, o) => out(o).decisionCorrect,
  },
  {
    id: "attribution_jev",
    kind: "judge",
    description:
      "Jev (TypeSafe yes/no classifier) says every `source` attribution is truthful: the value is stated in the document it names. Pass at probability 0.5 or above.",
    applies: (_c) => true,
    test: async (c, o) => {
      const e = out(o).extracted;
      if (!e.length) return true;
      const p = await jevVerdict(
        judgeKey(c.id, e),
        judgeState(c.input as TriageInput, e),
      );
      return p === null ? null : p >= 0.5;
    },
  },
  {
    id: "attribution_claude",
    kind: "judge",
    description:
      "Claude Haiku, given only the source text and the extracted fields, says every `source` attribution is truthful.",
    test: async (c, o) => {
      const e = out(o).extracted;
      if (!e.length) return true;
      const v = await claudeVerdict(
        judgeKey(c.id, e),
        judgeState(c.input as TriageInput, e),
      );
      return v ? v.verdict === "PASS" : null;
    },
  },
];

// ── The suite ──────────────────────────────────────────────────────────────────────────────

const suite: Suite = {
  name: "exchange-triage",
  // v1/v2 counts: construction_canonical=false in the committed example traces.
  // v3 incident: prompt history above. v4 to v6: measured on runs 2026-10-20-v4, -v5 and -v6
  // (see exchange-triage/prompts/extraction.v5.ts and v6.ts headers, evals/STRATEGY.md F1).
  timeline: [
    {
      version: "v1",
      headline: "The plain prompt repeated the broker's construction wording.",
      number: "4 nonstandard construction answers",
    },
    {
      version: "v2",
      headline:
        "Canonical construction classes gave the rules the names they expect.",
      number: "0 nonstandard construction answers",
    },
    {
      version: "v3",
      headline:
        "An invented value caught in production led to stricter source checks.",
      number: "1 invented value caught",
    },
    {
      version: "v4",
      headline:
        "Bare-masonry submissions stopped triggering unnecessary follow-ups.",
      number: "4 follow-ups fixed",
    },
    {
      version: "v5",
      headline:
        "Expiring premiums and quoted ranges stopped being read as the target.",
      number: "2 regressions fixed",
    },
    {
      version: "v6",
      headline:
        "Per-unit target rates count again, and v6 became the production prompt.",
      number: "27 of 27 decisions right",
    },
  ],
  description:
    `Exchange Triage extraction prompts v1, v2 and v3 over the 27-case golden set, through the production pipeline (intake, extraction, grounding, appetite; writer off) on claude ${MODEL} via the CLI. ` +
    "Baseline v2 (what shipped 2026-07-27), candidate v3 (production), v2-repeat as the noise floor, v1 as the frozen plain prompt. " +
    "Reference: the golden labels. Judges: two source-attribution classifiers, validated against human labels in suites/exchange-triage.labels.jsonl.",
  cases: async () =>
    golden.cases.map((gc) => ({
      id: gc.id,
      input: caseMod.caseInput(gc),
      reference: gc,
      tags: [gc.expected.decision, gc.submissionId ? "seeded" : "inline"],
    })),
  inputText: (c) => {
    const i = c.input as TriageInput;
    return (
      `Broker: ${i.broker}\n\n${i.emailText}` +
      (i.attachmentText ? `\n\nATTACHMENT:\n${i.attachmentText}` : "")
    );
  },
  variants: [
    {
      name: "v2",
      description:
        "Extraction prompt v2: canonical construction classes and the broker-working-value rule. Shipped 2026-07-27.",
      run: (c) => runVersion(c, "v2"),
    },
    {
      name: "v2-repeat",
      description: "v2 run a second time on identical inputs: the noise floor.",
      run: (c) => runVersion(c, "v2"),
    },
    {
      name: "v3",
      description:
        "Extraction prompt v3, production: null-first subclass rule and source tied to a citable span, after a live over-extraction Arize caught.",
      run: (c) => runVersion(c, "v3"),
    },
    {
      name: "v1",
      description:
        "Extraction prompt v1, frozen: plain instructions, no construction mapping, no few-shot examples.",
      run: (c) => runVersion(c, "v1"),
    },
  ],
  checks,
  baseline: "v2",
  candidate: "v3",
  noise: "v2-repeat",
  moneyFields: ["tiv", "targetPremium"],
  gate: {
    maxPassAllDrop: 0,
    noRegressionOn: ["decision_correct", "fields_correct"],
  },
  concurrency: 4,
};

export default suite;
