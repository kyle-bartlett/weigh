import type { Built } from "../../report/build.ts";
import { esc } from "../../report/html.ts";
import { stripPlot } from "../../report/html.ts";
import { matrix, fromTraces, cell } from "../../transition.ts";
import { promptTokens, type TraceLine } from "../../types.ts";
import type { Interval, Paired } from "../../stats.ts";
import type { Run } from "../store.ts";

export const tag = (name: string, meaning: string) =>
  `<span class="tag" tabindex="0" title="${esc(meaning)}">${esc(name)}</span>`;
/** Display only: dashes become commas and a trailing "N+" becomes "N or more", so public pages never show either. */
export const plainName = (text: string) =>
  text
    .replace(/\s*[\u2013\u2014]\s*/g, ", ")
    .replace(/(\d)\+(?!\w)/g, "$1 or more");
export const version = (name: string, role: string) =>
  `${role} ${tag(plainName(name), `The ${role}'s version name`)}`;
const number = (n: number, digits = 0) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : "Not available";
const count = (n: number, digits = 0, prefix = "") =>
  Number.isFinite(n)
    ? `<span data-count="${n}" data-digits="${digits}" data-prefix="${prefix}">${prefix}${number(n, digits)}</span>`
    : "Not available";

/** Shared verdict wording for the run card and the landing story. */
export function verdictSummary(run: Run, b?: Built) {
  const complete =
    run.status === "finished" &&
    b &&
    b.cmp.candidate.n > 0 &&
    b.cmp.baseline.n > 0;
  const B = b?.cmp.baseline,
    C = b?.cmp.candidate;
  const current = version(
    B?.variant ?? run.meta?.baseline ?? "pending",
    "current prompt",
  );
  const next = version(
    C?.variant ?? run.meta?.candidate ?? "pending",
    "new prompt",
  );
  const delta = B && C ? C.passAll.passed - B.passAll.passed : 0;
  const result =
    delta === 0
      ? "the same number of cases passed every check"
      : `${Math.abs(delta)} ${delta > 0 ? "more" : "fewer"} ${Math.abs(delta) === 1 ? "case" : "cases"} passed every check`;
  let sentence = complete
    ? `The ${next} ${delta > 0 ? "beat" : delta < 0 ? "trailed" : "tied"} the ${current}: ${result}.`
    : run.status === "finished"
      ? "This comparison has no graded cases."
      : run.status === "failed" || run.status === "cancelled"
        ? "This run stopped before a complete comparison was ready."
        : run.status === "lost"
          ? "The agent lost contact with the hub. The run picks up where it left off when the agent returns."
          : "We're still grading the prompts. No winner yet.";
  const decision = b?.cmp.checks.find((c) => c.id === "decision_correct");
  if (complete && !b.gate.pass) {
    const lostN =
      decision && decision.delta < 0
        ? decision.baseline.passed - decision.candidate.passed
        : 0;
    sentence =
      lostN > 0
        ? `Keep the ${current}: the ${next} got ${lostN} fewer ${lostN === 1 ? "decision" : "decisions"} right.`
        : `Keep the ${current}: with the ${next}, ${result}, but it didn't meet the shipping rules.`;
  } else if (complete && b.gate.pass && delta < 0) {
    sentence = `The ${next} stayed close enough to the ${current} to ship: ${result}, within the drop the suite allows.`;
  }
  const ship = complete
    ? b.gate.pass
      ? "Ship it"
      : "Don't ship"
    : "Don't ship yet";
  const answers =
    decision?.candidate.n && decision.baseline.n
      ? `${number(decision.candidate.passed)} of ${number(decision.candidate.n)} decisions right, ${decision.delta === 0 ? "unchanged from" : decision.delta > 0 ? "up from" : "down from"} ${number(decision.baseline.passed)} of ${number(decision.baseline.n)}.`
      : "";
  const cost =
    complete && b
      ? Number.isFinite(b.cmp.costUsd.pctChange)
        ? b.cmp.costUsd.pctChange === 0
          ? "Costs the same per case (API-equivalent)."
          : `Costs ${change(b.cmp.costUsd.pctChange)} per case (API-equivalent).`
        : "Cost change per case isn't available."
      : "";
  return {
    status: run.status,
    complete,
    sentence,
    ship,
    decision,
    answers: complete ? answers : "",
    cost,
    changed:
      complete && b ? changedSentence(b) : "The comparison isn't finished yet.",
    story: [sentence, complete ? answers : "", cost, `${ship}.`]
      .filter(Boolean)
      .join(" "),
  };
}

export function verdictCard(run: Run, b?: Built): string {
  const { complete, sentence, ship, decision } = verdictSummary(run, b);
  const B = b?.cmp.baseline,
    C = b?.cmp.candidate;
  const metric = (value: string, label: string, meaning: string) =>
    `<div><div class="n mono">${value}</div><b>${label}</b><p>${meaning}</p></div>`;
  return `<div class="verdict-card" data-complete="${!!complete}" data-ship="${!!complete && !!b?.gate.pass}">
<h1 class="page display">${sentence}</h1>
<p class="ship"><b>${ship}</b> ${tag("gate", "Whether the new prompt clears the suite's shipping rules")}${!complete && b ? " Results so far." : ""}</p>
<div class="verdict-numbers">
${metric(decision?.candidate.n ? `${count(decision.candidate.passed)} of ${number(decision.candidate.n)}` : "Not graded", "Decisions right", decision?.baseline.n ? `Matches the expert's answer; current prompt ${number(decision.baseline.passed)} of ${number(decision.baseline.n)}.` : "This comparison has no decision answers graded yet.")}
${metric(C?.n ? `${count(C.passAll.passed)} of ${number(C.passAll.n)}` : "Waiting", `Cases that passed every check ${tag("pass-all", "A case passes every check that applies; unanswered checks are left out")}`, B?.n ? `All applicable checks passed; current prompt ${number(B.passAll.passed)} of ${number(B.passAll.n)}.` : "Every applicable check must pass.")}
${metric(C?.n && b ? count(b.cmp.costUsd.candidateMean, 4, "$") : "Waiting", "Cost per case", B?.n && b ? `API-equivalent average; current prompt $${number(b.cmp.costUsd.baselineMean, 4)}.` : "Average API-equivalent cost of one case.")}
</div>
<p class="noise-note">${b?.noise && Number.isFinite(b.noise.passAllDrop) ? `The current prompt, run twice, moved ${number(Math.abs(b.noise.passAllDrop) * 100, 1)} points. Anything smaller is not a real change.` : "The current prompt hasn't been compared with a repeat run yet."} ${tag("noise", "The change in the share of cases passing every check when the current prompt runs twice")}</p>
</div>`;
}

const percent = (n: number, digits = 1) =>
  Number.isFinite(n) ? `${number(n * 100, digits)}%` : "Not available";
const change = (n: number) =>
  Number.isFinite(n)
    ? n === 0
      ? "No change"
      : `${percent(Math.abs(n))} ${n < 0 ? "less" : "more"}`
    : "Not available";
const points = (n: number) =>
  Number.isFinite(n)
    ? `${number(Math.abs(n) * 100, 1)} points ${n < 0 ? "lower" : "higher"}`
    : "Not available";
const range = (i: Interval, f = percent) =>
  Number.isFinite(i.lo) ? `${f(i.lo)} to ${f(i.hi)}` : "Not available";
const ciTag = () =>
  tag(
    "CI",
    "95% interval: Wilson for rates, seeded bootstrap for paired means",
  );
const plainNames: Record<string, [string, string]> = {
  extraction_schema: [
    "The answer has the required structure",
    "The extracted answer fits the required fields within two attempts.",
  ],
  fields_correct: [
    "The facts match the expert's answers",
    "Every labelled value matches, including amounts, construction class and missing facts.",
  ],
  construction_canonical: [
    "Construction type is the standard class",
    "The class is one the insurance rules can use.",
  ],
  nulls_stay_null: [
    "Missing facts stay empty",
    "The model doesn't guess facts the source never states.",
  ],
  decision_correct: [
    "The decision matches the expert's",
    "The next step for the submission matches the expert's answer.",
  ],
  attribution_jev: [
    "Each fact is backed by its named source",
    "Jev checks that the named document actually states the value.",
  ],
  attribution_claude: [
    "Each fact is backed by its named source",
    "Claude Haiku checks the source text against the extracted values.",
  ],
};

function checkName(b: Built, id: string) {
  const check = b.meta.checks.find((c) => c.id === id);
  return plainNames[id]?.[0] ?? check?.description ?? id;
}

// Technical terms in supplied descriptions use the same vocabulary as authored copy.
function prose(text: string, b?: Built): string {
  const terms: Record<string, [string, string]> = {
    "pass-all": ["cases that passed every check", "pass-all"],
    "noise floor": ["repeat-run change", "noise"],
    variants: ["versions", "variant"],
    variant: ["version", "variant"],
    "prompt tokens": [
      "words sent to the model (what it costs)",
      "prompt tokens",
    ],
    regressions: ["cases that got worse", "regression"],
    regression: ["a case that got worse", "regression"],
    trace: ["the full record of one run", "trace"],
    judges: ["AI graders", "judge"],
    judge: ["an AI grader", "judge"],
  };
  return esc(plainName(text))
    .replace(
      /\b(baseline|candidate)\b(?:\s+([\w.-]+))?/gi,
      (_, role: string, following?: string) => {
        const words =
          role.toLowerCase() === "baseline" ? "current prompt" : "new prompt";
        return following && b?.meta.variants.some((v) => v.name === following)
          ? version(following, words)
          : `${words}${following ? ` ${following}` : ""}`;
      },
    )
    .replace(
      /\b(noise floor|prompt tokens|pass-all|variants?|regressions?|trace|judges?)\b/gi,
      (word) => {
        const [plain, term] = terms[word.toLowerCase()]!;
        return `${plain} ${tag(term, plain)}`;
      },
    );
}

const caseUrl = (base: string, id: string) =>
  `${base}/c/${encodeURIComponent(id)}`;
function pairedRows(b: Built) {
  const byVersion = (v: string) =>
    new Map(b.lines.filter((l) => l.variant === v).map((l) => [l.case_id, l]));
  const B = byVersion(b.meta.baseline),
    C = byVersion(b.meta.candidate);
  return b.meta.case_order.flatMap((id) =>
    B.has(id) && C.has(id)
      ? [{ id, before: B.get(id)!, after: C.get(id)! }]
      : [],
  );
}

function changedGroups(b: Built) {
  const rows = pairedRows(b);
  const passesAll = (line: (typeof rows)[number]["after"]) =>
    line.ok && b.meta.checks.every((c) => line.checks[c.id] !== false);
  const fixed = rows.filter(
    ({ before, after }) =>
      after.ok &&
      ((!before.ok && passesAll(after)) ||
        b.meta.checks.some(
          (c) => before.checks[c.id] === false && after.checks[c.id] === true,
        )),
  );
  const broken = rows.filter(
    ({ before, after }) =>
      before.ok &&
      (!after.ok ||
        b.meta.checks.some(
          (c) => before.checks[c.id] === true && after.checks[c.id] === false,
        )),
  );
  return { fixed, broken };
}

export function changedSentence(b: Built): string {
  const { fixed, broken } = changedGroups(b);
  return `${fixed.length} ${fixed.length === 1 ? "case" : "cases"} gained a passing check; ${broken.length} ${broken.length === 1 ? "case" : "cases"} lost one, compared with the current prompt.`;
}

export function changedCases(b: Built, base: string): string {
  const { fixed, broken } = changedGroups(b);
  const rows = pairedRows(b);
  const links = (items: typeof rows) =>
    items
      .map(({ id }) => `<a href="${esc(caseUrl(base, id))}">${esc(id)}</a>`)
      .join(", ") || "None.";
  return `<section><div class="sec-head"><h2 class="display">What changed, in words</h2><p><b>${fixed.length} ${fixed.length === 1 ? "case" : "cases"} fixed. ${broken.length} ${broken.length === 1 ? "case" : "cases"} broke.</b><br>A case counts once in each group if any check changed. A case can have both a fix and a break; an unanswered check doesn't count as either.</p></div>
<p>Fixed: ${links(fixed)}</p><p>Broke: ${links(broken)}</p>${broken.length ? `<p>A case that got worse ${tag("regression", "A check passed with the current prompt and failed with the new prompt")}; open it to see which check changed.</p>` : ""}</section>`;
}

const grader = (b: Built, id: string) =>
  b.judges.some((j) => j.check === id)
    ? `An AI grader we checked against human answers ${tag("judge", "The human comparison and its test split are in For engineers")}`
    : `An AI grader without human validation recorded ${tag("judge", "Treat this as a review signal until checked against human answers")}`;

export function plainChecks(b: Built): string {
  return `<section><div class="sec-head"><h2 class="display">What we grade</h2><p>Each check asks one question. Counts compare the current prompt with the new prompt on the same cases.</p></div>
<div class="check-list">${b.cmp.checks
    .map((c) => {
      const d = b.meta.checks.find((d) => d.id === c.id)!;
      return `<article class="check-row"><div><h3>${prose(checkName(b, c.id))} ${tag(c.id, d.description)}</h3><p>${prose(plainNames[c.id]?.[1] ?? d.description)}</p>${d.kind === "judge" ? `<p>${grader(b, c.id)}</p>` : ""}${c.saturated ? `<p>Every case passes, so this check can no longer tell prompts apart ${tag("saturated", "Both prompts pass every applicable case")}</p>` : ""}</div><p class="check-counts">${version(b.meta.baseline, "Current prompt")}<br><span class="mono">${c.baseline.passed} of ${c.baseline.n}</span> passed<br>${version(b.meta.candidate, "New prompt")}<br><span class="mono">${c.candidate.passed} of ${c.candidate.n}</span> passed</p></article>`;
    })
    .join("")}</div></section>`;
}

function caseStatus(l: TraceLine | undefined, b: Built): string {
  if (!l) return "Waiting for this prompt";
  if (!l.ok) return "Run failed";
  if (l.checks.decision_correct === false) return "Wrong decision";
  const failed = b.meta.checks.filter((c) => l.checks[c.id] === false);
  if (failed.some((c) => c.id.startsWith("attribution_")))
    return "Grader flagged a source";
  if (failed.length) return `Needs review: ${checkName(b, failed[0]!.id)}`;
  if (l.unanswered?.length) return "Passed the answered checks";
  return "Passed everything";
}
function productDecision(l?: TraceLine): string {
  return productDecisionValue(l?.extra?.decision);
}

export function productDecisionValue(value: unknown): string {
  if (value == null) return "";
  const words: Record<string, string> = {
    INCOMPLETE: "follow up with the broker",
    REFERRED: "send to an underwriter",
    "IN APPETITE": "quote it",
  };
  return `<span class="case-decision">${esc(words[String(value)] ?? String(value))} ${tag(String(value), "The decision returned by the product")}</span>`;
}
function checkDetail(b: Built, l?: TraceLine): string {
  if (!l) return "Waiting for this prompt.";
  return b.meta.checks
    .map(
      (c) =>
        `<li>${prose(checkName(b, c.id))} ${tag(c.id, c.description)}: ${l.unanswered?.includes(c.id) ? `the grader gave no verdict, so it is left out ${tag("unanswered", "Excluded from this check's pass rate")}` : l.checks[c.id] === undefined ? "doesn't apply" : l.checks[c.id] ? "passed" : "failed"}</li>`,
    )
    .join("");
}

export function plainLedger(b: Built, base: string): string {
  const byVersion = (v: string) =>
    new Map(b.lines.filter((l) => l.variant === v).map((l) => [l.case_id, l]));
  const B = byVersion(b.meta.baseline),
    C = byVersion(b.meta.candidate);
  return `<section><div class="sec-head"><h2 class="display">Every case</h2><p>The result and the next step, side by side. The change measures words sent to the model (what it costs) ${tag("prompt tokens", "Fresh input, cache read and cache creation; tokens are pieces of words")}. Open check details to see every verdict.</p></div>
<table class="case-table"><thead><tr><th>Case</th><th>${version(b.meta.baseline, "Current prompt")}</th><th>${version(b.meta.candidate, "New prompt")}</th><th>Words sent</th></tr></thead><tbody>${b.meta.case_order
    .filter((id) => B.has(id) || C.has(id))
    .map((id) => {
      const before = B.get(id),
        after = C.get(id);
      return `<tr data-case="${esc(id)}"><td><a class="mono" href="${esc(caseUrl(base, id))}">${esc(id)}</a></td><td data-label="Current prompt"><b>${prose(caseStatus(before, b))}</b>${productDecision(before)}</td><td data-label="New prompt"><b>${prose(caseStatus(after, b))}</b>${productDecision(after)}<details><summary>Check details</summary><p>Current prompt</p><ul>${checkDetail(b, before)}</ul><p>New prompt</p><ul>${checkDetail(b, after)}</ul></details></td><td data-label="Words sent" class="mono">${before?.ok && after?.ok ? change((promptTokens(after.usage) - promptTokens(before.usage)) / Math.max(1, promptTokens(before.usage))) : "Waiting"}</td></tr>`;
    })
    .join("")}</tbody></table></section>`;
}

export function plainCost(b: Built): string {
  // Reuse the existing paired plot, keeping its geometry and all tick values.
  const plot = stripPlot(b.cmp)
    .replace(
      'aria-label="Prompt tokens per case, baseline and candidate"',
      'aria-label="Words sent to the model per case, current prompt and new prompt"',
    )
    .replace(">prompt tokens</text>", ">words sent</text>")
    .replace(
      `</i>${esc(b.meta.baseline)}`,
      `</i>${version(b.meta.baseline, "Current prompt")}`,
    )
    .replaceAll(
      `</i>${esc(b.meta.candidate)}`,
      `</i>${version(b.meta.candidate, "New prompt")}`,
    );
  const takeaway = (label: string, value: number) =>
    `${label}: ${value === 0 ? "unchanged" : change(value).toLowerCase()} with the new prompt.`;
  return `<section><div class="sec-head"><h2 class="display">Cost per case</h2><p>${takeaway("Cost per case", b.cmp.costUsd.pctChange)} ${takeaway("Words sent to the model", b.cmp.promptTokens.pctChange)}</p></div><p>Each line joins the same case on the current and new prompts. Words sent to the model (what it costs) ${tag("prompt tokens", "Measured tokens, including cache reads and cache creation")}; exact usage and likely ranges are in For engineers.</p><div class="panel">${plot}</div></section>`;
}

function engineerJudges(b: Built): string {
  return b.judges
    .map(
      (j) =>
        `<section><h2 class="display">Checking the AI grader</h2><p>${prose(checkName(b, j.check))} ${tag(j.check, "Check identifier")}. ${grader(b, j.check)}.</p><div class="table-scroll"><table><thead><tr><th>Human answer group</th><th>Answers</th><th>Real failures</th><th>Good answers</th><th>Failures caught</th><th>Good answers flagged</th><th>Good answers left alone</th></tr></thead><tbody>${j.splits.map((s) => `<tr><td>${esc(s.split)}</td><td>${s.n}</td><td>${s.humanFails}</td><td>${s.humanPasses}</td><td>Catches ${percent(s.tpr)} of real failures ${tag("TPR", "Share of human-labelled failures caught")}<br>likely range ${ciTag()}: ${range(s.tprCi, (n) => percent(n, 0))}</td><td>Wrongly flags ${percent(1 - s.tnr)} of good answers ${tag("TNR", "False alarms are one minus specificity")}</td><td>${percent(s.tnr)} left alone; likely range ${ciTag()}: ${range(s.tnrCi, (n) => percent(n, 0))}</td></tr>`).join("")}</tbody></table></div><p>${j.joined} human answers matched a grader verdict; ${j.unmatched} did not.</p></section>`,
    )
    .join("");
}

function engineerTransitions(b: Built): string {
  return `<section><h2 class="display">Where runs fail</h2><p>Rows show the last successful step; columns show the first failed step.</p>${[
    b.meta.baseline,
    b.meta.candidate,
  ]
    .map((v, i) => {
      const m = matrix(fromTraces(b.lines, v));
      if (!m.total)
        return `<p>${version(v, i ? "New prompt" : "Current prompt")}: no steps recorded.</p>`;
      return `<h3>${version(v, i ? "New prompt" : "Current prompt")}</h3><p>${m.failures} of ${m.total} full run records failed a step ${tag("trace", "The full record of one run")}.</p>${m.failures ? `<div class="table-scroll"><table><thead><tr><th>Last success / first failure</th>${m.to.map((t) => `<th>${esc(t)}</th>`).join("")}</tr></thead><tbody>${m.from.map((f) => `<tr><td>${esc(f)}</td>${m.to.map((t) => `<td>${cell(m, f, t) || ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : ""}`;
    })
    .join("")}</section>`;
}

export function engineerDetails(b: Built, base: string): string {
  const { cmp, meta } = b,
    B = cmp.baseline,
    C = cmp.candidate;
  const usage = (label: string, p: Paired, fmt: (n: number) => string) =>
    `<tr><td>${label}</td><td>${fmt(p.baselineMean)}</td><td>${fmt(p.candidateMean)}</td><td>${change(p.pctChange)}</td><td>${range(p.ci, fmt)}; median difference ${fmt(p.medianDelta)}</td></tr>`;
  const ms = (n: number) =>
    n >= 1000 ? `${number(n / 1000, 1)} s` : `${number(n)} ms`;
  const extraKeys = [
    ...new Set(b.lines.flatMap((l) => Object.keys(l.extra ?? {}))),
  ].slice(0, 6);
  const comparisonQuery = `?baseline=${encodeURIComponent(meta.baseline)}&candidate=${encodeURIComponent(meta.candidate)}`;
  return `<section><h2 class="display">The measurements</h2><p>${version(meta.baseline, "Current prompt")} and ${version(meta.candidate, "new prompt")}; ${C.n} paired cases.</p>
<p>Cases that passed every check ${tag("pass-all", "All applicable checks must pass")}: current prompt ${B.passAll.passed} of ${B.passAll.n} (${percent(B.passAll.rate, 0)}); new prompt ${C.passAll.passed} of ${C.passAll.n} (${percent(C.passAll.rate, 0)}). Likely range ${ciTag()}: ${range(B.passAll.ci)} current, ${range(C.passAll.ci)} new.</p>
<div class="table-scroll"><table><thead><tr><th>Measurement per case</th><th>Current prompt</th><th>New prompt</th><th>Change</th><th>Likely range ${ciTag()} on mean difference</th></tr></thead><tbody>
${usage(`Words sent to the model (what it costs) ${tag("prompt tokens", "Fresh input plus cache read plus cache creation")}`, cmp.promptTokens, (n) => number(n))}
${usage("API-equivalent cost", cmp.costUsd, (n) => `$${number(n, 4)}`)}
${usage("Time including all calls", cmp.latencyMs, ms)}
</tbody></table></div><p>Words sent: likely range ${ciTag()} on relative mean change ${range(cmp.promptTokens.ci, (n) => change(n / Math.max(1, cmp.promptTokens.baselineMean)))}.</p>
${b.noise ? `<p>Repeat-run change ${tag("noise", "Current prompt run twice")}: ${version(b.noise.variant, "repeat prompt")} moved ${points(-b.noise.passAllDrop)} in cases passing every check; new prompt moved ${points(-b.noise.candidatePassAllDrop)}. The new prompt's drop is ${b.noise.within ? "within" : "beyond"} that change.</p>${b.noise.checks.map((c) => `<p>${prose(checkName(b, c.id))} ${tag(c.id, "Protected check")}: repeat moved ${points(-c.noiseDrop)}; new prompt moved ${points(-c.candidateDrop)}.</p>`).join("")}` : ""}
<div class="table-scroll"><table><thead><tr><th>Check</th><th>Current prompt</th><th>New prompt</th><th>Change</th><th>Likely range ${ciTag()} for new prompt</th></tr></thead><tbody>${cmp.checks.map((c) => `<tr><td>${prose(checkName(b, c.id))} ${tag(c.id, "Check identifier")}${c.saturated ? `<p>Every case passes, so this check can no longer tell prompts apart ${tag("saturated", "Both prompts pass every applicable case")}</p>` : ""}</td><td>${c.baseline.passed}/${c.baseline.n} (${percent(c.baseline.rate)})</td><td>${c.candidate.passed}/${c.candidate.n} (${percent(c.candidate.rate)})</td><td>${points(c.delta)}</td><td>${range(c.candidate.ci, (n) => percent(n, 0))}</td></tr>`).join("")}</tbody></table></div>
<p>${cmp.regressions.length} checks on cases got worse ${tag("regression", "A check passed before and failed after")}: ${cmp.regressions.map((c) => `<a href="${esc(caseUrl(base, c.case_id))}">${esc(c.case_id)}</a> ${tag(c.check, checkName(b, c.check))}`).join(", ") || "none"}. The shipping rules compare rates, not individual cases.</p>
<h3>Usage for each paired case</h3><div class="table-scroll"><table><thead><tr><th>Case</th><th>Current words sent</th><th>New words sent</th><th>Change</th>${extraKeys.map((k) => `<th>${esc(k)}</th>`).join("")}</tr></thead><tbody>${pairedRows(
    b,
  )
    .map(
      ({ id, before, after }) =>
        `<tr><td><a href="${esc(caseUrl(base, id))}">${esc(id)}</a></td><td>${before.ok ? number(promptTokens(before.usage)) : "Error"}</td><td>${after.ok ? number(promptTokens(after.usage)) : "Error"}</td><td>${before.ok && after.ok ? change((promptTokens(after.usage) - promptTokens(before.usage)) / Math.max(1, promptTokens(before.usage))) : "Not available"}</td>${extraKeys.map((k) => `<td>${k === "decision" ? productDecision(after) : esc(after.extra?.[k] ?? "")}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table></div></section>
${engineerJudges(b)}${engineerTransitions(b)}
<section><h2 class="display">Method</h2><p>${prose(meta.description, b)}</p><h3>Versions ${tag("variant", "One way of running the pipeline")}</h3>${meta.variants.map((v) => `<p>${version(v.name, "Version")}: ${prose(v.description, b)}</p>`).join("")}
<h3>Check definitions</h3>${meta.checks.map((c) => `<p>${prose(checkName(b, c.id))} ${tag(c.id, "Check identifier")}: ${prose(c.description)} ${c.kind === "judge" ? grader(b, c.id) : "Checked by code."}</p>`).join("")}
<p>The grader gave no verdict, so it is left out ${tag("unanswered", "Absent verdicts never count as failures")}. A case's result uses only the checks that answered.</p>
<p>Shipping rules ${tag("gate", "Configured rules from this suite")}: the share of cases passing every check may fall by at most ${percent(meta.gate?.maxPassAllDrop ?? 0, 0)}.${meta.gate?.noRegressionOn?.length ? ` These checks must not fall: ${meta.gate.noRegressionOn.map((id) => `${prose(checkName(b, id))} ${tag(id, "Protected check")}`).join(", ")}.` : ""} ${b.gate.pass ? "The measured comparison clears these rules." : prose(b.gate.reasons.join("; "))}</p>
<p>${B.usage.metered && C.usage.metered ? "Usage and costs are metered from the provider's report on every call." : "Some usage figures are estimates; the full records below say which."} Costs are API-equivalent; these calls used a subscription. Time includes every call made for each case.</p>
<p>Likely range ${ciTag()}: Wilson for rates; seeded percentile bootstrap with 2,000 resamples for paired means. No p-values. Only cases completed by both prompts are compared, in suite order (${C.n} pairs). Errors: ${B.errors} current, ${C.errors} new.${meta.skipped.length ? ` Skipped cases: ${meta.skipped.map((s) => `${esc(s.id)} (${prose(s.reason)})`).join(", ")}.` : ""}</p>
<p>Words sent include fresh input, cache read and cache creation. Cached answers are reused when checks are rerun. ${b.lines.filter((l) => l.cached).length} of ${b.lines.length} stored records were marked cached.</p>
<h3>Reproduce</h3><pre>${esc(meta.command)}\nbun src/cli.ts report ${esc(meta.suite)} ${esc(meta.run_id)} --baseline ${esc(meta.baseline)} --candidate ${esc(meta.candidate)}</pre>
<p><a href="${base}/report.html${esc(comparisonQuery)}">Static report</a> · <a href="${base}/summary.md${esc(comparisonQuery)}">Summary (Markdown)</a> · <a href="${base}/traces.jsonl">Full records as JSON lines ${tag("trace", "The full record of one run")}</a></p>
<details><summary>All comparison measurements (JSON)</summary><pre>${esc(JSON.stringify({ comparison: b.cmp, noise: b.noise, gate: b.gate, judges: b.judges }, null, 2))}</pre></details></section>`;
}

export function runFragments(run: Run, b?: Built) {
  const base = `/r/${encodeURIComponent(run.suite)}/${encodeURIComponent(run.run_id)}`;
  return {
    verdict: verdictCard(run, b),
    changed: b ? changedCases(b, base) : "",
    checks: b ? plainChecks(b) : "",
    ledger: b
      ? plainLedger(b, base)
      : '<p class="empty">No finished pair yet.</p>',
    cost: b ? plainCost(b) : "",
    engineers: b
      ? engineerDetails(b, base)
      : "The method will appear when results arrive.",
  };
}
