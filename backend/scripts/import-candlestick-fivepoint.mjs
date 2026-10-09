#!/usr/bin/env node
// Recreates the approved FivePoint plan for Candlestick Point (2024 Modified Project Variant) as a
// building proposal: a massing read off the plan's own height map and block plan — one footprint per
// height zone of each development block (40–180 ft), eleven tower boxes A–K at their encouraged
// locations (220–420 ft), mid-block breaks kept open — on the same 271-acre site as the courtyard
// concept, so the two stand in one contest. Published through the normal API (site binding first).
// Without --apply nothing is posted: the conversion is validated, summarized and written to --out.
//
//   node scripts/import-candlestick-fivepoint.mjs [--apply]
//
// Inputs and provenance: scripts/data/candlestick/README.md (the fivepoint/ layers).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as turf from '@turf/turf';
import { canonicalSeedRecord } from './lib/canonical-seed-record.mjs';
import { DEFAULTS as COMMON, bboxOf, publish, siteCoveringFootprints, siteFromBoundary } from './lib/candlestick-common.mjs';

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
        `  --boundary <path>         Site boundary GeoJSON, WGS84 (default ${path.relative(process.cwd(), DEFAULTS.boundary)}).`,
        `  --backend <url>           API to publish to (default ${DEFAULTS.backend}).`,
        `  --origin <url>            Origin header for the write gate (default ${DEFAULTS.origin}; localhost only outside production).`,
        `  --city <id>               City id (default ${DEFAULTS.city}).`,
        `  --proposal-id <id>        Stable proposal id (default ${DEFAULTS.proposalId}); an existing one is left alone.`,
        `  --expires-in-days <n>     Expiry from now so a pool on it can auto-settle (default ${DEFAULTS.expiresInDays}; 0 = never).`,
        `  --out <path>              Where the converted record is written (default ${path.relative(process.cwd(), DEFAULTS.out)}).`,
        '  --apply                   Bind the site and POST the proposal. Without it: convert, validate, summarize, write --out.',
        '  --help                    This text.'
    ].join('\n'));
    process.exit(code);
}

function parseCli() {
    const { values } = parseArgs({
        options: {
            layers: { type: 'string' }, boundary: { type: 'string' }, backend: { type: 'string' }, origin: { type: 'string' },
            city: { type: 'string' }, 'proposal-id': { type: 'string' }, 'expires-in-days': { type: 'string' }, out: { type: 'string' },
            apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false }
        },
        strict: true
    });
    if (values.help) usage(0);
    const expiresInDays = values['expires-in-days'] === undefined ? DEFAULTS.expiresInDays : Number(values['expires-in-days']);
    if (!Number.isInteger(expiresInDays) || expiresInDays < 0) throw new Error('--expires-in-days must be a non-negative integer');
    return {
        layers: path.resolve(values.layers || DEFAULTS.layers),
        boundary: path.resolve(values.boundary || DEFAULTS.boundary),
        backend: (values.backend || DEFAULTS.backend).replace(/\/+$/, ''),
        origin: values.origin || DEFAULTS.origin,
        city: values.city || DEFAULTS.city,
        proposalId: values['proposal-id'] || DEFAULTS.proposalId,
        expiresInDays,
        out: path.resolve(values.out || DEFAULTS.out),
        apply: values.apply
    };
}

// ---- geometry -----------------------------------------------------------------------------

function round7(geometry) {
    return turf.truncate(turf.feature(geometry), { precision: 7, coordinates: 2, mutate: false }).geometry;
}

function largestPolygon(geometry) {
    if (!geometry) return null;
    if (geometry.type === 'Polygon') return geometry;
    if (geometry.type === 'MultiPolygon') {
        let best = null; let bestArea = 0;
        for (const coordinates of geometry.coordinates) {
            const area = turf.area(turf.polygon(coordinates));
            if (area > bestArea) { best = { type: 'Polygon', coordinates }; bestArea = area; }
        }
        return best;
    }
    return null;
}

// A height-zone polygon pulled in from its edges so neighbouring zones do not touch; falls back to
// the zone itself when the inset collapses (slivers).
function insetFootprint(geometry, insetM = ZONE_INSET_M) {
    let inset = null;
    try { inset = turf.buffer(turf.feature(geometry), -insetM, { units: 'meters' }); } catch (_) { inset = null; }
    const shrunk = inset && inset.geometry ? largestPolygon(inset.geometry) : null;
    return shrunk && turf.area(turf.feature(shrunk)) > 0 ? shrunk : largestPolygon(geometry);
}

// Mid-block breaks stay open: cut them out of the footprints they cross.
function withoutBreaks(geometry, breaks) {
    let current = turf.feature(geometry);
    const box = turf.bbox(current);
    for (const brk of breaks) {
        const other = turf.bbox(brk);
        if (other[0] > box[2] || box[0] > other[2] || other[1] > box[3] || box[1] > other[3]) continue;
        try {
            const cut = turf.difference(current, brk); // turf 6.5: two features
            if (cut && cut.geometry) current = cut;
        } catch (_) { /* keep the uncut footprint rather than lose it */ }
    }
    return largestPolygon(current.geometry) || geometry;
}

// A tower floorplate: a square of TOWER_SIDE_M around the encouraged location, clipped to its block.
function towerFootprint(point, block, sideM = TOWER_SIDE_M) {
    const center = turf.point(point);
    const half = (sideM / 2) * Math.SQRT2 / 1000; // km to the corners
    const corners = [45, 135, 225, 315].map(bearing => turf.destination(center, half, bearing, { units: 'kilometers' }).geometry.coordinates);
    let square = turf.polygon([[...corners, corners[0]]]);
    if (block) {
        try {
            const clipped = turf.intersect(square, turf.feature(block)); // turf 6.5: two features
            if (clipped && clipped.geometry) square = turf.feature(largestPolygon(clipped.geometry) || square.geometry);
        } catch (_) { /* unclipped square */ }
    }
    return square.geometry;
}

function storeys(heightM) {
    return Math.max(1, Math.round(heightM / FLOOR_M));
}

/**
 * Convert the digitized layers into building features (WGS84), one per height zone of every
 * development block that is not a park, plus one per tower.
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
        const footprint = round7(withoutBreaks(insetFootprint(zone.geometry), breakFeatures));
        const heightM = Number((heightFt * FT).toFixed(2));
        heightsFt[heightFt] = (heightsFt[heightFt] || 0) + 1;
        features.push({
            type: 'Feature',
            properties: {
                type: 'proposedBuilding',
                id: `${props.block_id}-${index}`,
                block: props.block_id,
                name: `${landUse} · ${heightFt} ft`,
                neighborhood: block.properties.neighborhood || null,
                landUse,
                levels: storeys(heightM),
                height: heightM,
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
                type: 'proposedBuilding',
                id: `tower-${props.tower}`,
                block: props.block_id || null,
                name: `Tower ${props.tower} · ${heightFt} ft`,
                neighborhood: block ? block.properties.neighborhood || null : null,
                landUse: block ? String(block.properties.land_use || '') : null,
                levels: storeys(heightM),
                height: heightM,
                source: 'encouraged tower location'
            },
            geometry: round7(towerFootprint(tower.geometry.coordinates, block ? block.geometry : null))
        });
    }
    const footprintM2 = Math.round(features.reduce((sum, feature) => sum + turf.area(feature), 0));
    return { features, skippedBlocks: Array.from(new Set(skippedBlocks)), heightsFt, footprintM2, blockCount: blockById.size };
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
        `for Development block plans), georeferenced to within a few metres: ${stats.features.length} volumes, one per height zone of each`,
        `development block plus the eleven towers at their encouraged locations. It is a faithful envelope, not the developer's building`,
        `designs. Sources: ${SOURCE_LINKS.ocii} · ${SOURCE_LINKS.documents}`
    ].join(' ');
}

function buildRecord({ program, stats, site, city, proposalId, expiresInDays }) {
    const now = new Date();
    const expiresAt = expiresInDays > 0 ? new Date(now.getTime() + expiresInDays * 86400000).toISOString() : null;
    const title = 'Candlestick Point as approved (FivePoint, 2024 plan): 7,218 homes, 11 towers up to 420 ft';
    return {
        proposalId,
        city,
        type: 'building',
        goal: 'buildings',
        typologyType: 'block',
        primaryType: 'Buildings',
        name: title,
        title,
        description: describe(program, stats),
        author: 'FivePoint (approved plan)',
        lifecycleStatus: 'Active',
        applied: false,
        termsConfirmed: true,
        createdAt: now.toISOString(),
        ...(expiresAt ? { expiresAt } : {}),
        site,
        // Binding tolerance (metres): the figures' traced boundary and DataSF's outline differ by
        // centimetres along the edge, and the server ignores footprint slivers narrower than this.
        toleranceM: 0.5,
        cadastreParcelIds: [],
        geometry: { buildings: stats.features },
        buildingProposal: {
            typologyType: 'block',
            createdFrom: 'import',
            blockName: 'Candlestick Point',
            parameters: {
                mode: 'imported',
                source: {
                    plan: '2024 Modified Project Variant (FEIR Addendum 7, Aug 2024; 2024 Design for Development)',
                    digitized: 'scripts/data/candlestick/fivepoint (vector figure content, similarity fit to the DataSF boundary)',
                    links: SOURCE_LINKS
                },
                buildings: stats.features.length,
                developmentBlocks: stats.blockCount,
                heightsFt: stats.heightsFt,
                footprintM2: stats.footprintM2,
                zoneInsetM: ZONE_INSET_M,
                towerSideM: TOWER_SIDE_M
            },
            ineligibleParcels: []
        },
        tags: ['buildings', 'candlestick-point', 'approved-plan']
    };
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
    const boundary = siteFromBoundary(JSON.parse(fs.readFileSync(cli.boundary, 'utf8')));
    const covering = siteCoveringFootprints(boundary, stats.features);
    if (covering.widened.length) log(`site widened by ${covering.widened.length} footprint(s) that cross the boundary: ${covering.widened.slice(0, 6).join(', ')}${covering.widened.length > 6 ? ', …' : ''}`);
    const record = buildRecord({ program, stats, site: covering.site, city: cli.city, proposalId: cli.proposalId, expiresInDays: cli.expiresInDays });
    canonicalSeedRecord(record);
    const heights = stats.features.map(feature => feature.properties.height);
    log(`converted ${stats.features.length} volumes from ${stats.blockCount} blocks (${stats.features.filter(f => f.properties.source === 'height zone').length} height zones + ${stats.features.filter(f => f.properties.source !== 'height zone').length} towers); skipped ${stats.skippedBlocks.length}${stats.skippedBlocks.length ? `: ${stats.skippedBlocks.join(', ')}` : ''}`);
    log(`heights (ft → count) ${JSON.stringify(stats.heightsFt)} · ${Math.min(...heights)}–${Math.max(...heights)} m · footprints ${stats.footprintM2} m²`);
    log(`bbox ${bboxOf(stats.features).join(', ')} · record ${(JSON.stringify(record).length / 1024).toFixed(0)} KB${record.expiresAt ? ` · expires ${record.expiresAt}` : ''}`);
    fs.mkdirSync(path.dirname(cli.out), { recursive: true });
    fs.writeFileSync(cli.out, JSON.stringify(record));
    log(`record written to ${cli.out}`);
    if (!cli.apply) { log('dry run: nothing posted (add --apply to publish)'); return; }
    const result = await publish(record, { backend: cli.backend, origin: cli.origin, city: cli.city });
    log(result.skipped ? 'done (existing)' : `done: ${cli.backend}/proposals/${result.id}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`[${new Date().toISOString()}] import failed:`, error);
        process.exit(1);
    });
}
