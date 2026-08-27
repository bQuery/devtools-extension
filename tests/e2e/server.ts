/**
 * Static server for the E2E smoke test.
 *
 * Playwright cannot open a DevTools panel, but the panel is an ordinary
 * extension page: served over http with a mocked `chrome` API it exercises
 * the real bundle — transport, protocol client, state and Web Components —
 * end to end. This serves `dist/` for that purpose.
 */
import { file } from 'bun';
import { existsSync } from 'fs';
import { join, normalize } from 'path';

const ROOT = normalize(join(import.meta.dir, '../../dist'));
const PORT = Number(process.env['PORT'] ?? 4173);

if (!existsSync(ROOT)) {
  throw new Error('dist/ is missing — run `bun run deploy-v3` before the E2E tests');
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(request) {
    const { pathname } = new URL(request.url);
    const relative = pathname === '/' ? '/panel.html' : pathname;
    // Contain the server to dist/ regardless of what the request asks for.
    const resolved = normalize(join(ROOT, relative));
    if (!resolved.startsWith(ROOT)) return new Response('Forbidden', { status: 403 });
    if (!existsSync(resolved)) return new Response('Not found', { status: 404 });
    return new Response(file(resolved));
  },
});

console.log(`E2E fixture server listening on http://127.0.0.1:${server.port}`);
