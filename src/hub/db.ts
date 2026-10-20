import { Database } from "bun:sqlite";

/**
 * One SQLite file holds the hub. Migrations are an ordered list of statements; schema_version records
 * how many have run. Adding a table or column means appending a statement, never editing an old one.
 */

const MIGRATIONS: string[] = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     repo_url TEXT NOT NULL DEFAULT '',
     branch TEXT NOT NULL DEFAULT 'main',
     public INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );
   CREATE TABLE suites (
     project_id TEXT NOT NULL REFERENCES projects(id),
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     path TEXT NOT NULL DEFAULT '',
     info_json TEXT NOT NULL,
     registered_at TEXT NOT NULL,
     PRIMARY KEY (project_id, name)
   );
   CREATE TABLE runs (
     key TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id),
     suite TEXT NOT NULL,
     run_id TEXT NOT NULL,
     status TEXT NOT NULL,
     requested_at TEXT NOT NULL,
     started_at TEXT,
     finished_at TEXT,
     agent_id TEXT,
     lease_until TEXT,
     cancel_requested INTEGER NOT NULL DEFAULT 0,
     options_json TEXT NOT NULL DEFAULT '{}',
     meta_json TEXT,
     summary_json TEXT,
     finished INTEGER NOT NULL DEFAULT 0,
     total INTEGER NOT NULL DEFAULT 0,
     last_seq INTEGER NOT NULL DEFAULT 0,
     last_src_seq INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX runs_project ON runs(project_id, requested_at);
   CREATE TABLE events (
     run_key TEXT NOT NULL REFERENCES runs(key),
     seq INTEGER NOT NULL,
     source TEXT NOT NULL,
     src_seq INTEGER NOT NULL,
     type TEXT NOT NULL,
     at TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     PRIMARY KEY (run_key, seq),
     UNIQUE (run_key, source, src_seq)
   );
   CREATE TABLE trace_lines (
     run_key TEXT NOT NULL REFERENCES runs(key),
     variant TEXT NOT NULL,
     case_id TEXT NOT NULL,
     at TEXT NOT NULL,
     ok INTEGER NOT NULL,
     line_json TEXT NOT NULL,
     PRIMARY KEY (run_key, variant, case_id)
   );
   CREATE TABLE outputs (
     run_key TEXT NOT NULL REFERENCES runs(key),
     variant TEXT NOT NULL,
     case_id TEXT NOT NULL,
     output_hash TEXT NOT NULL,
     gz BLOB NOT NULL,
     raw_bytes INTEGER NOT NULL,
     truncated INTEGER NOT NULL DEFAULT 0,
     stored_at TEXT NOT NULL,
     PRIMARY KEY (run_key, variant, case_id)
   );
   CREATE TABLE inputs (
     run_key TEXT NOT NULL REFERENCES runs(key),
     case_id TEXT NOT NULL,
     text TEXT NOT NULL,
     PRIMARY KEY (run_key, case_id)
   );
   CREATE TABLE judges (
     run_key TEXT NOT NULL REFERENCES runs(key),
     check_id TEXT NOT NULL,
     record_json TEXT NOT NULL,
     at TEXT NOT NULL,
     PRIMARY KEY (run_key, check_id)
   );
   CREATE TABLE labels (
     id INTEGER PRIMARY KEY,
     project_id TEXT NOT NULL,
     suite TEXT NOT NULL,
     run_key TEXT NOT NULL,
     case_id TEXT NOT NULL,
     variant TEXT NOT NULL,
     human TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     split TEXT,
     at TEXT NOT NULL,
     UNIQUE (run_key, case_id, variant)
   );
   CREATE TABLE agents (
     id TEXT PRIMARY KEY,
     last_seen_at TEXT NOT NULL,
     version TEXT NOT NULL DEFAULT '',
     current_run_key TEXT
   );`,
];

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
  );
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
  const row = db.query("SELECT MAX(v) AS v FROM schema_version").get() as {
    v: number | null;
  };
  for (let v = row.v ?? 0; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.run("INSERT INTO schema_version (v) VALUES (?)", [v + 1]);
    })();
  }
  return db;
}
