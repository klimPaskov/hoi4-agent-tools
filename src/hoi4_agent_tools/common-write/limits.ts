/**
 * The caps of `hoi4.common_write` output, applied before the output schema parses, so a large
 * definition (a balance of power with many ranges, a plan with hundreds of focuses) is reported
 * short, with a count of what was left out, and never makes the schema throw.
 */
export const MAX_DIFF_UNITS = 8_000;
export const MAX_FINDINGS = 50;
export const MAX_NAMES = { localisation: 50, sprites: 20, categories: 5, focuses: 100 } as const;
const MAX_NAME_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 1_024;

/** `text` cut to at most `limit` UTF-16 units without splitting a surrogate pair. */
export function cutText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const high = text.charCodeAt(limit - 1);
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? limit - 1 : limit);
}

export function capList(
  items: readonly string[],
  limit: number,
  length = MAX_NAME_LENGTH,
): { kept: string[]; omitted: number } {
  return {
    kept: items.slice(0, limit).map((item) => cutText(item, length)),
    omitted: Math.max(0, items.length - limit),
  };
}

export function capFindings<T extends { code: string; message: string }>(
  findings: readonly T[],
): { kept: T[]; omitted: number } {
  return {
    kept: findings.slice(0, MAX_FINDINGS).map((finding) => ({
      ...finding,
      code: cutText(finding.code, 128),
      message: cutText(finding.message, MAX_MESSAGE_LENGTH),
    })),
    omitted: Math.max(0, findings.length - MAX_FINDINGS),
  };
}
