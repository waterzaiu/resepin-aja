import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

test('asset routing cannot bypass Worker security headers', () => {
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(config, /"run_worker_first"\s*:\s*true/);
});
for (const path of ['/', '/index.html', '/unknown-ui-path']) {
  for (const method of ['GET', 'HEAD']) {
    test(`${method} ${path} applies HTML camera and preview policies at ASSETS delivery`, async () => {
      let calls = 0;
      const res = await worker.fetch(new Request('https://example.com' + path, { method }), {
        ASSETS: { fetch: async () => { calls++; return new Response(method === 'HEAD' ? null : '<html>UI</html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: 'asset-tag' } }); } },
      }, {});
      assert.equal(res.status, 200);
      assert.equal(calls, 1);
      assert.equal(res.headers.get('etag'), 'asset-tag');
      assert.equal(res.headers.get('Permissions-Policy'), 'camera=(self), microphone=(), geolocation=()');
      const csp = res.headers.get('Content-Security-Policy');
      assert.match(csp, /img-src 'self' data: https: blob:/);
      assert.match(csp, /connect-src 'self';/);
      assert.match(csp, /object-src 'none';/);
      assert.equal(csp.split(';').filter(x => x.includes('blob:')).length, 1);
      assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
    });
  }
}
test('API and unknown API paths never fall through to HTML or allow camera', async () => {
  for (const path of ['/health', '/api/missing']) {
    const res = await worker.fetch(new Request('https://example.com' + path), { ASSETS: { fetch: () => { throw Error('API reached assets'); } } }, {});
    assert.match(res.headers.get('Content-Type'), /application\/json/);
    assert.match(res.headers.get('Permissions-Policy'), /camera=\(\)/);
  }
});
