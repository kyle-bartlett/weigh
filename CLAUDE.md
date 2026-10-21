# Weigh

Kyle's global `~/.claude/CLAUDE.md` applies in full. This file adds what is specific to Weigh.

## Team workflow

Bindings for the team-workflow pack live in `docs/agents/team-workflow.md`: tracker, verify commands, decider, working mode (`lead`), handoff, orchestration. A new session here opens by invoking the orchestrate skill. Before writing any PR description or PR comment, read the pack's pr-writing reference (team-workflow pack, `skills/run/orchestrate/references/pr-writing.md`).

## Glossary

Use these words the way Weigh uses them, in replies as much as in code.

- **Suite**: one TypeScript module naming the cases, variants, checks, baseline, candidate and gate.
- **Case**: one input, with an optional reference answer, that every variant runs over.
- **Variant**: one way of running the pipeline. Returns its output and a `Usage` record (tokens, cost, latency, call count, metered or estimated).
- **Baseline** and **candidate**: the variant we compare from and the variant under test.
- **Check**: a function over (case, output) that returns pass or fail. A check can say which cases it applies to.
- **Gate**: the rule the candidate must clear (`maxPassAllDrop`, `noRegressionOn`). `weigh gate` exits 1 otherwise.
- **Pass-all**: a case passes every check that applies to it. The report's headline rate.
- **Run**: every variant over every case, cached under `runs/<suite>/<run-id>` so an interrupted run resumes without spending a model call twice.
- **Trace**: one line per case per variant in `traces.jsonl`. Every number in a report maps to one.
- **Judge**: a model-backed check. Reported against a person's labels as TPR, TNR and the Rogan-Gladen corrected rate.
- **Labels**: a person's pass or fail per case from the review page, with an optional split and note.
- **Split**: train, dev or test. Test is locked.
- **Hub**: the one Bun process with a SQLite file that stores runs and serves weigh.bartlettlabs.io.
- **Agent**: the always-on process (the iMac) that runs suites for the hub.
- **Project**: the hub's grouping of suites and runs.

## Never compromise

Changes must not break these without the decider's sign-off.

1. Model calls go through `~/.claude/PAI/TOOLS/Inference.ts`. Never import `@anthropic-ai/sdk`, never run `claude` directly.
2. bun only, one lockfile (`bun.lock`), one runtime dependency (zod).
3. Every report number maps to a trace line, and cached outputs are never re-spent. `rescore` must stay free.
4. Checks are binary. No Likert scales, no generic vendor metrics. A judge gates nothing until validated against human labels on a locked test split.
5. Tokens never appear in code, logs, chat, docs or the vault. The read-token connector URL stays private.
6. Public hub pages stay read-only. Starting a run needs the agent or admin token.
7. A push deploys nothing. The hub redeploys only on an explicit Coolify trigger, verified by image tag.
