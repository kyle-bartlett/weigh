# Weigh platform: hub, agent, live dashboard, any repo

Spec as built 2026-10-20 (from the approved plan). The harness design it extends: 2026-10-19-weigh-design.md.

Plan date 2026-10-20. Repo `~/wildcard/weigh` (Forgejo origin, public GitHub mirror). Design doc of the harness itself: `docs/superpowers/specs/2026-10-19-weigh-design.md`. This plan extends it; the data shapes, the statistics and the visual identity in that doc stand.

## Context

Weigh today is a terminal tool: `bun src/cli.ts run suites/<name>.ts` writes a run directory and renders a static HTML report. It has proved itself on two suites (Repo Scout filter, Exchange Triage prompts) and caught a model-version regression the app's own 100 percent score hid. Kyle wants it to become a platform: point it at any project repo from a browser, watch a run fill in live, read everything about an evaluation (checks, tokens, cost, gate, judges, cases) without a terminal, and let recruiters open the same page. Recruiters ask about evals on every call; a live, public eval dashboard is the proof.

Decisions Kyle made on 2026-10-20 (not reopened here):

- Audience: Kyle plus anonymous public viewers. Public value is the point.
- Runs execute on the always-on iMac. Model calls go through the Claude subscription login (PAI Inference.ts), which exists only on his machines. Jev needs only an API key.
- A project plugs in by shipping a suite file inside its own repo.
- A Claude Dashboard artifact (claude.ai) is a private companion view over an MCP connector. The public web UI is a separate, self-hosted surface because artifacts give anonymous visitors no live data and cannot subscribe to a stream.

Facts from scouting that shape the design:

- Weigh has no event layer. `runSuite` exposes one `log(string)` callback (`src/run.ts:135`, `:208`); the complete `TraceLine` exists right before `appendFileSync` at `src/run.ts:126`. `RUNS_DIR` is read once at import. Suites import their target repo at module load with top-level await and keep module-level state, so a long-lived process cannot re-point at another checkout: each run needs a subprocess.
- `build`, `readJudges`, `writeReports` in `src/cli.ts` are not exported. `compare`, `noiseFloor`, `gate` (`src/stats.ts`), `validate` (`src/judge.ts`), `matrix` (`src/transition.ts`), `renderHtml`, `renderMarkdown`, `renderReview` are.
- Every public portfolio app Kyle runs lives on Coolify (Vultr). `stephanie.bartlettlabs.io` is a zero-dependency Bun plus `bun:sqlite` app there, the closest precedent. The iMac's Cloudflare tunnel serves only hostnames locked behind Cloudflare Access for Kyle alone. Mission Control (chief-of-staff `src/web/index.ts`) is the private pattern: plain `Bun.serve`, bearer token file compared with `timingSafeEqual`, HTML served without auth and holding no data, 3 s polling.
- Exchange Triage already has the live-view parts to lift: `lib/sse.ts` (SSE frames, 10 s ping, flush in finally), `lib/client/sse.ts` (38-line fetch-body stream parser), `lib/client/traceState.ts` (pure `applyEvent` reducer; the event log is the render model), `components/glassbox/TraceBoard.tsx`. Gaps to fix rather than inherit: no `cancel()` on the stream and `req.signal` not wired, so a closed tab does not stop the run.
- Exchange Triage exposes a remote MCP endpoint over HTTP, so a Weigh MCP endpoint is an established pattern.

## Architecture: hub on Coolify, agent on the iMac

One codebase, two entrypoints: `weigh hub` (Bun + bun:sqlite, zero deps, on Coolify at `weigh.bartlettlabs.io`) and `weigh agent` (launchd on the iMac). The agent is outbound only: it long-polls the hub for jobs, runs the suite as a subprocess, tails the run's `events.jsonl` and POSTs events and outputs to the hub. The public URL survives iMac reboots and Time Machine windows; the iMac gets no inbound port or tunnel. Same run dir on disk, so the CLI keeps working offline.

Decisions baked in (not reopened during the build):

- Hub stores display metadata only (name, repo URL, branch, public flag). Anything executable (remote allowlist, install command, env) lives in the agent's local `~/.config/weigh/agent.json`. A leaked admin token can never become code execution on the iMac.
- Events are a file. The runner appends `events.jsonl` in the run dir; the agent tails it. Suites print app noise to stdout, and a file gives replay, crash recovery and the hub-down buffer for free.
- `job_done` carries the TraceLine (about 1 KB). Outputs and inputs go up on separate gzipped idempotent PUTs.
- Server-rendered HTML from template-literal functions (the house style), reusing `CSS` and `esc` from `src/report/html.ts`. One vanilla ES module for the live Run page. The hub recomputes `compare`/`gate`/`noiseFloor` after each `job_done` and sends a `summary` event with pre-rendered fragments, so the statistics exist in exactly one place and the browser only patches DOM. No Preact, no cdnjs, no build.
- Three tokens, three scopes, all Coolify env secrets compared with `timingSafeEqual` (Mission Control pattern): `WEIGH_ADMIN_TOKEN` (mutations), `WEIGH_AGENT_TOKEN` (`/api/agent/*` only), `WEIGH_READ_TOKEN` (private reads and `/mcp`). The read token is accepted as a bearer and as a path capability `/mcp/<token>` because claude.ai connectors may not allow a custom header.
- No types package. `weigh init <repo>` copies `src/types.ts` into `<repo>/weigh/types.ts`; runtime helpers load by path through `WEIGH_HOME`, the pattern the suites already use. Zod validates the loaded suite module.
- MCP is hand-rolled JSON-RPC over POST (about 120 lines, six read-only tools). Ignore the `MCP-Protocol-Version` header (Exchange Triage's `tolerateNewerProtocol` lesson).
- Deploy right after the first import, before the agent exists. A public URL showing the two real runs is the earliest "out of the terminal" moment.

## Event schema (`src/events.ts`)

```ts
interface Base { seq: number; at: string }   // seq: 1-based per run, assigned by the runner
export type RunnerEvent =
  | (Base & { type: "run_start"; run_id: string; suite: string; meta: RunMeta; case_order: string[]; total: number; resumed: number })
  | (Base & { type: "job_start"; variant: string; case_id: string })
  | (Base & { type: "job_done"; line: TraceLine; finished: number; total: number })
  | (Base & { type: "run_done"; finished_at: string })
  | (Base & { type: "run_cancelled"; finished: number; total: number })
  | (Base & { type: "run_error"; error: string });
export type AgentEvent = Base & { type: "log"; level: "info" | "warn" | "error"; text: string };   // git pull, bun install, loading suite
export type HubEvent =
  | (Base & { type: "summary"; cmp: Comparison; gate: GateResult; noise?: NoiseFloor; paired_n: number; html: { verdict: string; proof: string; checks: string } })
  | (Base & { type: "status"; status: RunStatus; agent_id?: string });
export type RunEvent = RunnerEvent | AgentEvent | HubEvent;
export type RunStatus = "queued" | "claimed" | "running" | "finished" | "failed" | "cancelled" | "lost";
export const RunEventSchema: z.ZodType<RunEvent>;
export function eventsFromTraces(meta, lines): RunnerEvent[];   // replay for imported runs with no events.jsonl
```

The hub assigns the storage `seq` on ingest (monotonic per run) and keeps the sender's sequence as `src_seq`. Idempotency key is `(run_id, source, src_seq)`. SSE `id:` is the hub seq, so native `EventSource` reconnects with `Last-Event-ID` for free.

## SQLite schema (`src/hub/db.ts`, WAL, busy_timeout 5000, foreign keys on)

| Table | Key columns | Notes |
|---|---|---|
| `schema_version` | `v` | migrations as an ordered array of SQL strings |
| `projects` | `id` slug PK, `name`, `description`, `repo_url`, `branch`, `public` (default 0), `created_at` | `public` is the only visibility switch |
| `suites` | PK(`project_id`,`name`), `description`, `path`, `variants_json`, `checks_json`, `baseline`, `candidate`, `noise`, `registered_at` | written by agent register |
| `runs` | `id` = `<suite>/<run_id>` PK, `project_id`, `status`, `requested_at`, `started_at`, `finished_at`, `agent_id`, `lease_until`, `cancel_requested`, `options_json`, `meta_json`, `case_order_json`, `summary_json`, `finished`, `total`, `last_seq`, `last_src_seq` | `summary_json` = latest `{cmp, gate, noise}` so list pages never recompute |
| `events` | PK(`run_id`,`seq`), `source`, `src_seq`, `type`, `at`, `payload_json`, UNIQUE(`run_id`,`source`,`src_seq`) | SSE replays from here |
| `trace_lines` | PK(`run_id`,`variant`,`case_id`), `at`, `ok`, `error`, `usage_json`, `checks_json`, `unanswered_json`, `extra_json`, `stages_json`, `output_hash`, `cached` | upserted from `job_done`; the query model for Run, Case and Compare pages |
| `outputs` | PK(`run_id`,`variant`,`case_id`), `output_hash`, `gz` BLOB, `raw_bytes`, `truncated`, `stored_at` | gzip at the agent; 1 MB raw cap (first 256 KB kept, `truncated=1` above it); 32 MB per run |
| `inputs` | PK(`run_id`,`case_id`), `text` | 16 KB per case cap |
| `judges` | PK(`run_id`,`check_id`), `labels_ref`, `result_json`, `at` | `JudgeRecord` shape from cli.ts |
| `labels` | id PK, `project_id`, `suite`, `run_id`, `case_id`, `variant`, `human`, `note`, `split`, `at`, UNIQUE(`run_id`,`case_id`,`variant`) | review page writes, judge validate reads |
| `agents` | `id` PK, `last_seen_at`, `version`, `current_run_id` | informational |

Measured sizes: the Exchange Triage run is 848 KB over 108 outputs, Repo Scout 1.7 MB over 184, largest single output 32 KB. Fifty runs of that size gzipped stay under 100 MB. Tokens are never in the DB. `REQUIRE_SECRETS=1` in the Dockerfile makes a missing token fatal (stephanie-tracker precedent).

## Agent protocol

| Step | Call | Semantics |
|---|---|---|
| Register | `POST /api/agent/register` `{agent_id, version, projects:[{id, suites:[...]}]}` | on start and after each pull; upserts `suites`; unknown projects are created private |
| Claim | `GET /api/agent/jobs?agent=imac&wait=25` | long poll, 500 ms check; atomic `UPDATE ... RETURNING` on the oldest queued run for the agent's projects; 204 when empty; one run at a time per agent |
| Heartbeat | `POST /api/agent/runs/:id/heartbeat` `{finished, total, status}` every 20 s, returns `{cancel}` | renews a 90 s lease; a missed lease marks the run `lost` (never auto-requeued: Retry in the UI resumes from cache for free); a late heartbeat flips `lost` back to `running` |
| Events | `POST /api/agent/runs/:id/events` `{events: RunEvent[]}` | agent batches up to 100 events or 500 ms, sends strictly in order, advances its cursor only on 2xx; hub ignores duplicates; body cap 1 MB |
| Outputs | `PUT /api/agent/runs/:id/outputs/:variant/:case_id` gzip body, `X-Output-Hash` header | after each `job_done`, from the cache file; idempotent |
| Inputs, judges | `PUT /api/agent/runs/:id/inputs`, `PUT .../judges` | once after `run_start` (scrubbed); judges at finish if `judges.json` exists |
| Finish | `POST /api/agent/runs/:id/finish` `{status, exit_code}` | after the final batch and all outputs are acked |
| Cancel | admin `POST /api/runs/:id/cancel` sets `cancel_requested` | next heartbeat returns `cancel:true`; agent sends SIGTERM; the runner's AbortSignal stops workers taking new jobs, in-flight jobs finish within the CLI timeout, runner emits `run_cancelled`; SIGKILL after 5 minutes |
| Hub down | retry with backoff 1 s to 30 s forever; cursor file `<run dir>/.hub-cursor` `{src_seq, outputs_acked}` | a startup sweep over `<WEIGH_RUNS>/*/*/.hub-cursor` finishes any upload that never reached `run_done` |
| Retry | admin `POST /api/runs/:id/retry` | requeues the same `run_id`; the runner's cache makes it a resume |

Agent config (`~/.config/weigh/agent.json`, zod-validated, never from the hub): `hub`, `token_file`, `agent_id`, `weigh_home`, `workdir`, `runs_dir`, `allowed_remotes` (Kyle's Forgejo and GitHub prefixes), `projects[]` with `remote`, `branch`, `install` (always with `--ignore-scripts`) and `env`.

Subprocess per job: `bun <weigh_home>/src/cli.ts run <checkout>/weigh/<name>.suite.ts --run-id <id>`, `cwd` = checkout, explicit env (`WEIGH_RUNS`, `WEIGH_HOME`, `HOME`, `PATH`, project env), nothing inherited wholesale. The run dir is deterministic because the agent learned the suite name from `weigh suite-info` at discovery, so it knows where `events.jsonl` will appear before spawning.

## Change set in the existing code

`src/types.ts`: `RunMeta` gains `cancelled_at?`.

`src/run.ts` (the 23 tests stay untouched, the `log` line stays byte-identical):
- `RunOptions` gains `onEvent?: (e: RunnerEvent) => void` and `signal?: AbortSignal`.
- A local `emit` stamps `seq` and `at`. `run_start` after `jobs` is built (line 201). In the worker loop, `job_start` before `runOne` and `job_done` after it, then the existing `log(...)`. The loop condition also checks `opts.signal?.aborted`.
- After `Promise.all`: aborted sets `cancelled_at` and emits `run_cancelled`, else `finished_at` and `run_done`. The body after `run_start` sits in try/catch that emits `run_error` and rethrows.
- `RUNS_DIR` stays read at import; the agent sets `WEIGH_RUNS` on the child.

`src/cli.ts`:
- `run` gains `--events <path>` (default `<dir>/events.jsonl`, `--no-events` to skip) wiring `onEvent` to `appendFileSync`; a SIGTERM handler aborts the controller; exit code 130 on cancel.
- New commands: `suite-info <suite.ts>` (JSON: name, description, variants, checks, baseline, candidate, noise; never calls `cases()`), `init <repo> [--name x]`, `import <run-dir> --hub <url> --token-file <p>`, `hub`, `agent`.
- Pure refactor: `build`, `readJudges`, `JudgeRecord`, `summaryLine` move to `src/report/build.ts` with a new in-memory `buildFrom(meta, lines, judges, pick)`; `build(dir)` calls it; the hub uses it.
- `loadSuite` validates with `SuiteSchema` (names are strings, `variants[].run` and `checks[].test` are functions, `baseline`/`candidate`/`noise` name existing variants, `kind` in code|judge) and names the field and file on failure.

`src/report/html.ts`: export the fragments (`verdictBand`, `proofStrip`, `checksTable`, `caseLedger`, `stripPlot`, `judgeTable`) so the static report and the hub pages share them.

## File layout after the change

```
src/events.ts            RunEvent union, RunEventSchema, eventsFromTraces
src/scrub.ts             scrub(value), scrubTrace, scrubMeta, scrubText
src/report/build.ts      build, buildFrom, readJudges, JudgeRecord, summaryLine (moved from cli.ts)
src/hub/server.ts        Bun.serve, route table, static files, limits, CSP, /healthz
src/hub/db.ts            open, pragmas, migrations
src/hub/store.ts         typed queries
src/hub/ingest.ts        apply RunEvent, scrub, recompute summary via buildFrom, broadcast
src/hub/stream.ts        SSE fan-out per run, since / Last-Event-ID, per-IP cap, 30 min max
src/hub/auth.ts          scopes admin|agent|read, bearer parse, timingSafeEqual
src/hub/api.ts           public read API, admin mutations
src/hub/agent-api.ts     register, jobs, heartbeat, events, outputs, inputs, judges, finish
src/hub/mcp.ts           JSON-RPC over POST, six tools
src/hub/pages/           layout, projects, run, case, judges, labels, compare
src/agent/main.ts        loop: register, poll, run, heartbeat, recovery sweep
src/agent/config.ts      agent.json schema, allowlist check
src/agent/checkout.ts    git clone/fetch/checkout, install with --ignore-scripts
src/agent/discover.ts    glob weigh/*.suite.ts, weigh suite-info per file
src/agent/runner.ts      Bun.spawn the CLI, SIGTERM on cancel, exit code mapping
src/agent/tail.ts        tail events.jsonl (stat poll 250 ms), batch
src/agent/upload.ts      HubClient (postEvents, putOutput, putInputs, putJudges, finish), importRunDir
src/agent/cursor.ts      .hub-cursor read/write
web/weigh.css, run.js, labels.js, common.js
templates/weigh.suite.ts
deploy/Dockerfile, docker-entrypoint.sh, launchd/com.bartlettlabs.weigh-agent.plist, bin/weigh-agent-launchd.sh
test/events, scrub, build, hub, stream, agent, pages, no-dash-source, mcp, import .test.ts
```

Reuse map: `compare`, `noiseFloor`, `gate` from `src/stats.ts` feed `hub/ingest.ts` through `buildFrom`; `validate` (`src/judge.ts`) backs `POST /api/runs/:id/judges/validate`; `matrix` (`src/transition.ts`) renders the "Where runs fail" section; `renderHtml` serves `GET /api/runs/:id/report.html`, `renderMarkdown` serves `summary.md`; `renderReview`'s hotkeys move into `web/labels.js`; `web/run.js` mirrors Exchange Triage's `lib/client/traceState.ts` reducer shape.

## Suite discovery, the "any repo" contract

- `<repo>/weigh/<name>.suite.ts` default-exports a `Suite`. Optional `<repo>/weigh/labels/<name>.jsonl` and `<repo>/weigh/types.ts` (copied by `weigh init`).
- The suite imports its own app by relative path (Bun honors the repo's nearest `tsconfig.json` paths, which is how the Exchange Triage suite already works). Weigh helpers load via `join(process.env.WEIGH_HOME, "src/claude-cli.ts")`; the CLI sets `WEIGH_HOME` to its own checkout when missing, so today's `bun src/cli.ts run` keeps working.
- Migration proof in Phase 3: `suites/exchange-triage.ts` becomes `exchange-triage/weigh/extraction-prompts.suite.ts`, `suites/reposcout-transcript.ts` becomes `chief-of-staff/weigh/transcript-filter.suite.ts`. Weigh-side copies stay until both run through the agent, then go. Data dirs move with them under `<repo>/weigh/data/` (gitignored).

## Security and scrub

- Visibility: anonymous sees only `public=1` projects (runs, summaries, trace lines, inputs, outputs, judges, labels read-only, report downloads); private projects are 404 to anonymous. The read token unlocks private reads and `/mcp`. Default private; Kyle flips Exchange Triage public (synthetic golden set). Repo Scout stays private (YouTube transcript excerpts).
- `src/scrub.ts`, applied at the agent before upload and again at hub ingest: absolute paths (`/Users/...`, `/Volumes/...`, `/private/...`, `~/`) become `<path>`; `sk-` keys, `Bearer <tok>` and long hex or base64 runs next to key|token|secret|authorization become `<redacted>`. Applied to `meta.command`, `TraceLine.error`, `extra.*` strings, inputs, outputs and `log` events. The agent also normalizes `command` to `bun src/cli.ts run weigh/<name>.suite.ts --run-id <id>`.
- Limits: events body 1 MB and 200 events; output 1 MB raw; inputs 16 KB per case; import bundle 64 MB; SSE 5 per IP, 200 global, 30 min max then reconnect; JSON parsed only on routes that expect it; 405 for GET on `/mcp`.
- Headers: CSP `default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`, nosniff, `Referrer-Policy: no-referrer`, `development: false` in `Bun.serve`.
- Hub never logs tokens; 401 bodies carry no detail. The agent runs as Kyle's user under launchd (COS pattern).
- Em dash guard: `test/pages.test.ts` renders every page with the example-run fixture and asserts no U+2014 or U+2013; `test/no-dash-source.test.ts` scans `src/hub/**`, `web/**`, `templates/**`, `README.md` (allowlist: the `EM_DASH` regex in `src/checks.ts`, and `test/`). In `NODE_ENV=test` the hub runs the same regex on every `text/html` response and throws. Model text containing dashes is data and renders as-is.

## Phases, each with its verification

**Phase 0: events and build refactor (half a day).** `events.ts`, `run.ts` hooks, `scrub.ts`, `report/build.ts`, cli `--events` and `suite-info`. Tests: `events.test.ts` (fake suite from `test/harness.test.ts`: `run_start`, six `job_start`/`job_done` pairs, `run_done` with increasing seq; abort after the first job yields `run_cancelled` and `cancelled_at`; `eventsFromTraces` over the written `traces.jsonl` equals the live `job_done` lines); `scrub.test.ts`; `build.test.ts` (`buildFrom` over `runs/examples/exchange-triage-2026-10-19` returns `gate.pass === true`, 27 paired cases, 7 checks, 2 judges). The existing 23 pass unchanged; `bunx tsc --noEmit` clean.

**Phase 1: hub, pages, import (1 to 2 days).** db, store, ingest, read API, admin mutations, pages (projects, run, case, compare), stream replay, `weigh import`. Tests: `hub.test.ts` boots `Bun.serve` on port 0 with a temp DB, imports the committed example (no `outputs/` there, so the Case page must say "output not archived"), then: run JSON has 27 `case_order` and `summary.gate.pass` true; the Run page HTML contains "Gate passed", 27 `data-case` rows, zero dashes; `POST /api/projects` is 401 without a bearer, 401 with a wrong one, 201 with the right one; SSE for a finished run replays `run_start` through `run_done` then closes; a second import changes nothing. Visual: `iris capture http://localhost:8787/r/exchange-triage/2026-10-19-prompts` shows the verdict band, proof strip and 27-row ledger; import the local run dir (has outputs) and screenshot a Case page with both outputs.

**Phase 1b: deploy (half a day).** `deploy/Dockerfile` (`oven/bun` slim, `/data` volume, non-root, `HEALTHCHECK /healthz`, `REQUIRE_SECRETS=1`), Coolify app with the three token secrets and `WEIGH_DB=/data/weigh.db`. `df -h` first, deploy through the Coolify API, confirm the container image tag equals the commit SHA, `cf` DNS record for `weigh.bartlettlabs.io`. Import both example runs from the laptop. Verify: `/healthz`, iris capture of the public Run page, 401 on mutations over the public URL. The Coolify API token lives in `~/.config/coolify/config.json`; never echo it.

**Phase 2: agent and live runs (2 days).** Agent modules, agent API, stream fan-out, `web/run.js`, `summary` events, cancel, retry, launchd plist and `bin/weigh-agent-launchd.sh` (COS pattern). Tests: `agent.test.ts` with an in-process hub and the fake suite: events arrive in order with contiguous `src_seq`; outputs round-trip through gzip; hub stopped for three batches then restarted, cursor replays with no gaps or duplicates; cancel through heartbeat terminates the child and the hub ends `cancelled`; a killed agent leaves `lost`, the recovery sweep finishes the upload on restart. `stream.test.ts`: two subscribers, per-IP cap returns 429, `since` resumes. Live: agent under launchd on the iMac pointed at exchange-triage; before the first run confirm `claude auth status` and `security find-generic-password -s openrouter-jev` on the iMac; enqueue from the project page; watch 108 cells fill in the laptop browser (or `--variants v2,v3` with a few cases for a short first run); screenshot mid-run and at the end. Repo Scout second (its `cases()` reads `scout.sqlite`, native on the iMac).

**Phase 3: onboarding and discovery (1 day).** `weigh init`, `discover.ts`, `templates/weigh.suite.ts`, project page "waiting for agent" state, both suites moved into their repos. Tests: `init` writes the two files; `discover` finds `weigh/*.suite.ts` and rejects a module that fails `SuiteSchema` with the field name; a remote outside the allowlist is refused before any git call. Verify: both suites run from their own repos through the agent; weigh-side copies deleted; README updated.

**Phase 4: labels and judges in the hub (1 day).** Labels API, `pages/labels.ts` plus `web/labels.js` (hotkeys from `review.ts`), `POST /api/runs/:id/judges/validate {check}` over hub labels, Judges page, `suites/exchange-triage.labels.jsonl` imported as seed. Tests: label upsert unique per (run, case, variant); validate reproduces the committed `judges.json` numbers for `attribution_jev` (TPR 0.5, TNR 1.0, n 54).

**Phase 5: MCP and the Dashboard artifact (half a day plus a check).** `hub/mcp.ts` tools `list_projects`, `list_runs(project?, limit)`, `get_run_summary(run)`, `get_run_checks(run)`, `get_run_cases(run, variant?, failing_only?)`, `get_judges(run)`, responses under 20 KB. Tests: `mcp.test.ts` drives `initialize`, `tools/list`, `tools/call` over fetch; 401 without the read token; the path-token form works. Verify: add the connector in claude.ai (header first, `/mcp/<token>` URL if unsupported), confirm `tools/list` from the artifact, then build the Dashboard artifact (type https://claude.ai/artifact/GZLZthZ2sQjn7T16skfdeF) with polling datasets over the connector.

**Phase 6: docs and record (half a day).** README platform section (agent setup, suite contract), `docs/superpowers/specs/2026-10-20-weigh-platform.md` (this plan with its decisions), `_SHIPLOG`, push Forgejo and GitHub. Prose through the writing guardrails.

Order for the earliest visible result: 0, 1, 1b, 2. Phases 3 to 6 are independent after that.

## Risks

| Risk | Mitigation |
|---|---|
| claude.ai connector cannot send a custom header | read-scope path token designed in from the start; MCP tools are read-only |
| iMac launchd environment lacks the claude subscription login or the Jev Keychain item | COS Repo Scout already runs Inference.ts under launchd there; verify both before Phase 2's live run; the Jev judge returns null on failure, never a false score |
| Exchange Triage checkout on the iMac is heavy (Next.js deps) | `bun install --frozen-lockfile --ignore-scripts` once per branch change; the suite imports only `lib/pipeline`, `lib/anthropic`, `evals/*` |
| Public exposure of case inputs | default private; Exchange Triage golden set is synthetic; Repo Scout stays private |
| SQLite growth on Coolify | gzip, per-run budget, `df -h` before deploys, a `prune` command later |
| Summary recompute per `job_done` | `compare` over 27 to 46 cases with a 2,000-resample bootstrap is a few ms; debounce 250 ms |
| The 23 tests reimport `run.ts` with a cache-busting query | `RUNS_DIR` semantics unchanged; new tests use their own temp dirs and `WEIGH_RUNS` the same way |
