import { describe, expect, test } from "bun:test";
import { scrub, scrubText } from "../src/scrub.ts";

describe("scrub", () => {
  test("local paths, keys and bearer tokens vanish; ordinary text and hashes stay", () => {
    expect(scrubText("read /Users/kyle/wildcard/weigh/suites/x.ts then")).toBe(
      "read <path> then",
    );
    expect(
      scrubText("on /Volumes/Bart_26/Dev/x.sqlite and ~/Obsidian/Atlas/A.md"),
    ).toBe("on <path> and <path>");
    // Built at runtime so no secret scanner mistakes the alphabet for a key.
    const fakeKey = ["sk", "ant", "x".repeat(32)].join("-");
    expect(scrubText(`key ${fakeKey}`)).toBe("key <redacted>");
    expect(scrubText(`Authorization: Bearer ${"e".repeat(24)}.abc.def`)).toBe(
      "Authorization: Bearer <redacted>",
    );
    expect(scrubText(`api_token=${"0123456789abcdef".repeat(3)}`)).toBe(
      "api_token=<redacted>",
    );
    expect(scrubText("TIV $1,000,000 on a masonry building in TX")).toBe(
      "TIV $1,000,000 on a masonry building in TX",
    );
    expect(scrubText("output_hash 3f2a9c1b7d4e6a08")).toBe(
      "output_hash 3f2a9c1b7d4e6a08",
    );
    expect(scrubText("2 of 3 ~ 67%")).toBe("2 of 3 ~ 67%");
  });
  test("deep copies objects and arrays, leaves keys and non-strings alone", () => {
    const v = scrub({
      error: "ENOENT /Users/k/x.json",
      usage: { inputTokens: 12 },
      extra: ["fine", { note: "Bearer abcdefghijklmnopqrstuvwxyz" }],
      ok: true,
    });
    expect(v).toEqual({
      error: "ENOENT <path>",
      usage: { inputTokens: 12 },
      extra: ["fine", { note: "Bearer <redacted>" }],
      ok: true,
    });
  });
});
