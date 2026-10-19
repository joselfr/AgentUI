import { resolve, sep } from 'node:path';

/**
 * `path.join` that cannot leave its base: the result is resolved and must stay inside `base` (an absolute part or a `..` makes it throw).
 * Used wherever a file name or an identifier ends up in a path.
 */
export function safeJoin(base: string, ...parts: string[]): string {
  const root = resolve(base);
  const target = resolve(root, ...parts);
  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('Path leaves its folder');
  return target;
}
