// Immutable HMLR release scopes use their published routing frame.
// Public output uses OSTN15. Convert queries into the release frame mathematically, never by a fit.
import proj4 from 'proj4';
import { fromWgs84 } from './osgb36-projection.js';

const RELEASE_FRAME = '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.2470,0.8421,-20.4894 +units=m +no_defs';
const forward = proj4(RELEASE_FRAME, 'EPSG:4326');
export const hmlrRoutingProjection = Object.freeze({ forward: point => forward.forward(point) });

export function hmlrRoutingBounds([west, south, east, north]) {
    const points = [];
    // A query envelope is conservative metadata, not a change to any parcel geometry.
    for (let step = 0; step <= 8; step++) {
        const t = step / 8, lon = west + (east - west) * t, lat = south + (north - south) * t;
        for (const point of [[lon, south], [lon, north], [west, lat], [east, lat]]) {
            points.push(forward.forward(fromWgs84(point)));
        }
    }
    const pad = 1e-7;
    return [Math.min(...points.map(p => p[0])) - pad, Math.min(...points.map(p => p[1])) - pad,
        Math.max(...points.map(p => p[0])) + pad, Math.max(...points.map(p => p[1])) + pad];
}
