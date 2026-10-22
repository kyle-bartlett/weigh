export function textRuleReason(text: string): string | undefined {
  if (/[\u2013\u2014]/.test(text)) return "contains an en dash or em dash";
  if (/\d\+(?!\w)/.test(text)) return 'contains a number followed by "+"';
  return undefined;
}

export function textRuleMessage(
  field: string,
  suite: string,
  reason: string,
): string {
  return `${field} in suite "${suite}" ${reason}; rewrite it (suite text may not contain an en dash or em dash or a number followed by "+")`;
}

/**
 * Make runtime-sourced text (an error message, a tool's output) pass the suite text rule: en and em
 * dashes become a hyphen and the "+" after a number is dropped. Author-written text is never passed
 * through here; it still fails loudly so the author rewrites it.
 */
export function sanitizeSuiteText(text: string): string {
  let out = text.replace(/[\u2013\u2014]/g, "-");
  while (/\d\+(?!\w)/.test(out)) out = out.replace(/(\d)\+(?!\w)/g, "$1");
  return out;
}
