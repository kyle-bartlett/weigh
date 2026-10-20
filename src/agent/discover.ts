import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { sh } from "./checkout.ts";

/**
 * A project plugs in by shipping weigh/<name>.suite.ts. Discovery asks the Weigh CLI for each file's
 * suite-info in a subprocess (suites import their app at module load and keep module state, so they
 * never load inside the agent) and reports what the hub needs to register them.
 */

export interface DiscoveredSuite {
  name: string;
  path: string;
  description: string;
  info: Record<string, unknown>;
}

export function discoverSuites(
  checkout: string,
  weighHome: string,
  env: Record<string, string>,
): { suites: DiscoveredSuite[]; errors: { path: string; error: string }[] } {
  const dir = join(checkout, "weigh");
  const suites: DiscoveredSuite[] = [];
  const errors: { path: string; error: string }[] = [];
  if (!existsSync(dir)) return { suites, errors };
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith(".suite.ts"))
    .sort()) {
    const file = join(dir, f);
    const r = sh(
      ["bun", join(weighHome, "src", "cli.ts"), "suite-info", file],
      { cwd: checkout, env },
    );
    const rel = relative(checkout, file);
    if (r.code !== 0) {
      errors.push({ path: rel, error: r.out.slice(-600) });
      continue;
    }
    try {
      const info = JSON.parse(r.out.slice(r.out.indexOf("{"))) as Record<
        string,
        unknown
      > & { name: string; description: string };
      suites.push({
        name: info.name,
        path: rel,
        description: info.description,
        info,
      });
    } catch (e) {
      errors.push({
        path: rel,
        error: `suite-info printed no JSON: ${String(e)}`,
      });
    }
  }
  return { suites, errors };
}
