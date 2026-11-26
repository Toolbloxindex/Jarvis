import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Lets the collector (plain Node with --experimental-strip-types) import the app's TypeScript
 * modules unchanged: Next resolves extensionless relative imports, `@/` aliases and stubs
 * `server-only`; Node does none of that. Returns a handle with deregister().
 */
const ROOT = new URL('../', import.meta.url);
const EXTENSIONS = ['.ts', '.tsx', '/index.ts'];

function resolveFile(base) {
  if (/\.[cm]?[jt]sx?$/.test(base.pathname) && existsSync(fileURLToPath(base))) return base.href;
  for (const ext of EXTENSIONS) {
    const url = new URL(base.href + ext);
    if (existsSync(fileURLToPath(url))) return url.href;
  }
  return null;
}

export function registerTsResolve() {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'server-only') return { url: 'data:text/javascript,export%20{}', shortCircuit: true };
      const parent = context.parentURL;
      if (specifier.startsWith('@/')) {
        const url = resolveFile(new URL(specifier.slice(2), ROOT));
        if (url) return { url, shortCircuit: true };
      } else if ((specifier.startsWith('./') || specifier.startsWith('../')) && parent?.startsWith('file:')) {
        const url = resolveFile(new URL(specifier, parent));
        if (url) return { url, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}
