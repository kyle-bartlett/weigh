import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/**
 * A hand-rolled browser for web/run.js: just the globals it touches (document.querySelector and
 * querySelectorAll, dataset, textContent, classList, style, innerHTML, EventSource, fetch, timers,
 * requestAnimationFrame, performance.now, matchMedia). Timers and animation frames queue instead
 * of running, so a test steps them by hand. No DOM library: the repo allows no new dependency.
 */
const source = readFileSync(new URL("../web/run.js", import.meta.url), "utf8");

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class El {
  textContent = "";
  className = "";
  hidden = false;
  innerHTML = "";
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  lastChild = { textContent: "" };
  offsetWidth = 0;
  attributes = new Map<string, string>();
  classes = new Set<string>();
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
  };
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  closest() {
    return null;
  }
}

const SECTIONS = [
  "verdict",
  "share",
  "changed",
  "checks",
  "ledger",
  "cost",
  "engineers",
];
const COUNTED =
  /<span data-count="([^"]*)" data-digits="([^"]*)" data-prefix="([^"]*)">([^<]*)<\/span>/g;

export function openPage(opts: {
  run: string;
  fetch: Fetch;
  total?: number;
  finished?: number;
  reducedMotion?: boolean;
}) {
  const script = new El();
  script.dataset = {
    run: opts.run,
    live: "true",
    since: "0",
    total: String(opts.total ?? 0),
    finished: String(opts.finished ?? 0),
  };
  const progress = new El();
  const bar = new El();
  const status = new El();
  const share = new El();
  share.hidden = true;
  const sections = new Map(SECTIONS.map((name) => [name, new El()]));
  const rows = new Map<string, El>();
  let cells: El[] = [];

  // Counted cells live inside fragment HTML, so they are parsed out of whatever a refresh wrote.
  const counted = () => {
    cells = [];
    for (const s of sections.values())
      for (const m of s.innerHTML.matchAll(COUNTED)) {
        const cell = new El();
        cell.dataset = { count: m[1]!, digits: m[2]!, prefix: m[3]! };
        cell.textContent = m[4]!;
        cells.push(cell);
      }
    return cells;
  };
  const querySelector = (selector: string) => {
    if (selector === "script[data-run]") return script;
    if (selector === "[data-progress]") return progress;
    if (selector === "[data-progress-bar]") return bar;
    if (selector === "[data-status]") return status;
    if (selector === "[data-share]") return share;
    if (selector === "[data-complete=true]")
      return [...sections.values()].some((s) =>
        s.innerHTML.includes('data-complete="true"'),
      )
        ? new El()
        : null;
    const section = /^\[data-section="(\w+)"\]$/.exec(selector);
    if (section) return sections.get(section[1]!) ?? null;
    const row = /^tr\[data-case="(.*)"\]$/.exec(selector);
    if (row) return rows.get(row[1]!) ?? null;
    return null;
  };
  const querySelectorAll = (selector: string) =>
    selector === "[data-count]" ? counted() : [];

  // Timers queue by id; fire() runs the oldest pending one and waits for the refresh it starts.
  let nextId = 0;
  const timers = new Map<number, { fn: () => unknown; ms: number }>();
  const frames: ((now: number) => void)[] = [];
  let clock = 0;
  const dispatched: string[] = [];

  class FakeEventSource {
    closed = false;
    onerror: (() => void) | null = null;
    private listeners = new Map<string, ((e: { data: string }) => void)[]>();
    constructor(readonly url: string) {
      page.es = this;
    }
    addEventListener(type: string, fn: (e: { data: string }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    close() {
      this.closed = true;
    }
    /** Delivers one event the way a browser would: nothing after close(). */
    emit(type: string, data: unknown = {}) {
      if (this.closed) return;
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      for (const fn of this.listeners.get(type) ?? []) fn({ data: payload });
    }
    /** Reads the hub's real SSE response and emits each frame as it arrives, until the hub or the page closes it. */
    async connect() {
      const response = await opts.fetch(this.url);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          let type = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) type = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) this.emit(type, data);
        }
      }
      await reader.cancel().catch(() => {});
    }
  }

  const page = {
    es: undefined as FakeEventSource | undefined,
    progress,
    bar,
    status,
    share,
    sections,
    rows,
    dispatched,
    /** The cells the count-up last read. */
    cells: () => cells,
    /** Delays of the timers still pending, oldest first. */
    pending: () => [...timers.values()].map((t) => t.ms),
    async fire() {
      const [id, t] = [...timers.entries()][0]!;
      timers.delete(id);
      await t.fn();
    },
    /** Pending animation frames, then runs them all at time `now`. */
    frames: () => frames.length,
    frame(now: number) {
      clock = now;
      for (const fn of frames.splice(0)) fn(now);
    },
    set clock(now: number) {
      clock = now;
    },
  };

  runInNewContext(source, {
    document: {
      querySelector,
      querySelectorAll,
      addEventListener() {},
      dispatchEvent: (e: { type: string }) => dispatched.push(e.type),
    },
    window: { addEventListener() {} },
    location: { hash: "", search: "" },
    fetch: opts.fetch,
    EventSource: FakeEventSource,
    CSS: { escape: (s: string) => s },
    setTimeout: (fn: () => unknown, ms: number) => {
      timers.set(++nextId, { fn, ms });
      return nextId;
    },
    clearTimeout: (id: number) => timers.delete(id),
    matchMedia: () => ({ matches: !!opts.reducedMotion }),
    requestAnimationFrame: (fn: (now: number) => void) => frames.push(fn),
    performance: { now: () => clock },
    navigator: {},
    CustomEvent: class {
      constructor(readonly type: string) {}
    },
    Element: El,
  });
  return page as typeof page & { es: FakeEventSource };
}
