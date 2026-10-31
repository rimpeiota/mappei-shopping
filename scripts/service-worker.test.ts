import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const serviceWorker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://shopping.invalid';
const cachedHome = '<html><body>Home starts automatic sync</body></html>';

type NavigationRequest = { method: 'GET'; mode: 'navigate'; url: string };
type NavigationEvent = {
  request: NavigationRequest;
  respondWith(response: Promise<Response>): void;
};

function worker(networkResponse?: Response) {
  const listeners = new Map<string, (event: NavigationEvent) => void>();
  const cacheReads: string[] = [];
  const cacheWrites: string[] = [];
  const networkRequests: string[] = [];

  runInNewContext(serviceWorker, {
    URL,
    Response,
    self: {
      location: { origin },
      addEventListener(type: string, listener: (event: NavigationEvent) => void) {
        listeners.set(type, listener);
      },
    },
    caches: {
      async match(key: string) {
        cacheReads.push(key);
        return key === '/' ? new Response(cachedHome) : undefined;
      },
      async open() {
        return {
          async put(key: string) { cacheWrites.push(key); },
        };
      },
    },
    async fetch(request: NavigationRequest) {
      networkRequests.push(request.url);
      if (!networkResponse) throw new TypeError('Network unavailable');
      return networkResponse;
    },
  }, { filename: 'public/sw.js' });

  return {
    cacheReads,
    cacheWrites,
    networkRequests,
    async navigate(path: string): Promise<Response> {
      const listener = listeners.get('fetch');
      assert.ok(listener, 'service worker must register its actual fetch handler');
      let pending: Promise<Response> | undefined;
      listener({
        request: { method: 'GET', mode: 'navigate', url: `${origin}${path}` },
        respondWith(response) { pending = response; },
      });
      assert.ok(pending, 'navigation must be handled through respondWith');
      return pending;
    },
  };
}

test('offline Home navigation retains its cached shell fallback', async () => {
  const sw = worker();
  const response = await sw.navigate('/');

  assert.equal(response.status, 200);
  assert.equal(await response.text(), cachedHome);
  assert.deepEqual(sw.networkRequests, [`${origin}/`]);
  assert.deepEqual(sw.cacheReads, ['/']);
  assert.deepEqual(sw.cacheWrites, []);
});

test('offline recovery navigation cannot load cached Home and start automatic sync', async () => {
  const sw = worker();
  const response = await sw.navigate('/recover');

  assert.equal(response.status, 503);
  assert.match(response.headers.get('content-type') ?? '', /^text\/plain/);
  assert.notEqual(await response.text(), cachedHome);
  assert.deepEqual(sw.networkRequests, [`${origin}/recover`]);
  assert.deepEqual(sw.cacheReads, [], 'recovery must not read the cached Home shell');
  assert.deepEqual(sw.cacheWrites, []);
});

test('online recovery navigation returns its network response without caching Home', async () => {
  const network = new Response('<html><body>Recovery</body></html>', {
    headers: { 'Content-Type': 'text/html' },
  });
  Object.defineProperty(network, 'url', { value: `${origin}/recover` });
  const sw = worker(network);
  const response = await sw.navigate('/recover');

  assert.equal(response, network);
  assert.equal(await response.text(), '<html><body>Recovery</body></html>');
  assert.deepEqual(sw.networkRequests, [`${origin}/recover`]);
  assert.deepEqual(sw.cacheReads, []);
  assert.deepEqual(sw.cacheWrites, []);
});
