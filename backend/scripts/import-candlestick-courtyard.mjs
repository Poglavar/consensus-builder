#!/usr/bin/env node
// Recreates the "Courtyard Candlestick" concept (Courtyard Urbanist, 2026-10-05) as a building
// proposal in this app: 1,105 courtyard-building footprints with levels and heights, on the
// 271-acre Candlestick Point site, published as independent Freeform buildings through the normal
// API (site binding first, then each proposal) so the server rules apply as they do for a browser.
// Without --apply nothing is posted: the conversion is validated, summarized, and written to --out.
//
//   node scripts/import-candlestick-courtyard.mjs --source <Candlestick_FG3D_Editable_Design.json> [--apply]
//
// Inputs and provenance: scripts/data/candlestick/README.md.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import proj4 from 'proj4';
import * as turf from '@turf/turf';
import { canonicalSeedRecord } from './lib/canonical-seed-record.mjs';
import { polygonBuildingParts } from './lib/building-import-geometry.mjs';
import { DEFAULTS as COMMON, bboxOf, publish, publishNamedPlan } from './lib/candlestick-common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = Object.freeze({
    ...COMMON,
    proposalId: 'sf-candlestick-courtyard-2026',
    planSlug: 'candlestick-courtyard-2026',
    out: path.join(HERE, '../../output/candlestick-courtyard-proposal.json')
});
// NAD83 / UTM zone 10N, the model's coordinate system (metres).
const EPSG_26910 = '+proj=utm +zone=10 +ellps=GRS80 +datum=NAD83 +units=m +no_defs';
const FLOOR_HEIGHT_M = 3.2; // only when a building carries no floorplate heights
const SOURCE_LINKS = Object.freeze({
    concept: 'https://candlestick-project.aliciapederson.chatgpt.site/',
    substack: 'https://urbancourtyard.substack.com/p/san-francisco-could-have-a-dense',
    post: 'https://x.com/UrbanCourtyard/status/2107220982914220531'
});

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

function usage(code = 0) {
    console.log([
        'Usage: node scripts/import-candlestick-courtyard.mjs --source <design.json> [options]',
        '',
        '  --source <path>           The concept model JSON (Candlestick_FG3D_Editable_Design.json). Required.',
        `  --backend <url>           API to publish to (default ${DEFAULTS.backend}).`,
        `  --origin <url>            Origin header for the write gate (default ${DEFAULTS.origin}; localhost only outside production).`,
        `  --city <id>               City id (default ${DEFAULTS.city}).`,
        `  --proposal-id <id>        Stable proposal id (default ${DEFAULTS.proposalId}); an existing one is left alone.`,
        '  --source-proposal-id <id> Counterproposal lineage source row ID (for recreation of an existing record).',
        `  --plan-slug <slug>        Immutable named plan (default ${DEFAULTS.planSlug}).`,
        `  --expires-in-days <n>     Expiry from now so a market on it can auto-settle (default ${DEFAULTS.expiresInDays}; 0 = never).`,
        `  --out <path>              Where the converted record is written (default ${path.relative(process.cwd(), DEFAULTS.out)}).`,
        '  --apply                   Bind and POST each building, then name their collection as a plan. Without it: convert, validate, summarize, write --out.',
        '  --help                    This text.'
    ].join('\n'));
    process.exit(code);
}

function parseCli() {
    const { values } = parseArgs({
        options: {
            source: { type: 'string' }, backend: { type: 'string' }, origin: { type: 'string' },
            city: { type: 'string' }, 'proposal-id': { type: 'string' }, 'source-proposal-id': { type: 'string' }, 'plan-slug': { type: 'string' }, 'expires-in-days': { type: 'string' }, out: { type: 'string' },
            apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false }
        },
        strict: true
    });
    if (values.help || !values.source) usage(values.help ? 0 : 1);
    const expiresInDays = values['expires-in-days'] === undefined ? DEFAULTS.expiresInDays : Number(values['expires-in-days']);
    if (!Number.isInteger(expiresInDays) || expiresInDays < 0) throw new Error('--expires-in-days must be a non-negative integer');
    return {
        source: path.resolve(values.source),
        backend: (values.backend || DEFAULTS.backend).replace(/\/+$/, ''),
        origin: values.origin || DEFAULTS.origin,
        city: values.city || DEFAULTS.city,
        proposalId: values['proposal-id'] || DEFAULTS.proposalId,
        sourceProposalId: values['source-proposal-id'] || null,
        planSlug: values['plan-slug'] || DEFAULTS.planSlug,
        expiresInDays,
        out: path.resolve(values.out || DEFAULTS.out),
        apply: values.apply
    };
}

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
                sourceFootprintAreaM2: building.footprint_area_m2 ?? null,
                sourceOccupiedFloorplates: building.occupied_floorplates || []
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

export function buildRecords({ model, stats, city, proposalId, expiresInDays, sourceSha256, sourceProposalId = null }) {
    const now = new Date();
    const expiresAt = expiresInDays > 0 ? new Date(now.getTime() + expiresInDays * 86400000).toISOString() : null;
    const planTitle = 'Courtyard Candlestick: 1,105 courtyard buildings, about 16,400 homes, no towers';
    const buildings = polygonBuildingParts(stats.features);
    return buildings.map((building, index) => {
        const rawSourceId = building.properties.id;
        if (rawSourceId === undefined || rawSourceId === null || rawSourceId === '') throw new Error(`Building at output index ${index} has no stable source ID.`);
        const sourceId = String(rawSourceId);
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
                    schema: model.schema_version || null,
                    release: model.release || null,
                    createdUtc: model.created_utc || null,
                    sha256: sourceSha256,
                    crs: 'EPSG:26910',
                    links: SOURCE_LINKS,
                    buildingId: sourceId,
                    componentIndex: building.properties.sourceComponentIndex || null,
                    blockId: building.properties.sourceBlockId || null,
                    sourceControlProperties: building.properties.sourceControlProperties || {},
                    sourceOccupiedFloorplates: building.properties.sourceOccupiedFloorplates || []
                }
            },
            ineligibleParcels: []
        };
        return {
            proposalId: `${proposalId}-${idSuffix}`,
            ...(sourceProposalId ? { sourceProposalId: String(sourceProposalId) } : {}),
            city,
            type: 'building',
            goal: 'single',
            typologyType: 'single',
            primaryType: 'Urban Rule',
            name: title,
            title,
            description: describe(model, stats),
            author: 'Courtyard Urbanist',
            lifecycleStatus: 'Active',
            applied: false,
            termsConfirmed: true,
            createdAt: now.toISOString(),
            ...(expiresAt ? { expiresAt } : {}),
            site: building.geometry,
            cadastreParcelIds: [],
            geometry: { buildings: [building] },
            buildingProposal,
            tags: ['buildings', 'candlestick-point', 'courtyard']
        };
    });
}

// ---- main ---------------------------------------------------------------------------------

async function main() {
    const cli = parseCli();
    const sourceBytes = fs.readFileSync(cli.source);
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    const model = JSON.parse(sourceBytes.toString('utf8'));
    log(`source ${path.basename(cli.source)} sha256 ${sourceSha256} (${model.release || 'release unknown'}, ${(model.buildings || []).length} buildings)`);

    const stats = convertBuildings(model);
    const records = buildRecords({ model, stats, city: cli.city, proposalId: cli.proposalId, expiresInDays: cli.expiresInDays, sourceSha256, sourceProposalId: cli.sourceProposalId });
    // The same projection and readability check every seed gets before a row can exist.
    records.forEach(canonicalSeedRecord);
    const planDefinition = {
        slug: cli.planSlug,
        title: 'Courtyard Candlestick (2026 concept)',
        description: `The Courtyard Candlestick concept building collection: ${records.length} individual Freeform building proposals.`,
        author: 'Courtyard Urbanist',
        place: 'Candlestick Point, San Francisco',
        city: cli.city,
        authoredProposalIds: records.map(record => record.proposalId)
    };
    const heights = stats.features.map(feature => feature.properties.height);
    log(`converted ${stats.features.length} buildings, dropped ${stats.dropped.length}${stats.dropped.length ? ` (${stats.dropped.slice(0, 5).join(', ')}${stats.dropped.length > 5 ? ', …' : ''})` : ''}`);
    log(`levels ${JSON.stringify(stats.levelsHistogram)} · heights ${Math.min(...heights)}–${Math.max(...heights)} m · footprints ${stats.footprintM2} m²`);
    log(`bbox ${bboxOf(stats.features).join(', ')} · ${records.length} Freeform proposals · records ${(JSON.stringify(records).length / 1024).toFixed(0)} KB${records[0]?.expiresAt ? ` · expires ${records[0].expiresAt}` : ''}`);

    fs.mkdirSync(path.dirname(cli.out), { recursive: true });
    fs.writeFileSync(cli.out, JSON.stringify({ plan: planDefinition, proposals: records }));
    log(`record written to ${cli.out}`);

    if (!cli.apply) {
        log('dry run: nothing posted (add --apply to publish)');
        return;
    }
    let created = 0; let skipped = 0;
    const proposalRowIds = [];
    for (const record of records) {
        const result = await publish(record, { backend: cli.backend, origin: cli.origin, city: cli.city });
        if (result.skipped) skipped++; else created++;
        if (result.id === undefined || result.id === null) throw new Error(`Proposal ${record.proposalId} has no database row id; cannot name the plan.`);
        proposalRowIds.push(String(result.id));
    }
    log(`done: ${created} created, ${skipped} existing`);
    const plan = await publishNamedPlan({
        ...planDefinition,
        proposalRowIds
    }, { backend: cli.backend, origin: cli.origin });
    log(plan.skipped ? `named plan ${cli.planSlug} already matches this collection` : `named plan created: ${cli.planSlug}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`[${new Date().toISOString()}] import failed:`, error);
        process.exit(1);
    });
}
