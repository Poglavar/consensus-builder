// A building source read from a city model in sheets (tiles): each request maps its box onto the
// source's sheet grid, reads the sheets it needs (kept in memory), and answers near with the real
// LOD2 surfaces and footprints/footprintsUnder from their ground surfaces. A city's config says how a
// sheet is read: a zipped CityGML file (readZippedCityGml) or a CityJSON API box (wien-lod2.js,
// nl-3dbag.js). A sheet the city does not publish is empty; any other failure is an error.
import * as turf from '@turf/turf';
import proj4 from 'proj4';
import { unzipSync, strFromU8 } from 'fflate';
import { createRequire } from 'node:module';
import { parseCityGml, buildingRecord } from './citygml.js';

const require = createRequire(import.meta.url);
const { createFootprintProvider } = require('../../frontend/js/footprint-provider.js');

const MAX_SHEETS = 16;
const SHEET_CACHE = 64;

// The buildings of one zipped CityGML sheet at url, or [] when it is not published (404).
export async function readZippedCityGml(url, fetchImpl, label) {
    const response = await fetchImpl(url);
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const gml = Object.keys(files).filter(name => /\.(gml|xml)$/i.test(name));
    if (!gml.length) throw new Error(`${label}: the archive holds no CityGML file`);
    return gml.flatMap(name => parseCityGml(strFromU8(files[name])));
}

// config: { id, crs (proj4 definition), heightOffsetM, sheetsFor([minX, minY, maxX, maxY]) → [sheet ids],
// readSheet(sheet, { fetchImpl }) → parsed buildings (citygml.js shape), attribution }. fetchImpl and
// log are injectable for tests.
export function createCityGmlSource(config, { fetchImpl = fetch, log = console } = {}) {
    const toLngLat = proj4(config.crs, 'EPSG:4326');
    const sheets = new Map();

    async function readSheet(sheet) {
        if (sheets.has(sheet)) {
            const entry = sheets.get(sheet);
            sheets.delete(sheet); sheets.set(sheet, entry);
            return entry;
        }
        const entry = (async () => {
            const started = Date.now();
            const records = (await config.readSheet(sheet, { fetchImpl }))
                .map(building => buildingRecord(building, (x, y) => toLngLat.forward([x, y]),
                    { heightOffsetM: config.heightOffsetM || 0, idPrefix: `${config.id}:` }))
                .filter(Boolean);
            log.log(`[${new Date().toISOString()}] [${config.id}] sheet ${sheet}: ${records.length} buildings in ${Date.now() - started} ms`);
            return records;
        })();
        sheets.set(sheet, entry);
        if (sheets.size > SHEET_CACHE) sheets.delete(sheets.keys().next().value);
        entry.catch(() => sheets.delete(sheet));
        return entry;
    }

    // The sheets under a WGS84 box, or null when the box needs more than MAX_SHEETS.
    function sheetsUnder([west, south, east, north]) {
        const corners = [[west, south], [east, south], [east, north], [west, north]].map(point => toLngLat.inverse(point));
        const xs = corners.map(point => point[0]), ys = corners.map(point => point[1]);
        const ids = config.sheetsFor([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
        return ids.length > MAX_SHEETS ? null : ids;
    }

    async function recordsIn(bbox) {
        const ids = sheetsUnder(bbox);
        if (!ids) return { records: [], truncated: true };
        const byId = new Map();
        for (const sheet of await Promise.all(ids.map(readSheet))) {
            for (const entry of sheet) {
                const box = turf.bbox({ type: 'Polygon', coordinates: entry.record.faces.flatMap(face => face.coordinates) });
                if (box[2] < bbox[0] || box[0] > bbox[2] || box[3] < bbox[1] || box[1] > bbox[3]) continue;
                byId.set(entry.record.object_id, entry); // a building on a sheet edge appears on both sheets
            }
        }
        return { records: [...byId.values()], truncated: false };
    }

    const stock = createFootprintProvider({
        turf,
        sources: { near: config.id, footprints: config.id },
        label: config.id,
        async featuresIn(bbox) {
            const { records, truncated } = await recordsIn(bbox);
            return {
                truncated,
                features: records.filter(entry => entry.footprint).map(entry => ({
                    type: 'Feature', id: entry.record.object_id, geometry: entry.footprint,
                    properties: { measured_height_m: entry.heightM, levels: entry.storeys }
                }))
            };
        }
    });

    async function near(geometry, bufferMeters = 0) {
        const buffered = bufferMeters > 0 ? turf.buffer(turf.feature(geometry), bufferMeters, { units: 'meters' }) : turf.feature(geometry);
        const { records, truncated } = await recordsIn(turf.bbox(buffered));
        const buildings = records.map(entry => entry.record);
        return { buildings, count: buildings.length, source: config.id, ...(truncated ? { partial: true } : {}),
            attribution: config.attribution };
    }

    return { near, footprints: stock.footprints, footprintsUnder: stock.footprintsUnder };
}
