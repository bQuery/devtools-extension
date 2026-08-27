import * as fs from 'fs';
import * as path from 'path';
const DIST = './dist';
const errors = [];
const require_ = (relative, why) => {
    if (!fs.existsSync(path.join(DIST, relative)))
        errors.push(`missing ${relative} (${why})`);
};
if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error('dist/manifest.json is missing — run `bun run deploy-v3` first');
}
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
require_('panel.html', 'the DevTools panel');
require_('panel.js', 'the panel bundle');
require_('content.js', 'the opt-in live-streaming relay');
if (manifest.devtools_page)
    require_(manifest.devtools_page, 'manifest.devtools_page');
if (manifest.options_ui?.page)
    require_(manifest.options_ui.page, 'manifest.options_ui.page');
if (manifest.background?.service_worker) {
    require_(manifest.background.service_worker, 'manifest.background.service_worker');
}
for (const script of manifest.background?.scripts ?? []) {
    require_(script, 'manifest.background.scripts');
}
const contentScript = fs.readFileSync(path.join(DIST, 'content.js'), 'utf8');
if (/\bimport\s*[({'"]/.test(contentScript) || /\bexport\s[{*]/.test(contentScript)) {
    errors.push('content.js contains module syntax; it must be a self-contained classic script');
}
for (const file of fs.readdirSync(DIST)) {
    if (!file.endsWith('.html'))
        continue;
    const html = fs.readFileSync(path.join(DIST, file), 'utf8');
    if (html.includes('{{'))
        errors.push(`${file} still contains an unreplaced template token`);
}
if ((manifest.host_permissions ?? []).length > 0) {
    errors.push('host_permissions must stay empty; the panel requests one origin at runtime');
}
const optional = manifest.optional_host_permissions ?? manifest.optional_permissions ?? [];
if (!optional.some(entry => entry.includes('://'))) {
    errors.push('no optional host permission declared; live streaming could never be enabled');
}
if (manifest.manifest_version === 3) {
    if (!manifest.background?.service_worker)
        errors.push('MV3 build has no service worker');
}
else if (manifest.manifest_version === 2) {
    if (!manifest.background?.scripts?.length)
        errors.push('MV2 build has no background scripts');
    if ((manifest.permissions ?? []).includes('scripting')) {
        errors.push('MV2 build still declares the MV3-only "scripting" permission');
    }
}
else {
    errors.push(`unexpected manifest_version: ${manifest.manifest_version}`);
}
if (errors.length > 0) {
    console.error('✗ build verification failed:');
    for (const error of errors)
        console.error(`  - ${error}`);
    process.exit(1);
}
console.log(`✓ ${manifest.name} ${manifest.version} (MV${manifest.manifest_version}) looks loadable`);
