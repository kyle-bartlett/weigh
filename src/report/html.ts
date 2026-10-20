import type { Comparison, GateResult, NoiseFloor } from "../stats.ts";
import { pct, signedPct } from "../stats.ts";
import type { RunMeta, TraceLine } from "../types.ts";
import { promptTokens } from "../types.ts";
import { matrix, fromTraces, cell as mcell } from "../transition.ts";
import type { validate } from "../judge.ts";

/**
 * The single-file report. Same design language as Kyle's portfolio: grey-green neutrals, Bricolage
 * Grotesque display, Instrument Sans body, IBM Plex Mono data. Green is the automated path, amber is
 * where a person decides. Rendered at rest: no scroll reveals, nothing hidden behind an observer.
 */

export const CSS = `
:root{--bg:#F2F4F1;--bg2:#E7EBE6;--card:#FAFBF9;--ink:#131A16;--ink2:#4B554F;--ink3:#7A857E;--line:#CBD2CD;--line2:#DEE3DF;--live:#157A52;--live-soft:#DCEFE5;--gate:#B8731B;--gate-soft:#F6E7D2;--shadow:0 1px 0 rgba(19,26,22,.06),0 12px 32px -20px rgba(19,26,22,.35)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0F1412;--bg2:#151C18;--card:#131A16;--ink:#E8ECE8;--ink2:#A2ACA5;--ink3:#6F7A73;--line:#2B352F;--line2:#1F2823;--live:#3FBF8A;--live-soft:#153A2B;--gate:#E0A04A;--gate-soft:#3A2B14;--shadow:0 1px 0 rgba(0,0,0,.4),0 12px 32px -20px rgba(0,0,0,.8)}}
:root[data-theme="dark"]{--bg:#0F1412;--bg2:#151C18;--card:#131A16;--ink:#E8ECE8;--ink2:#A2ACA5;--ink3:#6F7A73;--line:#2B352F;--line2:#1F2823;--live:#3FBF8A;--live-soft:#153A2B;--gate:#E0A04A;--gate-soft:#3A2B14;--shadow:0 1px 0 rgba(0,0,0,.4),0 12px 32px -20px rgba(0,0,0,.8)}
*{box-sizing:border-box}html{color-scheme:light dark}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased;padding-inline:clamp(16px,4vw,48px)}
a{color:inherit}
.wrap{max-width:1200px;margin:0 auto;padding-bottom:80px}
.mono{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.display{font-family:"Bricolage Grotesque","Instrument Sans",system-ui,sans-serif;font-variation-settings:"opsz" 96;letter-spacing:-.02em;text-wrap:balance}
.label{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink3)}
.top{display:flex;align-items:baseline;justify-content:space-between;gap:24px;padding-block:22px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.top .name{font-weight:600}.top .meta{font-size:13px;color:var(--ink3)}
h1{font-size:clamp(34px,4.2vw,58px);line-height:1;margin:48px 0 18px;font-weight:800}
h1 em{font-style:normal;color:var(--live)}h1 em.amber{color:var(--gate)}
h2{font-size:clamp(24px,2.6vw,36px);line-height:1.08;margin:0 0 8px;font-weight:700}
h3{font-size:18px;margin:0 0 6px;font-weight:600}
.lede{font-size:clamp(17px,1.3vw,19px);color:var(--ink2);max-width:40em;margin:0 0 28px}
.lede b{color:var(--ink);font-weight:600}
section{padding-block:clamp(36px,5vw,64px);border-top:1px solid var(--line)}
.sec-head{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,9fr);gap:24px;align-items:end;margin-bottom:28px}
.sec-head p{margin:0;color:var(--ink2);max-width:44em}
.verdict{display:flex;gap:14px;align-items:center;padding:16px 18px;border:1px solid var(--line);border-radius:6px;background:var(--card);box-shadow:var(--shadow);margin:0 0 36px}
.verdict .dot{width:11px;height:11px;border-radius:50%;background:var(--live);box-shadow:0 0 0 4px var(--live-soft);flex:none}
.verdict.fail .dot{background:var(--gate);box-shadow:0 0 0 4px var(--gate-soft)}
.verdict b{font-weight:600}.verdict span{color:var(--ink2)}
.verdict.noise{margin-top:-24px;border-color:var(--line2);box-shadow:none}.verdict.noise .dot{background:var(--ink3,var(--ink2));box-shadow:none;width:9px;height:9px}
.proof{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.proof div{padding:22px 18px 20px;border-right:1px solid var(--line2)}.proof div:first-child{padding-left:0}.proof div:last-child{border-right:0}
.proof .n{font-family:"Bricolage Grotesque",sans-serif;font-variation-settings:"opsz" 96;font-weight:700;font-size:clamp(26px,2.8vw,38px);line-height:1;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.proof .n small{font-size:.5em;font-weight:600;letter-spacing:0;color:var(--ink2);margin-left:5px}
.proof .t{margin-top:8px;font-size:13.5px;color:var(--ink2);line-height:1.4}
.proof .n.up{color:var(--live)}.proof .n.down{color:var(--gate)}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-family:"IBM Plex Mono",monospace;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3);font-weight:500;padding:10px 10px 10px 0;border-bottom:1px solid var(--line)}
td{padding:11px 10px 11px 0;border-bottom:1px solid var(--line2);vertical-align:top}
td.num,th.num{text-align:right;font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums;white-space:nowrap}
.bar{height:6px;background:var(--bg2);border-radius:3px;overflow:hidden;min-width:90px}
.bar i{display:block;height:100%;background:var(--live)}
.tag{display:inline-block;font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:2px 7px;border-radius:3px;background:var(--bg2);color:var(--ink2)}
.tag.amber{background:var(--gate-soft);color:var(--gate)}.tag.green{background:var(--live-soft);color:var(--live)}
.chk{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--live);margin-right:4px;vertical-align:middle}
.chk.fail{background:var(--gate)}.chk.na{background:transparent;border:1px solid var(--line)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:6px;box-shadow:var(--shadow);padding:18px 20px}
.two{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:clamp(24px,4vw,56px);align-items:start}
.notes p{margin:0 0 12px;color:var(--ink2);max-width:40em}.notes b{color:var(--ink);font-weight:600}
pre{font-family:"IBM Plex Mono",monospace;font-size:13px;background:var(--bg2);padding:14px 16px;border-radius:4px;overflow:auto;border:1px solid var(--line2)}
svg text{font-family:"IBM Plex Mono",monospace;font-size:11px;fill:var(--ink3)}
.legend{display:flex;gap:18px;font-size:13px;color:var(--ink2);margin-top:10px;flex-wrap:wrap}
.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
footer{padding-top:24px;border-top:1px solid var(--line);font-size:13px;color:var(--ink3)}
@media (max-width:900px){.two,.sec-head{grid-template-columns:1fr}.proof{grid-template-columns:repeat(2,minmax(0,1fr))}.proof div{padding-left:0}}
`;

export const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">`;

export const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
const n0 = (x: number) =>
  Number.isNaN(x) ? "n/a" : Math.round(x).toLocaleString("en-US");
const usd = (x: number, d = 4) =>
  Number.isNaN(x) ? "n/a" : `$${x.toFixed(d)}`;
const ms = (x: number) =>
  Number.isNaN(x)
    ? "n/a"
    : x >= 1000
      ? `${(x / 1000).toFixed(1)} s`
      : `${Math.round(x)} ms`;
const ci = (c: { lo: number; hi: number }, f: (x: number) => string) =>
  Number.isNaN(c.lo) ? "" : `${f(c.lo)} to ${f(c.hi)}`;

export interface ReportInput {
  meta: RunMeta & { case_order: string[] };
  lines: TraceLine[];
  cmp: Comparison;
  noise?: NoiseFloor;
  gate: GateResult;
  judges?: (ReturnType<typeof validate> & { check: string })[];
  generatedAt?: string;
}

/** One dot per case: baseline prompt tokens on the left, candidate on the right, a line between. */
function noiseBand(r: ReportInput): string {
  const n = r.noise;
  if (!n) return "";
  const checks = n.checks
    .map(
      (c) =>
        `${esc(c.id)} ${signedPct(-c.noiseDrop)} against the candidate's ${signedPct(-c.candidateDrop)}`,
    )
    .join(", ");
  return `<div class="verdict noise"><span class="dot"></span><div><b>Noise floor: the candidate's change is ${n.within ? "within" : "beyond"} it.</b> <span>The baseline run twice (${esc(r.cmp.baseline.variant)} against ${esc(n.variant)}) moved pass-all ${signedPct(-n.passAllDrop)} against the candidate's ${signedPct(-n.candidatePassAllDrop)}${checks ? "; " + checks : ""}. A drop no larger than the baseline's own drift is not evidence of a regression.</span></div></div>`;
}

export function stripPlot(cmp: Comparison): string {
  const b = cmp.baseline.usage.promptTokens,
    c = cmp.candidate.usage.promptTokens;
  if (!b.length) return "";
  const W = 640,
    H = 48 + b.length * 14,
    L = 150,
    R = 60;
  const max = Math.max(1, ...b, ...c);
  const x = (v: number) => L + ((W - L - R) * v) / max;
  const rows = b
    .map((bv, i) => {
      const cv = c[i]!,
        y = 36 + i * 14;
      const up = cv > bv;
      return `<line x1="${x(bv)}" y1="${y}" x2="${x(cv)}" y2="${y}" stroke="${up ? "var(--gate)" : "var(--live)"}" stroke-width="1.5" opacity=".6"/><circle cx="${x(bv)}" cy="${y}" r="3.2" fill="var(--ink3)"/><circle cx="${x(cv)}" cy="${y}" r="3.2" fill="${up ? "var(--gate)" : "var(--live)"}"/>`;
    })
    .join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (f) =>
        `<line x1="${x(max * f)}" y1="22" x2="${x(max * f)}" y2="${H - 10}" stroke="var(--line2)"/><text x="${x(max * f)}" y="16" text-anchor="middle">${n0(max * f)}</text>`,
    )
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Prompt tokens per case, baseline and candidate">${ticks}<text x="0" y="16">prompt tokens</text>${rows}</svg>
<div class="legend"><span><i style="background:var(--ink3)"></i>${esc(cmp.baseline.variant)}</span><span><i style="background:var(--live)"></i>${esc(cmp.candidate.variant)} used fewer</span><span><i style="background:var(--gate)"></i>${esc(cmp.candidate.variant)} used more</span></div>`;
}

function transitionTable(lines: TraceLine[], variant: string) {
  const m = matrix(fromTraces(lines, variant));
  if (!m.total) return "";
  if (!m.failures)
    return `<p class="notes"><b>${esc(variant)}</b>: no failed stages in ${m.total} traces.</p>`;
  return `<h3>${esc(variant)}</h3><table><thead><tr><th>last success \\ first failure</th>${m.to.map((t) => `<th class="num">${esc(t)}</th>`).join("")}</tr></thead><tbody>${m.from
    .map(
      (f) =>
        `<tr><td class="mono">${esc(f)}</td>${m.to.map((t) => `<td class="num">${mcell(m, f, t) || ""}</td>`).join("")}</tr>`,
    )
    .join(
      "",
    )}</tbody></table><p class="notes" style="margin-top:8px">${m.failures} of ${m.total} traces failed a stage.</p>`;
}

/**
 * The report is a sequence of fragments so the hub's pages and its live summary events can reuse each
 * one. Every fragment takes the same ReportInput the whole report takes.
 */

/** What every fragment needs: the paired variants, the case order both completed, the token delta. */
function ctx(r: ReportInput) {
  const B = r.cmp.baseline,
    C = r.cmp.candidate;
  const checkIds = r.meta.checks.map((c) => c.id);
  const byVar = (v: string) =>
    new Map(r.lines.filter((l) => l.variant === v).map((l) => [l.case_id, l]));
  const bl = byVar(B.variant),
    cl = byVar(C.variant);
  const order = r.meta.case_order.filter((id) => bl.has(id) && cl.has(id));
  return {
    B,
    C,
    checkIds,
    bl,
    cl,
    order,
    tokDelta: r.cmp.promptTokens.pctChange,
    metered: B.usage.metered && C.usage.metered,
  };
}

export function headline(r: ReportInput): string {
  const { C, tokDelta } = ctx(r);
  return r.gate.pass
    ? `${esc(C.variant)} holds quality and uses <em>${esc(signedPct(tokDelta).replace("+", "")).replace("-", "")} ${tokDelta < 0 ? "fewer" : "more"}</em> prompt tokens.`
    : `${esc(C.variant)} <em class="amber">does not clear the gate</em> yet.`;
}

export function lede(r: ReportInput): string {
  const { order, checkIds, metered } = ctx(r);
  return `${esc(r.meta.description)} <b>${order.length} cases</b>, two variants, ${checkIds.length} binary checks. ${metered ? "Tokens and cost are metered from the provider's usage report." : "Some usage figures are estimates; the method notes say which."}`;
}

export function verdictBand(r: ReportInput): string {
  const { gate, meta } = r;
  return `<div class="verdict ${gate.pass ? "" : "fail"}"><span class="dot"></span><div><b>Gate ${gate.pass ? "passed" : "failed"}.</b> <span>${gate.pass ? `Pass-all did not drop${meta.gate?.noRegressionOn?.length ? ` and ${esc(meta.gate.noRegressionOn.join(", "))} did not fall` : ""}.` : esc(gate.reasons.join("; "))}</span></div></div>
${noiseBand(r)}`;
}

export function proofStrip(r: ReportInput): string {
  const { B, C, tokDelta } = ctx(r);
  const cmp = r.cmp;
  return `<div class="proof">
<div><div class="n">${pct(B.passAll.rate, 0)}<small>${esc(B.variant)}</small></div><div class="t">pass-all rate, baseline (${B.passAll.passed} of ${B.passAll.n})</div></div>
<div><div class="n">${pct(C.passAll.rate, 0)}<small>${esc(C.variant)}</small></div><div class="t">pass-all rate, candidate (${C.passAll.passed} of ${C.passAll.n})</div></div>
<div><div class="n ${tokDelta < 0 ? "up" : "down"}">${esc(signedPct(tokDelta))}</div><div class="t">prompt tokens per case, ${n0(cmp.promptTokens.baselineMean)} to ${n0(cmp.promptTokens.candidateMean)} (${esc(ci(cmp.promptTokens.ci, (x) => signedPct(x / Math.max(1, cmp.promptTokens.baselineMean))))} on the mean)</div></div>
<div><div class="n ${cmp.costUsd.pctChange < 0 ? "up" : "down"}">${esc(signedPct(cmp.costUsd.pctChange))}</div><div class="t">cost per case, ${usd(cmp.costUsd.baselineMean)} to ${usd(cmp.costUsd.candidateMean)} (API-equivalent)</div></div>
<div><div class="n">${esc(signedPct(cmp.latencyMs.pctChange))}</div><div class="t">latency per case, ${ms(cmp.latencyMs.baselineMean)} to ${ms(cmp.latencyMs.candidateMean)}</div></div>
</div>`;
}

export function checksTable(r: ReportInput): string {
  const { B, C } = ctx(r);
  const rows = r.cmp.checks
    .map((c) => {
      const d = r.meta.checks.find((x) => x.id === c.id)!;
      return `<tr><td><b>${esc(c.id)}</b><br><span style="color:var(--ink2);font-size:13px">${esc(d.description)}</span></td><td><span class="tag ${d.kind === "judge" ? "amber" : ""}">${d.kind}</span></td><td class="num">${c.baseline.passed}/${c.baseline.n} <span style="color:var(--ink3)">${pct(c.baseline.rate)}</span></td><td class="num">${c.candidate.passed}/${c.candidate.n} <span style="color:var(--ink3)">${pct(c.candidate.rate)}</span></td><td class="num" style="color:${c.delta < 0 ? "var(--gate)" : "var(--ink)"}">${signedPct(c.delta)}</td><td class="num" style="color:var(--ink3)">${esc(ci(c.candidate.ci, (x) => pct(x, 0)))}</td><td>${c.saturated ? '<span class="tag green">saturated</span>' : ""}</td></tr>`;
    })
    .join("");
  const cmp = r.cmp;
  const regress = cmp.regressions.length
    ? `<p class="notes"><b>${cmp.regressions.length} per-case regression${cmp.regressions.length === 1 ? "" : "s"}</b> (baseline passed, candidate failed): ${cmp.regressions
        .slice(0, 12)
        .map(
          (x) =>
            `<a href="#case-${esc(x.case_id)}" class="mono">${esc(x.case_id)}</a> ${esc(x.check)}`,
        )
        .join(
          "; ",
        )}${cmp.regressions.length > 12 ? "; and more in the ledger" : ""}. Read these first; a single run of a nondeterministic model also produces them on noise, so the gate is on rates.</p>`
    : `<p class="notes">No per-case regression: every check the baseline passed, the candidate passed too.</p>`;
  return `<table><thead><tr><th>check</th><th>kind</th><th class="num">${esc(B.variant)}</th><th class="num">${esc(C.variant)}</th><th class="num">delta</th><th class="num">95% interval (candidate)</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<div style="margin-top:18px">${regress}</div>`;
}

export function checksSection(r: ReportInput): string {
  return `<section><div class="sec-head"><h2 class="display">Checks</h2><p>Every check is pass or fail per case. Rates carry Wilson 95% intervals. A check both variants pass everywhere is saturated: it guards against regressions but no longer discriminates.</p></div>
${checksTable(r)}</section>`;
}

export function tokensSection(r: ReportInput): string {
  const { B, C, tokDelta } = ctx(r);
  const cmp = r.cmp;
  return `<section><div class="sec-head"><h2 class="display">Prompt tokens, paired</h2><p>One row per case. Grey is ${esc(B.variant)}; the colored dot is ${esc(C.variant)}. Mean change ${esc(signedPct(tokDelta))}, median change ${n0(cmp.promptTokens.medianDelta)} tokens, bootstrap 95% interval on the mean difference ${esc(ci(cmp.promptTokens.ci, n0))} tokens.</p></div>
<div class="panel">${stripPlot(cmp)}</div></section>`;
}

/** The per-case table. caseHref turns the id into a link (the hub's case page); the static report anchors in place. */
export function caseLedger(
  r: ReportInput,
  caseHref?: (id: string) => string,
): string {
  const { B, C, checkIds, bl, cl, order } = ctx(r);
  const extraKeys = [
    ...new Set(r.lines.flatMap((l) => Object.keys(l.extra ?? {}))),
  ].slice(0, 6);
  const rows = order
    .map((id) => {
      const b = bl.get(id)!,
        c = cl.get(id)!;
      const dots = (l: TraceLine) =>
        checkIds
          .map(
            (k) =>
              `<span class="chk ${l.checks[k] === undefined ? "na" : l.checks[k] ? "" : "fail"}" title="${esc(k)}: ${l.checks[k] === undefined ? "not applicable" : l.checks[k] ? "pass" : "fail"}"></span>`,
          )
          .join("");
      const pt = (l: TraceLine) =>
        l.ok
          ? n0(promptTokens(l.usage))
          : '<span class="tag amber">error</span>';
      const extra = extraKeys
        .map((k) => `<td class="num">${esc(c.extra?.[k] ?? "")}</td>`)
        .join("");
      const delta =
        b.ok && c.ok
          ? signedPct(
              (promptTokens(c.usage) - promptTokens(b.usage)) /
                Math.max(1, promptTokens(b.usage)),
            )
          : "";
      const label = caseHref
        ? `<a href="${esc(caseHref(id))}">${esc(id)}</a>`
        : esc(id);
      return `<tr id="case-${esc(id)}" data-case="${esc(id)}"><td class="mono">${label}</td><td data-variant="${esc(B.variant)}">${dots(b)}</td><td data-variant="${esc(C.variant)}">${dots(c)}</td><td class="num">${pt(b)}</td><td class="num">${pt(c)}</td><td class="num" style="color:${delta.startsWith("-") ? "var(--live)" : "var(--ink2)"}">${delta}</td>${extra}</tr>`;
    })
    .join("");
  return `<section><div class="sec-head"><h2 class="display">Per-case ledger</h2><p>Dots are checks in the order of the table above; hollow means the check did not apply. Tokens are prompt tokens the model read (fresh input plus cache read plus cache creation).</p></div>
<table><thead><tr><th>case</th><th>${esc(B.variant)}</th><th>${esc(C.variant)}</th><th class="num">tokens ${esc(B.variant)}</th><th class="num">tokens ${esc(C.variant)}</th><th class="num">change</th>${extraKeys.map((k) => `<th class="num">${esc(k)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function judgeTable(
  j: NonNullable<ReportInput["judges"]>[number],
): string {
  return `<h3 class="mono" style="margin:18px 0 6px">${esc(j.check)}</h3>
<table><thead><tr><th>split</th><th class="num">n</th><th class="num">human fails</th><th class="num">human passes</th><th class="num">TPR</th><th class="num">TNR</th></tr></thead><tbody>${j.splits
    .map(
      (s) =>
        `<tr><td class="mono">${esc(s.split)}</td><td class="num">${s.n}</td><td class="num">${s.humanFails}</td><td class="num">${s.humanPasses}</td><td class="num">${pct(s.tpr)} <span style="color:var(--ink3)">${esc(ci(s.tprCi, (x) => pct(x, 0)))}</span></td><td class="num">${pct(s.tnr)} <span style="color:var(--ink3)">${esc(ci(s.tnrCi, (x) => pct(x, 0)))}</span></td></tr>`,
    )
    .join(
      "",
    )}</tbody></table><p class="notes" style="margin-top:6px">${j.joined} labels matched a judge verdict; ${j.unmatched} did not.</p>`;
}

export function judgeSection(r: ReportInput): string {
  return r.judges?.length
    ? `<section><div class="sec-head"><h2 class="display">Judge validation</h2><p>Each judge check is a classifier. Its verdicts count only as far as they agree with a person's labels on a split it never saw. Positive means a failure is present. TPR is the share of human-labelled failures the judge caught; TNR the share of human-labelled passes it left alone. Two judges on the same property can be compared row for row.</p></div>${r.judges.map(judgeTable).join("")}</section>`
    : "";
}

export function transitionsSection(r: ReportInput): string {
  const { B, C } = ctx(r);
  const transitions = [B.variant, C.variant]
    .map((v) => transitionTable(r.lines, v))
    .filter(Boolean)
    .join("");
  return transitions
    ? `<section><div class="sec-head"><h2 class="display">Where runs fail</h2><p>Rows are the last stage that succeeded, columns the first that failed. The matrix says where to look before any judge is built.</p></div>${transitions}</section>`
    : "";
}

export function methodSection(r: ReportInput): string {
  const { B, C, order, metered } = ctx(r);
  const meta = r.meta;
  return `<section><div class="two"><div><h2 class="display">Method</h2></div><div class="notes">
<p><b>Variants.</b> ${meta.variants.map((v) => `<b>${esc(v.name)}</b>: ${esc(v.description)}`).join(" ")}</p>
<p><b>Checks.</b> ${meta.checks.map((c) => `<b>${esc(c.id)}</b> (${c.kind}): ${esc(c.description)}`).join(" ")}</p>
<p><b>Gate.</b> Candidate pass-all may not drop by more than ${pct(meta.gate?.maxPassAllDrop ?? 0, 0)}${meta.gate?.noRegressionOn?.length ? `, and the rate of ${esc(meta.gate.noRegressionOn.join(" and "))} may not be lower on the candidate` : ""}. Regressions per case are listed, not gated.</p>
<p><b>Numbers.</b> ${metered ? "Token counts and cost come from the provider's usage report on every call (metered)." : "Where a provider reported usage the figures are metered; the rest are estimates and the ledger marks them."} Cost is the API-equivalent figure; these calls ran on a subscription. Latency is wall time per case including every call the variant made. Intervals: Wilson for rates, seeded percentile bootstrap (2,000 resamples) for paired means. No p-values.</p>
<p><b>Pairing.</b> Only cases both variants completed are compared, in suite order, so every paired number has the same n (${order.length}). Errors: ${B.errors} on ${esc(B.variant)}, ${C.errors} on ${esc(C.variant)}.${meta.skipped.length ? ` Skipped cases: ${meta.skipped.map((s) => `${esc(s.id)} (${esc(s.reason)})`).join(", ")}.` : ""}</p>
<p><b>Reproduce.</b></p><pre>${esc(meta.command)}\nbun src/cli.ts report ${esc(meta.suite)} ${esc(meta.run_id)}</pre>
</div></div></section>`;
}

export function renderHtml(r: ReportInput): string {
  const { meta } = r;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weigh: ${esc(meta.suite)}</title>${FONTS}<style>${CSS}</style></head><body><div class="wrap">
<div class="top"><div><span class="name">Weigh</span> <span class="meta">before/after eval harness</span></div><div class="meta mono">${esc(meta.suite)} · run ${esc(meta.run_id)} · ${esc((r.generatedAt ?? new Date().toISOString()).slice(0, 10))}</div></div>
<h1 class="display">${headline(r)}</h1>
<p class="lede">${lede(r)}</p>
${verdictBand(r)}${proofStrip(r)}

${checksSection(r)}

${tokensSection(r)}

${caseLedger(r)}

${judgeSection(r)}
${transitionsSection(r)}

${methodSection(r)}
<footer>Weigh, by Kyle Bartlett. Traces for this run: runs/${esc(meta.suite)}/${esc(meta.run_id)}/traces.jsonl. Every number above maps to a line in that file.</footer>
</div></body></html>`;
}
