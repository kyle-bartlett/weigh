import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { homedir } from "os";

// The suite imports chief-of-staff by path; skip where that checkout is absent.
const cos = process.env.COS_CHECKOUT ?? `${homedir()}/wildcard/chief-of-staff`;
const run = existsSync(cos) ? describe : describe.skip;

run("reposcout item matcher", async () => {
  const { found, similarNames } = await import(
    "../suites/reposcout-transcript.ts"
  );
  type Item = {
    kind: "repo" | "tool";
    name: string;
    url: string | null;
    category: string;
  };
  const it = (
    name: string,
    url?: string,
    kind: "repo" | "tool" = "repo",
  ): Item => ({ kind, name, url: url ?? null, category: "x" });

  test("URL and exact names still match", () => {
    expect(
      found("gh:lxc/incus", [it("Incus", "https://github.com/lxc/incus")]),
    ).toBe(true);
    expect(found("gh:lxc/incus", [it("Incus")])).toBe(true);
    expect(
      found("web:paperinstruments.com/blog/ultramarine", [
        it(
          "Ultramarine 1 Flash",
          "https://paperinstruments.com/blog/ultramarine",
          "tool",
        ),
      ]),
    ).toBe(true);
  });

  test("items listed under another name or URL for the same repo match", () => {
    expect(
      found("web:forge.routemehome.org/brian/incus-commander", [
        it("Incus Commander"),
      ]),
    ).toBe(true);
    expect(
      found("name:claude-generated-cuda-megakernel-qwen-3-8-27b-on-3090", [
        it("Claude-generated megakernel (3090, 140 tok/s claim)"),
      ]),
    ).toBe(true);
    // the project moved orgs; production's resolve stage recorded the new one
    expect(
      found("gh:anomalyco/opencode", [
        it("OpenCode", "https://github.com/sst/opencode"),
      ]),
    ).toBe(true);
    // same owner, repo renamed since the video
    expect(
      found("gh:abhi245y/ps5lm-plus", [
        it("PS5LM Plus (abhi245y fork)", "https://github.com/abhi245y/PS5LM"),
      ]),
    ).toBe(true);
  });

  test("conservative where the name alone cannot tell", () => {
    // a one-word repo name inside a longer product name is not the repo
    expect(
      found("gh:lxc/incus", [
        it(
          "Incus Commander",
          "https://forge.routemehome.org/brian/incus-commander",
        ),
      ]),
    ).toBe(false);
    expect(
      found("gh:ml-explore/mlx", [
        it(
          "MLX distributed inference",
          "https://machinelearning.apple.com/research/mlx-distributed-inference",
          "tool",
        ),
      ]),
    ).toBe(false);
    // the base repo is not the fork production recorded
    expect(
      found("gh:abhi245y/ps5lm-plus", [
        it("PS5LM (base, Mert Cobanov)", "https://github.com/cobanov/PS5LM"),
      ]),
    ).toBe(false);
  });

  test("a different GitHub repo with a similar name is not a match", () => {
    expect(
      found("gh:niko1221/strata", [
        it(
          "Strata Pascal Optimized Fork",
          "https://github.com/SirDebugALot/Strata-Qwen3.6-35B-A3B-Pascal-Optimized",
        ),
      ]),
    ).toBe(false);
    expect(
      found("gh:ml-explore/mlx", [
        it(
          "Muse Spark Open",
          "https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B",
          "tool",
        ),
      ]),
    ).toBe(false);
    expect(
      found("tool:gpt-6-luna", [it("GLM-5.3 Flash (Z.ai)", undefined, "tool")]),
    ).toBe(false);
  });

  test("similarNames needs two shared words or full containment", () => {
    expect(similarNames("Lucebox megakernel", "megakernel")).toBe(true);
    expect(similarNames("Strata", "Strata GLM")).toBe(true);
    expect(similarNames("Open Source Tool", "Open Source Other")).toBe(false);
  });
});
