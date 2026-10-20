import { esc } from "../../report/html.ts";
import { pct, signedPct } from "../../stats.ts";
import type { Project, Run, SuiteRow } from "../store.ts";
import { page, statusTag, when } from "./layout.ts";

/** The front page: one card per project the viewer may see, with its latest run. */
export function homePage(
  projects: { project: Project; suites: SuiteRow[]; latest?: Run }[],
  opts: { generatedAt?: string } = {},
): string {
  const cards = projects
    .map(({ project, suites, latest }) => {
      const s = latest?.summary;
      const verdict = s
        ? `${s.pass ? "Gate passed" : "Gate failed"} · pass-all ${pct(s.baseline_pass_all ?? NaN, 0)} to ${pct(s.candidate_pass_all ?? NaN, 0)} · tokens ${esc(signedPct(s.prompt_tokens_pct ?? NaN))}`
        : latest
          ? "no comparison yet"
          : "no runs yet";
      return `<a class="card" href="/p/${esc(project.id)}"><h3>${esc(project.name)}</h3><p>${esc(project.description || (suites.length ? suites.map((x) => x.name).join(", ") : "no suites registered"))}</p>
<div class="row"><span>${latest ? statusTag(latest.status) : ""}</span><span class="mono">${latest ? when(latest.requested_at) : ""}</span></div>
<div class="row" style="margin-top:8px"><span>${esc(verdict)}</span>${project.public ? "" : '<span class="tag">private</span>'}</div></a>`;
    })
    .join("");
  const body = `<h1 class="page display">Evaluations you can watch run.</h1>
<p class="lede">Each project ships a suite file; the agent runs it and every finished pair lands here as it happens. Open a project for its runs, a run for the verdict, a case for what the model actually said.</p>
${cards ? `<div class="cards">${cards}</div>` : '<p class="empty">Nothing public yet.</p>'}`;
  return page({ title: "Weigh", body, generatedAt: opts.generatedAt });
}

export function projectPage(
  project: Project,
  suites: SuiteRow[],
  runs: Run[],
  opts: { admin?: boolean; generatedAt?: string } = {},
): string {
  const rows = runs
    .map((r) => {
      const s = r.summary;
      const prog =
        r.total > 0
          ? `${r.finished}/${r.total}`
          : r.status === "queued"
            ? "waiting"
            : "";
      return `<tr><td class="mono"><a href="/r/${esc(r.suite)}/${esc(r.run_id)}">${esc(r.run_id)}</a></td><td class="mono">${esc(r.suite)}</td><td>${statusTag(r.status)}</td><td class="num">${esc(prog)}</td><td>${s ? `<span class="tag ${s.pass ? "green" : "amber"}">${s.pass ? "pass" : "fail"}</span>` : ""}</td><td class="num">${s ? `${pct(s.baseline_pass_all ?? NaN, 0)} to ${pct(s.candidate_pass_all ?? NaN, 0)}` : ""}</td><td class="num">${s ? esc(signedPct(s.prompt_tokens_pct ?? NaN)) : ""}</td><td class="num">${when(r.requested_at)}</td></tr>`;
    })
    .join("");
  const suiteList = suites.length
    ? suites
        .map(
          (s) =>
            `<div class="card"><h3 class="mono">${esc(s.name)}</h3><p>${esc(s.description)}</p><div class="row"><span>${esc(String((s.info.variants as unknown[] | undefined)?.length ?? 0))} variants · ${esc(String((s.info.checks as unknown[] | undefined)?.length ?? 0))} checks</span>${
              opts.admin
                ? `<form class="inline" method="post" action="/api/runs" data-enqueue><input type="hidden" name="project" value="${esc(project.id)}"><input type="hidden" name="suite" value="${esc(s.name)}"><button class="btn primary" type="submit">Run now</button></form>`
                : ""
            }</div></div>`,
        )
        .join("")
    : `<p class="empty">No suite registered yet. The agent registers <span class="mono">weigh/*.suite.ts</span> from the repo the first time it pulls.</p>`;
  const body = `<h1 class="page display">${esc(project.name)}</h1>
<p class="lede">${esc(project.description)}${project.repo_url ? ` <span class="mono" style="font-size:14px">${esc(project.repo_url)}${project.branch ? ` @ ${esc(project.branch)}` : ""}</span>` : ""}</p>
<section style="padding-top:0;border-top:0"><div class="sec-head"><h2 class="display">Suites</h2><p>A suite names its cases, its variants and its binary checks. The baseline and candidate it declares are what the gate compares.</p></div><div class="cards" style="margin-top:0">${suiteList}</div></section>
<section><div class="sec-head"><h2 class="display">Runs</h2><p>Newest first. A running row fills in live on its own page.</p></div>
${rows ? `<table><thead><tr><th>run</th><th>suite</th><th>status</th><th class="num">pairs</th><th>gate</th><th class="num">pass-all</th><th class="num">tokens</th><th class="num">requested</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">No runs yet.</p>'}</section>`;
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
