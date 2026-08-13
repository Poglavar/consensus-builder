// Reconstructs Savica F1–F3 from the current DGU built footprints, with labels and
// programme cross-checked against archived public eDozvola geometry and Pionir documents.

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
const PARCEL_ID = 'HR-335649-2716/8';
const PROPOSAL_ID = 'paron-savica-f1-f3-observed';
const LOCATION_CASE_ID = 'A20211027-2824386-V020101';
const LATEST_LOCATION_CASE_ID = 'P20230927-1364307-Z06';
const F1_F2_CASE_ID = 'A20220330-2833642-V010101';
const F3_CASE_ID = 'P20240131-1445130-Z01';
const PROJECT_ROOT = fileURLToPath(new URL('../../rekonstrukcije/pionir-paron/savica-f1-f3/', import.meta.url));
const LABEL_SOURCE_PATH = `${PROJECT_ROOT}location-permit-amendment-2021.geojson`;
const LATEST_LOCATION_SOURCE_PATH = `${PROJECT_ROOT}location-permit-amendment-2023.geojson`;
const F1_F2_SOURCE_PATH = `${PROJECT_ROOT}building-permit-f1-f2-2022.geojson`;
const F3_SOURCE_PATH = `${PROJECT_ROOT}building-permit-f3-2024.geojson`;
const PROPOSAL_PATH = `${PROJECT_ROOT}proposal.geojson`;
const CONTEXT_PATH = `${PROJECT_ROOT}observed-context.geojson`;
const COLORS = Object.freeze({ F1: '#2f6fed', F2: '#d63384', F3: '#198754' });
const LABEL_PATTERNS = Object.freeze({
    F1: /\bF1\b/i,
    F2: /\bF2\b/i,
    F3: /\bF3\b/i
});

function usage() {
    console.log(`Usage: node backend/scripts/seed-savica-f1-f3-proposal.mjs --dry-run|--apply [--export]

  --dry-run  Validate the built three-volume state without writing a row.
  --apply    Upsert the proposal in the local Consensus Builder database.
  --export   Write canonical proposal GeoJSON and observed context.`);
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

function buildingPolygons(collection) {
    return collection.features.filter(feature => feature.properties?.['edozvola:sourceLayer'] === 'eDozvola_building_polygon');
}

function labelFromPermit(feature) {
    const description = String(feature.properties?.gradjevina_zahvat_dodatno || '');
    return Object.entries(LABEL_PATTERNS).find(([, pattern]) => pattern.test(description))?.[0] || null;
}

function overlapRatio(left, right) {
    const intersection = turf.intersect(left, right);
    return intersection ? turf.area(intersection) / Math.min(turf.area(left), turf.area(right)) : 0;
}

async function readBuiltState(pool) {
    const parcelResult = await pool.query(`
        SELECT cestica_id,
               ST_Area(geom)::double precision AS area_m2,
               ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
        FROM public.parcel
        WHERE current = true
          AND maticni_broj_ko = 335649
          AND broj_cestice = '2716/8'
        LIMIT 1
    `);
    if (parcelResult.rowCount !== 1) throw new Error('Savica parcel 2716/8, k.o. Trnje was not found.');
    const parcel = parcelResult.rows[0];

    const buildingResult = await pool.query(`
        WITH host AS (
            SELECT geom
            FROM public.parcel
            WHERE current = true
              AND maticni_broj_ko = 335649
              AND broj_cestice = '2716/8'
            LIMIT 1
        )
        SELECT d.zgrada_id,
               d.broj_zgrade,
               d.naziv_vrste_zgrade,
               d.area_m2,
               ST_AsGeoJSON(ST_Transform(d.geom, 4326))::json AS geometry,
               observed.osm_id,
               observed.num_floors,
               observed.overlap_ratio
        FROM public.dgu_building d
        CROSS JOIN host
        LEFT JOIN LATERAL (
            SELECT o.osm_id,
                   o.num_floors,
                   ST_Area(ST_Intersection(d.geom, ST_Transform(o.geom, 3765)))
                       / NULLIF(ST_Area(d.geom), 0) AS overlap_ratio
            FROM public.overture_building_footprint o
            WHERE o.geom && ST_Envelope(ST_Transform(d.geom, 4326))
              AND ST_Intersects(o.geom, ST_Transform(d.geom, 4326))
            ORDER BY ST_Area(ST_Intersection(d.geom, ST_Transform(o.geom, 3765))) DESC
            LIMIT 1
        ) observed ON true
        WHERE d.current = true
          AND ST_Intersects(d.geom, host.geom)
          AND ST_Area(ST_Intersection(d.geom, host.geom)) / NULLIF(ST_Area(d.geom), 0) >= 0.95
        ORDER BY d.zgrada_id
    `);
    const principal = buildingResult.rows.filter(row => ['STAMBENA ZGRADA', 'POSLOVNA ZGRADA'].includes(row.naziv_vrste_zgrade));
    if (principal.length !== 3) throw new Error(`Expected three principal DGU buildings; found ${principal.length}.`);

    return {
        parcelFeature: {
            type: 'Feature',
            properties: {
                id: PARCEL_ID,
                cestica_id: parcel.cestica_id,
                maticni_broj_ko: 335649,
                broj_cestice: '2716/8',
                areaM2: Number(parcel.area_m2),
                source: 'DGU katastar, aktualna čestica'
            },
            geometry: parcel.geometry
        },
        allBuildings: buildingResult.rows,
        principal
    };
}

export function mapBuiltBuildings(principal, labelledPermits) {
    const permitByLabel = Object.fromEntries(labelledPermits.map(feature => [labelFromPermit(feature), feature]));
    for (const label of Object.keys(LABEL_PATTERNS)) {
        if (!permitByLabel[label]) throw new Error(`Missing labelled ${label} permit polygon.`);
    }

    const unused = new Set(principal.map(row => row.zgrada_id));
    return ['F1', 'F2', 'F3'].map(label => {
        const permit = permitByLabel[label];
        const ranked = principal
            .filter(row => unused.has(row.zgrada_id))
            .map(row => {
                const feature = { type: 'Feature', properties: {}, geometry: row.geometry };
                return { row, ratio: overlapRatio(feature, permit) };
            })
            .sort((left, right) => right.ratio - left.ratio);
        const match = ranked[0];
        if (!match || match.ratio < 0.85) {
            throw new Error(`${label}: no current DGU building overlaps the labelled permit footprint by at least 85%.`);
        }
        unused.delete(match.row.zgrada_id);
        const floors = Number(match.row.num_floors);
        if (!Number.isInteger(floors) || floors !== 8 || Number(match.row.overlap_ratio) < 0.85) {
            throw new Error(`${label}: expected a strongly overlapping OSM/Overture eight-floor tag.`);
        }
        const isResidential = label !== 'F3';
        return {
            type: 'Feature',
            properties: {
                name: label,
                block: 'Savica F1–F3 – izvedeno stanje',
                type: 'proposedBuildingSingle',
                footprintMode: 'polygon',
                height: 24,
                heightM: 24,
                floors,
                storeys: floors,
                floorCountBasis: label === 'F3'
                    ? 'Pionirov objavljeni opis navodi P+7; OSM/Overture također navodi 8 etaža'
                    : 'OSM/Overture building:levels=8; visina 24 m samo je prikazna procjena 8 × 3 m',
                heightBasis: '24 m display proxy; nije izmjerena visina',
                color: COLORS[label],
                source: 'aktualni DGU tlocrt, oznaka iz eDozvola lokacijske izmjene 2021.',
                programme: isResidential ? 'residential' : 'office',
                apartmentCount: isResidential ? 70 : 0,
                officeUnitCount: isResidential ? 0 : 8,
                dguBuildingId: match.row.zgrada_id,
                dguBuildingNumber: match.row.broj_zgrade,
                dguBuildingType: match.row.naziv_vrste_zgrade,
                dguFootprintAreaM2: Number(match.row.area_m2),
                osmId: match.row.osm_id,
                osmFloors: floors,
                osmDguOverlapRatio: Number(match.row.overlap_ratio),
                labelSourceCaseId: LOCATION_CASE_ID,
                labelSourceFeatureId: permit.properties?.['edozvola:sourceFeatureId'],
                permitToDguOverlapRatio: match.ratio,
                geometryBasis: 'observed-built-footprint'
            },
            geometry: match.row.geometry
        };
    });
}

export async function constructSavicaProposal(pool) {
    const [labelSource, latestLocation, f1f2Source, f3Source, built] = await Promise.all([
        readCollection(LABEL_SOURCE_PATH, LOCATION_CASE_ID),
        readCollection(LATEST_LOCATION_SOURCE_PATH, LATEST_LOCATION_CASE_ID),
        readCollection(F1_F2_SOURCE_PATH, F1_F2_CASE_ID),
        readCollection(F3_SOURCE_PATH, F3_CASE_ID),
        readBuiltState(pool)
    ]);
    const labelledPermits = buildingPolygons(labelSource).filter(feature => labelFromPermit(feature));
    if (labelledPermits.length !== 3) throw new Error(`Expected three labelled permit volumes; found ${labelledPermits.length}.`);
    if (buildingPolygons(latestLocation).length !== 4) throw new Error('Expected three volumes plus transformer in the 2023 location amendment.');
    if (buildingPolygons(f1f2Source).length !== 2) throw new Error('Expected two F1/F2 building-permit polygons.');
    if (buildingPolygons(f3Source).length !== 1) throw new Error('Expected one F3 building-permit polygon.');

    const buildings = mapBuiltBuildings(built.principal, labelledPermits);
    const stats = densityStats.summarizeDensity({
        parcelFeature: built.parcelFeature,
        buildings,
        turf,
        floorHeightM: 3,
        preferHeight: false
    });
    const sourceStatistics = {
        observedBuiltState: {
            parcelAreaM2: stats.parcelAreaM2,
            aboveGroundFootprintAreaM2: stats.footprintAreaM2,
            siteCoveragePercent: stats.siteCoveragePercent,
            aboveGroundVolumes: stats.buildingCount,
            apartments: buildings.reduce((sum, feature) => sum + feature.properties.apartmentCount, 0),
            offices: buildings.reduce((sum, feature) => sum + feature.properties.officeUnitCount, 0)
        },
        displayOnlyHeightEstimate: {
            heightEquivalentAboveGroundGbpM2: stats.aboveGroundGbpM2,
            heightEquivalentKin: stats.kin,
            method: 'current DGU footprint × eight display levels; not permit GBP'
        },
        caveat: 'Current built footprints are DGU geometry. Permit footprints remain archived as evidence and are not silently substituted for as-built geometry.'
    };
    const parentParcelNumbers = [{ id: PARCEL_ID, number: '2716/8', cadastre: 'Trnje' }];
    const buildingProposal = {
        parentParcelIds: [PARCEL_ID],
        parentParcelNumbers,
        createdFrom: 'single-building',
        typologyType: 'single',
        blockName: 'Savica F1–F3 – izvedeno stanje',
        parameters: {
            typology: 'single',
            floorHeightM: 3,
            geometryBasis: 'observed-built-state',
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
        name: 'Savica F1–F3 – rekonstrukcija izvedenog stanja',
        title: 'Savica F1–F3 – rekonstrukcija izvedenog stanja',
        description: 'Rekonstrukcija izvedenog kompleksa na k.č. 2716/8, k.o. Trnje: stambeni volumeni F1 i F2 sa po 70 stanova te poslovni volumen F3 s osam uredskih prostora. Tlocrti su aktualne DGU geometrije; oznake su sigurno pridružene prema označenoj lokacijskoj izmjeni. Svih osam nadzemnih etaža prikazano je s procijenjenih 24 m jer izmjerena visina nije dostupna. Zajedničke podzemne garaže i trafostanica ostaju kontekst, ne nadzemni volumeni prijedloga.',
        author: 'zagreb.lol – lokalna analiza',
        type: 'building',
        goal: 'single',
        primaryType: 'Urban Rule',
        typologyType: 'single',
        lifecycleStatus: 'Active',
        createdAt: RECONSTRUCTION_DATE,
        updatedAt: RECONSTRUCTION_DATE,
        tags: ['buildings', 'research', 'reconstruction', 'observed-built-state', 'permit-cross-check'],
        parentParcelIds: [PARCEL_ID],
        cadastreParcelIds: [PARCEL_ID],
        parcelIds: [PARCEL_ID],
        acceptedParcelIds: [],
        buildingGeometry: buildings[0].geometry,
        buildingProperties: buildings[0].properties,
        properties: buildings[0].properties,
        geometry: { superParcel: built.parcelFeature, buildings },
        buildingProposal,
        bounds: turf.bbox(built.parcelFeature),
        source: {
            projectPage: 'https://pionir.hr/prodaja-nekretnina/savica/objekt-f3/',
            f1UsePermit: 'https://pionir.hr/wp-content/dokumentacija_dozvole/savica/Uporabna_dozvola_F1.pdf',
            f2UsePermit: 'https://pionir.hr/wp-content/dokumentacija_dozvole/savica/uporabna_dozvola_f2.pdf',
            locationPermitLabelCaseId: LOCATION_CASE_ID,
            latestLocationPermitCaseId: LATEST_LOCATION_CASE_ID,
            f1f2BuildingPermitCaseId: F1_F2_CASE_ID,
            f3BuildingPermitCaseId: F3_CASE_ID,
            publicWfs: 'https://oss.uredjenazemlja.hr/OssWebServices/external/eDozvole',
            parcel: 'k.č. 2716/8, MB 335649, k.o. Trnje; DGU parcel id 21309385',
            investorRoles: {
                originalDesignAndEnergyDocuments: 'PARON d.o.o.',
                laterPermitsAndUsePermits: 'TEHNIKAGRADNJA d.o.o.',
                marketingAndPublishedDocuments: 'GIP PIONIR d.o.o.'
            },
            sourceStatistics
        }
    };
    return { proposal, stats, buildings, parcelFeature: built.parcelFeature, contextRows: built.allBuildings };
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

async function exportArtifacts(proposal, parcelFeature, contextRows) {
    const { collection, buildingCount } = assertReconstructionGeoJSONRoundTrip(proposal);
    await mkdir(dirname(PROPOSAL_PATH), { recursive: true });
    await writeFile(PROPOSAL_PATH, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
    const context = {
        type: 'FeatureCollection',
        name: 'Savica F1–F3 – DGU izvedeni kontekst',
        context: {
            schema: 'consensus-builder.reconstruction-context.v1',
            capturedAt: RECONSTRUCTION_DATE,
            geometryBasis: 'current DGU cadastral geometry',
            caveat: 'Podzemne garaže i trafostanica prikazane su samo kao kontekst.'
        },
        features: [
            { ...parcelFeature, properties: { ...parcelFeature.properties, 'context:role': 'site' } },
            ...contextRows.map(row => ({
                type: 'Feature',
                properties: {
                    'context:role': ['STAMBENA ZGRADA', 'POSLOVNA ZGRADA'].includes(row.naziv_vrste_zgrade)
                        ? 'principal-building'
                        : 'supporting-structure',
                    dguBuildingId: row.zgrada_id,
                    dguBuildingNumber: row.broj_zgrade,
                    dguBuildingType: row.naziv_vrste_zgrade,
                    footprintAreaM2: Number(row.area_m2),
                    source: 'DGU katastar, aktualna zgrada'
                },
                geometry: row.geometry
            }))
        ]
    };
    await writeFile(CONTEXT_PATH, `${JSON.stringify(context, null, 2)}\n`, 'utf8');
    console.log(`Exported ${buildingCount} buildings to ${PROPOSAL_PATH}; round trip passed.`);
    console.log(`Exported ${context.features.length - 1} DGU context structures to ${CONTEXT_PATH}.`);
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

    assertLocalDatabase();
    const pool = new Pool();
    try {
        const { proposal, stats, buildings, parcelFeature, contextRows } = await constructSavicaProposal(pool);
        console.log(JSON.stringify({
            proposalId: proposal.proposalId,
            buildings: stats.buildingCount,
            apartments: buildings.reduce((sum, feature) => sum + feature.properties.apartmentCount, 0),
            offices: buildings.reduce((sum, feature) => sum + feature.properties.officeUnitCount, 0),
            parcelAreaM2: Number(stats.parcelAreaM2.toFixed(2)),
            footprintAreaM2: Number(stats.footprintAreaM2.toFixed(2)),
            siteCoveragePercent: Number(stats.siteCoveragePercent.toFixed(3)),
            displayHeightEquivalentAboveGroundGbpM2: Number(stats.aboveGroundGbpM2.toFixed(2)),
            displayHeightEquivalentKin: Number(stats.kin.toFixed(4))
        }, null, 2));
        if (args.includes('--apply')) {
            const stored = await upsertProposal(pool, proposal);
            console.log(`Stored local proposal row ${stored.id} (${stored.proposal_id}).`);
        } else {
            console.log('Dry run complete; no database row was written.');
        }
        if (args.includes('--export')) await exportArtifacts(proposal, parcelFeature, contextRows);
    } finally {
        await pool.end();
    }
}

const invokedDirectly = process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
    await main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
