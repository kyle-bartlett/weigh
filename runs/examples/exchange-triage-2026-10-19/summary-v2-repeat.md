# Weigh: exchange-triage, run 2026-10-19-prompts

Exchange Triage extraction prompts v1, v2 and v3 over the 27-case golden set, through the production pipeline (intake, extraction, grounding, appetite; writer off) on claude sonnet via the CLI. Baseline v2 (what shipped 2026-07-27), candidate v3 (production), v2-repeat as the noise floor, v1 as the frozen plain prompt. Reference: the golden labels. Judges: two source-attribution classifiers, validated against human labels in suites/exchange-triage.labels.jsonl.

**Gate passed.** Pass-all did not drop and the guarded checks did not fall.

| | v2 | v2-repeat | change |
|---|---|---|---|
| pass-all | 7/27 (25.9%) | 7/27 (25.9%) | +0.0% |
| prompt tokens per case | 4,778 | 4,775 | -0.1% |
| output tokens per case | 1,035 | 1,015 | -1.9% |
| cost per case (API-equivalent) | $0.0232 | $0.0187 | -19.3% |
| latency per case | 89,669 ms | 59,540 ms | -33.6% |

## Checks

| check | kind | v2 | v2-repeat | delta |
|---|---|---|---|---|
| extraction_schema | code | 27/27 | 27/27 | +0.0% (saturated) |
| fields_correct | code | 26/27 | 26/27 | +0.0% |
| construction_canonical | code | 18/18 | 18/18 | +0.0% (saturated) |
| nulls_stay_null | code | 5/5 | 5/5 | +0.0% (saturated) |
| decision_correct | code | 23/27 | 23/27 | +0.0% |
| attribution_jev | judge | 19/27 | 19/27 | +0.0% |
| attribution_claude | judge | 11/27 | 11/27 | +0.0% |

No per-case regression.

Paired cases: 27. Bootstrap 95% interval on the mean token difference: -10 to 1. Tokens and cost metered from the provider's usage report.

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
