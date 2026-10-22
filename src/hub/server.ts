import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunStatus } from "../events.ts";
import { newRunId } from "../run.ts";
import { buildFrom, checkedJudges, type JudgeRecord } from "../report/build.ts";
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
import { runFragments, verdictSummary } from "./pages/run-sections.ts";
import { renderVerdictPng } from "./og.ts";
import {
  publicOrigin,
  readPublicOrigin,
  shareControls,
  shareUrls,
} from "./share.ts";
import { type Project, type Run, runKey, Store, TERMINAL } from "./store.ts";
import { Streams } from "./stream.ts";
import { handleMcp } from "./mcp.ts";
import { type LabelRow, SPLITS, validate } from "../judge.ts";
import { readAnalyticsSite, withAnalytics } from "./pages/layout.ts";
import { labelsPage } from "./pages/labels.ts";
import { scopesOf } from "./auth.ts";
import { textRuleReason } from "../suite-text.ts";

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
const LEASE_MS = 90_000;
const CLAIM_POLL_MS = 500;

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

function decodePathParam(value: string, name: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError)
      throw new HttpError(400, `malformed ${name} in path`);
    throw error;
  }
}

export function startHub(o: HubOptions) {
  const analyticsSite = readAnalyticsSite();
  const configuredOrigin = readPublicOrigin();
  const tokens = o.tokens ?? tokensFromEnv();
  const store = new Store(openDb(o.dbPath));
  const streams = new Streams();
  const webDir = o.webDir ?? join(import.meta.dir, "..", "..", "web");
  const now = () => new Date().toISOString();
  // Sequence identifies a snapshot; selected comparisons stay separate within it.
  const images = new Map<string, Map<string, Uint8Array>>();

  const html = (
    body: string,
    status = 200,
    extra: Record<string, string> = {},
    track = false,
  ) => {
    const security = { ...SECURITY };
    // Only public reader pages opt in. Owner pages and private projects never load the tracker.
    const site = track ? analyticsSite : undefined;
    if (site && status >= 200 && status < 300)
      security["content-security-policy"] = security["content-security-policy"]
        .replace(
          "script-src 'self';",
          "script-src 'self' https://www.staats.ai;",
        )
        .replace(
          "connect-src 'self';",
          "connect-src 'self' https://api.staats.ai;",
        );
    return new Response(withAnalytics(body, site, status), {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...security,
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
  const labelRows = (input: unknown) => {
    if (!Array.isArray(input))
      throw new HttpError(400, "labels must be an array");
    const rows = input.filter(
      (
        r,
      ): r is {
        case_id: string;
        variant: string;
        human: "pass" | "fail";
        note?: string;
        split?: unknown;
      } =>
        !!r &&
        typeof r === "object" &&
        typeof (r as { case_id?: unknown }).case_id === "string" &&
        typeof (r as { variant?: unknown }).variant === "string" &&
        ((r as { human?: unknown }).human === "pass" ||
          (r as { human?: unknown }).human === "fail"),
    );
    // An unknown split would show up as its own bucket, and "all" would count rows twice.
    const normalized = rows.map(({ split, ...row }) => {
      if (split == null) return row;
      if (typeof split !== "string" || !SPLITS.includes(split))
        throw new HttpError(400, "split must be train, dev or test");
      return { ...row, split };
    });
    return scrub(normalized);
  };
  /** The review page's write: a person's label replaces the stored one. */
  const storeLabels = (
    run: Run,
    input: unknown,
  ): { stored: number; total: number } => {
    const rows = labelRows(input);
    store.upsertLabels(run, rows);
    return { stored: rows.length, total: store.labels(run.key).length };
  };
  /** The agent's write: it only fills cases nobody has labelled, so a person's label is never overwritten. */
  const insertLabels = (
    run: Run,
    input: unknown,
  ): { inserted: number; skipped: number; total: number } => {
    const rows = labelRows(input);
    const inserted = store.insertLabels(run, rows);
    return {
      inserted,
      skipped: rows.length - inserted,
      total: store.labels(run.key).length,
    };
  };
  const validateJudge = (run: Run, check: string | undefined): JudgeRecord => {
    if (!check || !run.meta?.checks.some((x) => x.id === check))
      throw new HttpError(400, "check must name a check of this run");
    const labels = store.labels(run.key);
    if (!labels.length) throw new HttpError(409, "no labels on this run");
    const byKey = new Map(
      store.traces(run.key).map((l) => [`${l.variant}\u0000${l.case_id}`, l]),
    );
    const result = validate(labels as unknown as LabelRow[], (r) => {
      const v = byKey.get(
        `${r.variant ?? run.meta!.candidate}\u0000${r.case_id}`,
      )?.checks[check];
      return v === undefined ? undefined : v ? "pass" : "fail";
    });
    // A record that joined nothing would render as a validated grader with an empty table.
    if (result.joined === 0)
      throw new HttpError(
        409,
        `no label matched a verdict of ${check}; nothing stored`,
      );
    const record = {
      ...result,
      check,
      labels: `hub:${run.key} (${labels.length} labels)`,
      at: now(),
    };
    store.putJudges(run.key, [record]);
    ingestSummary(run.key);
    return record;
  };
  const needRunOwner = (c: Ctx, run: Run, agentId: unknown): void => {
    if (c.scopes.has("admin")) return;
    if (typeof agentId !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(agentId))
      throw new HttpError(400, "agent_id must be a slug");
    if (!run.agent_id || run.agent_id !== agentId)
      throw new HttpError(403, "run belongs to another agent");
  };

  const pickOf = (url: URL) => ({
    baseline: url.searchParams.get("baseline") || undefined,
    candidate: url.searchParams.get("candidate") || undefined,
  });
  const sharePick = (run: Run, url: URL) => {
    const pick = pickOf(url);
    for (const role of ["baseline", "candidate"] as const) {
      if (!run.meta?.variants.some((v) => v.name === pick[role]))
        delete pick[role];
    }
    return pick;
  };

  async function mcp(c: Ctx, s: Set<Scope>): Promise<Response> {
    if (!s.has("read")) throw new HttpError(401, "unauthorized");
    const body = (await readJson(c, 256 << 10)) as
      | Record<string, unknown>
      | Record<string, unknown>[];
    const answer = (m: Record<string, unknown>) => handleMcp(store, m);
    if (Array.isArray(body)) {
      const out = body
        .map(answer)
        .filter((x): x is Record<string, unknown> => !!x);
      return out.length
        ? json(out)
        : new Response(null, { status: 202, headers: SECURITY });
    }
    const r = answer(body);
    return r ? json(r) : new Response(null, { status: 202, headers: SECURITY });
  }

  /** Which projects each registered agent can run; rebuilt by every register call. */
  const agentProjects = new Map<string, string[]>();
  const sweep = setInterval(() => {
    for (const r of store.expiredLeases()) {
      store.updateRun(r.key, { status: "lost" });
      const e = store.insertEvent(r.key, "hub", r.last_seq + 1, {
        type: "status",
        status: "lost",
        agent_id: r.agent_id,
        seq: 1,
        at: now(),
      });
      if (e) streams.broadcast(r.key, [e]);
    }
  }, 30_000);

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
    route("GET", "/latest", () => {
      const run = store.latestFinishedRun(
        store
          .listProjects()
          .filter((p) => p.public)
          .map((p) => p.id),
      );
      if (!run) return text("No finished run yet.", 404);
      return new Response(null, {
        status: 302,
        headers: {
          location: `/r/${encodeURIComponent(run.suite)}/${encodeURIComponent(run.run_id)}`,
          "cache-control": "no-store",
          ...SECURITY,
        },
      });
    }),
    route("GET", "/", (c) =>
      html(
        homePage(store, {
          generatedAt: now(),
          includePrivate: c.scopes.has("read"),
        }),
        200,
        {},
        true,
      ),
    ),
    route("GET", "/p/:project", (c) => {
      const p = visibleProject(c, c.params.project!);
      return html(
        projectPage(
          p,
          store.listSuites(p.id),
          store.listRuns({ project: p.id, limit: 100 }),
          { admin: c.scopes.has("admin"), generatedAt: now(), store },
        ),
        200,
        {},
        p.public,
      );
    }),
    route("GET", "/r/:suite/:run", (c) => {
      const { project, run } = visibleRun(c);
      const pick = sharePick(run, c.url);
      return html(
        runPage(project, run, built(run, pick), {
          pick,
          generatedAt: now(),
          origin: publicOrigin(c.req, c.url, configuredOrigin),
        }),
        200,
        {},
        project.public,
      );
    }),
    route("GET", "/r/:suite/:run/og\\.png", (c) => {
      // Check visibility before looking in the cache, including after a project becomes private.
      const { run } = visibleRun(c);
      const pick = sharePick(run, c.url);
      const key = JSON.stringify([run.key, run.last_seq, run.status]);
      const comparison = JSON.stringify([
        pick.baseline ?? run.meta?.baseline,
        pick.candidate ?? run.meta?.candidate,
      ]);
      // Keyed on status as well: updateRun can change status without inserting an event.
      let png = images.get(key)?.get(comparison);
      if (!png) {
        png = renderVerdictPng(verdictSummary(run, built(run, pick)));
        if (!images.has(key)) {
          if (images.size >= 32) images.delete(images.keys().next().value!);
          images.set(key, new Map());
        }
        const comparisons = images.get(key)!;
        if (comparisons.size >= 8)
          comparisons.delete(comparisons.keys().next().value!);
        comparisons.set(comparison, png);
      }
      return new Response(Buffer.from(png), {
        headers: {
          "content-type": "image/png",
          "cache-control": "private, no-store",
          ...SECURITY,
        },
      });
    }),
    route("GET", "/r/:suite/:run/fragments", (c) => {
      const { run } = visibleRun(c);
      const b = built(run, sharePick(run, c.url));
      return json({
        ...runFragments(run, b),
        share: shareControls(
          run,
          b,
          shareUrls(run, b, publicOrigin(c.req, c.url, configuredOrigin)).link,
        ),
        status: run.status,
        finished: run.finished,
        total: run.total,
      });
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
          // Stored as the VariantOutput itself (what readOutput returns), never the cache file's wrapper.
          let output: VariantOutput | undefined;
          try {
            output = JSON.parse(raw) as VariantOutput;
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
        200,
        {},
        project.public,
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
        judges: checkedJudges(b.judges),
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
      // Name and description are shown on public pages, so they follow the suite text rule.
      for (const field of ["name", "description"] as const) {
        const value = b[field];
        if (value === undefined) continue;
        if (typeof value !== "string")
          throw new HttpError(400, `${field} must be a string`);
        const reason = textRuleReason(value);
        if (reason)
          throw new HttpError(
            400,
            `${field} ${reason}; rewrite it (project text may not contain an en dash or em dash or a number followed by "+")`,
          );
      }
      const p = store.upsertProject({ ...scrub(b), id: b.id });
      return json(p, 201);
    }),

    // labels and judge validation
    route("GET", "/r/:suite/:run/labels", (c) => {
      const { project, run } = visibleRun(c);
      if (!c.scopes.has("admin"))
        throw new HttpError(
          401,
          "sign in with the admin token (/auth?token=...) to label",
        );
      const lines = store.traces(run.key);
      return html(
        labelsPage(
          project,
          run,
          lines,
          store.inputs(run.key),
          store.labels(run.key),
          { generatedAt: now() },
        ),
      );
    }),
    route("GET", "/api/runs/:suite/:run/labels", (c) => {
      const { run } = visibleRun(c);
      return json(store.labels(run.key));
    }),
    route("PUT", "/api/runs/:suite/:run/labels", async (c) => {
      need(c, "admin");
      const run = agentRun(c);
      const b = (await readJson(c)) as { labels?: unknown };
      return json(storeLabels(run, b.labels ?? []));
    }),
    route("DELETE", "/api/runs/:suite/:run/labels/:case/:variant", (c) => {
      need(c, "admin");
      const run = agentRun(c);
      store.deleteLabel(
        run.key,
        decodePathParam(c.params.case!, "case"),
        decodePathParam(c.params.variant!, "variant"),
      );
      return json({ ok: true });
    }),
    route("POST", "/api/runs/:suite/:run/judges/validate", async (c) => {
      need(c, "admin");
      const run = agentRun(c);
      const b = (await readJson(c)) as { check?: string };
      return json(validateJudge(run, b.check));
    }),
    route("DELETE", "/api/runs/:suite/:run/judges/:check", (c) => {
      need(c, "admin");
      const run = agentRun(c);
      const removed = store.deleteJudge(
        run.key,
        decodePathParam(c.params.check!, "check"),
      );
      if (removed > 0) ingestSummary(run.key);
      return json({ ok: true, removed });
    }),

    // MCP: JSON-RPC over POST, read scope by bearer or by path token
    route("POST", "/mcp", (c) => mcp(c, c.scopes)),
    route("POST", "/mcp/:token", (c) =>
      mcp(c, scopesOf(decodeURIComponent(c.params.token!), tokens)),
    ),

    // admin: enqueue, cancel, retry
    route("POST", "/api/runs", async (c) => {
      need(c, "admin");
      const form = (c.req.headers.get("content-type") ?? "").includes(
        "application/x-www-form-urlencoded",
      );
      const b = form
        ? (Object.fromEntries((await c.req.formData()).entries()) as Record<
            string,
            string
          >)
        : ((await readJson(c)) as Record<string, unknown>);
      const project = String(b.project ?? "");
      const suite = String(b.suite ?? "");
      const p = store.getProject(project);
      const s = p && store.suite(project, suite);
      if (!p || !s)
        throw new HttpError(
          404,
          "no such project or suite (the agent registers suites)",
        );
      const runId = String(b.run_id || newRunId());
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId))
        throw new HttpError(400, "bad run_id");
      const list = (v: unknown) =>
        typeof v === "string"
          ? v
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean)
          : Array.isArray(v)
            ? v.map(String)
            : undefined;
      const options: Record<string, unknown> = {};
      const variants = list(b.variants);
      const cases = list(b.cases);
      if (variants?.length) options.variants = variants;
      if (cases?.length) options.cases = cases;
      if (b.concurrency) options.concurrency = Number(b.concurrency);
      const key = runKey(suite, runId);
      if (store.getRun(key)) throw new HttpError(409, "run id already exists");
      const run = store.createRun({
        key,
        project_id: project,
        suite,
        run_id: runId,
        status: "queued",
        options,
      });
      const e = store.insertEvent(key, "hub", 1, {
        type: "status",
        status: "queued",
        seq: 1,
        at: now(),
      });
      if (e) streams.broadcast(key, [e]);
      if (form)
        return new Response(null, {
          status: 303,
          headers: { location: `/r/${suite}/${runId}`, ...SECURITY },
        });
      return json(run, 201);
    }),
    route("POST", "/api/runs/:suite/:run/cancel", (c) => {
      need(c, "admin");
      const run = agentRun(c);
      if (TERMINAL.has(run.status))
        throw new HttpError(409, `run is ${run.status}`);
      if (run.status === "queued") {
        store.updateRun(run.key, { status: "cancelled", finished_at: now() });
        const e = store.insertEvent(run.key, "hub", run.last_seq + 1, {
          type: "status",
          status: "cancelled",
          seq: 1,
          at: now(),
        });
        if (e) streams.broadcast(run.key, [e]);
        return json({ status: "cancelled" });
      }
      store.updateRun(run.key, { cancel_requested: true });
      return json({ status: run.status, cancel_requested: true });
    }),
    route("POST", "/api/runs/:suite/:run/retry", (c) => {
      need(c, "admin");
      const run = agentRun(c);
      if (!TERMINAL.has(run.status) && run.status !== "lost")
        throw new HttpError(409, `run is ${run.status}`);
      store.updateRun(run.key, {
        status: "queued",
        agent_id: null,
        lease_until: null,
        cancel_requested: false,
        finished_at: null,
      });
      const e = store.insertEvent(run.key, "hub", run.last_seq + 1, {
        type: "status",
        status: "queued",
        seq: 1,
        at: now(),
      });
      if (e) streams.broadcast(run.key, [e]);
      return json({ status: "queued" });
    }),

    // agent: register, claim, heartbeat
    route("POST", "/api/agent/register", async (c) => {
      if (!c.scopes.has("agent") && !c.scopes.has("admin"))
        throw new HttpError(401, "unauthorized");
      const b = (await readJson(c)) as {
        agent_id?: string;
        version?: string;
        projects?: {
          id: string;
          suites?: {
            name: string;
            path: string;
            description?: string;
            info?: Record<string, unknown>;
          }[];
        }[];
      };
      if (!b.agent_id || !/^[a-z0-9][a-z0-9-]*$/.test(b.agent_id))
        throw new HttpError(400, "agent_id must be a slug");
      let suites = 0;
      for (const p of b.projects ?? []) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(p.id)) continue;
        store.upsertProject({ id: p.id });
        for (const s of p.suites ?? []) {
          if (
            !/^[a-z0-9][a-z0-9-]*$/.test(s.name) ||
            !s.path ||
            s.path.includes("..")
          )
            continue;
          store.upsertSuite({
            project_id: p.id,
            name: s.name,
            description: scrub(s.description ?? ""),
            path: s.path,
            info: scrub(s.info ?? {}),
          });
          suites++;
        }
      }
      agentProjects.set(
        b.agent_id,
        (b.projects ?? []).map((p) => p.id),
      );
      store.touchAgent(b.agent_id, scrub(b.version ?? ""), null);
      return json({ projects: (b.projects ?? []).length, suites });
    }),
    route("GET", "/api/agent/jobs", async (c) => {
      if (!c.scopes.has("agent") && !c.scopes.has("admin"))
        throw new HttpError(401, "unauthorized");
      const agent = c.url.searchParams.get("agent") ?? "";
      const projects = agentProjects.get(agent);
      if (!projects) throw new HttpError(409, "register first");
      const wait =
        Math.min(Number(c.url.searchParams.get("wait")) || 0, 50) * 1000;
      const until = Date.now() + wait;
      for (;;) {
        const run = store.claimNext(agent, projects, LEASE_MS);
        if (run) {
          store.touchAgent(agent, "", run.key);
          const s = store.suite(run.project_id, run.suite);
          const e = store.insertEvent(run.key, "hub", run.last_seq + 1, {
            type: "status",
            status: "claimed",
            agent_id: agent,
            seq: 1,
            at: now(),
          });
          if (e) streams.broadcast(run.key, [e]);
          return json({
            key: run.key,
            project_id: run.project_id,
            suite: run.suite,
            run_id: run.run_id,
            suite_path: s?.path ?? "",
            options: run.options,
            src_seq_base: run.last_src_seq,
          });
        }
        if (Date.now() >= until)
          return new Response(null, { status: 204, headers: SECURITY });
        await Bun.sleep(CLAIM_POLL_MS);
      }
    }),
    route("POST", "/api/agent/runs/:suite/:run/heartbeat", async (c) => {
      if (!c.scopes.has("agent") && !c.scopes.has("admin"))
        throw new HttpError(401, "unauthorized");
      const run = agentRun(c);
      await readJson(c).catch(() => ({}));
      const status: RunStatus =
        run.status === "lost" || run.status === "claimed"
          ? "running"
          : run.status;
      store.updateRun(run.key, {
        lease_until: new Date(Date.now() + LEASE_MS).toISOString(),
        status,
      });
      if (status !== run.status) {
        const e = store.insertEvent(run.key, "hub", run.last_seq + 1, {
          type: "status",
          status,
          agent_id: run.agent_id,
          seq: 1,
          at: now(),
        });
        if (e) streams.broadcast(run.key, [e]);
      }
      return json({ cancel: run.cancel_requested });
    }),

    /** Admins or agents on their own claimed run may add human labels; existing rows are left untouched. */
    route("PUT", "/api/agent/runs/:suite/:run/labels", async (c) => {
      if (!c.scopes.has("agent") && !c.scopes.has("admin"))
        throw new HttpError(401, "unauthorized");
      const run = agentRun(c);
      const b = (await readJson(c)) as {
        agent_id?: unknown;
        labels?: unknown;
      };
      needRunOwner(c, run, b.agent_id);
      return json(insertLabels(run, b.labels ?? []));
    }),
    /** Admins or agents on their own claimed run may validate its judges. */
    route("POST", "/api/agent/runs/:suite/:run/judges/validate", async (c) => {
      if (!c.scopes.has("agent") && !c.scopes.has("admin"))
        throw new HttpError(401, "unauthorized");
      const run = agentRun(c);
      const b = (await readJson(c)) as { agent_id?: unknown; check?: string };
      needRunOwner(c, run, b.agent_id);
      return json(validateJudge(run, b.check));
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
      const b = (await readJson(c, EVENTS_BODY_CAP)) as {
        events?: unknown[];
        source?: string;
      };
      if (!Array.isArray(b.events) || b.events.length > EVENTS_PER_BATCH)
        throw new HttpError(
          400,
          `events must be an array of at most ${EVENTS_PER_BATCH}`,
        );
      const r = ingest(
        store,
        streams,
        run.key,
        b.events,
        b.source === "agent" ? "agent" : "runner",
      );
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
      const kept = records.filter(
        (j) => typeof j.joined === "number" && j.joined > 0,
      );
      const dropped = records
        .filter((j) => !kept.includes(j))
        .map((j) => j.check);
      const before = JSON.stringify(store.judges(run.key));
      store.putJudges(run.key, scrub(kept));
      if (JSON.stringify(store.judges(run.key)) !== before)
        ingestSummary(run.key);
      return json(
        dropped.length
          ? {
              stored: kept.length,
              dropped,
              warn: `dropped ${dropped.length} judge record(s) that joined no human label: ${dropped.join(", ")}`,
            }
          : { stored: kept.length },
      );
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
      // This hub always serves TCP; Bun's types also cover Unix sockets.
      const url = requestUrl(req.url, bindBase(srv.hostname!, srv.port!));
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
    url: bindBase(
      server.hostname === "0.0.0.0"
        ? "127.0.0.1"
        : server.hostname === "::"
          ? "::1"
          : server.hostname!,
      server.port!,
    ),
    stop: () => {
      clearInterval(sweep);
      server.stop(true);
      store.db.close();
    },
  };
}

/** IPv6 literals need brackets when used as the authority of a URL. */
export function bindBase(hostname: string, port: number): string {
  const host =
    hostname.includes(":") && !hostname.startsWith("[")
      ? `[${hostname}]`
      : hostname;
  return `http://${host}:${port}`;
}

/** A malformed Host header makes Bun hand over an unparsable absolute URL. Keep the path, drop the host. */
export function requestUrl(raw: string, base: string): URL {
  try {
    return new URL(raw, base);
  } catch {
    const path = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^\/]*/i, "");
    return new URL(path.startsWith("/") ? path : `/${path}`, base);
  }
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
