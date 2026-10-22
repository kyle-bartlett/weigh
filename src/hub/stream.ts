import type { Store, StoredEvent } from "./store.ts";
import { TERMINAL } from "./store.ts";

/**
 * Server-sent events per run. A subscriber first gets every stored event after `since` (the browser
 * sends Last-Event-ID on reconnect, so a dropped connection costs nothing), then live ones as the hub
 * ingests them. A run in a terminal state replays and closes. Pings every 10 seconds keep proxies
 * from cutting an idle stream; every stream ends after 30 minutes and the browser reconnects.
 */

const PING_MS = 10_000;
const MAX_MS = 30 * 60_000;
const PER_IP = 5;
const GLOBAL = 200;

type Sub = (events: StoredEvent[]) => void;

export class Streams {
  private subs = new Map<string, Set<Sub>>();
  private perIp = new Map<string, number>();
  private open = 0;

  broadcast(key: string, events: StoredEvent[]) {
    if (!events.length) return;
    for (const fn of this.subs.get(key) ?? []) fn(events);
  }

  count() {
    return this.open;
  }

  /** The SSE response, or a 429 when the viewer or the hub has too many streams open. */
  response(store: Store, key: string, since: number, ip: string): Response {
    const mine = this.perIp.get(ip) ?? 0;
    if (mine >= PER_IP || this.open >= GLOBAL)
      return new Response("too many open streams", { status: 429 });
    const run = store.getRun(key);
    if (!run) return new Response("not found", { status: 404 });
    const enc = new TextEncoder();
    const frame = (e: StoredEvent) => {
      const payload: Record<string, unknown> = {
        ...e.event,
        seq: e.seq,
        source: e.source,
      };
      if (e.event.type === "summary") {
        // Pre-#7 rows contain HTML that must stay out of replay and live frames.
        delete payload.html;
      }
      return `id: ${e.seq}\nevent: ${e.event.type}\ndata: ${JSON.stringify(payload)}\n\n`;
    };
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        this.open++;
        this.perIp.set(ip, mine + 1);
        let last = since;
        const send = (events: StoredEvent[]) => {
          for (const e of events) {
            if (e.seq <= last) continue;
            last = e.seq;
            ctrl.enqueue(enc.encode(frame(e)));
          }
        };
        send(store.eventsSince(key, since));
        const done = () => {
          cleanup();
          try {
            ctrl.close();
          } catch {
            /* already closed */
          }
        };
        if (TERMINAL.has(run.status)) {
          ctrl.enqueue(enc.encode("event: end\ndata: {}\n\n"));
          done();
          return;
        }
        const sub: Sub = (events) => {
          send(events);
          const status = events.find((e) => e.event.type === "status");
          if (
            status &&
            status.event.type === "status" &&
            TERMINAL.has(status.event.status)
          ) {
            ctrl.enqueue(enc.encode("event: end\ndata: {}\n\n"));
            done();
          }
        };
        const set = this.subs.get(key) ?? new Set();
        set.add(sub);
        this.subs.set(key, set);
        const ping = setInterval(() => {
          try {
            ctrl.enqueue(enc.encode(": ping\n\n"));
          } catch {
            done();
          }
        }, PING_MS);
        const max = setTimeout(done, MAX_MS);
        cleanup = () => {
          cleanup = () => {};
          clearInterval(ping);
          clearTimeout(max);
          set.delete(sub);
          if (!set.size) this.subs.delete(key);
          this.open--;
          const n = (this.perIp.get(ip) ?? 1) - 1;
          if (n <= 0) this.perIp.delete(ip);
          else this.perIp.set(ip, n);
        };
      },
      cancel: () => cleanup(),
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }
}
