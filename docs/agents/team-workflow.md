# Team workflow: repo bindings

<!-- Seeded by the team-workflow pack's setup skill. Keep current via a setup re-run, not hand edits. -->

_Pack version: 1.7.2 · Last confirmed: 2026-10-21 (Kyle answered decider, home, mode; Scout took the defaults named "Scout's call" and they are open to correction at the next re-run)_

## Tracker binding

- **Tracker**: GitHub Issues on `kyle-bartlett/weigh` (the public mirror). Scout's call: the pack's recipes run on `gh` unchanged, and this machine has no Forgejo CLI or token. The Forgejo remote `origin` stays the source of truth for code; issues live on the mirror only.
- **Claim recipe**: the pack's tracker-discipline recipes as written, every command scoped `--repo kyle-bartlett/weigh`.
- **Frontier query**: `gh api 'repos/kyle-bartlett/weigh/issues?state=open&per_page=100' --paginate --jq '.[] | select(any(.labels[]; .name=="ready-for-agent")) | select(.assignees==[]) | select(all(.labels[]; .name!="blocked")) | "\(.number) \(.title)"'`, then drop items with a native `blocked_by` edge.
- **Blocking**: native dependency edges plus the `blocked` label, read both ways.
- **Label vocabulary**: pack defaults, created at setup on 2026-10-21 (`needs-triage`, `ready-for-agent`, `ready-for-human`, `blocked`, `slice`, `gate-decision`, `process`; `bug` already existed). GitHub's stock labels stay untouched.
- **Implicit-repo check**: match. `gh repo view` here resolves to `kyle-bartlett/weigh`.

## Verify commands

```bash
bunx tsc --noEmit
bun test
bun test --randomize --seed=3
```

Formatting is enforced by the procoder commit gate (it rejects unformatted files and attribution trailers); run the formatter in its own call before committing. No lint or build step exists as of 2026-10-21; revisit at the next re-run.

## The decider

- **Decider**: Kyle. Scout settles every fork that is not money, contracts, deleting data, or a message or post sent as Kyle (his autonomy doctrine, 2026-10-03), and records the ruling on the tracker item.

## Working mode

- **Working mode**: `lead`. A new session in this repo opens by invoking the orchestrate skill and following its startup checklist.

## Docs home

- **Binding doc home**: `docs/agents/team-workflow.md`
- **Decision maps**: `docs/agents/<scope>-decision-map.md`
- **Research findings**: `docs/agents/research/`
- **Domain/context docs agents should load**: `README.md`; `docs/superpowers/specs/2026-10-19-weigh-design.md`; `docs/superpowers/specs/2026-10-20-weigh-platform.md`; `docs/superpowers/specs/2026-10-20-v5-plain-language-design.md` (the approved but unbuilt v5 plan); the Obsidian note `Atlas/AI Evals Doctrine.md` on the machine that has it.

## Precedence & exemptions

Resident rules win unless an exemption below says otherwise.

- **Prototype test-exemption**: code on `prototype/<name>` branches is exempt from test-first and coverage rules; those branches never merge, and the exemption ends when the winner's real implementation starts.
- **Kyle's global CLAUDE.md outranks the pack** on tooling (bun only, one lockfile, model calls only through `Inference.ts`, never run `claude` directly), on writing guardrails for any prose deliverable, and on what reaches Kyle.
- **procoder gate**: commits are rejected for attribution trailers or unformatted files; the pack's commit discipline runs inside that gate.
- **Two remotes**: `main` is pushed to `origin` (Forgejo) and `github` (mirror) together. A push deploys nothing: the hub at weigh.bartlettlabs.io is a Coolify app that is triggered explicitly and verified by its container image tag.
- **Evals doctrine**: binary pass or fail checks only; a judge gates nothing until validated against human labels on a locked test split.

## Templates

- Issue/work-item spec: seeded at `.github/ISSUE_TEMPLATE/slice.md`
- Lane brief: seeded at `docs/agents/lane-brief.md`

## Handoff

- **Handoff location**: `.claude/handoff.md`, untracked
- **Ignore entry**: seeded in `.gitignore`
- **Session-start auto-load hook**: seeded in `.claude/settings.json` (created fresh; the repo had no settings file and no sync pipeline manages it)

## Glossary and non-negotiables

- **Routing**: written directly into `CLAUDE.md` (domain-memory is not bound).
- **Dispositions** (all 2026-10-21, harvested from README.md, accepted by Scout; Kyle corrects at re-run): suite, case, variant, baseline, candidate, check, gate, pass-all, run, trace, judge, labels, split, hub, agent, project: `accepted`. `noise floor`, `regression`, `saturated`: `declined` for now, the README defines them only in the report walkthrough; add at re-run with a definition Kyle signs.
- **Never-compromise list**: in `CLAUDE.md`, accepted.
- **Session-scope conduct pointer**: in `CLAUDE.md`, accepted.

## Adversarial review (floor layer)

- **Defect-class file**: `docs/agents/defect-classes.md`, seeded from the pack template, empty
- **Layers**: floor only
- **Mandatory lenses**: `src/hub/auth*` and anything touching tokens always runs the security lens
- **Live-probe policy**: proofs may hit a local `weigh hub` on a scratch SQLite file; never the live hub at weigh.bartlettlabs.io, never the iMac agent
- **Substantiality rules**: any change to `src/hub/` auth or MCP surfaces, or to `bin/weigh-agent-launchd.sh`, is always substantial

## Codebase review

Not bound as of 2026-10-21.

## Domain memory

Not bound as of 2026-10-21. Glossary lives in `CLAUDE.md`.

## Orchestration

Scout's call throughout; revise at re-run.

- **Lane launch**: in-process subagent by default (the Agent tool), separate session only for long builds or work Kyle wants to watch; the tracker item gets `Lane-start: workspace=<name> branch=<branch> runner=<runner>`; launcher titles lanes `#<N> — <short name>`, orchestrator titles itself `Orchestrator — weigh`; native auto-archive on PR close: no
- **Announce model/effort**: on
- **Runner inventory**: Claude Code subagents (Agent tool, including the Forge and Anvil agents); Codex via `codex exec` (never the plugin companion); human (Kyle). No launcher script yet; launch is manual per this doc.
- **Runner policy**: orchestrator's choice; Codex (Forge) preferred for implementation lanes at effort E3 and above; Claude for review and anything touching the hub's auth
- **Workspace provisioning**: one git worktree per lane under `.claude/worktrees/<item>` off `origin/main`; `bun install --frozen-lockfile` inside it; remove the worktree at close-out
- **Monitoring**: the orchestrator polls `gh issue list --repo kyle-bartlett/weigh` and `gh pr list --repo kyle-bartlett/weigh` between turns, plus the Monitor tool on lane output where available
- **Verification executor**: the orchestrator re-runs `bunx tsc --noEmit` and `bun test` in the lane's worktree, directly, checking each exit code
- **Review-tier policy**:
  - Mechanical verification re-runs: Sonnet, low effort · floor: never the adversarial pass
  - Adversarial review: Opus, high effort · floor: no low-effort skeptics on hub auth, MCP, or agent-launch changes
  - Max tier: Fable on changes to tokens, auth, or the iMac agent's launchd entry point
- **Merge flow**: lane branch pushed to `github` and reviewed as a PR on the mirror; the orchestrator merges into `main` locally after close-out and pushes `main` to `origin` and `github`; hub redeploy is a separate, explicit Coolify trigger

## Accepted drift

_None yet._

## Friction log

- `docs/agents/friction.md`
