# Weigh: a before/after eval harness for LLM pipelines

Design, 2026-10-19. Author: Scout (Kyle's operator). Builder: whoever picks this up, with no
further access to Kyle. Everything marked **my call** is Scout's decision, not Kyle's.

## Intent and the why

Every recruiter and HR screener asks Kyle whether he has done evaluations. The honest answer so
far is "yes, by hand": golden sets, scripts, trace notes. Weigh is the tool he can put on the
portfolio and talk through on a call. It puts two variants of the same LLM pipeline on the same
cases and reports what changed: binary pass/fail checks rolled into a pass-all rate, metered
tokens, dollars and latency per case with paired deltas, judge validation against human labels,
a review page for open coding, and a CI gate.

The first real use is Repo Scout (the Chief of Staff job on the iMac that reads YouTube repo
channels). Today it sends every video's full transcript (up to 45,000 characters) to the model.
Variant B runs each transcript chunk through Jev (TypeSafe's yes/no classifier, through
OpenRouter at about a hundredth of a cent per call) and sends only the chunks that name a repo
or tool. Weigh answers: did B lose any repos, and what did it save?

Kyle asked for two things in one breath: ship the filter with a before/after token count, and
turn the measuring itself into a showcase tool. Weigh is both.

## Goals

1. `weigh run suites/<name>.ts` runs every variant over every case, writes one trace line per
   case per variant, and produces an HTML report plus a Markdown summary.
2. The report reads as Kyle's portfolio does: the operations floor. Grey-green neutrals,
   Bricolage Grotesque display, Instrument Sans body, IBM Plex Mono data. Green means
   automated and live; amber means a person decides. Rendered at rest, no scroll reveals,
   one file, works offline, light and dark.
3. The tool embodies the evals doctrine Kyle follows (Husain and Shankar): binary checks only,
   code assertions before judges, every judge validated against human labels with TPR, TNR and
   the Rogan-Gladen correction, error analysis through a review page, pass-all rate as the
   roll-up, a saturation flag when every check passes, and prompts in git.
4. Numbers are honest and labeled. Tokens are metered when the provider reports usage (the
   claude CLI JSON envelope reports input, cache-read, cache-creation and output tokens plus
   cost; Jev reports input tokens and cost). Anything estimated says so in the report.
5. The Repo Scout filter ships behind a config switch and is turned on only if the gate passes:
   no check rate lower than baseline, no case that baseline passed and the candidate failed on
   the recall checks.
6. Every video with captions is a case. Kyle's standing rule (2026-10-19): never cap or reduce
   the number of videos processed.

## Non-goals

- No Likert scores, no generic metrics (helpfulness, coherence, ROUGE, BERTScore).
- No hosted service, no database, no React. Static HTML and JSONL on disk.
- No provider abstraction layer. A variant is a TypeScript function; it calls whatever it
  calls and reports usage in Weigh's shape.
- Not a replacement for Repo Scout's weekly eval note. Weigh compares variants; the weekly note
  watches production.

## Anti-goals (failure even if it runs)

- A filter that drops a repo the speaker only said aloud, and nobody notices. The recall checks
  exist for this, and the review page shows both outputs side by side.
- A report with a number nobody can trace to a trace line.
- An eval that quietly samples 5 videos to save time.
- Em dashes or plus-notation anywhere in generated prose.

## Constraints

- bun and TypeScript. Runtime dependency: zod only (already used in chief-of-staff). No npm,
  no npx. One lockfile.
- Model calls go through `~/.claude/PAI/TOOLS/Inference.ts` (the subscription path) with
  `extraArgs: ['--output-format','json']` so usage is metered. Never import
  `@anthropic-ai/sdk`. Never spawn `claude` directly.
- Jev calls go through `~/.claude/jev-kit/lib/jev.ts` (`jevEvaluate`, `prob`,
  `estimateTokens`). It already enforces the daily token cap and the PARKED off switch.
  Any Jev failure in production means "send the full transcript", never "skip the video".
- The production prompt and the eval prompt must be the same code. chief-of-staff exports a
  prompt builder; the suite imports it. No copied prompt strings.
- YouTube fetches stay at two at a time (home IP was throttled on 2026-10-08). Transcripts are
  cached on disk under the suite's data directory so reruns fetch nothing.
- Writing guardrails apply to every sentence the report or the Markdown summary emits.
- Repos: `~/wildcard/weigh` pushed to Forgejo `kyle/weigh`; chief-of-staff changes on branch
  `recovery/organization-readiness` (the branch the iMac runtime deploys from). Public GitHub
  mirror is Kyle's call, not the builder's.

## The parts Kyle decided

- Build the Jev transcript pre-filter for Repo Scout, with a before/after token count.
- Make the measuring tool itself a portfolio piece that shows real eval practice: token
  comparison and "the top eval criteria".
- It has to fit his style and stand out.
- Submit the work to the team (career log, vault, Open Brain) with a note that he wants it
  documented that a before/after token count tool was built.

## The parts Scout decided (my calls)

### Name

**Weigh.** Two variants on a scale. One syllable, says what it does on a recruiter call, no
collision in Kyle's repos. CLI is `weigh`.

### Repo layout (`~/wildcard/weigh`)

```
src/types.ts        Case, Variant, Usage, Check, CaseResult, Run
src/run.ts          runner: concurrency, per-case cache keyed by hash(variant, case), trace JSONL
src/checks.ts       binary check helpers: jsonValid, zodParses, setRecall, allIn, noEmDash, regex
src/stats.ts        pass-all, per-check rates with Wilson intervals, paired deltas (mean, median,
                    percent), bootstrap CI (2000 resamples, seeded), saturation flag
src/judge.ts        judge runner (Jev or Inference) and validation: TPR, TNR, Rogan-Gladen,
                    train/dev/test splits (port of eval-llm-judge/scripts/judge-metrics.ts)
src/transition.ts   transition failure matrix from staged traces (port of transition-matrix.ts)
src/report/html.ts  single-file report
src/report/md.ts    Markdown summary for the vault and LOG.md
src/review.ts       review page generator: cases, both outputs, checks, hotkeys, notes, export
src/cli.ts          weigh run | report | gate | review | judge-validate
suites/             one TypeScript module per suite; the first is reposcout-transcript.ts
test/               bun tests
docs/               this spec, a README with the method
runs/<suite>/<run-id>/  traces.jsonl, run.json, report.html, summary.md (gitignored except
                    the ones kept as examples)
```

### Data shapes

```ts
type Usage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  calls: number;
  metered: boolean;
  provider: string;
}; // metered=false means estimated
type Case = {
  id: string;
  input: unknown;
  reference?: unknown;
  tags?: string[];
};
type VariantOutput = {
  output: unknown;
  usage: Usage;
  extra?: Record<string, unknown>;
  stages?: { name: string; ok: boolean; detail?: unknown }[];
};
type Variant = {
  name: string;
  description: string;
  run: (c: Case) => Promise<VariantOutput>;
};
type Check = {
  id: string;
  description: string;
  kind: "code" | "judge";
  test: (c: Case, o: VariantOutput) => Promise<boolean> | boolean;
};
type Suite = {
  name: string;
  description: string;
  cases: () => Promise<Case[]>;
  variants: Variant[];
  checks: Check[];
  baseline: string;
  candidate: string;
  gate?: { minPassAll?: number; noRegressionOn?: string[] };
};
```

A trace line: `{run_id, suite, case_id, variant, at, ok, usage, checks:{id:boolean}, stages,
output_hash, output_path}`. Full outputs live beside the traces as files, not inline.

### Statistics

- Pass-all rate per variant: cases where every check passed over all cases.
- Per-check rate with a Wilson 95% interval.
- Paired deltas (candidate minus baseline) for input tokens, cost, latency: mean, median,
  percent change, and a seeded bootstrap 95% interval on the mean.
- Pass-all delta with a bootstrap interval too.
- Saturation: a check at 100% on both variants is flagged "saturated" in the report with the
  doctrine's note (retire it or make it harder).
- No p-values. Intervals and counts.

### The report

Sections, in order: title and kicker (suite, run id, date, n cases, variants); verdict band
(gate pass in green or fail in amber, one sentence); proof strip (pass-all A and B, input tokens
per case A and B with percent change, cost per case, latency per case); checks ledger (per
check: A rate, B rate, delta, interval, saturated flag); paired token plot (inline SVG strip
plot, one dot per case, A to B); per-case ledger (every case, both variants, each check as a
dot, tokens, link to the review page anchor); judge validation table when a suite has judge
checks (TPR, TNR, corrected prevalence per split); transition failure matrix when variants
report stages; method notes (what was metered, what was estimated, how each check is defined,
the gate rule); reproduce block (exact commands). Fonts from Google Fonts with system
fallbacks; the page must still read correctly offline.

### The review page

`weigh review <run>` writes `review.html`: one case at a time, input excerpt, baseline and
candidate outputs side by side with checks, hotkeys (p pass, f fail, n next, b back, / notes),
progress bar, labels and notes in localStorage, "Export labels.jsonl" button that downloads
`{case_id, variant, human, note}` lines. This is where Kyle open-codes the first 30 cases.
`weigh judge-validate labels.jsonl --judge <check-id> --run <run>` joins his labels with the
judge's verdicts and prints TPR, TNR and the corrected failure rate.

### The first suite: reposcout-transcript

Cases: every video in Repo Scout's store that was processed with a transcript (21 on
2026-10-19) plus the 20 golden-set videos, minus any whose captions cannot be fetched (listed
in the report as skipped, with the reason). The suite copies `scout.sqlite` and the traces from
the iMac on demand (`ssh imac`) or reads a local copy at `WEIGH_SCOUT_STATE`. Reference truth per
case: the set of item keys production recorded for the video (table `sightings`) and the repos
linked in the description (`githubRepos`).

Variants:

- `full`: today's behavior. Description plus the whole transcript (capped at 45,000
  characters as production does), production system prompt, one call to Inference.ts
  `standard` with the JSON envelope.
- `jev-filter`: the transcript is split into chunks of about 700 characters on sentence
  boundaries; each chunk goes to Jev with one noul question ("Does this passage name a
  software tool, GitHub repository, library, model, or product that the speaker is presenting
  or demonstrating?"); chunks at or above the threshold (0.5) are kept with one neighbor on
  each side; the first two chunks are always kept; the kept chunks are joined with a marker
  line between gaps. Everything else is identical to `full`. The variant records chunks total,
  chunks kept, Jev tokens and cost, and filter time as `extra`.

Checks (binary, all code):

- `json_valid`: the reply parsed as the Extraction schema within two attempts.
- `linked_recall`: every repo linked in the description appears in the model's items before
  the merge backfills it.
- `item_recall`: every item key production recorded for this video appears in this variant's
  items (keys normalized through `itemKey`). This is the check that catches a filter dropping a
  spoken-only tool.
- `categories_valid`: every item category is in the allowed set.
- `no_em_dash`: no em dash in any item text.

Gate: candidate pass-all rate at least baseline minus zero, and `item_recall` and
`linked_recall` rates not lower than baseline. Recorded in the report.

Both variants run with concurrency 2 on Inference calls (the per-process budget is raised for
the run) and the runner caches each (variant, case) result so a crash resumes.

### chief-of-staff changes (branch recovery/organization-readiness)

1. `src/reposcout/run.ts`: export `extractPrompt(v, config): {system, user}` and have
   `extract()` use it. No behavior change.
2. `src/reposcout/filter.ts`: `filterTranscript(text, opts)` as described, importing jev-kit's
   client by dynamic import from `${HOME}/.claude/jev-kit/lib/jev.ts` (path overridable by
   `JEV_KIT_DIR`). Returns `{text, chunks, kept, jevInputTokens, jevCostUsd, ms, fallback?:
string}`. Any error or a parked Jev returns the full text with `fallback` set.
3. `config/repo-scout.json` and `ScoutConfig`: `transcriptFilter: {mode:'off'|'jev',
threshold:0.5, chunkChars:700, neighbors:1}`. Default off until the gate passes.
4. `processVideo`: when mode is `jev`, filter before `extract`; trace stage `filter` with
   `{charsBefore, charsAfter, chunks, kept, jevInputTokens, jevCostUsd, ms, fallback}`.
5. `src/inference.ts` (the COS wrapper): request the JSON envelope and return `usage` on
   `AskResult` (`inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens, costUsd`).
   When stdout is not an envelope (mocks, older CLI) behave as today. The `extract` trace adds
   `usage` and `transcriptChars`. This is what makes the before/after visible in production
   traces and the weekly eval note, not only in Weigh.
6. `evals.ts` weekly note: a line with mean input tokens per video and the filter's kept
   ratio for the week.
7. Tests in `test/reposcout.test.ts` for the chunker, the keep rule with neighbors, the
   fallback, and the envelope parsing.

Rollout: tests and typecheck pass locally; push; on the iMac pull the SSD checkout and run
`bin/deploy-runtime.sh --skip-checks`; run `bun src/reposcout/run.ts video <url> --dry` on one
video and read the `filter` trace line; only then flip `mode` to `jev` if the Weigh gate passed.

### Submitting to the team

After the gate run: `_SHIPLOG` with a LOG.md entry flagged `portfolio` and `resume`, proof point
from the report (pass-all both variants, percent token change, dollars per video), a vault note
`Atlas/Weigh.md` with the method and the reproduce command, and an Open Brain capture. The LOG
entry states, in Kyle's words, that he wants it documented that a before/after token count tool
was built. The portfolio department reads flags automatically.

## Left to the builder

- Exact chunker boundaries and the marker text between gaps.
- Bootstrap seed and resample count beyond "seeded, at least 2000".
- How the review page lays out two long outputs (tabs or columns) as long as both are visible
  without scrolling past the checks.
- Test file organization.
- Whether the HTML report inlines a tiny font subset or relies on Google Fonts with fallbacks
  (fallbacks must be set either way).

## Open questions for Kyle (not blocking)

- Public GitHub mirror of `kyle/weigh` for recruiters, or Forgejo only with the portfolio page
  as the public face.
- Whether Weigh should also become the runner for Exchange Triage's 26-case set (a second suite
  would make the portfolio story stronger: one tool, two production systems).

## Addendum after the builder check (Scout's calls, 2026-10-19)

1. **item_recall reference and matching.** The reference is the set of item keys production
   recorded for the video (`sightings`, post-resolution keys such as `gh:owner/repo`). The
   variant's raw items are matched without any network call: a reference `gh:owner/repo` counts
   as found when an item's URL contains `owner/repo`, or its key equals it, or the slug of its
   name equals the slug of `repo` or of `owner/repo`; a reference `web:` or `tool:` key counts
   as found when the host or the name slug matches. The baseline is scored against its own
   earlier production output on purpose: its item_recall rate is the noise floor of the model,
   and the candidate is judged against that floor, not against 100%.
2. **Golden set.** `evals/reposcout/golden.json` in chief-of-staff (20 videos, description
   only, no sightings). Checks carry an optional `applies(case)`; item_recall applies only to
   cases with a production reference, and each check's rate is over the cases it applied to.
3. **Gate.** Rates, not per-case equality: pass-all may not drop, and `item_recall` and
   `linked_recall` rates may not be lower on the candidate. Per-case regressions are listed in
   the report for the reviewer, not gated, because a single run of a nondeterministic model
   would trip a per-case rule on noise.
4. **Model path.** The suite calls PAI `Inference.ts` directly with the `system` and `user`
   strings from chief-of-staff's exported `extractPrompt`, the exported `HEADLESS_ARGS`, and
   `--output-format json`; it repeats the production two-attempt retry (a few lines). Same
   prompt by construction; usage metered per attempt.
5. **Where.** The suite runs on the laptop (Jev key in its Keychain, yt-dlp installed,
   subscription login). chief-of-staff work happens in the laptop clone at
   `~/wildcard/chief-of-staff` on `recovery/organization-readiness`, pushed to Forgejo, pulled
   on the iMac SSD checkout, then deployed with `bin/deploy-runtime.sh`. Repo Scout state
   (`scout.sqlite`, traces) is copied from the iMac with `sqlite3 .backup` over ssh.
6. **Jev shape.** One request per chunk (state = the chunk, one `noul` question), concurrency
   4, 5 second timeout. A chunk whose call fails is kept (null probability keeps). Parked Jev,
   no key or cap reached means the whole transcript goes through unfiltered with `fallback`
   set; the video is never skipped.
7. **Headline number.** Prompt tokens the model read: fresh input plus cache read plus cache
   creation, labeled "prompt tokens (metered)". Uncached input shown beside it. Cost is the
   API-equivalent figure the CLI reports, labeled "API-equivalent; these calls ran on the
   subscription".
