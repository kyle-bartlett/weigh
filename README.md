# Weigh

A before/after eval harness for LLM pipelines. Put two variants of the same pipeline on the same
cases and see what changed: binary pass/fail checks rolled into a pass-all rate, metered tokens and
dollars per case with paired intervals, judge validation against human labels, a review page for
open coding, and a gate that CI can run.

Weigh follows the evals practice Hamel Husain and Shreya Shankar teach: look at traces before
building metrics, binary checks over scores, code assertions before judges, and never trust a
judge whose agreement with a person is unknown.

## How it works

A suite is one TypeScript module:

```ts
const suite: Suite = {
  name: "my-pipeline",
  description: "What the pipeline does and what the candidate changes.",
  cases: async () => [{ id: "c1", input: {...}, reference: {...} }],
  variants: [
    { name: "full", description: "today", run: async (c) => ({ output, usage }) },
    { name: "lean", description: "the change", run: async (c) => ({ output, usage }) },
  ],
  checks: [zodParses("json", Schema), setRecall("recall", "...", expected, found), noEmDash()],
  baseline: "full",
  candidate: "lean",
  gate: { maxPassAllDrop: 0, noRegressionOn: ["recall"] },
};
export default suite;
```

A variant returns its output and a `Usage` record: input, cache-read, cache-creation and output
tokens, cost, latency, call count, and whether those numbers were metered or estimated. Checks
are functions over (case, output) that return true or false. A check can say which cases it
applies to.

```sh
bun src/cli.ts cases suites/<name>.ts          # build and cache the inputs
bun src/cli.ts run suites/<name>.ts            # run every variant over every case
bun src/cli.ts report <name> [run-id]          # report.html and summary.md
bun src/cli.ts gate <name> [run-id]            # exit 1 unless the candidate clears the gate
bun src/cli.ts review <name> [run-id]          # review.html for open coding
bun src/cli.ts judge-validate <name> labels.jsonl --check <id>
```

Every (variant, case) result is cached under `runs/<suite>/<run-id>/outputs`, so an interrupted
run resumes without spending a model call twice. One trace line per case per variant lands in
`traces.jsonl` as it finishes. Every number in the report maps to a line in that file.

## What the report shows

- A verdict band: the gate passed (green) or failed (amber), and why.
- Pass-all rate per variant, prompt tokens per case, cost per case, latency per case, with the
  percent change and a bootstrap interval on the mean difference.
- Per check: both rates, the delta, a Wilson interval, and a saturated flag when both variants
  pass everywhere.
- A paired strip plot of prompt tokens, one row per case.
- A per-case ledger with every check as a dot.
- Judge validation (TPR, TNR per split) when a judge check has human labels.
- A transition failure matrix when variants report pipeline stages.
- Method notes: what was metered, what was estimated, how each check is defined, the gate rule,
  and the exact commands to reproduce.

## Statistics

Rates get Wilson 95% intervals. Paired differences get a seeded percentile bootstrap interval on
the mean (2,000 resamples), so two renders of the same run agree to the digit. No p-values.

## Judges

Weigh reports a judge's agreement with a person's labels: TPR (recall on failures), TNR
(specificity on passes), and the Rogan-Gladen correction that turns a judge's observed failure
rate on unlabeled traffic into an estimate of the true rate. Labels come from the review page,
exported as `labels.jsonl` with `case_id`, `human`, optional `split` and `note`.

## First suite: Repo Scout's transcript stage

`suites/reposcout-transcript.ts` evaluates a change to Repo Scout, a Chief of Staff job that reads
YouTube repo channels and lists every repo and tool a video covers. The baseline sends the whole
transcript to the model; the candidates first run each caption chunk through Jev (TypeSafe's
yes/no classifier) and send only the chunks that name a tool. The suite imports the production
prompt and the production filter from the chief-of-staff repo, so what it measures is what ships.

Reference truth per video: the items production recorded for it and the repos linked in its
description. Checks: valid JSON within two attempts, description-link recall, item recall against
production, allowed categories, no em dashes. Gate: pass-all may not drop, and the two recall
rates may not be lower.

```sh
bun src/cli.ts run suites/reposcout-transcript.ts
bun src/cli.ts report reposcout-transcript --candidate jev-strict
```

## Development

```sh
bun install
bun test
bunx tsc --noEmit
```

bun and TypeScript. One runtime dependency (zod). Model calls go through the subscription path in
`~/.claude/PAI/TOOLS/Inference.ts` with the claude CLI's JSON envelope, which is where the metered
token counts come from.
