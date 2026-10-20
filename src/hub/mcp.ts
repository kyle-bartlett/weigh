import { z } from "zod";
import { buildFrom } from "../report/build.ts";
import { promptTokens } from "../types.ts";
import { HttpError } from "./ingest.ts";
import { runKey, type Store } from "./store.ts";

/**
 * A remote MCP server over plain HTTP: JSON-RPC 2.0 by POST, six read-only tools, no server-initiated
 * streams. Hand-rolled because the surface is small and the hub takes no dependencies. The protocol
 * version header a client sends is ignored on purpose: claude.ai sends newer ones and a reader that
 * refuses them gains nothing.
 */

export const PROTOCOL = "2025-06-18";

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schema: z.ZodType;
  run: (store: Store, args: Record<string, unknown>) => unknown;
}

const run = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/, "suite/run_id");

const getRun = (store: Store, key: string) => {
  const r = store.getRun(key);
  if (!r) throw new HttpError(404, `no run ${key}`);
  return r;
};

const built = (store: Store, key: string) => {
  const r = getRun(store, key);
  if (!r.meta) throw new HttpError(409, `run ${key} has not started`);
  const lines = store.traces(key);
  if (!lines.length)
    throw new HttpError(409, `run ${key} has no finished pair yet`);
  return { run: r, b: buildFrom(r.meta, lines, store.judges(key)) };
};

export const TOOLS: Tool[] = [
  {
    name: "list_projects",
    description: "Projects on this hub with their suites and latest run.",
    inputSchema: { type: "object", properties: {} },
    schema: z.object({}),
    run: (store) =>
      store.listProjects().map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        public: p.public,
        suites: store.listSuites(p.id).map((s) => s.name),
        latest_run: store
          .listRuns({ project: p.id, limit: 1 })
          .map((r) => ({
            run: r.key,
            status: r.status,
            requested_at: r.requested_at,
            gate_pass: r.summary?.pass,
          }))[0],
      })),
  },
  {
    name: "list_runs",
    description: "Runs, newest first. Each row carries the headline numbers.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    schema: z.object({
      project: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    run: (store, a) =>
      store
        .listRuns({
          project: a.project as string | undefined,
          limit: (a.limit as number) ?? 20,
        })
        .map((r) => ({
          run: r.key,
          project: r.project_id,
          status: r.status,
          requested_at: r.requested_at,
          finished_at: r.finished_at,
          pairs: `${r.finished}/${r.total}`,
          gate_pass: r.summary?.pass,
          baseline_pass_all: r.summary?.baseline_pass_all,
          candidate_pass_all: r.summary?.candidate_pass_all,
          prompt_tokens_pct: r.summary?.prompt_tokens_pct,
        })),
  },
  {
    name: "get_run_summary",
    description:
      "Gate verdict, pass-all rates, token, cost and latency deltas with intervals, noise floor, regressions.",
    inputSchema: {
      type: "object",
      properties: { run: { type: "string", description: "suite/run_id" } },
      required: ["run"],
    },
    schema: z.object({ run }),
    run: (store, a) => {
      const { run: r, b } = built(store, a.run as string);
      const c = b.cmp;
      return {
        run: r.key,
        status: r.status,
        baseline: c.baseline.variant,
        candidate: c.candidate.variant,
        paired_cases: c.promptTokens.n,
        gate: b.gate,
        pass_all: {
          baseline: c.baseline.passAll,
          candidate: c.candidate.passAll,
        },
        prompt_tokens: {
          baseline_mean: c.promptTokens.baselineMean,
          candidate_mean: c.promptTokens.candidateMean,
          pct_change: c.promptTokens.pctChange,
          ci: c.promptTokens.ci,
        },
        cost_usd: {
          baseline_mean: c.costUsd.baselineMean,
          candidate_mean: c.costUsd.candidateMean,
          pct_change: c.costUsd.pctChange,
        },
        latency_ms: {
          baseline_mean: c.latencyMs.baselineMean,
          candidate_mean: c.latencyMs.candidateMean,
          pct_change: c.latencyMs.pctChange,
        },
        noise: b.noise,
        regressions: c.regressions.slice(0, 50),
        errors: { baseline: c.baseline.errors, candidate: c.candidate.errors },
      };
    },
  },
  {
    name: "get_run_checks",
    description:
      "Per-check pass rates for baseline and candidate with Wilson intervals and saturation.",
    inputSchema: {
      type: "object",
      properties: { run: { type: "string" } },
      required: ["run"],
    },
    schema: z.object({ run }),
    run: (store, a) => {
      const { b } = built(store, a.run as string);
      return b.cmp.checks.map((c) => ({
        id: c.id,
        kind: b.meta.checks.find((x) => x.id === c.id)?.kind,
        description: b.meta.checks.find((x) => x.id === c.id)?.description,
        baseline: c.baseline,
        candidate: c.candidate,
        delta: c.delta,
        saturated: c.saturated,
      }));
    },
  },
  {
    name: "get_run_cases",
    description:
      "One row per case and variant: checks, prompt tokens, cost, latency, error. Filter by variant or failing only.",
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string" },
        variant: { type: "string" },
        failing_only: { type: "boolean" },
      },
      required: ["run"],
    },
    schema: z.object({
      run,
      variant: z.string().optional(),
      failing_only: z.boolean().optional(),
    }),
    run: (store, a) => {
      const r = getRun(store, a.run as string);
      let lines = store.traces(r.key);
      if (a.variant) lines = lines.filter((l) => l.variant === a.variant);
      if (a.failing_only)
        lines = lines.filter(
          (l) => !l.ok || Object.values(l.checks).some((v) => !v),
        );
      return lines.slice(0, 200).map((l) => ({
        case_id: l.case_id,
        variant: l.variant,
        ok: l.ok,
        error: l.error,
        checks: l.checks,
        unanswered: l.unanswered,
        prompt_tokens: promptTokens(l.usage),
        output_tokens: l.usage.outputTokens,
        cost_usd: l.usage.costUsd,
        latency_ms: l.usage.latencyMs,
        extra: l.extra,
      }));
    },
  },
  {
    name: "get_judges",
    description:
      "Validation of every judge check on this run: TPR and TNR per split against human labels.",
    inputSchema: {
      type: "object",
      properties: { run: { type: "string" } },
      required: ["run"],
    },
    schema: z.object({ run }),
    run: (store, a) => store.judges(getRun(store, a.run as string).key),
  },
];

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const err = (id: Rpc["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});
const ok = (id: Rpc["id"], result: unknown) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  result,
});

/** Handle one JSON-RPC message. Returns null for notifications (the HTTP layer answers 202). */
export function handleMcp(
  store: Store,
  msg: Rpc,
): Record<string, unknown> | null {
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return err(msg.id, -32600, "invalid request");
  if (msg.method.startsWith("notifications/")) return null;
  switch (msg.method) {
    case "initialize":
      return ok(msg.id, {
        protocolVersion:
          typeof msg.params?.protocolVersion === "string"
            ? msg.params.protocolVersion
            : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "weigh", version: "0.2.0" },
        instructions:
          "Read-only view of Weigh eval runs. Run ids look like suite/run_id (for example exchange-triage/2026-10-19-prompts). Start with list_projects or list_runs.",
      });
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const name = msg.params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return err(msg.id, -32602, `unknown tool ${String(name)}`);
      const parsed = tool.schema.safeParse(msg.params?.arguments ?? {});
      if (!parsed.success)
        return ok(msg.id, {
          content: [
            {
              type: "text",
              text: `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            },
          ],
          isError: true,
        });
      try {
        const text = JSON.stringify(
          tool.run(store, parsed.data as Record<string, unknown>),
        );
        return ok(msg.id, {
          content: [
            {
              type: "text",
              text:
                text.length > 60_000
                  ? text.slice(0, 60_000) + "\n...truncated"
                  : text,
            },
          ],
        });
      } catch (e) {
        return ok(msg.id, {
          content: [
            { type: "text", text: e instanceof Error ? e.message : String(e) },
          ],
          isError: true,
        });
      }
    }
    default:
      return err(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

export { runKey };
