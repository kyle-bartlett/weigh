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
