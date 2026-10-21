import type { Built } from "../report/build.ts";
import { esc } from "../report/html.ts";
import type { Run } from "./store.ts";
import { plainName, verdictSummary } from "./pages/run-sections.ts";

export type VerdictSummary = ReturnType<typeof verdictSummary>;

/** Remove our display tags before decoding so a literal angle bracket stays text. */
export function plainSummary(html: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
  };
  return plainName(
    html
      .replace(/<[^>]*>/g, "")
      .replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (entity) => entities[entity]!),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function copySummary(
  summary: VerdictSummary,
  absoluteLink: string,
): string {
  return [
    plainSummary(summary.sentence),
    plainSummary(summary.changed),
    absoluteLink,
  ].join("\n");
}

/** Read once at hub startup; never log the value, which may contain credentials. */
export function readPublicOrigin(
  value = process.env.WEIGH_PUBLIC_ORIGIN,
): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    if (
      /^https?:\/\/[^/?#\\\s]+\/?$/i.test(value) &&
      !value.includes("@") &&
      parsed.hostname &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash
    )
      return parsed.origin;
  } catch {
    /* Invalid settings fall back to the existing proxy behavior. */
  }
  console.warn(
    "Ignoring invalid WEIGH_PUBLIC_ORIGIN: expected an HTTP(S) origin without a path, query, fragment or credentials.",
  );
  return undefined;
}

/** A configured origin takes precedence over all request headers. */
export function publicOrigin(
  req: Request,
  url: URL,
  configured?: string,
): string {
  if (configured) return configured;
  const proto =
    req.headers
      .get("x-forwarded-proto")
      ?.split(",")[0]
      ?.trim()
      .toLowerCase() === "https"
      ? "https"
      : "http";
  const host = req.headers.get("host") ?? url.host;
  if (!/[\s/@?#\\]/.test(host)) {
    try {
      const parsed = new URL(`${proto}://${host}`);
      if (parsed.hostname && !parsed.username && !parsed.password)
        return parsed.origin;
    } catch {
      /* Fall back to the parsed request URL, which always has a host. */
    }
  }
  return `${proto}://${url.host}`;
}

export function shareUrls(run: Run, built: Built | undefined, origin: string) {
  const base = `${origin}/r/${encodeURIComponent(run.suite)}/${encodeURIComponent(run.run_id)}`;
  const query = new URLSearchParams();
  for (const role of ["baseline", "candidate"] as const) {
    const selected = built?.meta[role];
    if (
      selected &&
      selected !== run.meta?.[role] &&
      run.meta?.variants.some((v) => v.name === selected)
    )
      query.set(role, selected);
  }
  const suffix = query.size ? `?${query}` : "";
  return { link: base + suffix, image: `${base}/og.png${suffix}` };
}

export function shareControls(
  run: Run,
  built: Built | undefined,
  link: string,
): string {
  const finished = run.status === "finished";
  return `<div data-share data-finished="${finished}"${finished ? "" : " hidden"}>
<button class="btn" type="button" data-copy-summary>Copy summary</button>
<span class="sr-only" data-copy-status role="status"></span>
<div data-copy-fallback hidden><label for="copy-summary-text">Select and copy</label>
<textarea id="copy-summary-text" readonly rows="5">${esc(copySummary(verdictSummary(run, built), link))}</textarea></div>
</div>`;
}
