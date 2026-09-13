import path from 'path';

/**
 * Resolve `candidate` against `baseDir` and reject if the result
 * escapes that directory (relative `..` or an absolute path outside).
 */
export function resolveWithinBase(candidate: string, baseDir: string = process.cwd()): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, candidate);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path '${candidate}' escapes allowed directory '${base}'`);
  }
  return resolved;
}
