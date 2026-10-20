import type { RunMeta, TraceLine } from "./types.ts";

/**
 * What leaves the machine gets scrubbed twice: at the agent before upload and at the hub on ingest.
 * Absolute local paths say where Kyle keeps things; keys and bearer tokens must never reach a public
 * page even by accident (a suite that logs its environment, an error message that quotes a header).
 * Data is not otherwise altered: hashes, case ids and model text pass through.
 */

const LOCAL_PATH =
  /(?:\/Users|\/Volumes|\/private|\/home|\/root)\/[^\s"'`)\],;]+|(?<![\w.])~\/[^\s"'`)\],;]+/g;
const SK_KEY = /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g;
/** A long hex or base64 run within a few characters of a word that names a secret. */
const NEAR_SECRET =
  /\b([a-z_]*(?:key|token|secret|authorization|password|passwd|credential)s?)\b([^\n]{0,24}?)([A-Fa-f0-9]{40,}|[A-Za-z0-9+/_-]{40,}={0,2})/gi;

export function scrubText(s: string): string {
  return s
    .replace(SK_KEY, "<redacted>")
    .replace(BEARER, "Bearer <redacted>")
    .replace(NEAR_SECRET, (_, w: string, gap: string) => `${w}${gap}<redacted>`)
    .replace(LOCAL_PATH, "<path>");
}

/** Deep copy with every string scrubbed. Keys are left alone. */
export function scrub<T>(v: T): T {
  if (typeof v === "string") return scrubText(v) as T;
  if (Array.isArray(v)) return v.map(scrub) as T;
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        scrub(x),
      ]),
    ) as T;
  return v;
}

export const scrubTrace = (l: TraceLine): TraceLine => scrub(l);

/** The command is also normalized: the agent's absolute invocation becomes the short form the README shows. */
export function scrubMeta(m: RunMeta): RunMeta {
  return scrub(m);
}
