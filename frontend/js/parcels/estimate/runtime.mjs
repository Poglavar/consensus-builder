// Fetch small imagery/context inputs and own a cancellable worker; no cadastral writes.
import { tilePlan, prepareSample } from './area.mjs?v=20261020-viewport';
export const ATTRIBUTION = '© <a href="https://www.maptiler.com/copyright/">MapTiler</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
export function runWorker(input, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs?v=20261020', import.meta.url), { type: 'module' });
    const finish = (error, result) => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); worker.terminate();
      error ? reject(error) : resolve(result);
    };
    const cancel = () => finish(new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('processing')), 60000);
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }) => data.error ? finish(new Error('processing')) : finish(null, data);
    worker.onerror = () => finish(new Error('processing'));
    if (signal.aborted) return cancel();
    worker.postMessage(input, [input.rgba.buffer]);
  });
}
export async function generate({ area, settings, signal, base, tileUrl, onProgress }) {
  const networkSignal = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  onProgress('loading');
  const contextUrl = `${base}/parcel-estimate/context?crs=EPSG:4326&bbox=${area.bounds.join(',')}`;
  const response = await fetch(contextUrl, { signal: networkSignal });
  if (!response.ok) throw new Error(response.status === 429 ? 'busy' : 'context');
  const context = await response.json();
  if (context.partial || context.truncated || !Array.isArray(context.features) || context.features.length > 5000) throw new Error('context');
  const { width, height } = area;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }), tiles = tilePlan(area);
  // At most nine tiles, three requests at a time; exact Mercator placement without map labels.
  for (let i = 0; i < tiles.length; i += 3) {
    await Promise.all(tiles.slice(i, i + 3).map(async tile => {
      const image = await fetch(tileUrl(tile), { signal: networkSignal });
      if (!image.ok) throw new Error(image.status === 429 ? 'busy' : 'imagery');
      const blob = await image.blob();
      if (blob.size > 4 * 1024 * 1024) throw new Error('imagery');
      const bitmap = await createImageBitmap(blob);
      try { ctx.drawImage(bitmap, tile.dx, tile.dy, tile.size, tile.size); } finally { bitmap.close(); }
    }));
  }
  const rgba = ctx.getImageData(0, 0, width, height).data;
  if (rgba.some((v, i) => i % 4 === 3 && v !== 255)) throw new Error('imagery');
  const imageHash = await hash(rgba), contextHash = await hash(new TextEncoder().encode(JSON.stringify(context)));
  const sample = prepareSample(area, context, imageHash, contextHash);
  const imageUrl = canvas.toDataURL('image/jpeg', 0.92);
  onProgress('processing');
  const result = await runWorker({ sample, rgba, settings, width, height }, signal);
  signal.throwIfAborted();
  return { ...result, imageUrl };
}
