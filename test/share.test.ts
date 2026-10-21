import { expect, setDefaultTimeout, test } from "bun:test";
import { startHub } from "../src/hub/server.ts";
import { join } from "node:path";
import { build } from "../src/report/build.ts";
import { copySummary } from "../src/hub/share.ts";
import { verdictSummary } from "../src/hub/pages/run-sections.ts";
import { verdictSvg } from "../src/hub/og.ts";
import { labelsPage } from "../src/hub/pages/labels.ts";

// Native rasterization uses the same budget as `bun test --timeout 60000`.
setDefaultTimeout(60_000);
const built = build(
  join(import.meta.dir, "../runs/examples/exchange-triage-2026-10-19"),
);
function exampleHub() {
  const hub = startHub({ dbPath: ":memory:", port: 0, tokens: {} });
  hub.store.upsertProject({ id: "example", public: true });
  const run = hub.store.createRun({
    key: "exchange-triage/2026-10-19-prompts",
    project_id: "example",
    suite: "exchange-triage",
    run_id: "2026-10-19-prompts",
    status: "finished",
  });
  hub.store.updateRun(run.key, {
    meta: built.meta,
    finished: 108,
    total: 108,
  });
  for (const line of built.lines) hub.store.upsertTrace(run.key, line);
  hub.store.putJudges(run.key, built.judges);
  return { hub, run: hub.store.getRun(run.key)!, path: `/r/${run.key}` };
}

test("latest returns a plain 404 or the newest anonymously visible finished run", async () => {
  const hub = startHub({ dbPath: ":memory:", port: 0, tokens: {} });
  const get = () => fetch(`${hub.url}/latest`, { redirect: "manual" });
  try {
    const empty = await get();
    expect(empty.status).toBe(404);
    expect(empty.headers.get("content-type")).toContain("text/plain");
    expect(await empty.text()).toBe("No finished run yet.");
    hub.store.upsertProject({ id: "public", public: true });
    hub.store.upsertProject({ id: "private", public: false });
    for (const [id, status, project, date] of [
      ["old", "finished", "public", "2026-10-19"],
      ["new", "finished", "public", "2026-10-20"],
      ["private", "finished", "private", "2026-10-21"],
      ["running", "running", "public", "2026-10-22"],
    ] as const) {
      hub.store.createRun({
        key: `demo/${id}`,
        project_id: project,
        suite: "demo",
        run_id: id,
        status,
      });
      hub.store.updateRun(`demo/${id}`, { finished_at: `${date}T00:00:00Z` });
    }
    const latest = await get();
    expect(latest.status).toBe(302);
    expect(latest.headers.get("location")).toBe("/r/demo/new");
    hub.store.upsertProject({ id: "public", public: false });
    expect((await get()).status).toBe(404);
  } finally {
    hub.stop();
  }
});

test("share image is a PNG, follows visibility, and changes with completion, sequence and comparison", async () => {
  const { hub, run, path } = exampleHub();
  const png = async (query = "") => {
    const response = await fetch(`${hub.url}${path}/og.png${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    return bytes;
  };
  try {
    const finished = await png();
    expect(await png()).toEqual(finished);
    expect(await png("?baseline=v1")).not.toEqual(finished);
    hub.store.updateRun(run.key, { status: "running" });
    const running = await png();
    expect(running).not.toEqual(finished);
    hub.store.updateRun(run.key, { status: "finished" });
    const changed = built.lines.find(
      (line) =>
        line.variant === built.meta.candidate &&
        line.ok &&
        Object.values(line.checks).every(Boolean),
    )!;
    hub.store.upsertTrace(run.key, {
      ...changed,
      checks: { ...changed.checks, fields_correct: false },
    });
    hub.store.db.run("UPDATE runs SET last_seq = last_seq + 1 WHERE key = ?", [
      run.key,
    ]);
    expect(await png()).not.toEqual(finished);
    hub.store.upsertProject({ id: "example", public: false });
    expect((await fetch(`${hub.url}${path}/og.png`)).status).toBe(404);
  } finally {
    hub.stop();
  }
});

test("run shares use proxy origin and only comparison parameters; live fragments reveal sharing", async () => {
  const { hub, run, path } = exampleHub();
  try {
    const response = await fetch(
      `${hub.url}${path}?baseline=v1&unrelated=discard-me`,
      {
        headers: { host: "preview.example:8443", "x-forwarded-proto": "https" },
      },
    );
    const html = await response.text();
    expect(html).toContain(
      `property="og:image" content="https://preview.example:8443${path}/og.png?baseline=v1`,
    );
    expect(html).toContain(
      'property="og:title" content="Keep the current prompt v1',
    );
    expect(html).toContain('property="og:description"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('src="/web/tour.js"');
    expect(html).toContain('data-share data-finished="true"');
    expect(html).not.toContain("discard-me");
    expect(html).not.toMatch(/[\u2013\u2014]|\d\+/);
    const fallback = await (
      await fetch(`${hub.url}${path}`, { headers: { host: "preview.example" } })
    ).text();
    expect(fallback).toContain(`http://preview.example${path}/og.png`);
    hub.store.updateRun(run.key, { status: "running" });
    const live = await (await fetch(`${hub.url}${path}`)).text();
    expect(live).toContain('data-share data-finished="false" hidden');
    hub.store.updateRun(run.key, { status: "finished" });
    const fragments = await (await fetch(`${hub.url}${path}/fragments`)).json();
    expect(fragments.share).toContain('data-share data-finished="true"');
    const labels = labelsPage(
      hub.store.getProject("example")!,
      run,
      built.lines,
      {},
      [],
    );
    expect(labels).not.toContain("/web/tour.js");
    expect(labels).not.toContain("data-copy-summary");
    const invalidRes = await fetch(`${hub.url}${path}?baseline=discard-me`, {
      headers: {
        host: "reader@preview.example",
        "x-forwarded-proto": "https, http",
      },
    });
    expect(invalidRes.status).toBe(200);
    const invalid = await invalidRes.text();
    expect(invalid).not.toContain("discard-me");
    expect(invalid).not.toContain("reader@");
    const badPort = await fetch(`${hub.url}${path}`, {
      headers: { host: "x.com:99999" },
    });
    expect(badPort.status).toBe(200);
    expect(await badPort.text()).not.toContain("x.com:99999");
  } finally {
    hub.stop();
  }
});

test("copy summary is exactly three plain lines with the absolute link last", () => {
  const { hub, run } = exampleHub();
  try {
    const link = "https://preview.example/r/exchange-triage/2026-10-19-prompts";
    const lines = copySummary(verdictSummary(run, built), link).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      "The new prompt v3 beat the current prompt v2: 6 more cases passed every check.",
    );
    expect(lines[1]).toMatch(
      /^\d+ cases? gained a passing check; \d+ cases? lost one/,
    );
    expect(lines[2]).toBe(link);
    expect(lines.join("\n")).not.toMatch(
      /<[^>]*>|&(?:amp|lt|gt|quot);|[\u2013\u2014]|\d\+/,
    );
  } finally {
    hub.stop();
  }
});

test("SVG keeps shared wording, escapes markup and bounds long headlines", () => {
  const { hub, run } = exampleHub();
  try {
    const summary = verdictSummary(run, built);
    const svg = verdictSvg(summary);
    expect(svg).toContain('width="1200" height="630"');
    expect(svg).toContain("Ship it");
    expect(svg).not.toContain("<span");
    expect(svg).not.toMatch(/[\u2013\u2014]|\d\+/);
    const unusual = verdictSvg({
      ...summary,
      sentence: "A &amp; B &lt;script&gt; " + "Long name ".repeat(100),
    });
    expect(unusual).toContain("A &amp; B &lt;script&gt;");
    expect(unusual).not.toContain("<script>");
    expect(unusual).toContain("…");
    expect(
      verdictSvg(verdictSummary({ ...run, status: "running" }, built)),
    ).toContain("Still running");
  } finally {
    hub.stop();
  }
});
