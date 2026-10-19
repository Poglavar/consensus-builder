// Keep segmentation and polygon union off the UI thread, and retain the last completed raster for export.
import { compute } from './core.mjs';
import { vectorize } from './geometry.mjs';
let prepared, completed;
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'prepare') { prepared = data; completed = null; }
    if (type === 'compute') {
      const start = performance.now(), result = compute({ ...prepared, ...data });
      completed = { result, settings: data.settings, edits: data.edits };
      self.postMessage({ id, type: 'result', result, elapsedMs: performance.now() - start });
    }
    if (type === 'export') {
      if (!completed) throw new Error('Generate plots before exporting.');
      await Promise.all([import('/data/vendor/polygon-clipping.js'), import('/data/vendor/proj4.js')]);
      const collection = vectorize(completed.result, prepared.sample, completed.settings, completed.edits,
        { union: globalThis.polygonClipping.union, project: globalThis.proj4 });
      self.postMessage({ id, type: 'export', collection });
    }
  } catch (error) { self.postMessage({ id, type: 'error', message: error.message }); }
};
