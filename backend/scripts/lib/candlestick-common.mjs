// Shared by the Candlestick Point importers (import-candlestick-courtyard.mjs and
// import-candlestick-fivepoint.mjs): the city and parcel source both plans are published against, where
// their ground files live, and the bounding box the importers log. Each importer builds its plan's
// building designs and publishes them with one agreement through restatement-publish.mjs.
import { fileURLToPath } from 'node:url';

export const CITY = 'san_francisco';
export const PARCEL_SOURCE_ID = 'us-ca-sf-datasf-active-parcels';

/** The committed ground file of a Candlestick plan (written by --capture). */
export const groundFile = planKey => fileURLToPath(new URL(`../data/candlestick/ground/${planKey}.json`, import.meta.url));

export function bboxOf(features) {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const feature of features) {
        const rings = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates : feature.geometry.coordinates.flat();
        for (const ring of rings) {
            for (const [lon, lat] of ring) {
                box[0] = Math.min(box[0], lon); box[1] = Math.min(box[1], lat);
                box[2] = Math.max(box[2], lon); box[3] = Math.max(box[3], lat);
            }
        }
    }
    return box.map(value => Number(value.toFixed(5)));
}
