// Cache only verified, versioned viewer files. Storage failures must not stop viewing.
export function createAssetLoader({ base, cacheStorage = globalThis.caches, fetcher = globalThis.fetch,
  onProgress = () => {}, onStorageUnavailable = () => {} }) {
  const cachePromise = Promise.resolve().then(() => cacheStorage?.open('bubba-cast-assets-v1'))
    .catch(() => { onStorageUnavailable(); return null; });
  const used = new Set();
  const urlFor = asset => new URL(`${base}/${asset.path}?v=${asset.sha256}`, globalThis.location?.href ?? 'http://localhost').href;
  async function valid(bytes, asset) {
    if (bytes.length !== asset.size) return false;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    return hash === asset.sha256;
  }
  return {
    urlFor,
    async load(asset) {
      if (!asset || !Number.isSafeInteger(asset.size) || asset.size < 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid viewer manifest. Reload the page.');
      const url = urlFor(asset);
      used.add(url);
      const cache = await cachePromise;
      try {
        const saved = await cache?.match(url);
        if (saved) {
          const bytes = new Uint8Array(await saved.arrayBuffer());
          if (await valid(bytes, asset)) { onProgress(asset, bytes.length, true); return bytes; }
          await cache.delete(url);
        }
      } catch { onStorageUnavailable(); }
      const response = await fetcher(url);
      if (!response.ok) throw new Error(`Could not download viewer files (HTTP ${response.status}). Please retry.`);
      const bytes = new Uint8Array(asset.size);
      let offset = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (offset + value.length > bytes.length) throw new Error('Viewer download has an unexpected size. Please retry.');
            bytes.set(value, offset);
            offset += value.length;
            onProgress(asset, offset, false);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } else {
        const body = new Uint8Array(await response.arrayBuffer());
        if (body.length !== bytes.length) throw new Error('Incomplete viewer download. Please retry.');
        bytes.set(body); offset = body.length;
        onProgress(asset, offset, false);
      }
      if (offset !== asset.size || !await valid(bytes, asset)) throw new Error('Viewer download verification failed. Please retry.');
      try {
        if (cache) await cache.put(url, new Response(bytes));
        else onStorageUnavailable();
      } catch { onStorageUnavailable(); }
      return bytes;
    },
    async prune() {
      try {
        const cache = await cachePromise;
        for (const request of await cache?.keys() ?? []) if (!used.has(request.url)) await cache.delete(request);
      } catch { /* Storage is optional. */ }
    },
  };
}
