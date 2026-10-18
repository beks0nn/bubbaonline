import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAssetLoader } from '../../public/cast-assets.mjs';

const descriptor = (value, path = 'assets/Tibia.spr') => ({ path, size: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') });
function storage() {
  const entries = new Map();
  const cache = {
    match: async url => entries.get(url)?.clone(),
    put: async (url, response) => { entries.set(url, response.clone()); },
    delete: async request => entries.delete(request.url ?? request),
    keys: async () => [...entries.keys()].map(url => ({ url })),
  };
  return { entries, cache, open: async () => cache };
}
test('a return visit reuses verified bytes without a network request', async () => {
  const cacheStorage = storage();
  const asset = descriptor('sprites');
  const first = createAssetLoader({ base: '/cast-client', cacheStorage, fetcher: async () => new Response('sprites') });
  await first.load(asset);
  const progress = [];
  const second = createAssetLoader({ base: '/cast-client', cacheStorage,
    fetcher: () => { throw new Error('Network must not be used'); },
    onProgress: (...args) => progress.push(args),
  });
  assert.equal(new TextDecoder().decode(await second.load(asset)), 'sprites');
  assert.equal(progress.at(-1)[2], true);
});
test('changed assets download and obsolete versions are removed', async () => {
  const cacheStorage = storage();
  const first = createAssetLoader({ base: '/cast-client', cacheStorage, fetcher: async () => new Response('old') });
  await first.load(descriptor('old'));
  let requests = 0;
  const second = createAssetLoader({ base: '/cast-client', cacheStorage, fetcher: async () => { requests++; return new Response('new'); } });
  await second.load(descriptor('new'));
  await second.prune();
  assert.equal(requests, 1);
  assert.deepEqual([...cacheStorage.entries.keys()], [second.urlFor(descriptor('new'))]);
});
test('corrupt cache entries are fetched again and repaired', async () => {
  const cacheStorage = storage();
  const asset = descriptor('correct');
  let requests = 0;
  const loader = createAssetLoader({ base: '/cast-client', cacheStorage, fetcher: async () => { requests++; return new Response('correct'); } });
  cacheStorage.entries.set(loader.urlFor(asset), new Response('corrupt'));
  assert.equal(new TextDecoder().decode(await loader.load(asset)), 'correct');
  assert.equal(requests, 1);
});
test('bad downloads are rejected and never saved', async () => {
  for (const body of ['bad', 'too long', 'no']) {
    const cacheStorage = storage();
    const loader = createAssetLoader({ base: '/cast-client', cacheStorage, fetcher: async () => new Response(body) });
    await assert.rejects(loader.load(descriptor('yes')));
    assert.equal(cacheStorage.entries.size, 0);
  }
});
test('blocked storage and quota failures still allow viewing', async () => {
  const quota = storage();
  quota.cache.put = async () => { throw new Error('Quota exceeded'); };
  for (const cacheStorage of [{ open: async () => { throw new Error('Storage blocked'); } }, quota]) {
    let unavailable = false;
    const loader = createAssetLoader({ base: '/cast-client', cacheStorage, fetcher: async () => new Response('yes'),
      onStorageUnavailable: () => { unavailable = true; },
    });
    assert.equal(new TextDecoder().decode(await loader.load(descriptor('yes'))), 'yes');
    assert.equal(unavailable, true);
  }
});
