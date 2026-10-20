import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Three tokens, three scopes. admin does everything; agent only reaches /api/agent; read unlocks
 * private projects and /mcp. Anonymous visitors get public projects and nothing else. Tokens come
 * from the environment (Coolify secrets), never from the database, and never appear in a log line.
 */

export type Scope = "admin" | "agent" | "read";
export interface Tokens {
  admin?: string;
  agent?: string;
  read?: string;
}

export function tokensFromEnv(env = process.env): Tokens {
  const t: Tokens = {
    admin: env.WEIGH_ADMIN_TOKEN || undefined,
    agent: env.WEIGH_AGENT_TOKEN || undefined,
    read: env.WEIGH_READ_TOKEN || undefined,
  };
  if (env.REQUIRE_SECRETS === "1" && !(t.admin && t.agent && t.read))
    throw new Error(
      "WEIGH_ADMIN_TOKEN, WEIGH_AGENT_TOKEN and WEIGH_READ_TOKEN must all be set",
    );
  return t;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
export const sameToken = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && timingSafeEqual(digest(a), digest(b));

export const COOKIE = "weigh_token";

/** The token a request carries: Authorization bearer first, then the session cookie. */
export function presentedToken(req: Request): string | undefined {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const cookie = req.headers.get("cookie");
  if (cookie) {
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    if (m) return decodeURIComponent(m[1]!);
  }
  return undefined;
}

export function scopesOf(
  token: string | undefined,
  tokens: Tokens,
): Set<Scope> {
  const s = new Set<Scope>();
  if (!token) return s;
  if (sameToken(token, tokens.admin)) s.add("admin").add("read");
  if (sameToken(token, tokens.agent)) s.add("agent");
  if (sameToken(token, tokens.read)) s.add("read");
  return s;
}

export const scopes = (req: Request, tokens: Tokens) =>
  scopesOf(presentedToken(req), tokens);

export const cookieFor = (token: string, secure: boolean) =>
  `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`;
