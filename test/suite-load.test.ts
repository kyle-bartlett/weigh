import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSuite } from "../src/cli.ts";

const dirs: string[] = [];
const suiteName = "naming-suite";
const rule =
  'variant names may not contain an en dash or em dash or end with "+"';

function suiteFile(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "weigh-suite-load-"));
  dirs.push(dir);
  const file = join(dir, "suite.ts");
  writeFileSync(
    file,
    `export default {
      name: ${JSON.stringify(suiteName)},
      description: "Variant naming validation",
      cases: async () => [],
      variants: ${JSON.stringify(names)}.map(name => ({
        name, description: "Test variant", run: async () => ({ text: "" })
      })),
      checks: [],
      baseline: ${JSON.stringify(names[0])},
      candidate: ${JSON.stringify(names[1])}
    };`,
  );
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("loadSuite variant names", () => {
  test.each([
    ["new–prompt", "contains an en dash or em dash"],
    ["new—prompt", "contains an en dash or em dash"],
    ["v3+", 'ends with "+"'],
    ["v3+ \t\n", 'ends with "+"'],
    ["new–prompt+", "contains an en dash or em dash"],
  ])("rejects candidate %j", async (name, reason) => {
    const file = suiteFile(["v2", name]);
    await expect(loadSuite(file)).rejects.toThrow(
      `${file} is not a valid suite:\n  variants.1.name: variant "${name}" in suite "${suiteName}" ${reason}; rename it (${rule})`,
    );
  });

  test("loads ordinary names and a plus in the middle", async () => {
    const names = ["v2", "v3", "c++-style"];
    const suite = await loadSuite(suiteFile(names));
    expect(suite.variants.map((v) => v.name)).toEqual(names);
  });

  test("reports one issue per offending variant, including non-candidates", async () => {
    const names = ["old—prompt+", "v3+", "extra–prompt"];
    const file = suiteFile(names);
    const message = await loadSuite(file).then(
      () => "loaded",
      (error: Error) => error.message,
    );
    expect(message).toBe(
      `${file} is not a valid suite:\n` +
        names
          .map(
            (name, i) =>
              `  variants.${i}.name: variant "${name}" in suite "${suiteName}" ${i === 1 ? 'ends with "+"' : "contains an en dash or em dash"}; rename it (${rule})`,
          )
          .join("\n"),
    );
  });
});
