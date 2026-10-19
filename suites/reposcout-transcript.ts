import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { allIn, check, noEmDash } from "../src/checks.ts";
import {
  addUsage,
  emptyUsage,
  type Case,
  type Suite,
  type Usage,
  type VariantOutput,
} from "../src/types.ts";

/**
 * Repo Scout's transcript stage: does a Jev pre-filter on the captions lose any repo or tool, and
 * what does it save? Cases are every video Repo Scout processed with a transcript plus the golden
 * set. Reference truth is what production recorded for the video (its item keys) and the repos
 * linked in the description. Both variants use the production prompt, imported from chief-of-staff,
 * and call the same model path with the same headless flags, so the only difference is the transcript.
 */

const HOME = homedir();
const COS =
  process.env.COS_CHECKOUT ?? join(HOME, "wildcard", "chief-of-staff");
const DATA =
  process.env.WEIGH_SCOUT_STATE ??
  join(import.meta.dir, "..", "data", "reposcout");
const TRANSCRIPTS = join(DATA, "transcripts");

// chief-of-staff is imported by path so the eval and production share one prompt and one filter.
// The shapes below are the slice of its exports this suite uses; typed here so tsc does not check that repo.
type Items = {
  kind: "repo" | "tool";
  name: string;
  url: string | null;
  category: string;
}[];
interface ScoutConfig {
  categories: string[];
  stack: string;
}
interface Core {
  scoutConfig: () => ScoutConfig;
  githubRepos: (text: string) => string[];
  itemKey: (kind: "repo" | "tool", urlOrName: string) => string;
  slug: (s: string) => string;
  Extraction: {
    safeParse: (x: unknown) =>
      | { success: true; data: { format: string; items: Items } }
      | {
          success: false;
          error: { issues: { path: (string | number)[]; message: string }[] };
        };
  };
}
interface RunMod {
  extractPrompt: (
    v: {
      title: string;
      description: string;
      transcript: string;
      channel: string;
    },
    config: ScoutConfig,
  ) => { system: string; user: string };
}
interface Inf {
  HEADLESS_ARGS: string[];
  unwrapEnvelope: (output: string) => {
    text: string;
    usage?: {
      inputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      outputTokens: number;
      costUsd: number;
    };
  };
  extractJson: (text: string) => unknown;
}
interface Filter {
  DEFAULT_FILTER: { threshold: number; chunkChars: number; neighbors: number };
  filterTranscript: (
    text: string,
    opts?: { threshold?: number; chunkChars?: number; neighbors?: number },
  ) => Promise<{
    text: string;
    chunks: number;
    kept: number;
    jevInputTokens: number;
    jevCostUsd: number;
    ms: number;
    fallback?: string;
  }>;
}
interface Sources {
  videoText: (
    url: string,
    wantTranscript: boolean,
  ) => Promise<{
    title: string;
    description: string;
    transcript: string;
    channel: string;
  }>;
}
const core = (await import(join(COS, "src/reposcout/core.ts"))) as Core;
const runMod = (await import(join(COS, "src/reposcout/run.ts"))) as RunMod;
const inf = (await import(join(COS, "src/inference.ts"))) as Inf;
const filter = (await import(join(COS, "src/reposcout/filter.ts"))) as Filter;
const sources = (await import(
  join(COS, "src/reposcout/sources.ts")
)) as Sources;
const pai = (await import(join(HOME, ".claude/PAI/TOOLS/Inference.ts"))) as {
  inference: (o: {
    systemPrompt: string;
    userPrompt: string;
    level: "fast" | "standard" | "smart";
    timeout?: number;
    expectJson?: boolean;
    extraArgs?: string[];
  }) => Promise<{
    success: boolean;
    output: string;
    error?: string;
    latencyMs: number;
  }>;
};

const config = core.scoutConfig();

interface Input {
  id: string;
  title: string;
  channel: string;
  description: string;
  transcript: string;
}
interface Reference {
  linked: string[];
  production: string[];
}

const skipped: { id: string; reason: string }[] = [];

/** Title, description and captions for one video, fetched once through yt-dlp and cached on disk. */
async function videoInput(
  id: string,
  fallbackTitle: string,
  fallbackChannel: string,
  fallbackDescription: string,
): Promise<Input | null> {
  const path = join(TRANSCRIPTS, `${id}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  try {
    const t = await sources.videoText(
      `https://www.youtube.com/watch?v=${id}`,
      true,
    );
    const input: Input = {
      id,
      title: t.title || fallbackTitle,
      channel: t.channel || fallbackChannel,
      description: t.description || fallbackDescription,
      transcript: t.transcript,
    };
    if (!input.transcript) {
      skipped.push({ id, reason: "no captions" });
      return null;
    }
    mkdirSync(TRANSCRIPTS, { recursive: true });
    writeFileSync(path, JSON.stringify(input));
    return input;
  } catch (e) {
    skipped.push({
      id,
      reason: String(e instanceof Error ? e.message : e).slice(0, 120),
    });
    return null;
  }
}

async function cases(): Promise<Case[]> {
  skipped.length = 0;
  const dbPath = join(DATA, "scout.sqlite");
  if (!existsSync(dbPath))
    throw new Error(
      `${dbPath} missing: copy Repo Scout's scout.sqlite there (ssh imac, sqlite3 .backup)`,
    );
  // Not opened read-only: the copy is in WAL mode and SQLite needs to create the -shm file beside it.
  const db = new Database(dbPath);
  const videos = db
    .query(
      "SELECT id,title,channel,COALESCE(description,'') description FROM videos WHERE status='done' ORDER BY published DESC",
    )
    .all() as {
    id: string;
    title: string;
    channel: string;
    description: string;
  }[];
  const golden = JSON.parse(
    readFileSync(join(COS, "evals/reposcout/golden.json"), "utf8"),
  ) as { id: string; channel: string; title: string; description: string }[];
  const seen = new Set(videos.map((v) => v.id));
  const all = [
    ...videos.map((v) => ({ ...v, tag: "production" })),
    ...golden
      .filter((g) => !seen.has(g.id))
      .map((g) => ({ ...g, tag: "golden" })),
  ];
  const out: Case[] = [];
  // Two at a time: YouTube throttles the home IP when fetches pile up.
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < all.length; i = next++) {
      const v = all[i]!;
      const input = await videoInput(v.id, v.title, v.channel, v.description);
      if (!input) continue;
      const production = (
        db
          .query("SELECT item_key FROM sightings WHERE video_id=?")
          .all(v.id) as { item_key: string }[]
      ).map((r) => r.item_key);
      const reference: Reference = {
        linked: core.githubRepos(input.description + "\n" + input.transcript),
        production,
      };
      out[i] = {
        id: v.id,
        input,
        reference,
        tags: [v.tag, `${input.transcript.length} chars`],
      };
    }
  };
  await Promise.all([worker(), worker()]);
  db.close();
  return out.filter(Boolean);
}

/** The production call, replayed: same prompt, same headless flags, the two-attempt retry, usage metered from the CLI envelope. */
async function callModel(
  system: string,
  user: string,
): Promise<{ output: unknown; usage: Usage; attempts: number }> {
  let usage = emptyUsage("claude-cli");
  let lastError = "";
  let raw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    const r = await pai.inference({
      systemPrompt: system,
      userPrompt:
        user +
        (lastError
          ? `\n\nYour previous reply was rejected: ${lastError}. Return valid JSON matching the shape.`
          : ""),
      level: "standard",
      timeout: 300000,
      expectJson: false,
      extraArgs: [...inf.HEADLESS_ARGS, "--output-format", "json"],
    });
    const env = inf.unwrapEnvelope(r.output);
    usage = addUsage(usage, {
      ...emptyUsage("claude-cli"),
      ...(env.usage ?? {}),
      latencyMs: Date.now() - t0,
      calls: 1,
      metered: !!env.usage,
    });
    if (!r.success) {
      lastError = (r.error ?? "no reply").slice(0, 200);
      continue;
    }
    raw = env.text;
    const parsed = core.Extraction.safeParse(inf.extractJson(env.text));
    if (parsed.success)
      return { output: parsed.data, usage, attempts: attempt + 1 };
    lastError = parsed.error.issues
      .slice(0, 3)
      .map((i) => i.path.join(".") + " " + i.message)
      .join("; ");
  }
  return {
    output: { invalid: true, error: lastError, raw: raw.slice(0, 4000) },
    usage,
    attempts: 2,
  };
}

async function runVariant(
  c: Case,
  transcript: string,
  extra: VariantOutput["extra"],
  jev?: Usage,
): Promise<VariantOutput> {
  const input = c.input as Input;
  const { system, user } = runMod.extractPrompt(
    {
      title: input.title,
      description: input.description,
      transcript,
      channel: input.channel,
    },
    config,
  );
  const r = await callModel(system, user);
  // Jev's cost, time and calls count against the variant; its input tokens do not join the model's prompt tokens
  // (the headline compares what the extraction model read) and are reported beside them as jevTokens.
  const usage: Usage = jev
    ? {
        ...r.usage,
        costUsd: r.usage.costUsd + jev.costUsd,
        latencyMs: r.usage.latencyMs + jev.latencyMs,
        calls: r.usage.calls + jev.calls,
        provider: jev.calls ? `${r.usage.provider}+jev` : r.usage.provider,
      }
    : r.usage;
  return { output: r.output, usage, extra: { ...extra, attempts: r.attempts } };
}

/** One filtered variant; `name` and the thresholds are the only differences. */
function jevVariant(name: string, threshold: number, neighbors: number) {
  return {
    name,
    description: `Same prompt and model; the transcript first goes through Jev in ${filter.DEFAULT_FILTER.chunkChars}-character chunks, keeping chunks scored at or above ${threshold}${neighbors ? ` plus ${neighbors} neighbor on each side` : ""} and always the first two.`,
    run: async (c: Case) => {
      const t = (c.input as Input).transcript;
      const f = await filter.filterTranscript(t, { threshold, neighbors });
      const jev: Usage = {
        ...emptyUsage("jev"),
        inputTokens: f.jevInputTokens,
        costUsd: f.jevCostUsd,
        latencyMs: f.ms,
        calls: f.fallback ? 0 : f.chunks,
        metered: true,
      };
      return runVariant(
        c,
        f.text,
        {
          charsBefore: t.length,
          charsAfter: Math.min(f.text.length, 45000),
          chunks: f.chunks,
          kept: f.kept,
          jevTokens: f.jevInputTokens,
          fallback: f.fallback ?? null,
        },
        jev,
      );
    },
  };
}

const items = (o: VariantOutput): Items =>
  (o.output as { items?: Items })?.items ?? [];
const norm = (s: string) => core.slug(s).replace(/-/g, "");

/** A production item key is found when a raw item points at the same repo or tool, without any network lookup. */
export function found(ref: string, its: Items): boolean {
  if (ref.startsWith("gh:")) {
    const [owner, repo] = ref.slice(3).split("/");
    if (!owner || !repo) return false;
    return its.some(
      (i) =>
        (i.url ?? "").toLowerCase().includes(`${owner}/${repo}`) ||
        core.itemKey(i.kind, i.url ?? i.name) === ref ||
        norm(i.name) === norm(repo) ||
        norm(i.name) === norm(`${owner}/${repo}`) ||
        norm(i.name) === norm(`${owner} ${repo}`),
    );
  }
  if (ref.startsWith("web:")) {
    const host = ref.slice(4).split("/")[0]!;
    const brand = host.split(".").slice(-2)[0]!;
    return its.some(
      (i) =>
        (i.url ?? "").toLowerCase().includes(host) ||
        norm(i.name) === norm(brand) ||
        norm(i.name).includes(norm(brand)),
    );
  }
  const name = ref.replace(/^(name|tool):/, "");
  return its.some(
    (i) =>
      norm(i.name) === norm(name) ||
      core.itemKey(i.kind, i.url ?? i.name) === ref,
  );
}

const suite: Suite = {
  name: "reposcout-transcript",
  description:
    "Repo Scout reads YouTube repo channels and lists every repo and tool a video covers. Baseline sends the full captions to the model; the candidates send only the caption chunks Jev says name a tool (jev-filter: at or above 0.5 with one neighbor each side; jev-strict: at or above 0.75, no neighbors).",
  cases,
  skipped: () => [...skipped],
  concurrency: 3,
  inputText: (c) => {
    const i = c.input as Input;
    return `${i.title}\n${i.channel}\n\nDESCRIPTION\n${i.description.slice(0, 1200)}\n\nTRANSCRIPT (${i.transcript.length} chars)\n${i.transcript.slice(0, 2500)}`;
  },
  variants: [
    {
      name: "full",
      description:
        "Production today: description plus the whole transcript (capped at 45,000 characters), one standard-level call with the production prompt.",
      run: (c) => {
        const t = (c.input as Input).transcript;
        return runVariant(c, t, {
          charsBefore: t.length,
          charsAfter: Math.min(t.length, 45000),
        });
      },
    },
    jevVariant(
      "jev-filter",
      filter.DEFAULT_FILTER.threshold,
      filter.DEFAULT_FILTER.neighbors,
    ),
    jevVariant("jev-strict", 0.75, 0),
  ],
  checks: [
    check(
      "json_valid",
      "The reply parsed as the Extraction schema within two attempts",
      (_c, o) => core.Extraction.safeParse(o.output).success,
    ),
    {
      ...check(
        "linked_recall",
        "Every repo linked in the description is named by the model before the merge backfills it",
        (c, o) => {
          const named = new Set(
            items(o).map((i) => core.itemKey(i.kind, i.url ?? i.name)),
          );
          return (c.reference as Reference).linked.every((r) =>
            named.has("gh:" + r),
          );
        },
      ),
      applies: (c) => (c.reference as Reference).linked.length > 0,
    },
    {
      ...check(
        "item_recall",
        "Every repo or tool production recorded for this video appears in this variant's items (matched by URL, key or name, no network)",
        (c, o) =>
          (c.reference as Reference).production.every((k) =>
            found(k, items(o)),
          ),
      ),
      applies: (c) => (c.reference as Reference).production.length > 0,
    },
    allIn(
      "categories_valid",
      "Every item category is in the allowed set",
      config.categories,
      (o) => items(o).map((i) => i.category),
    ),
    noEmDash(),
  ],
  baseline: "full",
  candidate: "jev-strict",
  gate: { maxPassAllDrop: 0, noRegressionOn: ["item_recall", "linked_recall"] },
};

export default suite;
