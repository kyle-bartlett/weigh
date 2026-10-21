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
bun src/cli.ts rescore suites/<name>.ts [run-id]  # re-run the checks over cached outputs, no model calls
```

Every (variant, case) result is cached under `runs/<suite>/<run-id>/outputs`, so an interrupted
run resumes without spending a model call twice. One trace line per case per variant lands in
`traces.jsonl` as it finishes. Every number in the report maps to a line in that file. Because outputs are cached, a check can be fixed
after the fact and the run re-scored with `rescore` for free; run.json records when that happened.

## What the report shows

- A verdict band: the gate passed (green) or failed (amber), and why.
- A noise-floor band when the suite names a `noise` variant (the baseline run a second time): how far
  the baseline drifted against itself, next to the candidate's change. A drop no larger than that drift
  is not evidence of a regression.
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
bun src/cli.ts report reposcout-transcript                       # jev-filter, the production default
bun src/cli.ts report reposcout-transcript --candidate jev-strict
bun src/cli.ts report reposcout-transcript --candidate full-repeat  # the noise floor on its own
```

### What the first run found (2026-10-19, 46 videos, 184 metered model calls)

Reports and traces are committed under `runs/examples/reposcout-transcript-2026-10-19`.

|                         | full     | jev-filter     | jev-strict     | full-repeat |
| ----------------------- | -------- | -------------- | -------------- | ----------- |
| prompt tokens per video | 7,105    | 6,396 (-10.0%) | 5,629 (-20.8%) | same inputs |
| pass-all                | 42 of 46 | 40 of 46       | 40 of 46       | 40 of 46    |
| item recall             | 24 of 27 | 21 of 27       | 21 of 27       | 22 of 27    |

Neither filter cleared the gate, so the filter stays off in production. Two things the run taught that a
token count alone would have hidden:

- Open coding the eight regression cells found three were the recall check itself rejecting an item
  that was plainly listed (a repo under its old GitHub org, a tool named without a URL). The matcher
  was fixed and the run re-scored from cache. Three more were the model omitting a tool whose
  mentions had survived the filter. Only two were the filter removing every spoken mention, both in
  the strict variant.
- The baseline run twice against itself failed the same gate. With 27 applicable cases, a one or two
  case change in recall is inside the model's own run-to-run drift, so the honest reading is that
  jev-filter's recall change is at the edge of noise and jev-strict's is beyond it. Saving 10 percent of
  prompt tokens is not worth an unmeasurable recall risk on a job whose cost is video download time,
  not tokens.

## Second suite: Exchange Triage's extraction prompts

The Exchange Triage repo now carries this suite itself as `weigh/extraction-prompts.suite.ts`, which is
what the agent runs; `suites/exchange-triage.ts` here is the same suite reaching the app by path for local
runs. It runs the Exchange Triage insurance-submission pipeline (intake, extraction,
grounding, appetite; the referral writer off) over its 27-case golden set with four extraction prompts:
v2 as the baseline (what shipped), v3 as the candidate (production, written after a live over-extraction),
v2 run a second time as the noise floor, and v1, the frozen plain prompt, for the history. The suite imports
the app's pipeline, prompts and field scorer by path (`ET_CHECKOUT`, default `~/wildcard/exchange-triage`)
and injects a metered model adapter, so what it measures is what the app does. The model is Claude Sonnet
through the CLI.

Checks: extraction JSON matches the schema, every labelled field matches the golden value, construction
type is the canonical ISO class, fields the source never states stay null, the routing decision matches.
Two judge checks ask whether every `source` attribution is truthful (the value is stated in the document
it names): Jev, TypeSafe's yes/no classifier, and Claude Haiku given only the source text and the
extracted pairs. Both judges are validated against 54 hand labels in `suites/exchange-triage.labels.jsonl` (drafted by the agent, reviewed and accepted by Kyle).

```sh
bun src/cli.ts run suites/exchange-triage.ts
bun src/cli.ts report exchange-triage                               # v3 against v2
bun src/cli.ts report exchange-triage --baseline v1 --candidate v3  # the gate against the plain prompt
bun src/cli.ts judge-validate exchange-triage suites/exchange-triage.labels.jsonl --check attribution_jev
bun src/cli.ts judge-validate exchange-triage suites/exchange-triage.labels.jsonl --check attribution_claude
```

### What the run found (2026-10-19, 27 cases, 4 prompts, 108 pipeline runs)

Reports, traces, judge validation and the review page are committed under
`runs/examples/exchange-triage-2026-10-19`.

|                        | v1       | v2       | v3       | v2-repeat |
| ---------------------- | -------- | -------- | -------- | --------- |
| fields correct         | 23 of 27 | 26 of 27 | 27 of 27 | 26 of 27  |
| decision correct       | 27 of 27 | 23 of 27 | 23 of 27 | 23 of 27  |
| construction canonical | 14 of 18 | 18 of 18 | 18 of 18 | 18 of 18  |
| prompt tokens per case | 4,362    | 4,778    | 5,076    | 4,775     |

The gate passed v3 over v2: it fixed the one field v2 missed (the subclass guess the production fix was
written for) and regressed nothing. The same gate run against v1 fails, because decision accuracy fell from
27 to 23 of 27. Four broker emails say only "masonry". v1 copies the wording through and the appetite rules
accept it; the canonical-class rule in v2 and v3 makes the model return null for a word that maps to two
ISO classes, and a null construction type routes the file to a follow-up email. The app's own eval scored v2
at 100 percent on decisions when it shipped, on an earlier Sonnet, so this is a model-version sensitivity
the eval surfaced, not a prompt that was always wrong. The fix belongs in the prompt (a stated default for
bare "masonry"), and the transition matrix pins every one of those failures to the appetite stage.

Two harness lessons from the first pass, both now fixed in the runner:

- One transient CLI outage cost 21 of 108 runs. The app routes a model failure to referral, which scores as a
  wrong decision, so the adapter now retries with backoff and records every error on the trace. The resumed
  run had zero.
- Jev timed out on 57 of 71 calls under load and a silent judge was being scored as a failure. A check can
  now return null, meaning "not evaluated"; the case is left out of that check's rate and named on the trace
  line, so a judge that did not answer never votes.

The judge validation is the part worth reading. Against the 54 labels, Jev never raised a false alarm
(TNR 100 percent) but caught only half the real failures (TPR 50 percent; 30 percent on the test split), and
Claude Haiku caught every real failure (TPR 100 percent) but flagged a third of the good extractions
(TNR 65 percent), mostly canonical class names it read as inventions ("Duplex/fourplex schedule" for two
stated fourplexes) and arithmetic on stated figures (26 units at $1,150). Neither judge alone earns the
trust; together they do: Haiku pass means pass, Jev fail means fail, and the disagreements go to a person.
The labeling rule should also say that arithmetic on stated figures counts as stated, which is the first
change to make on the dev split before the next round of labels.

## The platform: hub, agent, live pages

The terminal tool is now one end of a platform. Live at https://weigh.bartlettlabs.io.

- **Hub.** `weigh hub` is one Bun process with a SQLite file (zero dependencies beyond zod). It stores runs,
  renders every page on the server from the same fragments the static report uses, and streams each run's
  events over server-sent events. Pages: projects, a project's suites and runs, a run (verdict, proof strip,
  checks, paired tokens, per-case ledger, judge validation, where runs fail, method), and a case (the input,
  every variant's output, checks, usage, stages). A running run fills in live; the page reloads once into its
  static form when the run ends.
- **Agent.** `weigh agent` runs on the always-on machine that holds the Claude subscription login. It is
  outbound only: it registers the suites it found, long-polls the hub for queued runs, spawns the CLI on the
  suite, tails `events.jsonl` to the hub in order, uploads each finished output, heartbeats, and stops the run
  when the hub says cancel. A hub outage mid-run costs nothing: a cursor file records what the hub has
  acknowledged and the agent resumes the upload when it comes back. Retry resumes from the runner's cache.
- **Any repo.** A project plugs in by shipping `weigh/<name>.suite.ts` (run `weigh init <repo>` for a
  template and a copy of the types). The suite imports its own app by relative path and Weigh's helpers from
  `WEIGH_HOME`. Which repos the agent may clone, what install command runs and what environment a suite sees
  live in the agent's own config file, never in the hub.
- **Access.** Three tokens with three scopes: admin (enqueue, cancel, retry, project settings), agent
  (`/api/agent/*` only) and read (private projects and the MCP endpoint). Projects start private; anonymous
  visitors see only the ones marked public. Local paths, keys and bearer tokens are scrubbed before anything
  leaves the agent and again when the hub stores it.
- **MCP.** `POST /mcp` (bearer) or `POST /mcp/<read token>` speaks JSON-RPC with six read-only tools:
  `list_projects`, `list_runs`, `get_run_summary`, `get_run_checks`, `get_run_cases`, `get_judges`. Add it
  as a connector and a Claude Dashboard artifact can query the hub directly.

```sh
weigh hub --port 8787 --db data/weigh.db          # WEIGH_ADMIN_TOKEN, WEIGH_AGENT_TOKEN, WEIGH_READ_TOKEN
weigh import runs/<suite>/<run-id> --hub https://weigh.example --project <id> --token <agent token>
weigh agent --config ~/.config/weigh/agent.json   # see deploy/launchd for the always-on setup
weigh init ~/code/my-app --name main              # adds weigh/main.suite.ts and weigh/types.ts
```

Set optional `WEIGH_PUBLIC_ORIGIN=https://weigh.example` on the hub to pin share links
and images to its public origin behind any proxy. It must be an absolute HTTP or HTTPS
origin without a path, query, fragment or credentials (a trailing slash is allowed).
An invalid value is ignored with one startup warning. When valid, it takes precedence
over the Host header; when unset, the existing Host and `X-Forwarded-Proto` behavior stays.

The design and its decisions: `docs/superpowers/specs/2026-10-20-weigh-platform.md`.

## Development

```sh
bun install
bun test
bunx tsc --noEmit
```

bun and TypeScript. One runtime dependency (zod). A suite that imports another repo names its checkout in an
environment variable (`COS_CHECKOUT`, `ET_CHECKOUT`) and skips when it is missing. Model calls go through the subscription path in
`~/.claude/PAI/TOOLS/Inference.ts` with the claude CLI's JSON envelope, which is where the metered
token counts come from.
