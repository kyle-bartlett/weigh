import { spyOn } from "bun:test";

// Exercise the real hub handler without opening sockets in an implementation lane.
const handlers = new Map<string, (req: Request) => Promise<Response>>();
let port = 19000;
spyOn(Bun, "serve").mockImplementation(((options: {
  fetch: (req: Request, server: unknown) => Response | Promise<Response>;
}) => {
  const origin = `http://127.0.0.1:${++port}`;
  const server = {
    hostname: "127.0.0.1",
    port,
    requestIP: () => ({ address: "127.0.0.1" }),
    stop: () => handlers.delete(origin),
  };
  handlers.set(origin, async (req) => options.fetch(req, server));
  return server;
}) as unknown as typeof Bun.serve);
spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
  const req = new Request(input, init);
  const handler = handlers.get(new URL(req.url).origin);
  if (!handler) throw new Error("No in-process test hub for this request");
  return handler(req);
}) as typeof fetch);
