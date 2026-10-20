#!/bin/bash
# launchd entry point for the Weigh agent on the always-on machine. Keeps the Weigh checkout current
# (the agent runs suites with it), then runs the agent loop. launchd restarts it if it exits.
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
WEIGH_HOME="${WEIGH_HOME:-$HOME/weigh}"
CONFIG="${WEIGH_AGENT_CONFIG:-$HOME/.config/weigh/agent.json}"

if [ -d "$WEIGH_HOME/.git" ]; then
	git -C "$WEIGH_HOME" pull --quiet --ff-only || echo "weigh: pull failed, running what is checked out" >&2
	(cd "$WEIGH_HOME" && bun install --frozen-lockfile --ignore-scripts >/dev/null) || true
fi
exec bun "$WEIGH_HOME/src/cli.ts" agent --config "$CONFIG"
