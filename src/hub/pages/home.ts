import { esc } from "../../report/html.ts";
import { buildFrom, type Built, type JudgeRecord } from "../../report/build.ts";
import type { Project, Run, Store, SuiteRow } from "../store.ts";
import { page, statusTag, when } from "./layout.ts";
import { verdictSummary } from "./run-sections.ts";
import { plainSummary } from "../share.ts";
import { timelineSchema } from "../../timeline.ts";

/** The landing uses the same stored comparison and verdict wording as the run page. */
export function homePage(
  store: Store,
  opts: { generatedAt?: string; includePrivate?: boolean } = {},
): string {
  const projects = store
    .listProjects()
    .filter((p) => p.public || opts.includePrivate);
  const latest = store.latestFinishedRun(projects.map((p) => p.id));
  const judges = latest ? store.judges(latest.key) : [];
  const built = latest ? featuredBuild(store, latest, judges) : undefined;
  const href = latest
    ? `/r/${encodeURIComponent(latest.suite)}/${encodeURIComponent(latest.run_id)}`
    : undefined;
  // The graders were validated against the labels each judge record joined, not the hub's table.
  const checked = Math.max(0, ...judges.map((j) => j.joined));
  const labels = latest ? store.labelCount(latest.key) : 0;
  const finishedAt = latest?.finished_at ?? latest?.meta?.finished_at;
  // finished_at is agent-supplied text; an unparseable value must not take the landing page down.
  const finishedDate = finishedAt ? new Date(finishedAt) : undefined;
  const finishedUtc =
    finishedDate && !Number.isNaN(finishedDate.getTime())
      ? finishedDate.toISOString()
      : undefined;
  const cards = projects
    .map((project) => {
      const suites = store.listSuites(project.id);
      const run = store.listRuns({ project: project.id, limit: 1 })[0];
      return `<a class="card" href="/p/${esc(encodeURIComponent(project.id))}"><h3>${landingText(project.name)}</h3><p>${landingText(project.description || (suites.length ? suites.map((s) => s.name).join(", ") : "No suites registered yet."))}</p>
<div class="row"><span>${run ? statusTag(run.status) : "No runs yet."}</span><span class="mono">${run ? when(run.requested_at) : ""}</span></div>${project.public ? "" : '<span class="tag">private</span>'}</a>`;
    })
    .join("");
  const icon = (paths: string) =>
    `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  const body = `<main class="landing">
<h1 class="page display">Watch an AI get graded.</h1>
<p class="lede">Weigh runs a new prompt against the old one on real cases, grades every answer, and shows the result as it happens. Built by Kyle Bartlett.</p>
${latest ? `<article class="card latest-verdict" data-section="latest-verdict"><h2 class="label">Latest verdict</h2><p class="landing-story">${verdictSummary(latest, built).story}</p><a href="${esc(href!)}">watch the run</a></article>` : '<p class="empty">No finished run yet. The verdict will appear here when one finishes.</p>'}
<section><h2 class="display">How it works</h2><ol class="landing-steps">
<li>${icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18M10 12l5 3-5 3z"/>')}<p>Queue a run from the browser.</p></li>
<li>${icon('<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8M12 17v4M7 10l3 3 7-7"/>')}<p>Watch cases grade themselves live from an always-on machine.</p></li>
<li>${icon('<path d="M14 2H5v20h14V7zM14 2v5h5M8 12h8M8 16h5"/>')}<p>Read the verdict and open any case to see what the model said.</p></li>
</ol></section>
<section><div class="sec-head"><h2 class="display">Why it matters</h2><p>An AI that reads emails and makes decisions will be wrong sometimes. The question is whether you find out first. This is how.</p></div></section>
<div class="trust-strip" aria-label="Run evidence">
${latest ? `<span>${finishedUtc ? `Last run <time class="mono" datetime="${esc(finishedUtc)}">${when(finishedUtc)} UTC</time>` : "Finish date not recorded."}</span><span>${built && built.cmp.candidate.n > 0 ? `${built.cmp.candidate.n} cases` : "Case count not available."}</span><span>${checked ? `graders checked against ${checked} human labels` : labels ? `${labels} human labels recorded; graders not checked yet.` : "No human labels recorded for this run."}</span>` : ""}
<a href="https://github.com/kyle-bartlett/weigh">Public code</a></div>
<div class="landing-actions">${href ? `<a class="btn primary" href="${esc(href)}">Watch a run</a>` : '<button class="btn primary" type="button" disabled aria-disabled="true">Watch a run</button>'}<a class="btn" href="mailto:kyle@bartlettlabs.io">Talk to Kyle</a></div>
<section id="projects"><div class="sec-head"><h2 class="display">Projects</h2><p>Open a project for its suites, runs and every case behind the verdict.</p></div>${cards ? `<div class="cards">${cards}</div>` : '<p class="empty">Nothing public yet.</p>'}</section>
</main>`;
  return page({ title: "Weigh", body, generatedAt: opts.generatedAt });
}

const landingText = (text: string) => esc(text);

/** Same no-traces rule as the run page. A malformed stored meta must not take down `/`. */
function safeBuild(store: Store, run: Run, judges: JudgeRecord[]) {
  if (!run.meta) return undefined;
  const lines = store.traces(run.key);
  if (!lines.length) return undefined;
  try {
    return buildFrom(run.meta, lines, judges);
  } catch {
    return undefined;
  }
}

/**
 * A build reads meta, traces and judges. Each one changes only by appending an event (run_start,
 * job_done, the summary putJudges triggers), which moves last_seq; status covers the finish route.
 */
const snapshotOf = (r: Run): string => JSON.stringify([r.last_seq, r.status]);

/**
 * `/` is the most visited public URL, and building the featured comparison rereads every trace.
 * Keep the build per run snapshot, using the same key as the sentence cache. Only the current
 * latest run is ever read again, and a Built holds every trace line, so the cap stays small.
 */
const FEATURED_CACHE_MAX = 4;
const featuredBuilds = new WeakMap<
  Store,
  Map<string, { snapshot: string; built: Built | undefined }>
>();
function featuredBuild(
  store: Store,
  run: Run,
  judges: JudgeRecord[],
): Built | undefined {
  let cache = featuredBuilds.get(store);
  if (!cache) featuredBuilds.set(store, (cache = new Map()));
  const snapshot = snapshotOf(run);
  const hit = cache.get(run.key);
  if (hit?.snapshot === snapshot) return hit.built;
  const built = safeBuild(store, run, judges);
  if (cache.size >= FEATURED_CACHE_MAX) cache.clear();
  cache.set(run.key, { snapshot, built });
  return built;
}

/**
 * A sentence needs the run's traces. The list shows up to 100 runs on a public route, so each
 * sentence is kept per run snapshot (same key as the share image) instead of rebuilt per view.
 */
const sentences = new WeakMap<
  Store,
  Map<string, { snapshot: string; sentence: string }>
>();
function runSentence(store: Store | undefined, r: Run): string {
  if (!store) return plainSummary(verdictSummary(r, undefined).sentence);
  let cache = sentences.get(store);
  if (!cache) sentences.set(store, (cache = new Map()));
  const snapshot = snapshotOf(r);
  const hit = cache.get(r.key);
  if (hit?.snapshot === snapshot) return hit.sentence;
  const built = safeBuild(store, r, store.judges(r.key));
  const sentence = plainSummary(verdictSummary(r, built).sentence);
  if (cache.size >= 1000) cache.clear();
  cache.set(r.key, { snapshot, sentence });
  return sentence;
}

export function projectPage(
  project: Project,
  suites: SuiteRow[],
  runs: Run[],
  opts: { admin?: boolean; generatedAt?: string; store?: Store } = {},
): string {
  const rows = runs
    .map((r) => {
      const sentence = runSentence(opts.store, r);
      return `<tr><td class="mono" data-label="Run"><a href="/r/${esc(encodeURIComponent(r.suite))}/${esc(encodeURIComponent(r.run_id))}">${esc(r.run_id)}</a></td><td class="mono" data-label="Suite">${esc(r.suite)}</td><td data-label="Verdict">${esc(sentence)}</td><td class="num" data-label="Requested">${when(r.requested_at)}</td></tr>`;
    })
    .join("");
  const timelines = suites
    .map((suite) => {
      const parsed = timelineSchema.safeParse(suite.info.timeline);
      if (!parsed.success || !parsed.data.length) return "";
      return `<section aria-label="Version timeline"><h2 class="display">Version timeline${suites.length > 1 ? `: ${landingText(suite.name)}` : ""}</h2><p>What each version changed, and the number that showed it.</p><ol class="version-timeline">${parsed.data.map((step) => `<li><h3>${landingText(step.version)}</h3><p>${landingText(step.headline)}</p><p class="mono">${landingText(step.number)}</p></li>`).join("")}</ol></section>`;
    })
    .join("");
  const suiteList = suites.length
    ? suites
        .map(
          (s) =>
            `<div class="card"><h3 class="mono">${esc(s.name)}</h3><p>${landingText(s.description)}</p><div class="row"><span>${esc(String((s.info.variants as unknown[] | undefined)?.length ?? 0))} variants · ${esc(String((s.info.checks as unknown[] | undefined)?.length ?? 0))} checks</span>${
              opts.admin
                ? `<form class="inline" method="post" action="/api/runs" data-enqueue><input type="hidden" name="project" value="${esc(project.id)}"><input type="hidden" name="suite" value="${esc(s.name)}"><button class="btn primary" type="submit">Run now</button></form>`
                : ""
            }</div></div>`,
        )
        .join("")
    : `<p class="empty">No suite registered yet. The agent registers <span class="mono">weigh/*.suite.ts</span> from the repo the first time it pulls.</p>`;
  const body = `<main class="project-page"><h1 class="page display">${landingText(project.name)}</h1>
<p class="lede">${landingText(project.description)}${project.repo_url ? ` <span class="mono" style="font-size:14px">${esc(project.repo_url)}${project.branch ? ` @ ${esc(project.branch)}` : ""}</span>` : ""}</p>
${timelines}
<section style="padding-top:0;border-top:0"><div class="sec-head"><h2 class="display">Suites</h2><p>A suite names its cases, its variants and its binary checks. The baseline and candidate it declares are what the gate compares.</p></div><div class="cards" style="margin-top:0">${suiteList}</div></section>
<section><div class="sec-head"><h2 class="display">Runs</h2><p>Newest first. A running row fills in live on its own page.</p></div>
${rows ? `<table class="runs-table" aria-label="Runs"><thead><tr><th>Run</th><th>Suite</th><th>Verdict</th><th class="num">Requested</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">No runs yet.</p>'}</section></main>`;
  return page({
    title: `${project.name} · Weigh`,
    body,
    crumbs: [
      { href: "/", text: "projects" },
      { href: "", text: project.name },
    ],
    generatedAt: opts.generatedAt,
  });
}
