import type { ReportInput } from "./html.ts";
import { checkedJudges } from "./build.ts";
import { pct, signedPct } from "../stats.ts";

const n0 = (x: number) =>
  Number.isNaN(x) ? "n/a" : Math.round(x).toLocaleString("en-US");

/** The Markdown summary that goes to the vault and the career log. Same numbers as the HTML, fewer words. */
export function renderMarkdown(r: ReportInput): string {
  const { meta, cmp, gate } = r;
  const judges = checkedJudges(r.judges ?? []);
  const B = cmp.baseline,
    C = cmp.candidate;
  const lines = [
    `# Weigh: ${meta.suite}, run ${meta.run_id}`,
    "",
    `${meta.description}`,
    "",
    `**Gate ${gate.pass ? "passed" : "failed"}.** ${gate.pass ? "Pass-all did not drop and the guarded checks did not fall." : gate.reasons.join("; ")}`,
    ...(r.noise
      ? [
          "",
          `**Noise floor: the candidate's change is ${r.noise.within ? "within" : "beyond"} it.** The baseline run twice (${B.variant} against ${r.noise.variant}) moved pass-all ${signedPct(-r.noise.passAllDrop)} against the candidate's ${signedPct(-r.noise.candidatePassAllDrop)}${r.noise.checks.length ? "; " + r.noise.checks.map((c) => `${c.id} ${signedPct(-c.noiseDrop)} against ${signedPct(-c.candidateDrop)}`).join(", ") : ""}.`,
        ]
      : []),
    "",
    "| | " + B.variant + " | " + C.variant + " | change |",
    "|---|---|---|---|",
    `| pass-all | ${B.passAll.passed}/${B.passAll.n} (${pct(B.passAll.rate)}) | ${C.passAll.passed}/${C.passAll.n} (${pct(C.passAll.rate)}) | ${signedPct(C.passAll.rate - B.passAll.rate)} |`,
    `| prompt tokens per case | ${n0(cmp.promptTokens.baselineMean)} | ${n0(cmp.promptTokens.candidateMean)} | ${signedPct(cmp.promptTokens.pctChange)} |`,
    `| output tokens per case | ${n0(cmp.outputTokens.baselineMean)} | ${n0(cmp.outputTokens.candidateMean)} | ${signedPct(cmp.outputTokens.pctChange)} |`,
    `| cost per case (API-equivalent) | $${cmp.costUsd.baselineMean.toFixed(4)} | $${cmp.costUsd.candidateMean.toFixed(4)} | ${signedPct(cmp.costUsd.pctChange)} |`,
    `| latency per case | ${n0(cmp.latencyMs.baselineMean)} ms | ${n0(cmp.latencyMs.candidateMean)} ms | ${signedPct(cmp.latencyMs.pctChange)} |`,
    "",
    "## Checks",
    "",
    `| check | kind | ${B.variant} | ${C.variant} | delta |`,
    "|---|---|---|---|---|",
    ...cmp.checks.map((c) => {
      const d = meta.checks.find((x) => x.id === c.id)!;
      return `| ${c.id} | ${d.kind} | ${c.baseline.passed}/${c.baseline.n} | ${c.candidate.passed}/${c.candidate.n} | ${signedPct(c.delta)}${c.saturated ? " (saturated)" : ""} |`;
    }),
    "",
    cmp.regressions.length
      ? `Per-case regressions (baseline passed, candidate failed): ${cmp.regressions.map((x) => `${x.case_id} ${x.check}`).join("; ")}.`
      : "No per-case regression.",
    "",
    `Paired cases: ${cmp.promptTokens.n}. Bootstrap 95% interval on the mean token difference: ${n0(cmp.promptTokens.ci.lo)} to ${n0(cmp.promptTokens.ci.hi)}. ${B.usage.metered && C.usage.metered ? "Tokens and cost metered from the provider's usage report." : "Some figures estimated; see the HTML report."}`,
    ...(judges.length
      ? [
          "",
          "## Judge validation",
          "",
          ...judges.flatMap((j) => [
            `**${j.check}** (${j.joined} labels matched, ${j.unmatched} unmatched)`,
            "",
            "| split | n | human fails | human passes | TPR | TNR |",
            "|---|---|---|---|---|---|",
            ...j.splits.map(
              (s) =>
                `| ${s.split} | ${s.n} | ${s.humanFails} | ${s.humanPasses} | ${pct(s.tpr)} | ${pct(s.tnr)} |`,
            ),
            "",
          ]),
        ]
      : []),
    "",
    "Reproduce:",
    "```",
    meta.command,
    `bun src/cli.ts report ${meta.suite} ${meta.run_id}`,
    "```",
    "",
  ];
  return lines.join("\n");
}
