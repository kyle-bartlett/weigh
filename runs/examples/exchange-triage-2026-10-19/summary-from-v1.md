# Weigh: exchange-triage, run 2026-10-19-prompts

Exchange Triage extraction prompts v1, v2 and v3 over the 27-case golden set, through the production pipeline (intake, extraction, grounding, appetite; writer off) on claude sonnet via the CLI. Baseline v2 (what shipped 2026-07-27), candidate v3 (production), v2-repeat as the noise floor, v1 as the frozen plain prompt. Reference: the golden labels. Judges: two source-attribution classifiers, validated against human labels in suites/exchange-triage.labels.jsonl.

**Gate failed.** decision_correct fell from 100.0% to 85.2%

**Noise floor: the candidate's change is within it.** The baseline run twice (v1 against v2-repeat) moved pass-all -11.1% against the candidate's +11.1%; decision_correct -14.8% against -14.8%, fields_correct +11.1% against +14.8%.

| | v1 | v3 | change |
|---|---|---|---|
| pass-all | 10/27 (37.0%) | 13/27 (48.1%) | +11.1% |
| prompt tokens per case | 4,362 | 5,076 | +16.4% |
| output tokens per case | 1,013 | 1,015 | +0.2% |
| cost per case (API-equivalent) | $0.0239 | $0.0192 | -19.7% |
| latency per case | 58,132 ms | 95,435 ms | +64.2% |

## Checks

| check | kind | v1 | v3 | delta |
|---|---|---|---|---|
| extraction_schema | code | 27/27 | 27/27 | +0.0% (saturated) |
| fields_correct | code | 23/27 | 27/27 | +14.8% |
| construction_canonical | code | 14/18 | 18/18 | +22.2% |
| nulls_stay_null | code | 5/5 | 5/5 | +0.0% (saturated) |
| decision_correct | code | 27/27 | 23/27 | -14.8% |
| attribution_jev | judge | 20/27 | 27/27 | +25.9% |
| attribution_claude | judge | 10/27 | 16/27 | +22.2% |

Per-case regressions (baseline passed, candidate failed): V-02 decision_correct; V-03 decision_correct; V-06 attribution_claude; V-13 decision_correct; V-16 decision_correct.

Paired cases: 27. Bootstrap 95% interval on the mean token difference: 698 to 728. Tokens and cost metered from the provider's usage report.

## Judge validation

**attribution_claude** (54 labels matched, 0 unmatched)

| split | n | human fails | human passes | TPR | TNR |
|---|---|---|---|---|---|
| all | 54 | 14 | 40 | 100.0% | 65.0% |
| train | 12 | 1 | 11 | 100.0% | 54.5% |
| dev | 22 | 3 | 19 | 100.0% | 73.7% |
| test | 20 | 10 | 10 | 100.0% | 60.0% |

**attribution_jev** (54 labels matched, 0 unmatched)

| split | n | human fails | human passes | TPR | TNR |
|---|---|---|---|---|---|
| all | 54 | 14 | 40 | 50.0% | 100.0% |
| train | 12 | 1 | 11 | 100.0% | 100.0% |
| dev | 22 | 3 | 19 | 100.0% | 100.0% |
| test | 20 | 10 | 10 | 30.0% | 100.0% |


Reproduce:
```
bun src/cli.ts run suites/exchange-triage.ts --run-id 2026-10-19-prompts
bun src/cli.ts report exchange-triage 2026-10-19-prompts
```
