// Official OSTN15 transformation, with mandatory grid integrity and no Helmert fallback.
import proj4 from 'proj4';
import { sha256Hex } from './portable-hash.js';

export const OSTN15_GRID_SHA256 = 'bcb9c6b3b2760e2740fd80e2182fd2eec4e79038165bac703a9415ed1813dee2';
export const OSTN15_OPERATION = 'OSGB36 to ETRS89 (2), EPSG:7709, OSTN15 NTv2; ETRS89 geographic coordinates used as WGS84 ensemble coordinates without inferring an epoch';

const GRID_NAME = 'OSTN15_NTv2_OSGBtoETRS';
const OSGB36_OSTN15 = 'OSGB36-OSTN15';
const WGS84 = 'EPSG:4326';
const OSGB36_DEF = `+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +nadgrids=${GRID_NAME} +units=m +no_defs +type=crs`;
let initialized = false;

function asArrayBuffer(data) {
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    throw new TypeError('OSTN15 grid must be an ArrayBuffer or typed-array view');
}

/** Register the official OSTN15 NTv2 grid before using either transform. */
export async function initializeOstn15(gridData) {
    const grid = asArrayBuffer(gridData);
    if (grid.byteLength !== 15240384 || sha256Hex(new Uint8Array(grid)) !== OSTN15_GRID_SHA256) {
        throw new Error('OSTN15 grid integrity check failed');
    }
    if (initialized) return;
    proj4.nadgrid(GRID_NAME, grid);
    proj4.defs(OSGB36_OSTN15, OSGB36_DEF);
    initialized = true;
}

function transform(from, to, point, label) {
    if (!initialized) throw new Error('OSTN15 grid is not initialized');
    if (!Array.isArray(point) || point.length < 2 || !point.slice(0, 2).every(Number.isFinite)) {
        throw new TypeError(`${label} point must contain two finite numbers`);
    }
    const result = proj4(from, to).forward(point.slice(0, 2));
    if (!Array.isArray(result) || result.length < 2 || !result.slice(0, 2).every(Number.isFinite)) {
        throw new RangeError(`${label} point is outside OSTN15 grid coverage`);
    }
    return result.slice(0, 2);
}

/** Convert OSGB36 / British National Grid [easting, northing] to [longitude, latitude]. */
export function toWgs84(point) {
    return transform(OSGB36_OSTN15, WGS84, point, 'OSGB36');
}

/** Convert WGS84 [longitude, latitude] to OSGB36 / British National Grid [easting, northing]. */
export function fromWgs84(point) {
    return transform(WGS84, OSGB36_OSTN15, point, 'WGS84');
}
