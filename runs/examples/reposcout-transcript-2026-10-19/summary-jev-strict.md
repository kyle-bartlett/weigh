# Weigh: reposcout-transcript, run 2026-10-19-jev-filter

Repo Scout reads YouTube repo channels and lists every repo and tool a video covers. Baseline sends the full captions to the model; the candidates send only the caption chunks Jev says name a tool (jev-filter: at or above 0.5 with one neighbor each side; jev-strict: at or above 0.75, no neighbors). full-repeat is the baseline run twice, the noise floor.

**Gate failed.** pass-all fell from 91.3% to 87.0% (allowed drop 0.0%); item_recall fell from 88.9% to 77.8%

**Noise floor: the candidate's change is beyond it.** The baseline run twice (full against full-repeat) moved pass-all -4.3% against the candidate's -4.3%; item_recall -7.4% against -11.1%, linked_recall +0.0% against +3.2%.

| | full | jev-strict | change |
|---|---|---|---|
| pass-all | 42/46 (91.3%) | 40/46 (87.0%) | -4.3% |
| prompt tokens per case | 7,105 | 5,629 | -20.8% |
| output tokens per case | 3,355 | 3,332 | -0.7% |
| cost per case (API-equivalent) | $0.1100 | $0.1007 | -8.5% |
| latency per case | 31,557 ms | 32,731 ms | +3.7% |

## Checks

| check | kind | full | jev-strict | delta |
|---|---|---|---|---|
| json_valid | code | 45/46 | 46/46 | +2.2% |
| linked_recall | code | 29/31 | 30/31 | +3.2% |
| item_recall | code | 24/27 | 21/27 | -11.1% |
| categories_valid | code | 46/46 | 46/46 | +0.0% (saturated) |
| no_em_dash | code | 46/46 | 46/46 | +0.0% (saturated) |

Per-case regressions (baseline passed, candidate failed): kuO4NOqp7Tc item_recall; GqUiMns5GPg item_recall; tL0KwFaAe0Y item_recall.

Paired cases: 46. Bootstrap 95% interval on the mean token difference: -2,070 to -956. Tokens and cost metered from the provider's usage report.

Reproduce:
```
bun src/cli.ts run suites/reposcout-transcript.ts --run-id 2026-10-19-jev-filter --variants full-repeat
bun src/cli.ts report reposcout-transcript 2026-10-19-jev-filter
```
