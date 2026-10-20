import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunStatus } from "../events.ts";
import { buildFrom, type JudgeRecord } from "../report/build.ts";
import { renderHtml } from "../report/html.ts";
import { renderMarkdown } from "../report/md.ts";
import { scrub } from "../scrub.ts";
import type { VariantOutput } from "../types.ts";
import {
  cookieFor,
  type Scope,
  scopes,
  type Tokens,
  tokensFromEnv,
} from "./auth.ts";
import { openDb } from "./db.ts";
import { HttpError, ingest, summarize } from "./ingest.ts";
import { casePage } from "./pages/case.ts";
import { homePage, projectPage } from "./pages/home.ts";
import { runPage } from "./pages/run.ts";
import { type Project, type Run, runKey, Store, TERMINAL } from "./store.ts";
import { Streams } from "./stream.ts";

/**
 * The hub: one Bun.serve, a route table, no framework. Public GETs for public projects, bearer or
 * cookie tokens for everything else. Pages are rendered on the server from the same fragments the
 * static report uses; the only script is the live run module.
 */

export interface HubOptions {
  port?: number;
  hostname?: string;
  dbPath: string;
  tokens?: Tokens;
  webDir?: string;
}

const EVENTS_BODY_CAP = 1 << 20;
const EVENTS_PER_BATCH = 200;
const OUTPUT_GZ_CAP = 1 << 20;
const OUTPUT_RUN_BUDGET = 32 << 20;
const INPUT_CASE_CAP = 16 << 10;
const JSON_CAP = 4 << 20;

const SECURITY = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

type Params = Record<string, string>;
interface Ctx {
  req: Request;
  url: URL;
  params: Params;
  scopes: Set<Scope>;
  ip: string;
}
type Handler = (c: Ctx) => Response | Promise<Response>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const route = (method: string, path: string, handler: Handler): Route => {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:([a-z_]+)/g, (_, k: string) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "$",
  );
  return { method, pattern, keys, handler };
};

export function startHub(o: HubOptions) {
  const tokens = o.tokens ?? tokensFromEnv();
  const store = new Store(openDb(o.dbPath));
  const streams = new Streams();
  const webDir = o.webDir ?? join(import.meta.dir, "..", "..", "web");
  const now = () => new Date().toISOString();

  const html = (
    body: string,
    status = 200,
    extra: Record<string, string> = {},
  ) => {
    return new Response(body, {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...SECURITY,
        ...extra,
      },
    });
  };
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...SECURITY,
      },
    });
  const text = (v: string, status = 200, type = "text/plain; charset=utf-8") =>
    new Response(v, { status, headers: { "content-type": type, ...SECURITY } });
  const need = (c: Ctx, s: Scope) => {
    if (!c.scopes.has(s)) throw new HttpError(401, "unauthorized");
  };
  /** The project, or 404 when it is private and the viewer has no read scope. */
  const visibleProject = (c: Ctx, id: string): Project => {
    const p = store.getProject(id);
    if (!p || (!p.public && !c.scopes.has("read")))
      throw new HttpError(404, "not found");
    return p;
  };
  const visibleRun = (c: Ctx): { project: Project; run: Run } => {
    const run = store.getRun(runKey(c.params.suite!, c.params.run!));
    if (!run) throw new HttpError(404, "not found");
    return { project: visibleProject(c, run.project_id), run };
  };
  const built = (
    run: Run,
    pick: { baseline?: string; candidate?: string } = {},
  ) => {
    if (!run.meta) return undefined;
    const lines = store.traces(run.key);
    if (!lines.length) return undefined;
    return buildFrom(run.meta, lines, store.judges(run.key), pick);
  };
  const readJson = async (c: Ctx, cap = JSON_CAP) => {
    const len = Number(c.req.headers.get("content-length") ?? 0);
    if (len > cap) throw new HttpError(413, "body too large");
    const t = await c.req.text();
    if (t.length > cap) throw new HttpError(413, "body too large");
    try {
      return JSON.parse(t) as unknown;
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
  };
  const agentRun = (c: Ctx): Run => {
    const run = store.getRun(runKey(c.params.suite!, c.params.run!));
    if (!run) throw new HttpError(404, "no such run");
    return run;
  };
  const pickOf = (url: URL) => ({
    baseline: url.searchParams.get("baseline") || undefined,
    candidate: url.searchParams.get("candidate") || undefined,
  });

  const routes: Route[] = [
    route("GET", "/healthz", () => text("ok")),
    route("GET", "/auth", (c) => {
      const t = c.url.searchParams.get("token") ?? "";
      const s = scopes(
        new Request("http://x", { headers: { authorization: `Bearer ${t}` } }),
        tokens,
      );
      if (!s.size) throw new HttpError(401, "unauthorized");
      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": cookieFor(t, c.url.protocol === "https:"),
          ...SECURITY,
        },
      });
    }),
    route("GET", "/web/:file", (c) => {
      const f = c.params.file!;
      if (!/^[a-z0-9._-]+$/i.test(f)) throw new HttpError(404, "not found");
      const p = join(webDir, f);
      if (!existsSync(p)) throw new HttpError(404, "not found");
      const type = f.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : f.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "application/octet-stream";
      return new Response(readFileSync(p), {
        headers: {
          "content-type": type,
          "cache-control": "public, max-age=300",
          ...SECURITY,
        },
      });
    }),

    // pages
    route("GET", "/", (c) =>
      html(
        homePage(
          store
            .listProjects()
            .filter((p) => p.public || c.scopes.has("read"))
            .map((project) => ({
              project,
              suites: store.listSuites(project.id),
              latest: store.listRuns({ project: project.id, limit: 1 })[0],
            })),
          { generatedAt: now() },
        ),
      ),
    ),
    route("GET", "/p/:project", (c) => {
      const p = visibleProject(c, c.params.project!);
      return html(
        projectPage(
          p,
          store.listSuites(p.id),
          store.listRuns({ project: p.id, limit: 100 }),
          { admin: c.scopes.has("admin"), generatedAt: now() },
        ),
      );
    }),
    route("GET", "/r/:suite/:run", (c) => {
      const { project, run } = visibleRun(c);
      const pick = pickOf(c.url);
      return html(
        runPage(project, run, built(run, pick), { pick, generatedAt: now() }),
      );
    }),
    route("GET", "/r/:suite/:run/report.html", (c) => {
      const { run } = visibleRun(c);
      const b = built(run, pickOf(c.url));
      if (!b) throw new HttpError(404, "no comparison yet");
      return html(renderHtml({ ...b, generatedAt: now() }));
    }),
    route("GET", "/r/:suite/:run/summary.md", (c) => {
      const { run } = visibleRun(c);
      const b = built(run, pickOf(c.url));
      if (!b) throw new HttpError(404, "no comparison yet");
      return text(renderMarkdown(b), 200, "text/markdown; charset=utf-8");
    }),
    route("GET", "/r/:suite/:run/traces.jsonl", (c) => {
      const { run } = visibleRun(c);
      return text(
        store
          .traces(run.key)
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
        200,
        "application/x-ndjson; charset=utf-8",
      );
    }),
    route("GET", "/r/:suite/:run/c/:case", (c) => {
      const { project, run } = visibleRun(c);
      const id = decodeURIComponent(c.params.case!);
      const lines = store.tracesFor(run.key, id);
      if (!lines.length) throw new HttpError(404, "no such case");
      const outputs = new Map(
        lines.map((l) => {
          const o = store.getOutput(run.key, l.variant, id);
          if (!o) return [l.variant, undefined];
          const raw = Buffer.from(
            Bun.gunzipSync(o.gz as Uint8Array<ArrayBuffer>),
          ).toString("utf8");
          let output: VariantOutput | undefined;
          try {
            output =
              (JSON.parse(raw) as { output?: VariantOutput }).output ??
              (JSON.parse(raw) as VariantOutput);
          } catch {
            output = { output: raw, usage: l.usage };
          }
          return [l.variant, { output, truncated: o.truncated }];
        }),
      );
      return html(
        casePage(project, run, id, store.inputs(run.key)[id], lines, outputs, {
          generatedAt: now(),
        }),
      );
    }),

    // read API
    route("GET", "/api/projects", (c) =>
      json(
        store
          .listProjects()
          .filter((p) => p.public || c.scopes.has("read"))
          .map((p) => ({
            ...p,
            suites: store.listSuites(p.id).map((s) => ({
              name: s.name,
              description: s.description,
              ...s.info,
            })),
          })),
      ),
    ),
    route("GET", "/api/projects/:project", (c) => {
      const p = visibleProject(c, c.params.project!);
      return json({
        ...p,
        suites: store.listSuites(p.id),
        runs: store.listRuns({ project: p.id, limit: 50 }),
      });
    }),
    route("GET", "/api/runs", (c) => {
      const project = c.url.searchParams.get("project") || undefined;
      const limit = Number(c.url.searchParams.get("limit")) || 50;
      const visible = new Set(
        store
          .listProjects()
          .filter((p) => p.public || c.scopes.has("read"))
          .map((p) => p.id),
      );
      if (project && !visible.has(project))
        throw new HttpError(404, "not found");
      return json(
        store
          .listRuns({ project, limit })
          .filter((r) => visible.has(r.project_id)),
      );
    }),
    route("GET", "/api/runs/:suite/:run", (c) => {
      const { run } = visibleRun(c);
      return json(run);
    }),
    route("GET", "/api/runs/:suite/:run/summary", (c) => {
      const { run } = visibleRun(c);
      const b = built(run, pickOf(c.url));
      if (!b) throw new HttpError(404, "no comparison yet");
      return json({
        cmp: b.cmp,
        gate: b.gate,
        noise: b.noise,
        judges: b.judges,
        meta: b.meta,
      });
    }),
    route("GET", "/api/runs/:suite/:run/traces", (c) => {
      const { run } = visibleRun(c);
      return json(store.traces(run.key));
    }),
    route("GET", "/api/runs/:suite/:run/events", (c) => {
      const { run } = visibleRun(c);
      const since =
        Number(
          c.req.headers.get("last-event-id") ??
            c.url.searchParams.get("since") ??
            0,
        ) || 0;
      return streams.response(store, run.key, since, c.ip);
    }),

    // admin API
    route("POST", "/api/projects", async (c) => {
      need(c, "admin");
      const b = (await readJson(c)) as Partial<Project> & { id?: string };
      if (!b.id || !/^[a-z0-9][a-z0-9-]*$/.test(b.id))
        throw new HttpError(400, "id must be a lowercase slug");
      const p = store.upsertProject({ ...scrub(b), id: b.id });
      return json(p, 201);
    }),

    // agent API (also used by `weigh import`)
    route("POST", "/api/agent/runs", async (c) => {
      if (!c.scopes.has("agent") && !c.scopes.has("admin"))
        throw new HttpError(401, "unauthorized");
      const b = (await readJson(c)) as {
        project?: string;
        suite?: string;
        run_id?: string;
      };
      if (!b.project || !b.suite || !b.run_id)
        throw new HttpError(400, "project, suite and run_id are required");
      if (
        !/^[a-z0-9][a-z0-9-]*$/.test(b.project) ||
        !/^[a-z0-9][a-z0-9-]*$/.test(b.suite) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(b.run_id)
      )
        throw new HttpError(400, "bad identifier");
      store.upsertProject({ id: b.project });
      const key = runKey(b.suite, b.run_id);
      const existing = store.getRun(key);
      if (existing && existing.project_id !== b.project)
        throw new HttpError(409, "run belongs to another project");
      if (!existing)
        store.createRun({
          key,
          project_id: b.project,
          suite: b.suite,
          run_id: b.run_id,
          status: "claimed",
        });
      return json({ key, created: !existing }, existing ? 200 : 201);
    }),
    route("POST", "/api/agent/runs/:suite/:run/events", async (c) => {
      if (!c.scopes.has("agent") && !c.scopes.has("admin"))
        throw new HttpError(401, "unauthorized");
      const run = agentRun(c);
      const b = (await readJson(c, EVENTS_BODY_CAP)) as { events?: unknown[] };
      if (!Array.isArray(b.events) || b.events.length > EVENTS_PER_BATCH)
        throw new HttpError(
          400,
          `events must be an array of at most ${EVENTS_PER_BATCH}`,
        );
      const r = ingest(store, streams, run.key, b.events, "runner");
      return json({ accepted: r.accepted, last_src_seq: r.last_src_seq });
    }),
    route(
      "PUT",
      "/api/agent/runs/:suite/:run/outputs/:variant/:case",
      async (c) => {
        if (!c.scopes.has("agent") && !c.scopes.has("admin"))
          throw new HttpError(401, "unauthorized");
        const run = agentRun(c);
        const gz = new Uint8Array(await c.req.arrayBuffer());
        if (gz.length > OUTPUT_GZ_CAP)
          throw new HttpError(413, "output too large");
        if (store.outputBytes(run.key) + gz.length > OUTPUT_RUN_BUDGET)
          throw new HttpError(413, "run output budget exceeded");
        try {
          Bun.gunzipSync(gz);
        } catch {
          throw new HttpError(400, "body must be gzip");
        }
        store.putOutput(
          run.key,
          decodeURIComponent(c.params.variant!),
          decodeURIComponent(c.params.case!),
          {
            output_hash: c.req.headers.get("x-output-hash") ?? "",
            gz,
            raw_bytes: Number(c.req.headers.get("x-raw-bytes") ?? 0) || 0,
            truncated: c.req.headers.get("x-truncated") === "1",
          },
        );
        return new Response(null, { status: 204, headers: SECURITY });
      },
    ),
    route("PUT", "/api/agent/runs/:suite/:run/inputs", async (c) => {
      if (!c.scopes.has("agent") && !c.scopes.has("admin"))
        throw new HttpError(401, "unauthorized");
      const run = agentRun(c);
      const b = (await readJson(c)) as Record<string, unknown>;
      const texts: Record<string, string> = {};
      for (const [k, v] of Object.entries(b))
        if (typeof v === "string") texts[k] = scrub(v).slice(0, INPUT_CASE_CAP);
      store.putInputs(run.key, texts);
      return json({ stored: Object.keys(texts).length });
    }),
    route("PUT", "/api/agent/runs/:suite/:run/judges", async (c) => {
      if (!c.scopes.has("agent") && !c.scopes.has("admin"))
        throw new HttpError(401, "unauthorized");
      const run = agentRun(c);
      const b = (await readJson(c)) as { records?: JudgeRecord[] };
      const records = (b.records ?? []).filter(
        (j) => j && typeof j.check === "string" && Array.isArray(j.splits),
      );
      const before = JSON.stringify(store.judges(run.key));
      store.putJudges(run.key, scrub(records));
      if (JSON.stringify(store.judges(run.key)) !== before)
        ingestSummary(run.key);
      return json({ stored: records.length });
    }),
    route("POST", "/api/agent/runs/:suite/:run/finish", async (c) => {
      if (!c.scopes.has("agent") && !c.scopes.has("admin"))
        throw new HttpError(401, "unauthorized");
      const run = agentRun(c);
      const b = (await readJson(c)) as { status?: RunStatus };
      const status = b.status && TERMINAL.has(b.status) ? b.status : "finished";
      if (run.status !== status) {
        store.updateRun(run.key, {
          status,
          finished_at: run.finished_at ?? now(),
          lease_until: null,
        });
        const e = store.insertEvent(run.key, "hub", run.last_seq + 1, {
          type: "status",
          status,
          agent_id: run.agent_id,
          seq: 1,
          at: now(),
        });
        if (e) streams.broadcast(run.key, [e]);
      }
      return json({ status });
    }),
  ];

  /** Judges arriving after the traces change the report, so the summary is rebuilt and announced. */
  function ingestSummary(key: string) {
    const e = summarize(store, key);
    if (e) streams.broadcast(key, [e]);
  }

  const server = Bun.serve({
    port: o.port ?? 8787,
    hostname: o.hostname ?? "0.0.0.0",
    development: false,
    idleTimeout: 255,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      const ip =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        srv.requestIP(req)?.address ||
        "?";
      const c: Ctx = { req, url, params: {}, scopes: scopes(req, tokens), ip };
      try {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.pattern);
          if (!m) continue;
          r.keys.forEach((k, i) => (c.params[k] = m[i + 1]!));
          return await r.handler(c);
        }
        if (url.pathname === "/mcp" && req.method === "GET")
          return text("method not allowed", 405);
        throw new HttpError(404, "not found");
      } catch (e) {
        if (e instanceof HttpError) {
          return url.pathname.startsWith("/api/") || e.status === 401
            ? json({ error: e.message }, e.status)
            : html(errorPage(e.status, e.message), e.status);
        }
        console.error(
          `${req.method} ${url.pathname}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
        );
        return json({ error: "internal error" }, 500);
      }
    },
  });
  return {
    server,
    store,
    streams,
    url: `http://${server.hostname === "0.0.0.0" ? "127.0.0.1" : server.hostname}:${server.port}`,
    stop: () => {
      server.stop(true);
      store.db.close();
    },
  };
}

function errorPage(status: number, message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${status}</title></head><body style="font-family:system-ui;padding:40px"><h1>${status}</h1><p>${message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</p><p><a href="/">Weigh</a></p></body></html>`;
}

if (import.meta.main) {
  const h = startHub({
    port: Number(process.env.PORT) || 8787,
    dbPath: process.env.WEIGH_DB ?? join(process.cwd(), "data", "weigh.db"),
  });
  console.error(`weigh hub listening on ${h.url}`);
}
