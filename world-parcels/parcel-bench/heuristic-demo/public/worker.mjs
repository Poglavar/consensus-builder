// Keep segmentation and shared-border straightening off the UI thread; export the displayed geometry.
import { compute } from './core.mjs';
import { vectorize } from './geometry.mjs';
import { buildPlotGeometry } from './regularize.mjs';
let prepared, completed;
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'prepare') { prepared = data; completed = null; }
    if (type === 'compute') {
      const start = performance.now();
      await Promise.all([import('/data/vendor/polygon-clipping.js'), import('/data/vendor/topojson-server.js'), import('/data/vendor/topojson-client.js')]);
      const result = buildPlotGeometry(compute({ ...prepared, ...data }), prepared.sample,
        { union: globalThis.polygonClipping.union, topology: globalThis.topojson.topology, feature: globalThis.topojson.feature });
      completed = { result, settings: data.settings, edits: data.edits };
      self.postMessage({ id, type: 'result', result, elapsedMs: performance.now() - start });
    }
    if (type === 'export') {
      if (!completed) throw new Error('Generate plots before exporting.');
      await import('/data/vendor/proj4.js');
      const collection = vectorize(completed.result, prepared.sample, completed.settings, completed.edits,
        { project: globalThis.proj4 });
      self.postMessage({ id, type: 'export', collection });
    }
  } catch (error) { self.postMessage({ id, type: 'error', message: error.message }); }
};
