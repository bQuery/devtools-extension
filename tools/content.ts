/**
 * Bundles the content script.
 *
 * Content scripts are injected as classic scripts — they cannot be ES modules
 * and cannot share Rollup chunks with the rest of the build — so this entry is
 * bundled separately, as a self-contained IIFE.
 */
import { buildSync } from 'esbuild';

buildSync({
  entryPoints: ['./src/content.ts'],
  outfile: './dist/content.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome102', 'firefox102', 'es2022'],
  sourcemap: true,
  minify: true,
  legalComments: 'none',
});

console.log('✓ content.js bundled');
