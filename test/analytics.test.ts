import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { withAnalytics, readAnalyticsSite } from "../src/hub/pages/layout.ts";
import { startHub } from "../src/hub/server.ts";

test("hub snapshots the analytics setting and allows its origin only on successful tracked HTML", async () => {
  const previous = process.env.WEIGH_ANALYTICS_SITE;
  const server = {
    hostname: "localhost",
    port: 8787,
    requestIP: () => null,
    stop() {},
  };
  let handler: (req: Request, server: any) => Promise<Response>;
  const serve = spyOn(Bun, "serve").mockImplementation((options: any) => {
    handler = options.fetch;
    return server as any;
  });
  try {
    for (const site of ["", "demo"]) {
      process.env.WEIGH_ANALYTICS_SITE = site;
      const hub = startHub({ dbPath: ":memory:", tokens: {} });
      process.env.WEIGH_ANALYTICS_SITE = "changed";
      try {
        for (const [path, status] of [
          ["/", 200],
          ["/missing", 404],
        ] as const) {
          const response = await handler!(
            new Request(`http://localhost${path}`),
            server,
          );
          expect(response.status).toBe(status);
          const html = await response.text();
          const policy = response.headers.get("content-security-policy")!;
          if (site && status === 200) {
            expect(html).toContain('data-site="demo"');
            expect(policy).toContain(
              "script-src 'self' https://www.staats.ai;",
            );
            expect(policy).toContain(
              "connect-src 'self' https://www.staats.ai;",
            );
          } else {
            expect(html).not.toContain("staats.ai");
            expect(policy).not.toContain("staats.ai");
          }
        }
      } finally {
        hub.stop();
      }
    }
  } finally {
    serve.mockRestore();
    if (previous === undefined) delete process.env.WEIGH_ANALYTICS_SITE;
    else process.env.WEIGH_ANALYTICS_SITE = previous;
  }
});

test("analytics head is opt-in, escaped, and absent on every error response", () => {
  const html = "<html><head></head><body></body></html>";
  expect(readAnalyticsSite("  ")).toBeUndefined();
  expect(readAnalyticsSite(" demo ")).toBe("demo");
  expect(withAnalytics(html, undefined)).toBe(html);
  expect(withAnalytics(html, "")).toBe(html);
  expect(withAnalytics(html, 'x"<')).toContain('data-site="x&quot;&lt;"');
  expect(withAnalytics(html, "demo")).toContain(
    '<script defer data-site="demo" src="https://www.staats.ai/s.js"></script>',
  );
  for (const status of [400, 401, 403, 404, 500])
    expect(withAnalytics(html, "demo", status)).toBe(html);
});

test("analytics measures viewport entry once and opened disclosures, not closing or stream restoration", () => {
  const script = readFileSync(
    new URL("../web/analytics.js", import.meta.url),
    "utf8",
  );
  const events: string[] = [];
  const listeners = new Map<string, (event: any) => void>();
  let intersect: (entries: { isIntersecting: boolean }[]) => void = () => {};
  let disconnected = false;
  const card = {};
  runInNewContext(script, {
    window: { staats: (event: string) => events.push(event) },
    document: {
      querySelector: (selector: string) =>
        selector.includes("verdict") ? card : null,
      addEventListener: (event: string, fn: (event: any) => void) =>
        listeners.set(event, fn),
    },
    IntersectionObserver: class {
      constructor(fn: typeof intersect) {
        intersect = fn;
      }
      observe(target: unknown) {
        expect(target).toBe(card);
      }
      disconnect() {
        disconnected = true;
      }
    },
  });
  intersect([{ isIntersecting: false }]);
  expect(events).toEqual([]);
  intersect([{ isIntersecting: true }]);
  intersect([{ isIntersecting: true }]);
  expect(events).toEqual(["verdict_viewed"]);
  expect(disconnected).toBe(true);
  const toggle = listeners.get("toggle")!;
  const drawer = {
    open: false,
    id: "engineers",
    dataset: {},
    matches: () => false,
  };
  toggle({ target: drawer });
  drawer.open = true;
  toggle({ target: drawer });
  toggle({ target: { ...drawer, id: "", matches: () => true } });
  toggle({
    target: {
      ...drawer,
      id: "",
      dataset: { analyticsRestored: "" },
      matches: () => true,
    },
  });
  listeners.get("click")!({ target: { closest: () => ({}) } });
  expect(events).toEqual([
    "verdict_viewed",
    "engineers_opened",
    "case_opened",
    "copy_summary",
  ]);
});

test("case page opens count once and missing tracker or observer leaves the page usable", () => {
  const script = readFileSync(
    new URL("../web/analytics.js", import.meta.url),
    "utf8",
  );
  const events: string[] = [];
  for (const window of [{ staats: (event: string) => events.push(event) }, {}])
    expect(() =>
      runInNewContext(script, {
        window,
        document: {
          querySelector: (selector: string) =>
            selector === ".case-page" ? {} : null,
          addEventListener() {},
        },
      }),
    ).not.toThrow();
  expect(events).toEqual(["case_opened"]);
});
