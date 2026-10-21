import { parseEvent, type RunEvent, type RunStatus } from "../events.ts";
import { buildFrom } from "../report/build.ts";
import { scrub } from "../scrub.ts";
import type { Store, StoredEvent, Summary } from "./store.ts";
import type { Streams } from "./stream.ts";

/**
 * Applying events to the store is the only way run state changes. The agent (or an import) posts
 * runner events in order; the hub stores them, keeps the trace lines as the query model, recomputes
 * the comparison after every finished pair, and appends its own summary and status events so a
 * browser replaying the log sees exactly what a live viewer saw.
 */

export interface IngestResult {
  accepted: number;
  last_src_seq: number;
  stored: StoredEvent[];
}

export function ingest(
  store: Store,
  streams: Streams,
  key: string,
  raw: unknown[],
  source: "runner" | "agent",
): IngestResult {
  const run = store.getRun(key);
  if (!run) throw new HttpError(404, "no such run");
  const events = raw.map((e) => scrub(parseEvent(e)));
  const stored: StoredEvent[] = [];
  let recompute = false;
  let lastSrc = run.last_src_seq;
  store.db.transaction(() => {
    for (const e of events) {
      const row = store.insertEvent(key, source, e.seq, e);
      if (!row) continue;
      stored.push(row);
      if (source === "runner") lastSrc = Math.max(lastSrc, e.seq);
      recompute = apply(store, key, e) || recompute;
    }
    store.updateRun(key, { last_src_seq: lastSrc });
  })();
  // Status follows what was newly stored: a replayed batch (an import run twice, an agent retry)
  // must not move a finished run back to running.
  const fresh = stored.map((e) => e.event);
  if (recompute) {
    const s = summarize(store, key);
    if (s) stored.push(s);
  }
  const status = statusAfter(fresh);
  if (status) {
    const cur = store.getRun(key)!;
    if (cur.status !== status) {
      store.updateRun(key, { status });
      const e = store.insertEvent(key, "hub", nextHubSeq(store, key), {
        type: "status",
        status,
        agent_id: cur.agent_id,
        seq: 1,
        at: new Date().toISOString(),
      });
      if (e) stored.push(e);
    }
  }
  streams.broadcast(key, stored);
  return { accepted: stored.length, last_src_seq: lastSrc, stored };
}

/** Updates run columns and trace lines for one event. Returns true when the comparison needs recomputing. */
function apply(store: Store, key: string, e: RunEvent): boolean {
  switch (e.type) {
    case "run_start":
      store.updateRun(key, {
        meta: { ...e.meta, case_order: e.case_order },
        total: e.total + e.resumed,
        finished: e.resumed,
        started_at: e.meta.started_at,
      });
      return false;
    case "job_done": {
      store.upsertTrace(key, e.line);
      // The runner counts this attempt only; the run row counts resumed pairs too (set at run_start).
      const r = store.getRun(key)!;
      store.updateRun(key, {
        finished: e.finished + Math.max(0, r.total - e.total),
      });
      return true;
    }
    case "run_done":
      store.updateRun(key, { finished_at: e.finished_at });
      return true;
    case "run_cancelled":
      store.updateRun(key, { finished_at: e.at });
      return true;
    case "run_error":
      store.updateRun(key, { finished_at: e.at });
      return false;
    default:
      return false;
  }
}

function statusAfter(events: RunEvent[]): RunStatus | undefined {
  let s: RunStatus | undefined;
  for (const e of events) {
    if (e.type === "run_start" || e.type === "job_done") s = "running";
    if (e.type === "run_done") s = "finished";
    if (e.type === "run_cancelled") s = "cancelled";
    if (e.type === "run_error") s = "failed";
  }
  return s;
}

const nextHubSeq = (store: Store, key: string) =>
  (store.getRun(key)?.last_seq ?? 0) + 1;

/** Build the comparison from stored lines, keep the headline numbers on the run, append a summary event. */
export function summarize(store: Store, key: string): StoredEvent | undefined {
  const run = store.getRun(key);
  if (!run?.meta) return undefined;
  const lines = store.traces(key);
  if (!lines.length) return undefined;
  const built = buildFrom(run.meta, lines, store.judges(key));
  const summary: Summary = {
    pass: built.gate.pass,
    reasons: built.gate.reasons,
    baseline_pass_all: built.cmp.baseline.passAll.rate,
    candidate_pass_all: built.cmp.candidate.passAll.rate,
    prompt_tokens_pct: built.cmp.promptTokens.pctChange,
    paired_n: built.cmp.promptTokens.n,
    at: new Date().toISOString(),
  };
  store.updateRun(key, { summary });
  return store.insertEvent(key, "hub", nextHubSeq(store, key), {
    type: "summary",
    cmp: built.cmp,
    gate: built.gate,
    noise: built.noise,
    paired_n: summary.paired_n,
    seq: 1,
    at: summary.at,
  });
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
