#!/usr/bin/env node
// Recreates the approved FivePoint plan for Candlestick Point (2024 Modified Project Variant) as
// Freeform buildings: massing read off the plan's own height map and block plan — connected pieces per
// height zone of each development block (40–180 ft), eleven tower boxes A–K at their encouraged
// locations (220–420 ft), mid-block breaks kept open. Each footprint is its own Freeform proposal,
// published through the normal API.
// Without --apply nothing is posted: the conversion is validated, summarized and written to --out.
//
//   node scripts/import-candlestick-fivepoint.mjs [--apply]
//
// Inputs and provenance: scripts/data/candlestick/README.md (the fivepoint/ layers).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as turf from '@turf/turf';
import { canonicalSeedRecord } from './lib/canonical-seed-record.mjs';
import { partitionBuildingFootprints, polygonBuildingParts } from './lib/building-import-geometry.mjs';
import { DEFAULTS as COMMON, bboxOf, publish } from './lib/candlestick-common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = Object.freeze({
    ...COMMON,
    layers: path.join(HERE, 'data/candlestick/fivepoint'),
    proposalId: 'sf-candlestick-fivepoint-2024',
    out: path.join(HERE, '../../output/candlestick-fivepoint-proposal.json')
});
const FT = 0.3048;
const FLOOR_M = 3.2;            // storeys ≈ height / 3.2 m (residential floor-to-floor)
const ZONE_INSET_M = 1.5;       // keeps neighbouring zones from sharing an edge in the massing
const TOWER_SIDE_M = 34;        // ≈ 110 ft, a typical residential tower floorplate
const EXCLUDED_LAND_USE = /parks and open space/i;
const SOURCE_LINKS = Object.freeze({
    ocii: 'https://sfocii.org/projects/hunters-point-shipyard-candlestick-point-2/overview',
    documents: 'https://sfocii.org/projects/hunters-point-shipyard-candlestick-point-2/document-library'
});

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

function usage(code = 0) {
    console.log([
        'Usage: node scripts/import-candlestick-fivepoint.mjs [options]',
        '',
        `  --layers <dir>            The digitized plan layers (default ${path.relative(process.cwd(), DEFAULTS.layers)}).`,
        `  --backend <url>           API to publish to (default ${DEFAULTS.backend}).`,
        `  --origin <url>            Origin header for the write gate (default ${DEFAULTS.origin}; localhost only outside production).`,
        `  --city <id>               City id (default ${DEFAULTS.city}).`,
        `  --proposal-id <id>        Stable proposal id (default ${DEFAULTS.proposalId}); an existing one is left alone.`,
        '  --source-proposal-id <id> Link replacement buildings to their published source proposal.',
        `  --expires-in-days <n>     Expiry from now so a pool on it can auto-settle (default ${DEFAULTS.expiresInDays}; 0 = never).`,
        `  --out <path>              Where the converted record is written (default ${path.relative(process.cwd(), DEFAULTS.out)}).`,
        '  --apply                   Bind and POST each building. Without it: convert, validate, summarize, write --out.',
        '  --help                    This text.'
    ].join('\n'));
    process.exit(code);
}

function parseCli() {
    const { values } = parseArgs({
        options: {
            layers: { type: 'string' }, backend: { type: 'string' }, origin: { type: 'string' },
            city: { type: 'string' }, 'source-proposal-id': { type: 'string' }, 'proposal-id': { type: 'string' }, 'expires-in-days': { type: 'string' }, out: { type: 'string' },
            apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false }
        },
        strict: true
    });
    if (values.help) usage(0);
    const expiresInDays = values['expires-in-days'] === undefined ? DEFAULTS.expiresInDays : Number(values['expires-in-days']);
    if (!Number.isInteger(expiresInDays) || expiresInDays < 0) throw new Error('--expires-in-days must be a non-negative integer');
    return {
        layers: path.resolve(values.layers || DEFAULTS.layers),
        backend: (values.backend || DEFAULTS.backend).replace(/\/+$/, ''),
        origin: values.origin || DEFAULTS.origin,
        city: values.city || DEFAULTS.city,
        proposalId: values['proposal-id'] || DEFAULTS.proposalId,
        sourceProposalId: values['source-proposal-id'] || null,
        expiresInDays,
        out: path.resolve(values.out || DEFAULTS.out),
        apply: values.apply
    };
}

// ---- geometry -----------------------------------------------------------------------------

function round7(geometry) {
    return turf.truncate(turf.feature(geometry), { precision: 7, coordinates: 2, mutate: false }).geometry;
}

// A height-zone polygon pulled in from its edges so neighbouring zones do not touch; falls back to
// the zone itself when the inset collapses (slivers).
function insetFootprint(geometry, insetM = ZONE_INSET_M) {
    const inset = turf.buffer(turf.feature(geometry), -insetM, { units: 'meters' });
    return inset && turf.area(inset) > 0 ? inset.geometry : geometry;
}

// Mid-block breaks stay open: cut them out of the footprints they cross.
function withoutBreaks(geometry, breaks) {
    let current = turf.feature(geometry);
    const box = turf.bbox(current);
    for (const brk of breaks) {
        const other = turf.bbox(brk);
        if (other[0] > box[2] || box[0] > other[2] || other[1] > box[3] || box[1] > other[3]) continue;
        current = turf.difference(current, brk); // turf 6.5: two features
        if (!current) return null;
    }
    return current.geometry;
}

// A tower floorplate: a square of TOWER_SIDE_M around the encouraged location, clipped to its block.
function towerFootprint(point, block, sideM = TOWER_SIDE_M) {
    const center = turf.point(point);
    const half = (sideM / 2) * Math.SQRT2 / 1000; // km to the corners
    const corners = [45, 135, 225, 315].map(bearing => turf.destination(center, half, bearing, { units: 'kilometers' }).geometry.coordinates);
    let square = turf.polygon([[...corners, corners[0]]]);
    if (block) {
        square = turf.intersect(square, turf.feature(block)); // turf 6.5: two features
        if (!square) throw new Error('The encouraged tower footprint does not intersect its block.');
    }
    return square.geometry;
}

function storeys(heightM) {
    return Math.max(1, Math.round(heightM / FLOOR_M));
}

/**
 * Convert the digitized layers into building features (WGS84), one per height zone of every
 * development block that is not a park, plus each tower; disconnected pieces are retained and
 * tower footprints are removed from lower volumes so all proposals can stand together.
 * @param {{ blocks: object, zones: object, towers: object, breaks?: object }} layers GeoJSON FeatureCollections
 */
export function convertPlan({ blocks, zones, towers, breaks = { features: [] } }) {
    const blockById = new Map((blocks.features || []).map(feature => [feature.properties.block_id, feature]));
    const skippedBlocks = [];
    const breakFeatures = (breaks.features || []).filter(feature => feature && feature.geometry);
    const features = [];
    const heightsFt = {};
    const zoneIndexByBlock = new Map();
    for (const zone of zones.features || []) {
        const props = zone.properties || {};
        const block = blockById.get(props.block_id);
        if (!block) { skippedBlocks.push(`${props.block_id} (zone without a development block)`); continue; }
        const landUse = String(block.properties.land_use || '');
        if (EXCLUDED_LAND_USE.test(landUse)) { skippedBlocks.push(`${props.block_id} (${landUse})`); continue; }
        const heightFt = Number(props.height_ft);
        if (!Number.isFinite(heightFt) || heightFt <= 0) { skippedBlocks.push(`${props.block_id} (no height)`); continue; }
        const index = (zoneIndexByBlock.get(props.block_id) || 0) + 1;
        zoneIndexByBlock.set(props.block_id, index);
        const cut = withoutBreaks(insetFootprint(zone.geometry), breakFeatures);
        if (!cut) { skippedBlocks.push(`${props.block_id} (entire zone is a passage)`); continue; }
        const footprint = round7(cut);
        const heightM = Number((heightFt * FT).toFixed(2));
        heightsFt[heightFt] = (heightsFt[heightFt] || 0) + 1;
        features.push({
            type: 'Feature',
            properties: {
                type: 'proposedBuildingSingle',
                id: `${props.block_id}-${index}`,
                block: props.block_id,
                name: `${landUse} · ${heightFt} ft`,
                neighborhood: block.properties.neighborhood || null,
                landUse,
                levels: storeys(heightM),
                floors: storeys(heightM),
                storeys: storeys(heightM),
                height: heightM,
                heightM,
                source: 'height zone'
            },
            geometry: footprint
        });
    }
    for (const tower of towers.features || []) {
        const props = tower.properties || {};
        const heightFt = Number(props.max_height_ft);
        if (!Number.isFinite(heightFt) || heightFt <= 0 || !tower.geometry || tower.geometry.type !== 'Point') continue;
        const block = blockById.get(props.block_id);
        const heightM = Number((heightFt * FT).toFixed(2));
        heightsFt[heightFt] = (heightsFt[heightFt] || 0) + 1;
        features.push({
            type: 'Feature',
            properties: {
                type: 'proposedBuildingSingle',
                id: `tower-${props.tower}`,
                block: props.block_id || null,
                name: `Tower ${props.tower} · ${heightFt} ft`,
                neighborhood: block ? block.properties.neighborhood || null : null,
                landUse: block ? String(block.properties.land_use || '') : null,
                levels: storeys(heightM),
                floors: storeys(heightM),
                storeys: storeys(heightM),
                height: heightM,
                heightM,
                source: 'encouraged tower location'
            },
            geometry: round7(towerFootprint(tower.geometry.coordinates, block ? block.geometry : null))
        });
    }
    const connected = partitionBuildingFootprints(features);
    const footprintM2 = Math.round(connected.reduce((sum, feature) => sum + turf.area(feature), 0));
    Object.keys(heightsFt).forEach(height => delete heightsFt[height]);
    connected.forEach(feature => {
        const height = Math.round(feature.properties.height / FT);
        heightsFt[height] = (heightsFt[height] || 0) + 1;
    });
    return { features: connected, skippedBlocks: Array.from(new Set(skippedBlocks)), heightsFt, footprintM2, blockCount: blockById.size };
}

// ---- the record ---------------------------------------------------------------------------

function number(value) {
    return typeof value === 'number' ? value.toLocaleString('en-US') : String(value);
}

function describe(program, stats) {
    const res = program.residential || {};
    const nonRes = program.non_residential_gsf || {};
    const pick = (node) => (node && typeof node === 'object' && 'value' in node ? node.value : node);
    const homes = pick(res.homes_units) ?? 7218;
    const affordable = pick(res.affordable_units) ?? 2472;
    return [
        `The approved plan for Candlestick Point: the 2024 Modified Project Variant by FivePoint (CP Development Co.) with the Office of`,
        `Community Investment and Infrastructure, approved by OCII in September 2024 and the Board of Supervisors in October 2024; the final`,
        `map for the first major phase was approved on 16 June 2026 and construction began in September 2026 with about 700 homes.`,
        `Program: ${number(homes)} homes (${number(affordable)} affordable), about 2.8 million sq ft of office and R&D space in a 22-acre`,
        `Innovation District, 304,500 sq ft of retail, a 220-room hotel, 50,000 sq ft of community space, 69,000 sq ft of arts space and`,
        `14,191 parking spaces; 105.7 acres of parks, of which 96.7 are the existing state recreation area. The existing Bayview street`,
        `grid is extended across about 60 blocks in four neighborhoods (Alice Griffith, Candlestick North, Candlestick Center, Candlestick`,
        `South); heights are 40 to 85 ft on most blocks, up to 180 ft in the Innovation District, with eleven encouraged tower locations`,
        `A–K from 170 to 420 ft.`,
        `This massing was read off the plan's own figures (FEIR Addendum 7, August 2024, land-use and maximum-height maps; the 2024 Design`,
        `for Development block plans), georeferenced to within a few metres: ${stats.features.length} connected volumes from each height zone of each`,
        `development block plus the eleven towers at their encouraged locations. It is a faithful envelope, not the developer's building`,
        `designs. Towers own their footprints; lower volumes exclude the tower bases. Sources: ${SOURCE_LINKS.ocii} · ${SOURCE_LINKS.documents}`
    ].join(' ');
}

export function buildRecords({ program, stats, city, proposalId, expiresInDays, sourceProposalId = null }) {
    const now = new Date();
    const expiresAt = expiresInDays > 0 ? new Date(now.getTime() + expiresInDays * 86400000).toISOString() : null;
    const planTitle = 'Candlestick Point as approved (FivePoint, 2024 plan): 7,218 homes, 11 towers up to 420 ft';
    return polygonBuildingParts(stats.features).map((building, index) => {
        const sourceId = String(building.properties.id || index + 1);
        const slug = sourceId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'building';
        const idSuffix = `${slug}-${createHash('sha256').update(sourceId).digest('hex').slice(0, 8)}`;
        const title = `${planTitle} — ${building.properties.name || sourceId}`;
        const buildingProposal = {
            typologyType: 'single',
            createdFrom: 'blockify',
            blockName: 'Candlestick Point',
            parameters: {
                typology: 'single',
                height: building.properties.height,
                rotation: 0,
                footprintMode: 'polygon',
                source: {
                    plan: '2024 Modified Project Variant (FEIR Addendum 7, Aug 2024; 2024 Design for Development)',
                    digitized: 'scripts/data/candlestick/fivepoint (vector figure content, similarity fit to the DataSF boundary)',
                    links: SOURCE_LINKS,
                    featureId: sourceId,
                    sourceType: building.properties.source,
                    blockId: building.properties.block || null
                }
            },
            ineligibleParcels: []
        };
        return {
            proposalId: `${proposalId}-${idSuffix}`,
            city,
            ...(sourceProposalId ? { sourceProposalId: String(sourceProposalId) } : {}),
            type: 'building',
            goal: 'single',
            typologyType: 'single',
            primaryType: 'Urban Rule',
            name: title,
            title,
            description: describe(program, stats),
            author: 'FivePoint (approved plan)',
            lifecycleStatus: 'Active',
            applied: false,
            termsConfirmed: true,
            createdAt: now.toISOString(),
            ...(expiresAt ? { expiresAt } : {}),
            site: building.geometry,
            cadastreParcelIds: [],
            geometry: { buildings: [building] },
            buildingProposal,
            tags: ['buildings', 'candlestick-point', 'approved-plan']
        };
    });
}

// ---- main ---------------------------------------------------------------------------------

function readLayer(dir, name) {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}

async function main() {
    const cli = parseCli();
    const layers = {
        blocks: readLayer(cli.layers, 'blocks.geojson'),
        zones: readLayer(cli.layers, 'height_zones.geojson'),
        towers: readLayer(cli.layers, 'towers.geojson'),
        breaks: readLayer(cli.layers, 'mid_block_breaks.geojson')
    };
    const program = readLayer(cli.layers, 'program.json');
    const stats = convertPlan(layers);
    const records = buildRecords({ program, stats, city: cli.city, proposalId: cli.proposalId, expiresInDays: cli.expiresInDays, sourceProposalId: cli.sourceProposalId });
    records.forEach(canonicalSeedRecord);
    const heights = stats.features.map(feature => feature.properties.height);
    log(`converted ${stats.features.length} volumes from ${stats.blockCount} blocks (${stats.features.filter(f => f.properties.source === 'height zone').length} height zones + ${stats.features.filter(f => f.properties.source !== 'height zone').length} towers); skipped ${stats.skippedBlocks.length}${stats.skippedBlocks.length ? `: ${stats.skippedBlocks.join(', ')}` : ''}`);
    log(`heights (ft → count) ${JSON.stringify(stats.heightsFt)} · ${Math.min(...heights)}–${Math.max(...heights)} m · footprints ${stats.footprintM2} m²`);
    log(`bbox ${bboxOf(stats.features).join(', ')} · ${records.length} Freeform proposals · records ${(JSON.stringify(records).length / 1024).toFixed(0)} KB${records[0]?.expiresAt ? ` · expires ${records[0].expiresAt}` : ''}`);
    fs.mkdirSync(path.dirname(cli.out), { recursive: true });
    fs.writeFileSync(cli.out, JSON.stringify({ proposals: records }));
    log(`record written to ${cli.out}`);
    if (!cli.apply) { log('dry run: nothing posted (add --apply to publish)'); return; }
    let created = 0; let skipped = 0;
    for (const record of records) {
        const result = await publish(record, { backend: cli.backend, origin: cli.origin, city: cli.city });
        if (result.skipped) skipped++; else created++;
    }
    log(`done: ${created} created, ${skipped} existing`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`[${new Date().toISOString()}] import failed:`, error);
        process.exit(1);
    });
}
