#!/usr/bin/env node
// Recreates the "Courtyard Candlestick" concept (Courtyard Urbanist, 2026-10-05) in this app: 1,105
// courtyard-building footprints with levels and heights on the 271-acre Candlestick Point site, as one
// building design per block of the concept (the index links at most 200 designs to one agreement, and
// the concept has about 106 blocks), published with one agreement through lib/restatement-publish.mjs.
// Each block design is content on the ground it stands on (goal 'buildings'): its footprints keep their
// own heights and source identity. --dry-run builds and prints the design objects without network access.
//
//   node scripts/import-candlestick-courtyard.mjs --source <Candlestick_FG3D_Editable_Design.json> --dry-run
//   node scripts/import-candlestick-courtyard.mjs --source <file> --designs --api <api> [--origin <app>] --apply
//   node scripts/import-candlestick-courtyard.mjs --source <file> --capture --app <app> --api <api>
//   node scripts/import-candlestick-courtyard.mjs --source <file> --agreement --api <api> [--origin <app>] [--app <app>] --apply
//
// Inputs and provenance: scripts/data/candlestick/README.md.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';
import * as turf from '@turf/turf';
import { polygonBuildingParts } from './lib/building-import-geometry.mjs';
import { CITY, PARCEL_SOURCE_ID, bboxOf, groundFile } from './lib/candlestick-common.mjs';
import { log, runRestatementCli } from './lib/restatement-publish.mjs';

export const PLAN_KEY = 'candlestick-courtyard';
export const PLAN_TITLE = 'Courtyard Candlestick: 1,105 courtyard buildings, about 16,400 homes, no towers';
export const AUTHOR = 'Courtyard Urbanist';
// The concept's publication date.
export const AUTHORED_AT = '2026-10-05T00:00:00.000Z';
// NAD83 / UTM zone 10N, the model's coordinate system (metres).
const EPSG_26910 = '+proj=utm +zone=10 +ellps=GRS80 +datum=NAD83 +units=m +no_defs';
const FLOOR_HEIGHT_M = 3.2; // only when a building carries no floorplate heights
const NO_BLOCK = 'unassigned';
const SOURCE_LINKS = Object.freeze({
    concept: 'https://candlestick-project.aliciapederson.chatgpt.site/',
    substack: 'https://urbancourtyard.substack.com/p/san-francisco-could-have-a-dense',
    post: 'https://x.com/UrbanCourtyard/status/2107220982914220531'
});

// ---- geometry -----------------------------------------------------------------------------

const toWgs84 = proj4(EPSG_26910, 'EPSG:4326');

function ringToWgs84(ring) {
    const out = ring.map(([x, y]) => {
        const [lon, lat] = toWgs84.forward([x, y]);
        return [lon, lat];
    });
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
    return out;
}

function polygonToWgs84(polygon) {
    return polygon.map(ringToWgs84).filter(ring => ring.length >= 4);
}

// A ring is real when it has at least three distinct vertices; a one-point or collinear "polygon"
// is a modelling artefact. Footprints are Polygons or (25 of them) MultiPolygons; every usable
// polygon part is kept and the geometry type follows what survived.
function usableRing(ring) {
    if (!Array.isArray(ring) || ring.length < 4) return false;
    const distinct = new Set(ring.map(([x, y]) => `${Number(x).toFixed(3)},${Number(y).toFixed(3)}`));
    return distinct.size >= 3;
}

export function footprintToWgs84(geometry) {
    if (!geometry || !Array.isArray(geometry.coordinates)) return null;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    const converted = polygons.filter(polygon => Array.isArray(polygon) && usableRing(polygon[0])).map(polygonToWgs84);
    if (!converted.length) return null;
    return converted.length === 1
        ? { type: 'Polygon', coordinates: converted[0] }
        : { type: 'MultiPolygon', coordinates: converted };
}

export function buildingHeightM(building) {
    const tops = (building.occupied_floorplates || [])
        .map(plate => Number(plate && plate.properties && plate.properties.z_top_m))
        .filter(value => Number.isFinite(value) && value > 0);
    if (tops.length) return Number(Math.max(...tops).toFixed(2));
    const levels = Number(building.source_control_properties && building.source_control_properties.levels);
    return Number.isFinite(levels) && levels > 0 ? Number((levels * FLOOR_HEIGHT_M).toFixed(2)) : null;
}

export function convertBuildings(model) {
    const features = [];
    const dropped = [];
    const levelsHistogram = {};
    let footprintM2 = 0;
    for (const building of model.buildings || []) {
        const convertedFootprint = footprintToWgs84(building.footprint_utm_m);
        const footprint = convertedFootprint ? turf.cleanCoords(turf.feature(convertedFootprint)).geometry : null;
        const height = footprint ? buildingHeightM(building) : null;
        if (!footprint || height === null) { dropped.push(building.id); continue; }
        const control = building.source_control_properties || {};
        const levels = Number.isFinite(Number(control.levels)) ? Number(control.levels) : null;
        if (levels !== null) levelsHistogram[levels] = (levelsHistogram[levels] || 0) + 1;
        footprintM2 += Number(building.footprint_area_m2) || 0;
        features.push({
            type: 'Feature',
            properties: {
                type: 'proposedBuildingSingle',
                id: building.id,
                block: building.block_id || null,
                name: control.program || null,
                levels,
                floors: levels,
                storeys: levels,
                height,
                heightM: height,
                source: 'Courtyard Candlestick published design model',
                sourceBuildingId: building.id,
                sourceBlockId: building.block_id || null,
                sourceControlProperties: control,
                sourceFootprintAreaM2: building.footprint_area_m2 ?? null
            },
            geometry: footprint
        });
    }
    return { features, dropped, levelsHistogram, footprintM2: Math.round(footprintM2) };
}

// ---- the record ---------------------------------------------------------------------------

function describe(model, stats) {
    const scope = model.scope || {};
    const assumptions = model.program_assumptions || {};
    return [
        'The Courtyard Candlestick concept: the whole 271.6-acre Candlestick Point site as a fine-grained neighborhood of small',
        `perimeter buildings around protected courtyards, instead of the approved tower-and-podium plan. ${stats.features.length} buildings on`,
        `${scope.block_count || 106} small radial blocks around three car-free piazzas (Bayview, Candlestick civic, Harney), joined by ring and`,
        'radial streets, with a 44.8-acre shore promenade, four neighborhood gardens, an athletic park and 98 shared garages.',
        '',
        `Program as published: about 16,400 homes (16,133,601 sq ft of residential space at ${assumptions.average_apartment_net_area_sf || 900} sq ft`,
        'net and 91.5% efficiency), about 6,560 of them three- and four-bedroom; 1,386,765 sq ft of commercial and office space;',
        '238,290 sq ft of school and recreation space; 60 homes per acre against 27 in the official plan. Most buildings are five or',
        'six storeys (9.75 to 21.95 m); an optional 26-level tower on the civic piazza is not included here.',
        '',
        `Recreated from the author's published model (schema ${model.schema_version || '3.0.1'}, release ${model.release || 'CND-2026-10-05-FG3D-FINAL'},`,
        `EPSG:26910 metres, reprojected to WGS84). Footprints and heights are the model's; streets, piazzas and parks are not`,
        'drawn as separate proposals here. Concept page: ' + SOURCE_LINKS.concept + ' · write-up: ' + SOURCE_LINKS.substack + ' · announcement: ' + SOURCE_LINKS.post
    ].filter(Boolean).join(' ');
}

/**
 * The plan's design records: one building design per block of the concept (its footprints, each split
 * into polygons without picking a largest part), blocks in the model's order.
 * @returns [{ key, record }]
 */
export function buildDesigns({ model, stats, sourceSha256 }) {
    const description = describe(model, stats);
    const blocks = new Map();
    polygonBuildingParts(stats.features).forEach((building, index) => {
        const rawSourceId = building.properties.id;
        if (rawSourceId === undefined || rawSourceId === null || rawSourceId === '') throw new Error(`Building at output index ${index} has no stable source ID.`);
        const block = building.properties.sourceBlockId ? String(building.properties.sourceBlockId) : NO_BLOCK;
        if (!blocks.has(block)) blocks.set(block, []);
        blocks.get(block).push(building);
    });
    return [...blocks.entries()].map(([block, buildings]) => {
        const slug = block.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
        return {
            key: `${slug}-${createHash('sha256').update(block).digest('hex').slice(0, 8)}`,
            record: {
                goal: 'buildings',
                title: `${PLAN_TITLE} — block ${block} (${buildings.length} building${buildings.length === 1 ? '' : 's'})`,
                description,
                author: AUTHOR,
                city: CITY,
                createdAt: AUTHORED_AT,
                geometry: { buildings },
                buildingProposal: {
                    typologyType: 'single',
                    createdFrom: 'blockify',
                    blockName: `Candlestick Point ${block}`,
                    parameters: {
                        typology: 'single',
                        rotation: 0,
                        footprintMode: 'polygon',
                        source: {
                            schema: model.schema_version || null,
                            release: model.release || null,
                            createdUtc: model.created_utc || null,
                            sha256: sourceSha256,
                            crs: 'EPSG:26910',
                            links: SOURCE_LINKS,
                            blockId: block === NO_BLOCK ? null : block
                        }
                    },
                    ineligibleParcels: []
                }
            }
        };
    });
}

// ---- main ---------------------------------------------------------------------------------------------

/** The Courtyard plan from the concept model at `source`: its designs and where its ground file lives. */
export function courtyardPlan(source) {
    if (!source) {
        throw Object.assign(new Error('--source <Candlestick_FG3D_Editable_Design.json> is required (scripts/data/candlestick/README.md says where to get it)'), { stated: true });
    }
    const sourceBytes = fs.readFileSync(path.resolve(source));
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    const model = JSON.parse(sourceBytes.toString('utf8'));
    log(`source ${path.basename(source)} sha256 ${sourceSha256} (${model.release || 'release unknown'}, ${(model.buildings || []).length} buildings)`);
    const stats = convertBuildings(model);
    const designs = buildDesigns({ model, stats, sourceSha256 });
    const heights = stats.features.map(feature => feature.properties.height);
    log(`converted ${stats.features.length} buildings into ${designs.length} block designs, dropped ${stats.dropped.length}${stats.dropped.length ? ` (${stats.dropped.slice(0, 5).join(', ')}${stats.dropped.length > 5 ? ', …' : ''})` : ''}`);
    log(`levels ${JSON.stringify(stats.levelsHistogram)} · heights ${Math.min(...heights)}–${Math.max(...heights)} m · footprints ${stats.footprintM2} m² · bbox ${bboxOf(stats.features).join(', ')}`);
    return {
        key: PLAN_KEY,
        title: PLAN_TITLE,
        author: AUTHOR,
        city: CITY,
        parcelSourceId: PARCEL_SOURCE_ID,
        groundFile: groundFile(PLAN_KEY),
        designs
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runRestatementCli({
        script: 'backend/scripts/import-candlestick-courtyard.mjs',
        describe: 'the Courtyard Candlestick concept',
        planKeys: [PLAN_KEY],
        options: { source: { type: 'string', description: 'The concept model JSON (Candlestick_FG3D_Editable_Design.json). Required by every step.' } },
        plans: async values => [courtyardPlan(values.source)]
    });
}
