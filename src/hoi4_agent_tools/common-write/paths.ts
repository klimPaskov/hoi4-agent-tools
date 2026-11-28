/**
 * A new file's path, checked before the engine is asked (the engine refuses the same paths): a
 * path segment the mod may hold on every platform has no NTFS stream or drive (`:`), wildcard or
 * control character, no trailing dot or space, and is not a reserved device name.
 */
const RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)\d)$/iu;

export function isPlainSegment(part: string): boolean {
  if (part === '' || part === '.' || part === '..' || /[. ]$/u.test(part)) return false;
  // eslint-disable-next-line no-control-regex -- control characters are the point
  if (/[\u0000-\u001f\u007f:*?"<>|\\]/u.test(part)) return false;
  return !RESERVED.test(part.split('.')[0] ?? '');
}

export function isPlainRelativePath(path: string): boolean {
  return path.split('/').every(isPlainSegment);
}
