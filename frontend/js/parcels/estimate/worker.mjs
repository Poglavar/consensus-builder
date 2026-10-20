// Generate and vectorize one bounded estimate away from the map's UI thread.
import { compute } from './core.mjs?v=20261020';
import { vectorize } from './geometry.mjs?v=20261020';
import { geographic } from './area.mjs?v=20261020';
self.onmessage = ({ data }) => {
  try {
    const result = compute(data);
    const collection = vectorize(result, data.sample, data.settings, { seeds: [], dividers: [] }, {
      toWgs84: point => geographic(point.map(v => v / data.sample.mercator_scale))
    });
    self.postMessage({ collection, stats: result.stats });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
