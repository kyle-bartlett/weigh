import { z } from "zod";
import type { Comparison, GateResult, NoiseFloor } from "./stats.ts";
import type { RunMeta, TraceLine, Usage } from "./types.ts";

/**
 * The event stream of one run. The runner emits RunnerEvents in order (seq 1..n) and the CLI appends
 * them to <run dir>/events.jsonl; the agent tails that file to the hub; the hub adds its own events
 * (summary after each job_done, status changes) and streams the lot to browsers. The event log is the
 * render model: a page that replays it from seq 1 ends in the same state as one that watched it live.
 */

interface Base {
  /** 1-based, per run, assigned by whoever emits. The hub keeps it as src_seq and assigns its own. */
  seq: number;
  at: string;
}

export type RunStatus =
  | "queued"
  | "claimed"
  | "running"
  | "finished"
  | "failed"
  | "cancelled"
  | "lost";

export type RunnerEvent =
  | (Base & {
      type: "run_start";
      run_id: string;
      suite: string;
      meta: RunMeta;
      case_order: string[];
      /** Jobs this attempt will run (pairs already cached from an earlier attempt are not counted). */
      total: number;
      /** Trace lines kept from an earlier attempt of the same run id. */
      resumed: number;
    })
  | (Base & { type: "job_start"; variant: string; case_id: string })
  | (Base & {
      type: "job_done";
      line: TraceLine;
      finished: number;
      total: number;
    })
  | (Base & { type: "run_done"; finished_at: string })
  | (Base & { type: "run_cancelled"; finished: number; total: number })
  | (Base & { type: "run_error"; error: string });

export type AgentEvent =
  | (Base & { type: "log"; level: "info" | "warn" | "error"; text: string })
  | (Base & {
      type: "model_call";
      variant?: string;
      case_id?: string;
      model: string;
      ok: boolean;
      usage: Usage;
    });

export type HubEvent =
  | (Base & {
      type: "summary";
      cmp: Comparison;
      gate: GateResult;
      noise?: NoiseFloor;
      paired_n: number;
      /** Pre-rendered fragments so the browser never formats a number. */
      html?: { verdict: string; proof: string; checks: string };
    })
  | (Base & { type: "status"; status: RunStatus; agent_id?: string });

export type RunEvent = RunnerEvent | AgentEvent | HubEvent;

const base = { seq: z.number().int().min(1), at: z.string().min(1) };
const fn = z.custom<unknown>(() => true);
const usage = z.looseObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  calls: z.number(),
});
const line = z.looseObject({
  run_id: z.string(),
  suite: z.string(),
  case_id: z.string(),
  variant: z.string(),
  at: z.string(),
  ok: z.boolean(),
  usage,
  checks: z.record(z.string(), z.boolean()),
  output_hash: z.string(),
});

/** The envelope of every event is checked; nested payloads (meta, line, cmp) are checked for the fields pages read. */
export const RunEventSchema: z.ZodType<RunEvent> = z.discriminatedUnion(
  "type",
  [
    z.object({
      ...base,
      type: z.literal("run_start"),
      run_id: z.string(),
      suite: z.string(),
      meta: z.looseObject({
        run_id: z.string(),
        suite: z.string(),
        baseline: z.string(),
        candidate: z.string(),
        checks: z.array(z.looseObject({ id: z.string() })),
        variants: z.array(z.looseObject({ name: z.string() })),
      }),
      case_order: z.array(z.string()),
      total: z.number().int().min(0),
      resumed: z.number().int().min(0),
    }),
    z.object({
      ...base,
      type: z.literal("job_start"),
      variant: z.string(),
      case_id: z.string(),
    }),
    z.object({
      ...base,
      type: z.literal("job_done"),
      line,
      finished: z.number().int().min(0),
      total: z.number().int().min(0),
    }),
    z.object({ ...base, type: z.literal("run_done"), finished_at: z.string() }),
    z.object({
      ...base,
      type: z.literal("run_cancelled"),
      finished: z.number().int().min(0),
      total: z.number().int().min(0),
    }),
    z.object({ ...base, type: z.literal("run_error"), error: z.string() }),
    z.object({
      ...base,
      type: z.literal("log"),
      level: z.enum(["info", "warn", "error"]),
      text: z.string(),
    }),
    z.object({
      ...base,
      type: z.literal("model_call"),
      variant: z.string().optional(),
      case_id: z.string().optional(),
      model: z.string(),
      ok: z.boolean(),
      usage,
    }),
    z.object({
      ...base,
      type: z.literal("summary"),
      cmp: fn,
      gate: z.looseObject({ pass: z.boolean(), reasons: z.array(z.string()) }),
      noise: fn.optional(),
      paired_n: z.number().int().min(0),
      html: z
        .object({ verdict: z.string(), proof: z.string(), checks: z.string() })
        .optional(),
    }),
    z.object({
      ...base,
      type: z.literal("status"),
      status: z.enum([
        "queued",
        "claimed",
        "running",
        "finished",
        "failed",
        "cancelled",
        "lost",
      ]),
      agent_id: z.string().optional(),
    }),
  ],
) as unknown as z.ZodType<RunEvent>;

export const parseEvent = (raw: unknown): RunEvent => RunEventSchema.parse(raw);

/**
 * Synthesize the runner's event stream for a run that has traces.jsonl but no events.jsonl (every run
 * before the platform existed). Replaying it through the same reducer the live page uses means imported
 * runs and live runs are the same thing to the hub.
 */
export function eventsFromTraces(
  meta: RunMeta & { case_order: string[] },
  lines: TraceLine[],
): RunnerEvent[] {
  const sorted = [...lines].sort((a, b) => a.at.localeCompare(b.at));
  let seq = 0;
  const out: RunnerEvent[] = [
    {
      seq: ++seq,
      at: meta.started_at,
      type: "run_start",
      run_id: meta.run_id,
      suite: meta.suite,
      meta,
      case_order: meta.case_order,
      total: sorted.length,
      resumed: 0,
    },
  ];
  sorted.forEach((l, i) =>
    out.push({
      seq: ++seq,
      at: l.at,
      type: "job_done",
      line: l,
      finished: i + 1,
      total: sorted.length,
    }),
  );
  const last = sorted.at(-1)?.at ?? meta.started_at;
  out.push({
    seq: ++seq,
    at: meta.finished_at ?? last,
    type: "run_done",
    finished_at: meta.finished_at ?? last,
  });
  return out;
}
