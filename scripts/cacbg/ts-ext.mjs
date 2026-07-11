// Minimal ESM resolve hook: lets Node's built-in TS type-stripping import the shared package's
// extensionless relative specifiers (e.g. `./format` → `./format.ts`). No bundler/tsx dependency —
// the matcher must call the ONE production normalizer (packages/shared), never a copy.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as presolve } from 'node:path';

export function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[mc]?[jt]s$/.test(specifier) && context.parentURL) {
    const cand = presolve(dirname(fileURLToPath(context.parentURL)), `${specifier}.ts`);
    if (existsSync(cand)) return next(pathToFileURL(cand).href, context);
  }
  return next(specifier, context);
}
