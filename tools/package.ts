/**
 * Packs `dist/` into a store-ready zip under `artifacts/`.
 *
 * The file name carries the manifest version and target so a release workflow
 * can upload MV3 and MV2 builds side by side.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const DIST = './dist';
const OUT_DIR = './artifacts';

interface Manifest {
  version: string;
  manifest_version: number;
}

if (!fs.existsSync(DIST)) {
  throw new Error('dist/ is missing — run `bun run deploy-v3` first');
}

const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8')) as Manifest;

fs.mkdirSync(OUT_DIR, { recursive: true });

const target = manifest.manifest_version === 2 ? 'firefox-mv2' : 'chromium-mv3';
const outFile = path.resolve(OUT_DIR, `bquery-devtools-${manifest.version}-${target}.zip`);
fs.rmSync(outFile, { force: true });

// `zip` keeps the archive flat-rooted (no `dist/` prefix), which is what both
// stores expect.
execFileSync('zip', ['-r', '-q', outFile, '.'], { cwd: DIST, stdio: 'inherit' });

console.log(`✓ packaged ${path.relative('.', outFile)}`);
