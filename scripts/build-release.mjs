// Builds everything a server needs into dist/release, with no TypeScript runner and no source tree:
//   server.mjs        the collector (our own packages bundled in; only the Firestore client stays external)
//   assets/tracker.js the website script
//   assets/admin/     the admin console
// Run through `npm run build:release` (which builds the script and the console first).
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist/release');
const must = (path) => {
  if (!existsSync(path)) throw new Error(`Missing ${path}. Run "npm run build" first.`);
  return path;
};

rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, 'assets'), { recursive: true });

await build({
  entryPoints: [must(resolve(root, 'packages/server/src/main.ts'))],
  outfile: resolve(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  // The Firestore client loads its protocol files from disk at run time, so it is installed beside the bundle instead.
  external: ['@google-cloud/firestore'],
  // Lets any bundled CommonJS code use require() inside an ES module.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

cpSync(must(resolve(root, 'packages/tracker/dist/tracker.js')), resolve(out, 'assets/tracker.js'));
cpSync(must(resolve(root, 'packages/admin-ui/dist')), resolve(out, 'assets/admin'), { recursive: true });
for (const f of ['assets/tracker.js', 'assets/admin/index.html', 'assets/admin/app.js', 'assets/admin/app.css']) {
  if (statSync(resolve(out, f)).size === 0) throw new Error(`${f} is empty`);
}
console.log(`release written to ${out}`);
