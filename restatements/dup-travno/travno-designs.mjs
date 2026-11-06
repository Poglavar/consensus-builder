// The DUP Travno (1971) restatement's designs (README.md), built from the committed data only:
// data/buildings.geojson (the masses extract-plan.py reads off the plan sheet, EPSG:3765) and
// data/obuhvat.geojson (the plan's register entry) and data/bindings.json (the parcels each building
// binds, record-bindings.mjs). The buildings are freeform designs whose footprints are their own land, as
// the plan's era parcelled Travno (a tower's cadastral parcel is the tower); buildings that bind a common
// parcel are one design. No network, no database.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const turf = require('@turf/turf');
const proj4 = require('proj4');

proj4.defs('EPSG:3765', '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs');

export const CITY = 'zagreb';
export const PLAN_KEY = 'dup-travno';
export const AUTHOR = 'DUP Travno (Urbanistički zavod grada Zagreba, 1971)';
// The sheet's own date: "Plan visina izgradnje, broja i strukture stanova", 7. 9. 1971.
export const PLAN_DATE = '1971-09-07T00:00:00.000Z';
const SOURCE = 'Izvedeno iz kartografskog prikaza "Plan visina izgradnje, broja i strukture stanova" (1:1000, 7. 9. 1971),'
    + ' DUP stambenog naselja Travno, SGGZ 11/72 (geoportal.zagreb.hr, sloj PUP/DUP).';
// Overlap between two designs' footprints that is drawing noise (m²); more than this is refused.
const MAX_OVERLAP_M2 = 0.5;

const data = name => JSON.parse(readFileSync(fileURLToPath(new URL(`./data/${name}`, import.meta.url)), 'utf8'));
const round = value => Math.round(value * 1e8) / 1e8;
const toWgs = ([x, y]) => proj4('EPSG:3765', 'EPSG:4326', [x, y]).map(round);
const polygonToWgs = rings => rings.map(ring => ring.map(toWgs));
const area = geometry => turf.area(turf.feature(geometry));
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many));

function difference(geometry, cut) {
    if (!cut) return geometry;
    const rest = turf.difference(turf.feature(geometry), turf.feature(cut));
    return rest ? rest.geometry : null;
}

function union(geometries) {
    if (!geometries.length) return null;
    if (geometries.length === 1) return geometries[0];
    return geometries.slice(1).reduce((merged, geometry) => turf.union(merged, turf.feature(geometry)), turf.feature(geometries[0])).geometry;
}

// Polygon parts of a (Multi)Polygon, dropping slivers a subtraction leaves.
function partsOf(geometry, minM2 = 1) {
    if (!geometry) return [];
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.map(coordinates => ({ type: 'Polygon', coordinates })).filter(polygon => area(polygon) >= minM2);
}

/** The plan's buildings, in claim order, each with its parts in WGS84 (low parts never under a high one). */
export function travnoBuildings() {
    const features = data('buildings.geojson').features;
    const keys = [...new Set(features.map(feature => feature.properties.key))];
    return keys.map(key => {
        const own = features.filter(feature => feature.properties.key === key);
        const meta = { ...own[0].properties };
        const high = own.filter(feature => feature.properties.part !== 'low').map(feature => ({ type: 'Polygon', coordinates: polygonToWgs(feature.geometry.coordinates) }));
        const highUnion = union(high);
        const low = own.filter(feature => feature.properties.part === 'low')
            .flatMap(feature => partsOf(difference({ type: 'Polygon', coordinates: polygonToWgs(feature.geometry.coordinates) }, highUnion)));
        const parts = [
            ...high.map(geometry => ({ geometry, heightM: meta.heightM, storeys: meta.storeys, part: own[0].properties.part === 'whole' ? 'whole' : 'high' })),
            ...low.map(geometry => ({ geometry, heightM: meta.lowHeightM, storeys: 1, part: 'low' }))
        ];
        return { key, meta, parts };
    });
}

// Each design takes only ground no earlier design took: what simplification makes two neighbours share is
// cut from the later one, and anything beyond drawing noise is refused.
function withoutOverlaps(buildings) {
    let taken = null;
    return buildings.map(building => {
        const parts = building.parts.flatMap(part => {
            const before = area(part.geometry);
            const rest = partsOf(difference(part.geometry, taken));
            const lost = before - rest.reduce((sum, geometry) => sum + area(geometry), 0);
            if (lost > MAX_OVERLAP_M2) throw new Error(`${building.key}: ${lost.toFixed(1)} m² overlaps an earlier building`);
            return rest.map(geometry => ({ ...part, geometry }));
        });
        taken = union([...(taken ? [taken] : []), ...parts.map(part => part.geometry)]);
        return { ...building, parts };
    });
}

function flatsText(flats) {
    if (!flats) return '';
    const total = Object.values(flats).reduce((sum, n) => sum + n, 0);
    const mix = Object.entries(flats).map(([type, n]) => `${n} ${type}`).join(', ');
    return ` ${total} ${plural(total, 'stan', 'stana', 'stanova')} (${mix})`;
}

// One building's sentence for a design's description, and its short name for a title.
function buildingText(building) {
    const { meta, parts } = building;
    const footprintM2 = Math.round(parts.reduce((sum, part) => sum + area(part.geometry), 0));
    const highM2 = Math.round(parts.filter(part => part.part !== 'low').reduce((sum, part) => sum + area(part.geometry), 0));
    if (meta.kind === 'residential') {
        return `Blok ${meta.block}: ${meta.label}.${flatsText(meta.flats)}, ${meta.netFlatAreaM2} m² stambene površine prema tablici plana;`
            + ` tlocrt ${footprintM2} m², od toga ${highM2} m² pune visine, ostatak prizemni dijelovi (${meta.lowHeightM} m, svjetliji ton plana visina).`;
    }
    return `${meta.name[0].toUpperCase()}${meta.name.slice(1)}, označena "${meta.label}"${meta.note ? ` (${meta.note})` : ''}; tlocrt ${footprintM2} m², namjena na ovom listu nije označena.`;
}
// A group's title: its blocks, then its public buildings by name, or by count when there are many.
function groupName(group) {
    const blocks = group.filter(building => building.meta.kind === 'residential').map(building => building.meta.block);
    const publicNames = group.filter(building => building.meta.kind !== 'residential').map(building => building.meta.name);
    const blockText = blocks.length ? `${blocks.length === 1 ? 'stambeni blok' : 'stambeni blokovi'} ${blocks.join(', ')}` : '';
    const publicText = publicNames.length > 2
        ? `${publicNames.length} ${plural(publicNames.length, 'javna građevina', 'javne građevine', 'javnih građevina')}`
        : publicNames.join(' i ');
    return [blockText, publicText].filter(Boolean).join(blockText && publicText ? ' i ' : '');
}

/**
 * Buildings whose land binds a common cadastral parcel, as groups in plan order: a freeform building
 * replaces the parcels it binds, so two designs binding one parcel would displace each other (the app
 * refuses that), and such buildings are one design. bindings: { key: [parcelId] } (data/bindings.json).
 */
export function groupByBinding(buildings, bindings) {
    const parent = new Map(buildings.map(building => [building.key, building.key]));
    const find = key => (parent.get(key) === key ? key : find(parent.get(key)));
    const holder = new Map();
    for (const building of buildings) {
        const parcels = bindings[building.key];
        if (!Array.isArray(parcels) || !parcels.length) throw new Error(`${building.key}: no recorded binding (run record-bindings.mjs)`);
        for (const parcel of parcels) {
            if (holder.has(parcel)) parent.set(find(building.key), find(holder.get(parcel)));
            else holder.set(parcel, building.key);
        }
    }
    const groups = new Map();
    for (const building of buildings) {
        const root = find(building.key);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(building);
    }
    return [...groups.values()];
}

function groupDesign(group) {
    const residential = group.filter(building => building.meta.kind === 'residential');
    const title = group.length === 1
        ? (residential.length ? `DUP Travno – stambeni blok ${group[0].meta.block}` : `DUP Travno – ${group[0].meta.name} (${group[0].meta.label})`)
        : `DUP Travno – ${groupName(group)}`;
    const tallest = group.reduce((top, building) => (building.meta.heightM > top.meta.heightM ? building : top), group[0]);
    const blockName = `DUP Travno ${group.map(building => building.key).join('+')}`;
    return {
        key: group.map(building => building.key).join('+'),
        record: {
            goal: 'single',
            title,
            description: `${group.map(buildingText).join(' ')} ${SOURCE}`,
            author: AUTHOR,
            city: CITY,
            createdAt: PLAN_DATE,
            geometry: {
                buildings: group.flatMap(building => building.parts.map(part => ({
                    type: 'Feature',
                    properties: { type: 'proposedBuildingSingle', height: part.heightM, levels: part.storeys, rotation: 0,
                        block: building.meta.kind === 'residential' ? `DUP Travno ${building.meta.block}` : `DUP Travno ${building.meta.name}` },
                    geometry: part.geometry
                })))
            },
            buildingProposal: { typologyType: 'single', blockName, parameters: { typology: 'single', floors: tallest.meta.storeys, height: tallest.meta.heightM, rotation: 0 } }
        }
    };
}

/** Every drawn building in plan order (residential blocks first), its parts free of overlaps with earlier ones. */
export function planBuildings() {
    const order = building => (building.meta.kind === 'residential' ? 0 : 1);
    return withoutOverlaps(travnoBuildings()).sort((a, b) => order(a) - order(b));
}

/** The plan: one freeform building design per group of buildings that bind a common parcel. */
export function travnoPlan() {
    const register = data('obuhvat.geojson').features[0].properties;
    const { buildings: bindings } = data('bindings.json');
    return {
        key: PLAN_KEY,
        title: 'DUP Travno (1971)',
        author: AUTHOR,
        city: CITY,
        // The imported Croatian cadastre in the app database, as the app binds a Zagreb design.
        parcelSourceId: 'oss-wfs',
        groundFile: fileURLToPath(new URL(`./ground/${PLAN_KEY}.json`, import.meta.url)),
        register,
        designs: groupByBinding(planBuildings(), bindings).map(groupDesign)
    };
}
