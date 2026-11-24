// The public Kazakh cadastre uses the same functional-zone geometry and IDs in every city.
import { bbox as geometryBounds } from '@turf/turf';
import { clipToBounds } from '../display-clip.js';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { validateGeometry } from '../../parcels/source-contract.js';
import { withSourceProposal, sourceRevision } from '../source-proposal.js';

export const genplanService = 'https://map.gov4c.kz/ggkgs/ows';
export const genplanLayer = 'kz:gpzone';

const upstream = message => Object.assign(new Error(message), { status: 503, code: 'planning-source-unavailable' });
const spatialReference = Object.freeze({ horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' });
const unzip = promisify(gunzip);
const readSnapshot = async filename => JSON.parse((await unzip(await readFile(new URL(`../data/${filename}`, import.meta.url)))).toString('utf8'));

export function createKzGenplanProvider(descriptor, { interpretZone, rulesEvidence, effect = 'obligatory', snapshot = readSnapshot }) {
    const { layer, service, admterrId } = descriptor;
    let index;
    function load() {
        return index ??= Promise.resolve().then(() => snapshot(descriptor.snapshotFilename)).then(data => {
            if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('Invalid feature collection');
            const byId = new Map();
            for (const feature of data.features) {
                const id = feature?.properties?.object_id_i32;
                if (String(feature?.properties?.admterr_id) !== admterrId) continue;
                if (feature.type !== 'Feature' || !Number.isSafeInteger(id) || id < 0 || byId.has(String(id)) || !validateGeometry(feature.geometry)) {
                    throw new Error('Invalid or duplicate zone');
                }
                byId.set(String(id), { feature, bbox: geometryBounds(feature) });
            }
            const rows = [...byId.values()].sort((a, b) => a.feature.properties.object_id_i32 - b.feature.properties.object_id_i32);
            return { rows, byId };
        }).catch(error => {
            index = null;
            throw upstream(`General plan snapshot ${descriptor.id} could not be read (${error.message}).`);
        });
    }
    const versions = new WeakMap();
    function record(feature, displayGeometry, city = descriptor.city, scenario = descriptor.scenario) {
        const p = feature.properties, reading = interpretZone(p), recordId = String(p.object_id_i32);
        const id = `${descriptor.id}:${recordId}`;
        const site = validateGeometry(displayGeometry) ? displayGeometry : null;
        const title = [reading.use, reading.heightLabel, reading.implementationLabel].filter(Boolean).join(' · ');
        let version = versions.get(feature);
        if (!version) {
            version = sourceRevision({ id: recordId, geometry: feature.geometry, properties: p });
            versions.set(feature, version);
        }
        return withSourceProposal({
            id, role: 'permitted', title, site, areas: site ? [{ id: `${id}:area`, geometry: site }] : [], volumes: [], spatialReference,
            source: { ...descriptor, city: city || descriptor.city, scenario, recordId, version,
                ...(descriptor.kind === 'regulation' ? { publishedAt: descriptor.edition } : {}) },
            authority: { effect, basis: 'source-summary', applicability: 'unresolved' },
            assessment: { meaning: 'zoning-area', status: reading.status, reason: reading.reason, ...(reading.reasonCode ? { reasonCode: reading.reasonCode } : {}), geometry: 'source-area', constraints: 'not-evaluated', current: true },
            // The zone's use in the shared vocabulary (docs/vocabulary.md, Permitted use): a key the app
            // translates, a group the map colours by, and the plan's own words.
            use: { key: reading.useKey, group: reading.useGroup, label: reading.use, stage: reading.stage },
            ...(reading.landBasis ? { landBasis: reading.landBasis } : {}),
            metrics: { floorAreaM2: null, heightM: reading.heightM,
                // The asterisked class (6* этажей): taller only on the condition the legend's note sets.
                ...(reading.uplift ? { conditional: { heightM: Math.round(reading.uplift.storeys * reading.storeyHeightM * 100) / 100,
                    storeys: reading.uplift.storeys, condition: reading.uplift.condition, conditionCode: reading.uplift.conditionCode } } : {}) },
            constraints: reading.status === 'allowed' ? reading.constraints.map(item => ({ ...item, scenario })) : [],
            sourceEvidence: { layer, service, properties: p, interpretation: reading, ...(reading.uplift ? { uplift: reading.uplift } : {}), rules: rulesEvidence }
        });
    }
    return {
        descriptor,
        async query(_pool, { bbox, limit, after = null, scenario = descriptor.scenario, city }) {
            if (after !== null && !/^\d{1,7}$/.test(String(after))) throw Object.assign(new Error('Invalid source cursor'), { status: 400 });
            const { rows } = await load();
            const [w, s, e, n] = bbox;
            const matches = rows.filter(({ bbox: [west, south, east, north] }) => west <= e && east >= w && south <= n && north >= s);
            const start = after === null ? 0 : Number(after);
            const page = matches.slice(start, start + limit);
            const items = page.flatMap(({ bbox: [west, south, east, north], feature }) => {
                const geometry = w <= west && s <= south && east <= e && north <= n ? feature.geometry : clipToBounds(feature, bbox);
                return geometry ? [record(feature, geometry, city, scenario)] : [];
            });
            const statuses = {};
            for (const { assessment: { status } } of items) {
                if (status != null) statuses[status] = (statuses[status] || 0) + 1;
            }
            return { items, nextAfter: start + page.length < matches.length ? String(start + page.length) : null, omitted: 0,
                summary: { sourceId: descriptor.id, cachedResults: items.length, withGeometry: items.length, withoutGeometry: 0, statuses } };
        },
        async record(_pool, { recordId, city, scenario }) {
            if (!/^\d{1,10}$/.test(String(recordId))) return [];
            const { byId } = await load();
            const feature = byId.get(String(recordId))?.feature;
            return feature ? [record(feature, feature.geometry, city, scenario)] : [];
        }
    };
}
