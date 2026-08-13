// Reconstructs the accepted seven-volume Rudeš location-permit state from 2025.
// The later pending building-permit amendment is a separate alternative and is
// deliberately not merged into this proposal.

import dotenv from 'dotenv';
import * as turf from '@turf/turf';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertReconstructionGeoJSONRoundTrip } from '../proposals/reconstruction-geojson.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
await import('../../frontend/js/building-density-stats.js');

const { Pool } = pg;
const densityStats = globalThis.BuildingDensityStats;
const RECONSTRUCTION_DATE = '2026-08-13T00:00:00.000Z';
const PARCEL_ID = 'HR-335614-799/1';
const PROPOSAL_ID = 'paron-zagrebacka-avenija-rudes-location-permit-2025';
const LOCATION_CASE_ID = 'P20250513-1768397-Z06';
const PENDING_CASE_ID = 'P20251224-1934214-Z11';
const PROJECT_ROOT = fileURLToPath(new URL('../../rekonstrukcije/pionir-paron/zagrebacka-avenija-rudes/', import.meta.url));
const SOURCE_PATH = `${PROJECT_ROOT}location-permit-amendment-2025.geojson`;
const PENDING_SOURCE_PATH = `${PROJECT_ROOT}building-permit-amendment-request-2025.geojson`;
const PROPOSAL_PATH = `${PROJECT_ROOT}proposal.geojson`;
const UNDERGROUND_FEATURE_ID = 'eDozvola_building_polygon.357667';
const COLORS = Object.freeze(['#2f6fed', '#d63384', '#198754', '#fd7e14', '#6f42c1', '#20c997', '#dc3545']);

function usage() {
    console.log(`Usage: node backend/scripts/seed-rudes-zagrebacka-avenija-proposal.mjs --dry-run|--apply [--export]

  --dry-run  Validate the seven-volume accepted 2025 state without writing a row.
  --apply    Upsert the proposal in the local Consensus Builder database.
  --export   Write canonical proposal GeoJSON.`);
}

function assertLocalDatabase() {
    const host = String(process.env.PGHOST || 'localhost').trim().toLowerCase();
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
        throw new Error(`Refusing to seed non-local PGHOST=${host || '(empty)'}.`);
    }
}

async function readCollection(path, expectedCaseId) {
    const collection = JSON.parse(await readFile(path, 'utf8'));
    if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
        throw new Error(`${path} is not a GeoJSON FeatureCollection.`);
    }
    if (collection.edozvola?.caseId !== expectedCaseId) {
        throw new Error(`Expected eDozvola case ${expectedCaseId} in ${path}.`);
    }
    return collection;
}

function overlapRatio(left, right) {
    const intersection = turf.intersect(left, right);
    return intersection ? turf.area(intersection) / Math.min(turf.area(left), turf.area(right)) : 0;
}

export async function constructRudesProposal() {
    const source = await readCollection(SOURCE_PATH, LOCATION_CASE_ID);
    const pending = await readCollection(PENDING_SOURCE_PATH, PENDING_CASE_ID);
    const siteSource = source.features.find(feature => feature.properties?.['edozvola:sourceLayer'] === 'eDozvola_area_polygon');
    const allBuildingPolygons = source.features.filter(feature => feature.properties?.['edozvola:sourceLayer'] === 'eDozvola_building_polygon');
    if (!siteSource) throw new Error('Rudeš location-permit source has no area polygon.');
    if (allBuildingPolygons.length !== 8) throw new Error(`Expected eight published polygons; found ${allBuildingPolygons.length}.`);

    const underground = allBuildingPolygons.find(feature => feature.properties?.['edozvola:sourceFeatureId'] === UNDERGROUND_FEATURE_ID);
    if (!underground) throw new Error(`Missing shared underground polygon ${UNDERGROUND_FEATURE_ID}.`);
    const planned = allBuildingPolygons.filter(feature => feature !== underground);
    if (planned.length !== 7) throw new Error(`Expected seven above-ground volumes; found ${planned.length}.`);
    const pendingPolygon = pending.features.find(feature => feature.properties?.['edozvola:sourceLayer'] === 'eDozvola_building_polygon');
    if (!pendingPolygon) throw new Error('Pending amendment source has no building polygon.');

    const parcelFeature = {
        type: 'Feature',
        properties: {
            id: PARCEL_ID,
            cestica_id: 21362030,
            maticni_broj_ko: 335614,
            broj_cestice: '799/1',
            areaM2: turf.area(siteSource),
            source: 'accepted 2025 location-permit area polygon',
            sourceCaseId: LOCATION_CASE_ID,
            sourceFeatureId: siteSource.properties?.['edozvola:sourceFeatureId'] || null
        },
        geometry: siteSource.geometry
    };

    const buildings = planned
        .map(feature => ({ feature, centroid: turf.centroid(feature).geometry.coordinates }))
        .sort((left, right) => left.centroid[0] - right.centroid[0] || right.centroid[1] - left.centroid[1])
        .map(({ feature }, index) => {
            const sourceFeatureId = feature.properties?.['edozvola:sourceFeatureId'];
            return {
                type: 'Feature',
                properties: {
                    name: `V${index + 1}`,
                    block: 'Zagrebačka avenija–Rudeš – prihvaćena shema iz 2025.',
                    type: 'proposedBuildingSingle',
                    footprintMode: 'polygon',
                    height: 27,
                    heightM: 27,
                    floors: null,
                    storeys: null,
                    floorCountBasis: 'nije objavljen u geometrijskom WFS izvoru; 27 m je samo privremena visina za 3D prikaz',
                    heightBasis: '27 m display proxy',
                    color: COLORS[index],
                    source: 'final 2025 national eDozvola WFS location-permit amendment geometry',
                    sourceCaseId: LOCATION_CASE_ID,
                    sourceFeatureId,
                    footprintAreaM2: turf.area(feature),
                    officialVolumeLabel: null,
                    localVolumeLabel: `V${index + 1}`,
                    labelBasis: 'neutral local west-to-east ordering; official phase label unresolved',
                    geometryBasis: 'permit-planned-footprint',
                    pendingAmendmentOverlapRatio: overlapRatio(feature, pendingPolygon)
                },
                geometry: feature.geometry
            };
        });

    const affectedByPending = buildings
        .filter(feature => feature.properties.pendingAmendmentOverlapRatio > 0.05)
        .map(feature => ({
            name: feature.properties.name,
            overlapRatio: feature.properties.pendingAmendmentOverlapRatio
        }));
    if (affectedByPending.length < 2) {
        throw new Error('Expected the pending amendment to overlap multiple accepted above-ground volumes.');
    }

    const stats = densityStats.summarizeDensity({
        parcelFeature,
        buildings,
        turf,
        floorHeightM: 3,
        preferHeight: false
    });
    const sourceStatistics = {
        accepted2025Scheme: {
            parcelAreaM2: stats.parcelAreaM2,
            aboveGroundFootprintAreaM2: stats.footprintAreaM2,
            siteCoveragePercent: stats.siteCoveragePercent,
            aboveGroundVolumes: stats.buildingCount,
            sharedUndergroundFootprintAreaM2: turf.area(underground)
        },
        displayOnlyHeightEstimate: {
            heightEquivalentAboveGroundGbpM2: stats.aboveGroundGbpM2,
            heightEquivalentKin: stats.kin,
            method: 'footprint × nine 3 m display levels; not permit GBP'
        },
        pendingAlternative: {
            caseId: PENDING_CASE_ID,
            footprintAreaM2: turf.area(pendingPolygon),
            affectedAcceptedVolumes: affectedByPending,
            statusAtArchive: pending.edozvola?.caseStatus || null
        },
        caveat: 'The pending building-permit amendment is not part of this proposal and must not be added to the accepted seven-volume state.'
    };
    const parentParcelNumbers = [{ id: PARCEL_ID, number: '799/1', cadastre: 'Rudeš' }];
    const buildingProposal = {
        parentParcelIds: [PARCEL_ID],
        parentParcelNumbers,
        createdFrom: 'single-building',
        typologyType: 'single',
        blockName: 'Zagrebačka avenija–Rudeš – prihvaćena shema iz 2025.',
        parameters: {
            typology: 'single',
            floorHeightM: 3,
            geometryBasis: 'permit-planned-footprint',
            sourceStatistics
        },
        buildingFeature: buildings[0],
        buildings,
        ancestorKey: PARCEL_ID,
        takeWholeParcels: true,
        metadata: { sourceStatistics }
    };
    const proposal = {
        proposalId: PROPOSAL_ID,
        city: 'zagreb',
        name: 'Zagrebačka avenija–Rudeš – sedam volumena iz lokacijske izmjene 2025.',
        title: 'Zagrebačka avenija–Rudeš – sedam volumena iz lokacijske izmjene 2025.',
        description: 'Datirana rekonstrukcija sedam nadzemnih volumena na k.č. 799/1 iz izmjene lokacijske dozvole koja je postala pravomoćna 19. prosinca 2025. Objavljeni izvor nema oznake ni katnost volumena, pa su V1–V7 neutralne lokalne oznake, a 27 m služi samo za 3D prikaz. Naknadni zahtjev za izmjenu građevinske dozvole od 24. prosinca 2025. presijeca više ovih volumena i nije uključen u prijedlog.',
        author: 'zagreb.lol – lokalna analiza',
        type: 'building',
        goal: 'single',
        primaryType: 'Urban Rule',
        typologyType: 'single',
        lifecycleStatus: 'Active',
        createdAt: RECONSTRUCTION_DATE,
        updatedAt: RECONSTRUCTION_DATE,
        tags: ['buildings', 'research', 'reconstruction', 'location-permit', 'historical-permit-state'],
        parentParcelIds: [PARCEL_ID],
        cadastreParcelIds: [PARCEL_ID],
        parcelIds: [PARCEL_ID],
        acceptedParcelIds: [],
        buildingGeometry: buildings[0].geometry,
        buildingProperties: buildings[0].properties,
        properties: buildings[0].properties,
        geometry: { superParcel: parcelFeature, buildings },
        buildingProposal,
        bounds: turf.bbox(parcelFeature),
        source: {
            article: 'https://baustela.hr/nekretnine/vijesti/76275/nove-zgrade-na-zagrebackoj-zili-kucavici-jos-jedno-pionirovo-naselje-ovog-puta-na-zapadu-grada/vijest',
            locationPermitCaseId: LOCATION_CASE_ID,
            locationPermitClass: 'UP/I-350-05/25-01/000390',
            locationPermitDecisionAt: '2025-11-11',
            locationPermitFinalAt: '2025-12-19',
            pendingBuildingPermitAmendmentCaseId: PENDING_CASE_ID,
            publicWfs: 'https://oss.uredjenazemlja.hr/OssWebServices/external/eDozvole',
            parcel: 'k.č. 799/1, MB 335614, k.o. Rudeš; DGU parcel id 21362030',
            sourceStatistics
        }
    };
    return { proposal, stats, buildings, underground, pendingPolygon };
}

async function upsertProposal(pool, proposal) {
    const result = await pool.query(`
        INSERT INTO public.proposal (
            proposal_id, city, name, title, description, author, type,
            lifecycle_status, created_at, updated_at,
            ancestor_parcel_ids, cadastre_parcel_ids,
            building_proposal, bounds, proposal_data, applied
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $9,
            $10::jsonb, $11::jsonb,
            $12::jsonb, $13::jsonb, $14::jsonb, false
        )
        ON CONFLICT (proposal_id) DO UPDATE SET
            city = EXCLUDED.city,
            name = EXCLUDED.name,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            author = EXCLUDED.author,
            type = EXCLUDED.type,
            lifecycle_status = EXCLUDED.lifecycle_status,
            updated_at = NOW(),
            ancestor_parcel_ids = EXCLUDED.ancestor_parcel_ids,
            cadastre_parcel_ids = EXCLUDED.cadastre_parcel_ids,
            building_proposal = EXCLUDED.building_proposal,
            bounds = EXCLUDED.bounds,
            proposal_data = EXCLUDED.proposal_data,
            applied = false
        RETURNING id, proposal_id
    `, [
        proposal.proposalId,
        proposal.city,
        proposal.name,
        proposal.title,
        proposal.description,
        proposal.author,
        proposal.type,
        proposal.lifecycleStatus,
        proposal.createdAt,
        JSON.stringify(proposal.parentParcelIds),
        JSON.stringify(proposal.cadastreParcelIds),
        JSON.stringify(proposal.buildingProposal),
        JSON.stringify(proposal.bounds),
        JSON.stringify(proposal)
    ]);
    return result.rows[0];
}

async function exportProposal(proposal) {
    const { collection, buildingCount } = assertReconstructionGeoJSONRoundTrip(proposal);
    await mkdir(dirname(PROPOSAL_PATH), { recursive: true });
    await writeFile(PROPOSAL_PATH, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
    console.log(`Exported ${buildingCount} planned buildings to ${PROPOSAL_PATH}; round trip passed.`);
}

async function main() {
    const args = process.argv.slice(2);
    if (!args.length || args.includes('--help') || args.includes('-h')) {
        usage();
        return;
    }
    const allowed = new Set(['--dry-run', '--apply', '--export']);
    const unknown = args.filter(arg => !allowed.has(arg));
    if (unknown.length || (args.includes('--dry-run') === args.includes('--apply'))) {
        usage();
        throw new Error('Choose exactly one of --dry-run or --apply.');
    }

    const { proposal, stats, underground } = await constructRudesProposal();
    console.log(JSON.stringify({
        proposalId: proposal.proposalId,
        buildings: stats.buildingCount,
        parcelAreaM2: Number(stats.parcelAreaM2.toFixed(2)),
        aboveGroundFootprintAreaM2: Number(stats.footprintAreaM2.toFixed(2)),
        undergroundFootprintAreaM2: Number(turf.area(underground).toFixed(2)),
        siteCoveragePercent: Number(stats.siteCoveragePercent.toFixed(3)),
        displayHeightEquivalentAboveGroundGbpM2: Number(stats.aboveGroundGbpM2.toFixed(2)),
        displayHeightEquivalentKin: Number(stats.kin.toFixed(4))
    }, null, 2));

    let pool;
    try {
        if (args.includes('--apply')) {
            assertLocalDatabase();
            pool = new Pool();
            const stored = await upsertProposal(pool, proposal);
            console.log(`Stored local proposal row ${stored.id} (${stored.proposal_id}).`);
        } else {
            console.log('Dry run complete; no database row was written.');
        }
        if (args.includes('--export')) await exportProposal(proposal);
    } finally {
        if (pool) await pool.end();
    }
}

const invokedDirectly = process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
