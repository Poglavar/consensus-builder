// The existing XYZ/WMS gateway readers share source dispatch with other domains. Transport guards
// remain in publicFetch and decoded imagery configuration; no client URL is fetched unchecked.
import { createRequire } from 'node:module';
import { readImageryImage, warpGeographicImage, wmsMapUrl, xyzTileBounds, xyzTileUrl } from './discovery.js';
const Runtime = createRequire(import.meta.url)('../../frontend/js/source-runtime.js');

function reader(config, { publicFetch }) {
    return {
        async image(spec) {
            const downloaded = await readImageryImage(publicFetch, spec.url, { width: spec.width, height: spec.height });
            return spec.warp ? warpGeographicImage(downloaded, spec.bbox) : downloaded;
        }
    };
}
export const imagerySourceRegistry = Runtime.createRegistry({ abstraction: 'imagery', required: ['image', 'tileRequest'], adapters: {
    xyz: (config, context) => ({ ...reader(config, context),
        tileRequest: (z, x, y) => ({ url: xyzTileUrl(config, z, x, y) }) }),
    wms: (config, context) => ({ ...reader(config, context),
        tileRequest(z, x, y) {
            const bounds = xyzTileBounds(z, x, y);
            return { url: wmsMapUrl(config, bounds), bbox: bounds, width: 256, height: 256, warp: config.crs !== 'EPSG:3857' };
        },
        mapRequest: (bbox, width, height) => ({ url: wmsMapUrl(config, bbox, width, height), width, height }) })
} });
export function imageryReader(source, publicFetch) {
    return imagerySourceRegistry.open(Runtime.source('imagery', source.adapter, source, { kind: 'custom' }), { publicFetch });
}
