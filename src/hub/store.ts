import type { Database } from "bun:sqlite";
import type { RunEvent, RunStatus } from "../events.ts";
import type { JudgeRecord } from "../report/build.ts";
import type { RunMeta, TraceLine } from "../types.ts";

/** Every query the hub runs, typed. Pages and the API never touch SQL. */

export interface Project {
  id: string;
  name: string;
  description: string;
  repo_url: string;
  branch: string;
  public: boolean;
  created_at: string;
}

export interface SuiteRow {
  project_id: string;
  name: string;
  description: string;
  path: string;
  info: Record<string, unknown>;
  registered_at: string;
}

export type Meta = RunMeta & { case_order: string[] };

export interface Summary {
  pass?: boolean;
  reasons?: string[];
  baseline_pass_all?: number;
  candidate_pass_all?: number;
  prompt_tokens_pct?: number;
  paired_n: number;
  at: string;
}

export interface Run {
  key: string;
  project_id: string;
  suite: string;
  run_id: string;
  status: RunStatus;
  requested_at: string;
  started_at?: string;
  finished_at?: string;
  agent_id?: string;
  lease_until?: string;
  cancel_requested: boolean;
  options: Record<string, unknown>;
  meta?: Meta;
  summary?: Summary;
  finished: number;
  total: number;
  last_seq: number;
  last_src_seq: number;
}

export interface StoredEvent {
  seq: number;
  source: "runner" | "agent" | "hub";
  src_seq: number;
  event: RunEvent;
}

export const runKey = (suite: string, runId: string) => `${suite}/${runId}`;

export const TERMINAL: ReadonlySet<RunStatus> = new Set([
  "finished",
  "failed",
  "cancelled",
]);

const now = () => new Date().toISOString();

export class Store {
  constructor(readonly db: Database) {}

  // projects

  listProjects(): Project[] {
    return (
      this.db.query("SELECT * FROM projects ORDER BY name").all() as Raw[]
    ).map(project);
  }
  getProject(id: string): Project | undefined {
    const r = this.db
      .query("SELECT * FROM projects WHERE id = ?")
      .get(id) as Raw | null;
    return r ? project(r) : undefined;
  }
  upsertProject(
    p: Partial<Project> & { id: string },
    create = true,
  ): Project | undefined {
    const cur = this.getProject(p.id);
    if (!cur && !create) return undefined;
    const next = {
      id: p.id,
      name: p.name ?? cur?.name ?? p.id,
      description: p.description ?? cur?.description ?? "",
      repo_url: p.repo_url ?? cur?.repo_url ?? "",
      branch: p.branch ?? cur?.branch ?? "main",
      public: p.public ?? cur?.public ?? false,
      created_at: cur?.created_at ?? now(),
    };
    this.db.run(
      `INSERT INTO projects (id, name, description, repo_url, branch, public, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
         repo_url = excluded.repo_url, branch = excluded.branch, public = excluded.public`,
      [
        next.id,
        next.name,
        next.description,
        next.repo_url,
        next.branch,
        next.public ? 1 : 0,
        next.created_at,
      ],
    );
    return next;
  }

  // suites

  upsertSuite(s: Omit<SuiteRow, "registered_at">) {
    this.db.run(
      `INSERT INTO suites (project_id, name, description, path, info_json, registered_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, name) DO UPDATE SET description = excluded.description,
         path = excluded.path, info_json = excluded.info_json, registered_at = excluded.registered_at`,
      [
        s.project_id,
        s.name,
        s.description,
        s.path,
        JSON.stringify(s.info),
        now(),
      ],
    );
  }
  listSuites(projectId: string): SuiteRow[] {
    return (
      this.db
        .query("SELECT * FROM suites WHERE project_id = ? ORDER BY name")
        .all(projectId) as Raw[]
    ).map((r) => ({
      project_id: r.project_id as string,
      name: r.name as string,
      description: r.description as string,
      path: r.path as string,
      info: JSON.parse(r.info_json as string),
      registered_at: r.registered_at as string,
    }));
  }

  // runs

  getRun(key: string): Run | undefined {
    const r = this.db
      .query("SELECT * FROM runs WHERE key = ?")
      .get(key) as Raw | null;
    return r ? run(r) : undefined;
  }
  /** Select before limiting so queued runs cannot hide the last finished result. */
  latestFinishedRun(projectIds: string[]): Run | undefined {
    if (!projectIds.length) return undefined;
    const row = this.db
      .query(
        `SELECT * FROM runs WHERE status = 'finished' AND project_id IN (${projectIds.map(() => "?").join(",")})
       ORDER BY COALESCE(finished_at, json_extract(meta_json, '$.finished_at'), requested_at) DESC, key DESC LIMIT 1`,
      )
      .get(...projectIds) as Raw | null;
    return row ? run(row) : undefined;
  }
  listRuns(opts: { project?: string; limit?: number } = {}): Run[] {
    const limit = Math.min(opts.limit ?? 50, 500);
    const rows = opts.project
      ? this.db
          .query(
            "SELECT * FROM runs WHERE project_id = ? ORDER BY requested_at DESC LIMIT ?",
          )
          .all(opts.project, limit)
      : this.db
          .query("SELECT * FROM runs ORDER BY requested_at DESC LIMIT ?")
          .all(limit);
    return (rows as Raw[]).map(run);
  }
  createRun(r: {
    key: string;
    project_id: string;
    suite: string;
    run_id: string;
    status: RunStatus;
    options?: Record<string, unknown>;
  }): Run {
    this.db.run(
      `INSERT INTO runs (key, project_id, suite, run_id, status, requested_at, options_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        r.key,
        r.project_id,
        r.suite,
        r.run_id,
        r.status,
        now(),
        JSON.stringify(r.options ?? {}),
      ],
    );
    return this.getRun(r.key)!;
  }
  updateRun(
    key: string,
    patch: Partial<{
      status: RunStatus;
      started_at: string;
      finished_at: string | null;
      agent_id: string | null;
      lease_until: string | null;
      cancel_requested: boolean;
      meta: Meta;
      summary: Summary;
      finished: number;
      total: number;
      last_src_seq: number;
    }>,
  ) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const put = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.status !== undefined) put("status", patch.status);
    if (patch.started_at !== undefined) put("started_at", patch.started_at);
    if (patch.finished_at !== undefined) put("finished_at", patch.finished_at);
    if (patch.agent_id !== undefined) put("agent_id", patch.agent_id);
    if (patch.lease_until !== undefined) put("lease_until", patch.lease_until);
    if (patch.cancel_requested !== undefined)
      put("cancel_requested", patch.cancel_requested ? 1 : 0);
    if (patch.meta !== undefined) put("meta_json", JSON.stringify(patch.meta));
    if (patch.summary !== undefined)
      put("summary_json", JSON.stringify(patch.summary));
    if (patch.finished !== undefined) put("finished", patch.finished);
    if (patch.total !== undefined) put("total", patch.total);
    if (patch.last_src_seq !== undefined)
      put("last_src_seq", patch.last_src_seq);
    if (!sets.length) return;
    vals.push(key);
    this.db.run(
      `UPDATE runs SET ${sets.join(", ")} WHERE key = ?`,
      vals as never,
    );
  }

  /** Atomically hand the oldest queued run in one of the agent's projects to that agent. */
  claimNext(
    agentId: string,
    projectIds: string[],
    leaseMs: number,
  ): Run | undefined {
    if (!projectIds.length) return undefined;
    const marks = projectIds.map(() => "?").join(",");
    const row = this.db
      .query(
        `UPDATE runs SET status = 'claimed', agent_id = ?, lease_until = ?
         WHERE key = (SELECT key FROM runs WHERE status = 'queued' AND project_id IN (${marks}) ORDER BY requested_at LIMIT 1)
         RETURNING *`,
      )
      .get(
        agentId,
        new Date(Date.now() + leaseMs).toISOString(),
        ...projectIds,
      ) as Raw | null;
    return row ? run(row) : undefined;
  }
  /** Runs whose agent stopped heartbeating. */
  expiredLeases(): Run[] {
    return (
      this.db
        .query(
          "SELECT * FROM runs WHERE status IN ('claimed','running') AND lease_until IS NOT NULL AND lease_until < ?",
        )
        .all(new Date().toISOString()) as Raw[]
    ).map(run);
  }
  suite(projectId: string, name: string): SuiteRow | undefined {
    return this.listSuites(projectId).find((s) => s.name === name);
  }

  // events

  /** Appends one event; returns the stored row, or undefined when (source, src_seq) was already stored. */
  insertEvent(
    key: string,
    source: StoredEvent["source"],
    srcSeq: number,
    e: RunEvent,
  ): StoredEvent | undefined {
    const next = (
      this.db
        .query(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE run_key = ?",
        )
        .get(key) as { n: number }
    ).n;
    const res = this.db.run(
      `INSERT OR IGNORE INTO events (run_key, seq, source, src_seq, type, at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [key, next, source, srcSeq, e.type, e.at, JSON.stringify(e)],
    );
    if (!res.changes) return undefined;
    this.db.run("UPDATE runs SET last_seq = ? WHERE key = ?", [next, key]);
    return { seq: next, source, src_seq: srcSeq, event: e };
  }
  eventsSince(key: string, after: number, limit = 5000): StoredEvent[] {
    return (
      this.db
        .query(
          "SELECT seq, source, src_seq, payload_json FROM events WHERE run_key = ? AND seq > ? ORDER BY seq LIMIT ?",
        )
        .all(key, after, limit) as Raw[]
    ).map((r) => ({
      seq: r.seq as number,
      source: r.source as StoredEvent["source"],
      src_seq: r.src_seq as number,
      event: JSON.parse(r.payload_json as string) as RunEvent,
    }));
  }

  // trace lines

  upsertTrace(key: string, l: TraceLine) {
    this.db.run(
      `INSERT INTO trace_lines (run_key, variant, case_id, at, ok, line_json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_key, variant, case_id) DO UPDATE SET at = excluded.at, ok = excluded.ok, line_json = excluded.line_json`,
      [key, l.variant, l.case_id, l.at, l.ok ? 1 : 0, JSON.stringify(l)],
    );
  }
  traces(key: string): TraceLine[] {
    return (
      this.db
        .query(
          "SELECT line_json FROM trace_lines WHERE run_key = ? ORDER BY at",
        )
        .all(key) as Raw[]
    ).map((r) => JSON.parse(r.line_json as string));
  }
  tracesFor(key: string, caseId: string): TraceLine[] {
    return (
      this.db
        .query(
          "SELECT line_json FROM trace_lines WHERE run_key = ? AND case_id = ? ORDER BY variant",
        )
        .all(key, caseId) as Raw[]
    ).map((r) => JSON.parse(r.line_json as string));
  }

  // outputs

  putOutput(
    key: string,
    variant: string,
    caseId: string,
    o: {
      output_hash: string;
      gz: Uint8Array;
      raw_bytes: number;
      truncated: boolean;
    },
  ) {
    this.db.run(
      `INSERT INTO outputs (run_key, variant, case_id, output_hash, gz, raw_bytes, truncated, stored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_key, variant, case_id) DO UPDATE SET output_hash = excluded.output_hash, gz = excluded.gz,
         raw_bytes = excluded.raw_bytes, truncated = excluded.truncated, stored_at = excluded.stored_at`,
      [
        key,
        variant,
        caseId,
        o.output_hash,
        o.gz,
        o.raw_bytes,
        o.truncated ? 1 : 0,
        now(),
      ],
    );
  }
  getOutput(
    key: string,
    variant: string,
    caseId: string,
  ):
    | {
        output_hash: string;
        gz: Uint8Array;
        raw_bytes: number;
        truncated: boolean;
      }
    | undefined {
    const r = this.db
      .query(
        "SELECT output_hash, gz, raw_bytes, truncated FROM outputs WHERE run_key = ? AND variant = ? AND case_id = ?",
      )
      .get(key, variant, caseId) as Raw | null;
    return r
      ? {
          output_hash: r.output_hash as string,
          gz: r.gz as Uint8Array,
          raw_bytes: r.raw_bytes as number,
          truncated: !!r.truncated,
        }
      : undefined;
  }
  outputBytes(key: string): number {
    return (
      this.db
        .query(
          "SELECT COALESCE(SUM(LENGTH(gz)), 0) AS n FROM outputs WHERE run_key = ?",
        )
        .get(key) as { n: number }
    ).n;
  }

  // inputs, judges, agents

  putInputs(key: string, texts: Record<string, string>) {
    const stmt = this.db.prepare(
      `INSERT INTO inputs (run_key, case_id, text) VALUES (?, ?, ?)
       ON CONFLICT(run_key, case_id) DO UPDATE SET text = excluded.text`,
    );
    this.db.transaction(() => {
      for (const [id, t] of Object.entries(texts)) stmt.run(key, id, t);
    })();
  }
  inputs(key: string): Record<string, string> {
    return Object.fromEntries(
      (
        this.db
          .query("SELECT case_id, text FROM inputs WHERE run_key = ?")
          .all(key) as Raw[]
      ).map((r) => [r.case_id as string, r.text as string]),
    );
  }
  putJudges(key: string, records: JudgeRecord[]) {
    const stmt = this.db.prepare(
      `INSERT INTO judges (run_key, check_id, record_json, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_key, check_id) DO UPDATE SET record_json = excluded.record_json, at = excluded.at`,
    );
    this.db.transaction(() => {
      for (const j of records) stmt.run(key, j.check, JSON.stringify(j), j.at);
    })();
  }
  /** Removes one check's judge record; returns how many rows went (0 or 1). */
  deleteJudge(key: string, check: string): number {
    return this.db.run(
      "DELETE FROM judges WHERE run_key = ? AND check_id = ?",
      [key, check],
    ).changes;
  }
  judges(key: string): JudgeRecord[] {
    return (
      this.db
        .query(
          "SELECT record_json FROM judges WHERE run_key = ? ORDER BY check_id",
        )
        .all(key) as Raw[]
    ).map((r) => JSON.parse(r.record_json as string));
  }
  upsertLabels(
    run: Run,
    rows: {
      case_id: string;
      variant: string;
      human: "pass" | "fail";
      note?: string;
      split?: string;
    }[],
  ) {
    const stmt = this.db.prepare(
      `INSERT INTO labels (project_id, suite, run_key, case_id, variant, human, note, split, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_key, case_id, variant) DO UPDATE SET human = excluded.human, note = excluded.note,
         split = COALESCE(excluded.split, labels.split), at = excluded.at`,
    );
    this.db.transaction(() => {
      for (const r of rows)
        stmt.run(
          run.project_id,
          run.suite,
          run.key,
          r.case_id,
          r.variant,
          r.human,
          r.note ?? "",
          r.split ?? null,
          now(),
        );
    })();
  }
  /** Insert labels for keys that have none; an existing row is never changed. Returns how many were inserted. */
  insertLabels(
    run: Run,
    rows: {
      case_id: string;
      variant: string;
      human: "pass" | "fail";
      note?: string;
      split?: string;
    }[],
  ): number {
    const stmt = this.db.prepare(
      `INSERT INTO labels (project_id, suite, run_key, case_id, variant, human, note, split, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_key, case_id, variant) DO NOTHING`,
    );
    let inserted = 0;
    this.db.transaction(() => {
      for (const r of rows)
        inserted += stmt.run(
          run.project_id,
          run.suite,
          run.key,
          r.case_id,
          r.variant,
          r.human,
          r.note ?? "",
          r.split ?? null,
          now(),
        ).changes;
    })();
    return inserted;
  }
  /** Human answers for this run, counted once per case and version, not per grader. */
  labelCount(key: string): number {
    return (
      this.db
        .query("SELECT COUNT(*) AS n FROM labels WHERE run_key = ?")
        .get(key) as { n: number }
    ).n;
  }
  labels(key: string): {
    case_id: string;
    variant: string;
    human: "pass" | "fail";
    note: string;
    split?: string;
    at: string;
  }[] {
    return (
      this.db
        .query(
          "SELECT case_id, variant, human, note, split, at FROM labels WHERE run_key = ? ORDER BY case_id, variant",
        )
        .all(key) as Raw[]
    ).map((r) => ({
      case_id: r.case_id as string,
      variant: r.variant as string,
      human: r.human as "pass" | "fail",
      note: r.note as string,
      split: (r.split as string) ?? undefined,
      at: r.at as string,
    }));
  }
  deleteLabel(key: string, caseId: string, variant: string) {
    this.db.run(
      "DELETE FROM labels WHERE run_key = ? AND case_id = ? AND variant = ?",
      [key, caseId, variant],
    );
  }

  touchAgent(id: string, version: string, currentRunKey: string | null) {
    this.db.run(
      `INSERT INTO agents (id, last_seen_at, version, current_run_key) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, version = excluded.version,
         current_run_key = excluded.current_run_key`,
      [id, now(), version, currentRunKey],
    );
  }
}

type Raw = Record<string, unknown>;

function project(r: Raw): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string,
    repo_url: r.repo_url as string,
    branch: r.branch as string,
    public: !!r.public,
    created_at: r.created_at as string,
  };
}

function run(r: Raw): Run {
  return {
    key: r.key as string,
    project_id: r.project_id as string,
    suite: r.suite as string,
    run_id: r.run_id as string,
    status: r.status as RunStatus,
    requested_at: r.requested_at as string,
    started_at: (r.started_at as string) ?? undefined,
    finished_at: (r.finished_at as string) ?? undefined,
    agent_id: (r.agent_id as string) ?? undefined,
    lease_until: (r.lease_until as string) ?? undefined,
    cancel_requested: !!r.cancel_requested,
    options: JSON.parse((r.options_json as string) || "{}"),
    meta: r.meta_json ? JSON.parse(r.meta_json as string) : undefined,
    summary: r.summary_json ? JSON.parse(r.summary_json as string) : undefined,
    finished: r.finished as number,
    total: r.total as number,
    last_seq: r.last_seq as number,
    last_src_seq: r.last_src_seq as number,
  };
}
