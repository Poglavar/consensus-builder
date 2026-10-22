// The UPU Borovje restatement's designs (README.md), built from the committed data only: the plan
// geometry in data/*.geojson through plan-topology.mjs (two streets, three parcel layouts of 17 plots)
// and flat-plan.mjs (the buildings fitted to their plots) is version 1; the committed corrections are
// replayed onto it in order: data/cadastral-snap.json (version 2, the plan's boundary on the cadastre)
// and data/streets-fit.json (version 3, streets take exactly their lanes). No network, no database.
// build-and-upload.mjs publishes the official plan and build-urban-blocks.mjs the urban-blocks
// alternative from the current version; snap-to-cadastre.mjs computes version 2 from version 1 and
// fit-streets.mjs version 3 from version 2.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildBorovjeTopology, roadDefinitionFor } from './plan-topology.mjs';
import { fitBuildingsToPlots } from './flat-plan.mjs';
import { buildingFeature, openBlock, streetSideOf, summarize } from '../../backend/scripts/lib/borovje-alternatives.mjs';

const turf = createRequire(new URL('../../backend/package.json', import.meta.url))('@turf/turf');

export const CITY = 'zagreb';
export const AUTHOR = 'UPU Borovje – zona jug (Grad Zagreb, prijedlog plana 2026)';
// The plan's own date: the draft UPU went to public consultation on 23 June 2026.
export const PLAN_DATE = '2026-06-23T00:00:00.000Z';
export const BLOCKS_AUTHOR = 'Urban Game Theory – alternativni prijedlog';
// The urban-blocks alternative was drawn on 10 October 2026.
export const BLOCKS_DATE = '2026-10-10T00:00:00.000Z';
export const CURRENT_VERSION = 3;
export const LAYOUT_KEYS = Object.freeze(['parcelacija-1', 'parcelacija-2', 'parcelacija-3']);
export const STREET_KEYS = Object.freeze({ main: 'ulice', west: 'ulice-zapad' });
export const PLAN_KEYS = Object.freeze({ official: 'upu-borovje', urbanBlocks: 'borovje-urbani-blokovi' });
const CORRECTIONS = Object.freeze({ 2: 'cadastral-snap.json', 3: 'streets-fit.json' });
const FLOOR_HEIGHT_M = 3.5;
// A building may leave its plot by rounding only.
const MAX_OUTSIDE_PLOT_M2 = 0.01;
// Per-kazeta rules from the plan's textual provisions (odredbe za provedbu): etažnost and above-ground
// utilisation coefficient per provedbeno pravilo. PP-5 is the existing housing row M1-12, kept as it is.
const PP_RULES = Object.freeze({
    'PP-1': { etaznost: 'P+3', kisn: 1.5 },
    'PP-2': { etaznost: 'P+4', kisn: 1.7 },
    'PP-3': { etaznost: 'P+8', kisn: 1.6 },
    'PP-4': { etaznost: 'P+5', kisn: 2.1 },
    'PP-5': { etaznost: 'P+1+Pk', kisn: null }
});
// Urban blocks: taller along the two city streets (Tigrovi on the north, Bonde on the west), lower inside.
const STREET_PLOTS = new Set(['m1-1', 'm1-2', 'm1-10', 'm1-11']);

const plotKey = name => String(name).toLowerCase();
const feature = geometry => ({ type: 'Feature', properties: {}, geometry });
const round1 = value => Math.round(value * 10) / 10;
const numberOf = key => Number(key.replace(/^[a-z0-9]+-/, ''));
const groundFile = name => fileURLToPath(new URL(`./ground/${name}.json`, import.meta.url));

async function data(name) {
    return JSON.parse(await readFile(new URL(`./data/${name}`, import.meta.url), 'utf8'));
}

// ---- the plan at a version ---------------------------------------------------------------------------

// Version 1: the plan as the UPU draws it, the ground cut into connected streets and plots.
async function baseState() {
    const [parcelation, streets, buildings, zones] = await Promise.all([
        data('parcelation.geojson'), data('streets.geojson'), data('buildings.geojson'), data('zones.geojson')
    ]);
    const topology = buildBorovjeTopology(parcelation, streets, turf);
    if (topology.readjustments.length !== LAYOUT_KEYS.length) {
        throw new Error(`expected ${LAYOUT_KEYS.length} connected blocks, found ${topology.readjustments.length}`);
    }
    const layouts = topology.readjustments.map((block, index) => ({
        key: LAYOUT_KEYS[index],
        index,
        pool: block.geometry,
        plots: block.plots.map(plot => ({ key: plotKey(plot.properties.name), name: plot.properties.name, kind: plot.properties.kind, geometry: plot.geometry }))
    }));
    const plotGeometry = name => layouts.flatMap(layout => layout.plots).find(plot => plot.name === name)?.geometry || null;
    const roads = [
        { key: STREET_KEYS.main, title: 'UPU Borovje – ulična mreža', streets: topology.roads.main.streets },
        { key: STREET_KEYS.west, title: 'UPU Borovje – ulična mreža (2)', streets: topology.roads.west.streets }
    ].map(road => {
        const source = road.key === STREET_KEYS.main ? topology.roads.main : topology.roads.west;
        return { ...road, definition: roadDefinitionFor(source.streets, source.geometry) };
    });
    // M1-12 (PP-5) is the existing housing row the plan keeps: nothing is built there.
    const built = buildings.features.filter(item => item.properties.pp !== 'PP-5')
        .sort((a, b) => numberOf(plotKey(a.properties.name)) - numberOf(plotKey(b.properties.name)));
    const fitted = fitBuildingsToPlots(built.map(item => ({ name: item.properties.name, geometry: item.geometry })), plotGeometry, turf);
    const buildingsOut = fitted.map((entry, index) => ({
        key: plotKey(entry.name),
        name: entry.name,
        pp: built[index].properties.pp,
        floors: built[index].properties.floors,
        areaM2: built[index].properties.area_m2,
        geometry: entry.geometry,
        trimmedM2: entry.trimmedM2
    }));
    // A park stands on its plot exactly: the R2 zone (traced as R2-0) on plot R2-1, each Z1 on its own.
    const parks = zones.features.map(zone => {
        const plotName = zone.properties.kind === 'R2' ? 'R2-1' : zone.properties.name;
        const geometry = plotGeometry(plotName);
        if (!geometry) throw new Error(`park ${zone.properties.name}: no plot ${plotName}`);
        return { key: plotKey(plotName), name: zone.properties.name, kind: zone.properties.kind, areaM2: zone.properties.area_m2, geometry };
    });
    return { version: 1, layouts, roads, buildings: buildingsOut, parks };
}

// One committed correction, member by member: a layout's pool and every one of its plots, a street's
// land (and, for the collector, its stretches), a park's footprint. Anything it names that the plan does
// not have, or a layout it changes only in part, is refused.
function applyCorrection(state, correction, version) {
    const members = { ...correction.members };
    const take = key => {
        const change = members[key];
        delete members[key];
        return change || null;
    };
    for (const layout of state.layouts) {
        const change = take(layout.key);
        if (!change) continue;
        const named = new Set(Object.keys(change.plots || {}));
        layout.pool = change.pool;
        layout.plots = layout.plots.map(plot => {
            const corrected = change.plots[plot.key];
            if (!corrected) throw new Error(`version ${version}: layout ${layout.key} has no plot ${plot.key}`);
            named.delete(plot.key);
            return { ...plot, geometry: corrected.geometry };
        });
        if (named.size) throw new Error(`version ${version}: layout ${layout.key} names plots it does not have: ${[...named].join(', ')}`);
    }
    for (const road of state.roads) {
        const change = take(road.key);
        if (!change) continue;
        const definition = { ...road.definition, polygon: change.polygon };
        if (change.segments) {
            // points and segments are the same polylines (road-drawing.js keeps them so); a stretch the
            // correction adds (the narrowed collector) comes with its id and cross-section.
            definition.segments = structuredClone(change.segments);
            definition.points = structuredClone(change.segments);
            if (change.segmentIds) definition.segmentIds = [...change.segmentIds];
            if (change.segmentProfiles) definition.segmentProfiles = structuredClone(change.segmentProfiles);
            if (definition.segmentIds.length !== definition.segments.length
                || definition.segmentIds.some(id => !definition.segmentProfiles[id])) {
                throw new Error(`version ${version}: every stretch of ${road.key} needs an id and a cross-section`);
            }
        }
        road.definition = definition;
    }
    for (const park of state.parks) {
        const change = take(park.key);
        if (change) park.geometry = change.geometry;
    }
    const unknown = Object.keys(members);
    if (unknown.length) throw new Error(`version ${version}: corrections for members the plan does not have: ${unknown.join(', ')}`);
    state.version = version;
}

// What every version keeps: a park is its plot, and a building stays on its plot.
function checkState(state) {
    const plots = new Map(state.layouts.flatMap(layout => layout.plots).map(plot => [plot.key, plot]));
    for (const park of state.parks) {
        const plot = plots.get(park.key);
        if (!plot || JSON.stringify(plot.geometry) !== JSON.stringify(park.geometry)) {
            throw new Error(`version ${state.version}: park ${park.name} is not exactly its plot ${park.key}`);
        }
    }
    for (const building of state.buildings) {
        const plot = plots.get(building.key);
        if (!plot) throw new Error(`version ${state.version}: building ${building.name} has no plot`);
        const outside = turf.difference(feature(building.geometry), feature(plot.geometry));
        const outsideM2 = outside ? turf.area(outside) : 0;
        if (outsideM2 > MAX_OUTSIDE_PLOT_M2) throw new Error(`version ${state.version}: building ${building.name} leaves its plot by ${outsideM2.toFixed(3)} m²`);
    }
}

/**
 * The plan at a version: 1 is the UPU as drawn, 2 adds the cadastral boundary, 3 (current) fits the
 * streets to their lanes.
 * @returns {Promise<{ version, layouts: [{ key, index, pool, plots: [{ key, name, kind, geometry }] }],
 *   roads: [{ key, title, streets, definition }], buildings: [{ key, name, pp, floors, areaM2, geometry,
 *   trimmedM2 }], parks: [{ key, name, kind, areaM2, geometry }] }>}
 */
export async function borovjeState(version = CURRENT_VERSION) {
    if (!Number.isInteger(version) || version < 1 || version > CURRENT_VERSION) {
        throw new Error(`UPU Borovje has versions 1 to ${CURRENT_VERSION}, not ${version}`);
    }
    const state = await baseState();
    for (let next = 2; next <= version; next += 1) applyCorrection(state, await data(CORRECTIONS[next]), next);
    checkState(state);
    return state;
}

// ---- design records ------------------------------------------------------------------------------------

function roadDesign(road) {
    const lengthM = Math.round(road.streets.reduce((sum, item) => sum + Number(item.properties?.length_m || 0), 0));
    return {
        key: road.key,
        record: {
            goal: 'road-track',
            title: road.title,
            description: `Planirana ulična mreža (${lengthM} m osi). Osi su izvedene iz kartografskog`
                + ' prikaza 2a. Prometni i komunikacijski sustav, UPU Borovje – zona jug'
                + ' (prijedlog plana za javnu raspravu, 2026).',
            author: AUTHOR,
            city: CITY,
            createdAt: PLAN_DATE,
            // A design has a site or a geometry of its own: a street's is its land.
            geometry: structuredClone(road.definition.polygon),
            roadProposal: { definition: structuredClone(road.definition), isCorridor: true }
        }
    };
}

// A layout of the plan's plots, drawn from its GeoJSON; the plots' names travel in the description
// only, in plot order (a parcel layout's plots are geometry).
function layoutDesign(layout) {
    return {
        key: layout.key,
        record: {
            goal: 'parcel-layout',
            title: `UPU Borovje – nova parcelacija – blok ${layout.index + 1}/${LAYOUT_KEYS.length}`,
            description: `Nova parcelacija povezanog bloka ${layout.index + 1} od ${LAYOUT_KEYS.length}; čestice redom: `
                + `${layout.plots.map(plot => plot.name).join(', ')}. Ulična mreža odvaja blok od ostalih dijelova obuhvata,`
                + ' pa je svaki od tri nepovezana bloka zaseban raspored čestica.',
            author: AUTHOR,
            city: CITY,
            createdAt: PLAN_DATE,
            site: structuredClone(layout.pool),
            parcelLayout: {
                algorithm: 'manual',
                generatedAt: PLAN_DATE,
                pool: structuredClone(layout.pool),
                totalArea: round1(turf.area(feature(layout.pool))),
                plots: layout.plots.map(plot => ({ geometry: structuredClone(plot.geometry), area: round1(turf.area(feature(plot.geometry))), source: 'geojson' }))
            }
        }
    };
}

// A building is content on its plot (goal 'buildings'): a freeform 'single' would take ground of its
// own and cut the plot a second time. The typology stays single for the geometry editor.
function buildingDesign(building) {
    const rule = PP_RULES[building.pp] || {};
    const height = Math.round(building.floors * FLOOR_HEIGHT_M * 10) / 10;
    return {
        key: building.key,
        record: {
            goal: 'buildings',
            title: `UPU Borovje – zgrada ${building.name} [${building.pp}]`,
            description: `Kazeta ${building.name}, pravilo provedbe [${building.pp}]: ${rule.etaznost}`
                + ` (${building.floors} nadzemnih etaža${rule.kisn ? `, kisn ${rule.kisn}` : ''}),`
                + ` površina za smještaj zgrade ${building.areaM2} m².`
                + ' Izvedeno iz kartografskog prikaza 4. Način i uvjeti gradnje,'
                + ' UPU Borovje – zona jug (prijedlog plana za javnu raspravu, 2026).',
            author: AUTHOR,
            city: CITY,
            createdAt: PLAN_DATE,
            geometry: {
                buildings: [{
                    type: 'Feature',
                    properties: { type: 'proposedBuildingSingle', height, rotation: 0, block: `UPU Borovje ${building.name}` },
                    geometry: structuredClone(building.geometry)
                }]
            },
            buildingProposal: { typologyType: 'single', parameters: { height, floors: building.floors, typology: 'single', rotation: 0 } }
        }
    };
}

function parkDesign(park) {
    const isRecreation = park.kind === 'R2';
    const title = isRecreation ? `UPU Borovje – rekreacija ${park.name} (otvorena igrališta)` : `UPU Borovje – javni park ${park.name}`;
    return {
        key: park.key,
        record: {
            goal: 'park',
            title,
            description: (isRecreation
                ? `Zona sportsko-rekreacijske namjene R2 (${park.areaM2} m²): otvoreni sportski tereni i igrališta.`
                : `Javna zelena površina – park Z1 (${park.areaM2} m²), uključuje dječja igrališta prema odredbama.`)
                + ' Izvedeno iz kartografskog prikaza 1. Korištenje i namjena površina,'
                + ' UPU Borovje – zona jug (prijedlog plana za javnu raspravu, 2026).',
            author: AUTHOR,
            city: CITY,
            createdAt: PLAN_DATE,
            geometry: structuredClone(park.geometry),
            structureProposal: { kind: 'park', geometry: structuredClone(park.geometry), blockName: `UPU Borovje ${park.name}` }
        }
    };
}

// "Borovje – urbani blokovi": on each of the same eleven building plots, an open urban block instead of
// the plan's free-standing slab: a 12 m deep ring along the plot edge with its park-facing middle left
// out, so the building holds the street and both ends and its yard opens onto the park.
function urbanBlockDesigns(state) {
    const plots = state.layouts.flatMap(layout => layout.plots);
    const sites = plots.filter(plot => /^m1-\d+$/.test(plot.key)).sort((a, b) => numberOf(a.key) - numberOf(b.key));
    if (sites.length !== 11) throw new Error(`expected 11 building plots M1-1…M1-11, found ${sites.length}`);
    const green = plots.filter(plot => /^(z1|r2)-/.test(plot.key)).map(plot => feature(plot.geometry))
        .reduce((union, next) => (union ? turf.union(union, next) : next), null).geometry;
    const buildings = [];
    const designs = sites.map(plot => {
        const block = openBlock(plot.geometry, { streetSide: streetSideOf(plot.geometry, green) });
        if (!block) throw new Error(`${plot.key}: no block fits`);
        const floors = STREET_PLOTS.has(plot.key) ? 6 : 5;
        const building = buildingFeature(plot.key, block.geometry, floors, { kind: block.kind });
        if (!turf.booleanWithin(building, feature(plot.geometry))) throw new Error(`${plot.key}: the block leaves its plot`);
        buildings.push(building);
        const label = plot.key.toUpperCase();
        const height = building.properties.height;
        const area = Math.round(turf.area(building));
        return {
            key: `blok-${plot.key}`,
            record: {
                goal: 'buildings',
                title: `Borovje – urbani blokovi: blok ${label}`,
                description: `Alternativa planu UPU Borovje – zona jug na istoj građevnoj čestici ${label}: otvoreni gradski blok `
                    + 'umjesto samostojeće lamele. Krilo dubine 12 m drži ulicu i oba kraja čestice, a dvorište se otvara prema parku. '
                    + `P+${floors - 1} (${floors} nadzemnih etaža, ${height} m), tlocrt ${area} m², oko ${area * floors} m² GBP. `
                    + 'Ulice, parcelacija i parkovi isti su kao u službenom planu.',
                author: BLOCKS_AUTHOR,
                city: CITY,
                createdAt: BLOCKS_DATE,
                geometry: {
                    buildings: [{
                        type: 'Feature',
                        geometry: building.geometry,
                        properties: { type: 'proposedBuildingSingle', block: `Borovje urbani blokovi ${label}`, height, levels: floors, rotation: 0 }
                    }]
                },
                buildingProposal: { typologyType: 'single', blockName: 'Borovje', parameters: { floors, height, rotation: 0, typology: 'single' } }
            }
        };
    });
    return { designs, total: summarize(buildings) };
}

// ---- plans ----------------------------------------------------------------------------------------------

/** The official plan at the current version: two streets, three parcel layouts, eleven buildings, six parks. */
export async function officialPlan() {
    const state = await borovjeState();
    return {
        key: PLAN_KEYS.official,
        title: 'UPU Borovje – zona jug',
        author: AUTHOR,
        city: CITY,
        parcelSourceId: null,
        groundFile: groundFile(PLAN_KEYS.official),
        designs: [
            ...state.roads.map(roadDesign),
            ...state.layouts.map(layoutDesign),
            ...state.buildings.map(buildingDesign),
            ...state.parks.map(parkDesign)
        ]
    };
}

/** The urban-blocks alternative: the official streets, layouts and parks, an open block on each building plot. */
export async function urbanBlocksPlan() {
    const state = await borovjeState();
    const blocks = urbanBlockDesigns(state);
    return {
        key: PLAN_KEYS.urbanBlocks,
        title: 'Borovje – urbani blokovi',
        author: BLOCKS_AUTHOR,
        city: CITY,
        parcelSourceId: null,
        groundFile: groundFile(PLAN_KEYS.urbanBlocks),
        blocks: blocks.total,
        designs: [
            ...state.roads.map(roadDesign),
            ...state.layouts.map(layoutDesign),
            ...blocks.designs,
            ...state.parks.map(parkDesign)
        ]
    };
}
