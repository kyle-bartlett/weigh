/**
 * Weigh suite "__NAME__". The agent discovers every weigh/*.suite.ts in this repo and registers it with
 * the hub. Import your own app by relative path; Weigh's helpers load from WEIGH_HOME at run time.
 *
 *   bun $WEIGH_HOME/src/cli.ts run weigh/__NAME__.suite.ts
 */
import { join } from "node:path";
import type { Case, Suite, VariantOutput } from "./types.ts";
import { emptyUsage } from "./types.ts";

const WEIGH_HOME =
  process.env.WEIGH_HOME ?? join(process.env.HOME ?? "", "weigh");

/** Metered Claude calls through the subscription login: `const { callClaudeCli } = await weigh("claude-cli.ts")`. */
const weigh = (file: string) => import(join(WEIGH_HOME, "src", file));
void weigh;

// Replace with your pipeline. Each variant turns a case into a VariantOutput with real usage numbers.
async function runPipeline(
  c: Case,
  prompt: "baseline" | "candidate",
): Promise<VariantOutput> {
  const started = Date.now();
  const text = `${prompt}: ${JSON.stringify(c.input)}`;
  return {
    output: { text },
    usage: {
      ...emptyUsage("example"),
      inputTokens: text.length,
      outputTokens: 8,
      calls: 1,
      latencyMs: Date.now() - started,
      metered: false,
    },
  };
}

const suite: Suite = {
  name: "__NAME__",
  description: "Describe what this suite compares and what the reference is.",
  cases: async () => [
    { id: "example-1", input: { question: "What is 2 + 2?" }, reference: "4" },
    {
      id: "example-2",
      input: { question: "Capital of Texas?" },
      reference: "Austin",
    },
  ],
  variants: [
    {
      name: "baseline",
      description: "what ships today",
      run: (c) => runPipeline(c, "baseline"),
    },
    {
      name: "candidate",
      description: "the change under test",
      run: (c) => runPipeline(c, "candidate"),
    },
  ],
  checks: [
    {
      id: "has_text",
      description: "output carries a non-empty text field",
      kind: "code",
      test: (_c, o) =>
        typeof (o.output as { text?: unknown }).text === "string" &&
        (o.output as { text: string }).text.length > 0,
    },
  ],
  baseline: "baseline",
  candidate: "candidate",
  gate: { noRegressionOn: ["has_text"] },
};

export default suite;
