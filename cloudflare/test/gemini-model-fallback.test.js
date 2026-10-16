import test from 'node:test';
import assert from 'node:assert/strict';
import { callVisionWithFallback, ProviderError } from '../src/gemini.js';

const images = ['data:image/jpeg;base64,/9j/2Q=='];
const chain = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash']
  .map(model => ({ name: 'gemini', model, apiKey: 'test-key' }));
const recipe = { namaMasakan: 'Tumis', waktuMasak: 10, porsi: 1,
  bahanTerdeteksi: ['sayur'], bahanKurang: [], langkah: ['Tumis sayur'], menuAlternatif: [] };
const success = () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(recipe) }] } }] });

for (const consent of [false, null, undefined]) {
  test(`different vendor is never contacted without consent (${consent})`, async () => {
    const urls = [];
    const mixed = [chain[0], { name: 'openai', model: 'other', apiKey: 'test-key' }, chain[1]];
    await assert.rejects(callVisionWithFallback(images, mixed, async url => {
      urls.push(url);
      return new Response('busy', { status: 503 });
    }, consent), /gemini.*503/);
    assert.equal(urls.length, 2);
    assert.ok(urls.every(url => url.includes('generativelanguage.googleapis.com')));
  });
}

for (const status of [401, 403]) {
  test(`authentication ${status} is fatal even with consent`, async () => {
    let calls = 0;
    await assert.rejects(callVisionWithFallback(images, chain, async () => {
      calls++;
      return new Response('auth failed', { status });
    }, true), error => error instanceof ProviderError && !error.retryable && error.message.includes(String(status)));
    assert.equal(calls, 1);
  });
}

test('invalid local image data is fatal before any network request', async () => {
  let calls = 0;
  await assert.rejects(callVisionWithFallback(['not an image'], chain, async () => {
    calls++;
    return success();
  }, true), error => error instanceof ProviderError && error.status === 400 && !error.retryable);
  assert.equal(calls, 0);
});

test('exhaustion is bounded by supplied candidates and preserves final upstream error', async () => {
  let calls = 0;
  await assert.rejects(callVisionWithFallback(images, chain, async () => {
    calls++;
    return new Response('model unavailable', { status: calls === chain.length ? 404 : 503 });
  }, false), error => error instanceof ProviderError && error.status === 502 &&
    error.message.includes('gemini-2.5-flash') && error.message.includes('404'));
  assert.equal(calls, chain.length);
});

test('cross-provider fallback is allowed with explicit consent', async () => {
  const mixed = [chain[0], { name: 'openai', model: 'other', apiKey: 'test-key' }];
  const result = await callVisionWithFallback(images, mixed, async url => {
    if (url.includes('generativelanguage')) return new Response('busy', { status: 503 });
    return Response.json({ choices: [{ message: { content: JSON.stringify(recipe) } }] });
  }, true);
  assert.equal(result.provider, 'openai');
});

for (const status of [400, 404, 429, 500, 503]) {
  test(`same-provider model fallback after upstream ${status} needs no cross-provider consent`, async () => {
    const urls = [];
    const result = await callVisionWithFallback(images, chain, async url => {
      urls.push(url);
      return urls.length === 1 ? new Response('upstream rejected', { status }) : success();
    }, false);
    assert.equal(result.model, chain[1].model);
    assert.equal(urls.length, 2);
    assert.ok(urls.every(url => url.startsWith('https://generativelanguage.googleapis.com/')));
  });
}
