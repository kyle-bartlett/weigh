import type { ZodType } from "zod";
import type { Case, Check, VariantOutput } from "./types.ts";

/**
 * Helpers for code checks. Every check is binary. The doctrine's order: fix the prompt first,
 * write a code assertion second, build a judge only for a failure that persists.
 */

export function check(
  id: string,
  description: string,
  test: Check["test"],
  kind: Check["kind"] = "code",
): Check {
  return { id, description, kind, test };
}

/** Output parses with the schema. */
export function zodParses(
  id: string,
  schema: ZodType,
  pick: (o: VariantOutput) => unknown = (o) => o.output,
): Check {
  return check(
    id,
    "Output matches the expected schema",
    (_c, o) => schema.safeParse(pick(o)).success,
  );
}

/** Every item of `expected(case)` appears in `found(output)`. An empty expected set passes. */
export function setRecall(
  id: string,
  description: string,
  expected: (c: Case) => Iterable<string>,
  found: (o: VariantOutput) => Iterable<string>,
): Check {
  return check(id, description, (c, o) => {
    const have = new Set(found(o));
    for (const e of expected(c)) if (!have.has(e)) return false;
    return true;
  });
}

/** Every value from `values(output)` is in the allowed set. */
export function allIn(
  id: string,
  description: string,
  allowed: Iterable<string>,
  values: (o: VariantOutput) => Iterable<string>,
): Check {
  const ok = new Set(allowed);
  return check(id, description, (_c, o) =>
    [...values(o)].every((v) => ok.has(v)),
  );
}

const EM_DASH = /[—–]/;
/** No em or en dash in any string reachable from the output (Kyle's writing rule). */
export function noEmDash(
  id = "no_em_dash",
  pick: (o: VariantOutput) => unknown = (o) => o.output,
): Check {
  return check(
    id,
    "No em dash in any output text",
    (_c, o) => !strings(pick(o)).some((s) => EM_DASH.test(s)),
  );
}

/** Every string value in a JSON-like structure. */
export function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out);
  else if (x && typeof x === "object")
    for (const v of Object.values(x)) strings(v, out);
  return out;
}

/** Which of `expected` are missing from `found`; for the review page and the per-case ledger. */
export function missing(
  expected: Iterable<string>,
  found: Iterable<string>,
): string[] {
  const have = new Set(found);
  return [...expected].filter((e) => !have.has(e));
}
