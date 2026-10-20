import { join } from "node:path";
import { homedir } from "node:os";
import { emptyUsage, type Usage } from "./types.ts";

/**
 * One metered model call through the subscription path (PAI Inference.ts, the claude CLI).
 * The CLI's JSON envelope carries real token counts and the API-equivalent cost, which is
 * where every metered number in a Weigh report comes from. Never the Anthropic SDK.
 */

export const HEADLESS_ARGS = [
  "--settings",
  '{"hooks":{}}',
  "--no-session-persistence",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
];

export type CliModel = "haiku" | "sonnet" | "opus";

interface Pai {
  inference: (o: {
    systemPrompt: string;
    userPrompt: string;
    level: "fast" | "standard" | "smart";
    timeout?: number;
    extraArgs?: string[];
  }) => Promise<{ success: boolean; output: string; error?: string }>;
}

let pai: Promise<Pai> | undefined;
const loadPai = () =>
  (pai ??= import(
    process.env.PAI_INFERENCE ??
      join(homedir(), ".claude/PAI/TOOLS/Inference.ts")
  ) as Promise<Pai>);

export interface CliCall {
  system: string;
  user: string;
  /** Default sonnet. A trailing --model flag overrides the level's model. */
  model?: CliModel;
  timeoutMs?: number;
}

export interface CliResult {
  ok: boolean;
  text: string;
  error?: string;
  usage: Usage;
  /** The model id the CLI reported, e.g. claude-sonnet-5-5. */
  modelId?: string;
}

interface Envelope {
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

export function parseEnvelope(output: string): Envelope | null {
  try {
    const e = JSON.parse(output) as Envelope;
    return e && typeof e === "object" && typeof e.result === "string"
      ? e
      : null;
  } catch {
    return null;
  }
}

export async function callClaudeCli(o: CliCall): Promise<CliResult> {
  const { inference } = await loadPai();
  const t0 = Date.now();
  const r = await inference({
    systemPrompt: o.system,
    userPrompt: o.user,
    level: "standard",
    timeout: o.timeoutMs ?? 180_000,
    extraArgs: [
      ...HEADLESS_ARGS,
      "--model",
      o.model ?? "sonnet",
      "--output-format",
      "json",
    ],
  });
  const env = parseEnvelope(r.output);
  const u = env?.usage;
  const usage: Usage = {
    ...emptyUsage("claude-cli"),
    inputTokens: u?.input_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    costUsd: env?.total_cost_usd ?? 0,
    latencyMs: Date.now() - t0,
    calls: 1,
    metered: !!u,
  };
  return {
    ok: r.success && !!env,
    text: env?.result ?? r.output ?? "",
    error: r.success ? undefined : (r.error ?? "no reply").slice(0, 300),
    usage,
    modelId: env?.modelUsage ? Object.keys(env.modelUsage)[0] : undefined,
  };
}

/** First JSON object or array in a reply, fences tolerated. undefined when there is none. */
export function firstJson(text: string): unknown {
  const t = text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim();
  const starts = ["{", "["].map((c) => t.indexOf(c)).filter((i) => i >= 0);
  if (!starts.length) return undefined;
  const start = Math.min(...starts);
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (end <= start) return undefined;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
