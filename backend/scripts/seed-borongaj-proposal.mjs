// Reconstructs the accepted 2022 Borongajska–Čavićeva nine-volume scheme.
// The later 2025 location-permit amendment is archived separately and is not
// silently mixed into this dated proposal state.

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
const PARCEL_ID = 'HR-335533-2692/7';
const PROPOSAL_ID = 'pionir-borongajska-caviceva-location-permit-2022';
const LOCATION_CASE_ID = 'A20220613-2838627-V020101';
const MIGRATED_LOCATION_CASE_ID = 'P20221230-1037184-Z02';
const PROJECT_ROOT = fileURLToPath(new URL('../../rekonstrukcije/pionir-paron/borongajska-caviceva/', import.meta.url));
const FULL_SOURCE_PATH = `${PROJECT_ROOT}location-permit-2022-full.geojson`;
const SITE_SOURCE_PATH = `${PROJECT_ROOT}location-permit-2022.geojson`;
const AMENDMENT_2025_PATH = `${PROJECT_ROOT}location-permit-amendment-2025.geojson`;
const PROPOSAL_PATH = `${PROJECT_ROOT}proposal.geojson`;
const OBSERVED_CONTEXT_PATH = `${PROJECT_ROOT}observed-context.geojson`;

const VOLUMES = Object.freeze({
    'eDozvola_building_polygon.7188': {
        order: 1,
        name: 'A1',
        color: '#2f6fed',
        apartments: 64,
        offices: 6,
        permitGbpM2: 4757,
        storeys: 9,
        permitCaseId: 'P20240312-1476435-Z01',
        permitSourceFile: 'building-a1-permit-2024.geojson',
        permitUrl: 'https://pionir.hr/wp-content/dokumentacija_dozvole/borongajska-caviceva/objekt-a1/gradevinska-dozvola-a1.pdf'
    },
    'eDozvola_building_polygon.7189': {
        order: 2,
        name: 'A2',
        color: '#d63384',
        apartments: 192,
        offices: 12,
        permitGbpM2: null,
        storeys: 9,
        permitCaseId: 'P20230630-1310132-Z01',
        permitSourceFile: 'building-a2-permit-2023.geojson',
        permitUrl: 'https://pionir.hr/wp-content/dokumentacija_dozvole/borongajska-caviceva/objekt-a2/badel_A2_gradevinska_dozvola_nadzemno.pdf'
    },
    'eDozvola_building_polygon.7193': {
        order: 3,
        name: 'B1',
        color: '#198754',
        apartments: null,
        offices: null,
        permitGbpM2: null,
        storeys: 9,
        permitCaseId: 'P20241001-1609912-Z01',
        permitSourceFile: 'building-b1-permit-2025.geojson',
        permitUrl: 'https://pionir.hr/wp-content/dokumentacija_dozvole/borongajska-caviceva/objekt-b1/gradevinska-dozvola-nadzemno-b1.pdf'
    },
    'eDozvola_building_polygon.7194': {
        order: 4,
        name: 'B2',
        color: '#fd7e14',
        apartments: 126,
        offices: null,
        permitGbpM2: 8064,
        storeys: 9,
        permitCaseId: 'P20250717-1815302-Z01',
        permitSourceFile: 'building-b2-permit-2025.geojson'
    },
    'eDozvola_building_polygon.7187': {
        order: 5,
        name: 'B3',
        color: '#6f42c1',
        apartments: null,
        offices: null,
        permitGbpM2: null,
        storeys: 9,
        permitCaseId: 'P20250321-1729062-Z01',
        permitSourceFile: 'building-b3-permit-2025.geojson',
        permitUrl: 'https://pionir.hr/wp-content/dokumentacija_dozvole/borongajska-caviceva/objekt-b3/Gradevinska_dozvola_B3_nadzemno.pdf'
    },
    'eDozvola_building_polygon.7196': {
        order: 6,
        name: 'B4',
        color: '#20c997',
        apartments: null,
        offices: null,
        permitGbpM2: null,
        storeys: 9,
        permitCaseId: 'P20250428-1757572-Z01',
        permitSourceFile: 'building-b4-permit-2025.geojson'
    },
    'eDozvola_building_polygon.7191': {
        order: 7,
        name: 'C1',
        color: '#0dcaf0',
        apartments: 177,
        offices: 0,
        permitGbpM2: 11874,
        storeys: 9,
        permitCaseId: 'P20260304-4502783-Z01',
        amendmentFeatureId: 'eDozvola_building_polygon.375644',
        permitUrl: 'https://pionir.hr/wp-content/dokumentacija_dozvole/borongajska-caviceva/objekt-c1/gradevinska_dozvola_nadzemno_c1.pdf'
    },
    'eDozvola_building_polygon.7192': {
        order: 8,
        name: 'C2',
        color: '#ffc107',
        apartments: null,
        offices: null,
        permitGbpM2: null,
        storeys: null,
        phaseLabelConfidence: 'inferred'
    },
    'eDozvola_building_polygon.7197': {
        order: 9,
        name: 'C3',
        color: '#dc3545',
        apartments: null,
        offices: null,
        permitGbpM2: null,
        storeys: null,
        phaseLabelConfidence: 'inferred'
    }
});

const EXCLUDED_SOURCE_FEATURES = Object.freeze({
    'eDozvola_building_polygon.7190': 'pomoćna/parterna geometrija',
    'eDozvola_building_polygon.7195': 'trafostanica ZTS 555'
});

function usage() {
    console.log(`Usage: node backend/scripts/seed-borongaj-proposal.mjs --dry-run|--apply [--export]

  --dry-run  Validate the dated nine-volume reconstruction without writing a row.
  --apply    Upsert the proposal in the local Consensus Builder database.
  --export   Write canonical proposal GeoJSON and current DGU context.`);
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

function polygonById(collection, sourceFeatureId) {
    return collection.features.find(feature => feature.properties?.['edozvola:sourceFeatureId'] === sourceFeatureId);
}

function overlapRatio(left, right) {
    const intersection = turf.intersect(left, right);
    return intersection ? turf.area(intersection) / Math.min(turf.area(left), turf.area(right)) : 0;
}

async function validateNamedPermitMatch(sourceFeature, config) {
    if (config.permitSourceFile) {
        const permit = JSON.parse(await readFile(`${PROJECT_ROOT}${config.permitSourceFile}`, 'utf8'));
        const permitPolygons = permit.features.filter(feature => feature.properties?.['edozvola:sourceLayer'] === 'eDozvola_building_polygon');
        const best = permitPolygons
            .map(feature => ({ feature, ratio: overlapRatio(sourceFeature, feature) }))
            .sort((left, right) => right.ratio - left.ratio)[0];
        if (!best || best.ratio < 0.95) {
            throw new Error(`${config.name}: named permit geometry does not match the 2022 location-permit footprint.`);
        }
        return {
            phaseLabelConfidence: 'direct-permit-geometry-match',
            matchedPermitFeatureId: best.feature.properties?.['edozvola:sourceFeatureId'] || null,
            permitGeometryOverlapRatio: best.ratio
        };
    }
    if (config.amendmentFeatureId) {
        const amendment = await readCollection(AMENDMENT_2025_PATH, 'P20250825-1836121-Z06');
        const amendmentFeature = polygonById(amendment, config.amendmentFeatureId);
        const ratio = amendmentFeature ? overlapRatio(sourceFeature, amendmentFeature) : 0;
        if (ratio < 0.9) throw new Error(`${config.name}: later amendment footprint match is too weak.`);
        return {
            phaseLabelConfidence: 'signed-permit-data-plus-later-footprint-match',
            matchedAmendmentFeatureId: config.amendmentFeatureId,
            amendmentGeometryOverlapRatio: ratio
        };
    }
    return {
        phaseLabelConfidence: config.phaseLabelConfidence || 'inferred',
        phaseLabelBasis: 'remaining C-group footprints in original WFS source order; no individual named permit is public yet'
    };
}

export async function constructBorongajProposal() {
    const source = await readCollection(FULL_SOURCE_PATH, LOCATION_CASE_ID);
    const siteSource = await readCollection(SITE_SOURCE_PATH, MIGRATED_LOCATION_CASE_ID);
    const sourcePolygons = source.features.filter(feature => feature.properties?.['edozvola:sourceLayer'] === 'eDozvola_building_polygon');
    if (sourcePolygons.length !== 11) throw new Error(`Expected 11 source polygons; found ${sourcePolygons.length}.`);
    for (const sourceFeatureId of Object.keys(EXCLUDED_SOURCE_FEATURES)) {
        if (!polygonById(source, sourceFeatureId)) throw new Error(`Missing excluded source feature ${sourceFeatureId}.`);
    }

    const siteSourceFeature = siteSource.features.find(feature => feature.properties?.['edozvola:sourceLayer'] === 'eDozvola_area_polygon');
    if (!siteSourceFeature) throw new Error('The migrated 2022 record has no development-area polygon.');
    const parcelFeature = {
        type: 'Feature',
        properties: {
            id: `permit-area-${MIGRATED_LOCATION_CASE_ID}`,
            parentParcelId: PARCEL_ID,
            maticni_broj_ko: 335533,
            broj_cestice: '2692/7',
            areaM2: turf.area(siteSourceFeature),
            source: 'accepted 2022 location-permit area polygon',
            sourceCaseId: MIGRATED_LOCATION_CASE_ID,
            sourceFeatureId: siteSourceFeature.properties?.['edozvola:sourceFeatureId'] || null
        },
        geometry: siteSourceFeature.geometry
    };

    const buildings = [];
    for (const [sourceFeatureId, config] of Object.entries(VOLUMES)) {
        const sourceFeature = polygonById(source, sourceFeatureId);
        if (!sourceFeature) throw new Error(`Missing planned volume ${sourceFeatureId}.`);
        const match = await validateNamedPermitMatch(sourceFeature, config);
        const displayStoreys = config.storeys || 9;
        buildings.push({
            type: 'Feature',
            properties: {
                name: config.name,
                block: 'Borongajska–Čavićeva – prihvaćena shema iz 2022.',
                type: 'proposedBuildingSingle',
                footprintMode: 'polygon',
                height: displayStoreys * 3,
                heightM: displayStoreys * 3,
                floors: config.storeys,
                storeys: config.storeys,
                floorCountBasis: config.storeys
                    ? 'devet nadzemnih razina (Pr+8K) potvrđeno pojedinačnim aktom ili prodajnim etažnim pregledom'
                    : 'neriješeno; 27 m je samo privremena visina za 3D prikaz',
                heightBasis: config.storeys ? '9 × 3 m display height' : '27 m display proxy',
                color: config.color,
                source: 'accepted 2022 national eDozvola WFS location-permit geometry',
                sourceCaseId: LOCATION_CASE_ID,
                sourceFeatureId,
                footprintAreaM2: turf.area(sourceFeature),
                apartments: config.apartments,
                offices: config.offices,
                permitGbpM2: config.permitGbpM2,
                permitCaseId: config.permitCaseId || null,
                permitUrl: config.permitUrl || null,
                geometryBasis: 'permit-planned-footprint',
                ...match
            },
            geometry: sourceFeature.geometry
        });
    }
    buildings.sort((left, right) => VOLUMES[left.properties.sourceFeatureId].order - VOLUMES[right.properties.sourceFeatureId].order);
    if (buildings.length !== 9 || new Set(buildings.map(feature => feature.properties.name)).size !== 9) {
        throw new Error('Borongaj reconstruction must contain exactly nine uniquely named volumes.');
    }

    const stats = densityStats.summarizeDensity({
        parcelFeature,
        buildings,
        turf,
        floorHeightM: 3,
        preferHeight: false
    });
    const knownApartments = buildings.reduce((sum, feature) => sum + (Number(feature.properties.apartments) || 0), 0);
    const sourceStatistics = {
        accepted2022Scheme: {
            developmentAreaM2: stats.parcelAreaM2,
            footprintAreaM2: stats.footprintAreaM2,
            siteCoveragePercent: stats.siteCoveragePercent,
            aboveGroundVolumes: stats.buildingCount,
            knownApartmentsAcrossFourPublishedPhases: knownApartments
        },
        displayOnlyHeightEstimate: {
            heightEquivalentAboveGroundGbpM2: stats.aboveGroundGbpM2,
            heightEquivalentKin: stats.kin,
            method: 'footprint × nine 3 m display levels; not a permit GBP total'
        },
        excludedSourceFeatures: EXCLUDED_SOURCE_FEATURES,
        caveat: 'This is the accepted 2022 nine-volume state. The final 2025 location-permit amendment expands the site and is archived separately; its 23 polygons are not merged here.'
    };
    const parentParcelNumbers = [{ id: PARCEL_ID, number: '2692/7', cadastre: 'Peščenica' }];
    const buildingProposal = {
        parentParcelIds: [PARCEL_ID],
        parentParcelNumbers,
        createdFrom: 'single-building',
        typologyType: 'single',
        blockName: 'Borongajska–Čavićeva – prihvaćena shema iz 2022.',
        parameters: {
            typology: 'single',
            floorHeightM: 3,
            geometryBasis: 'permit-planned-footprint',
            sourceStatistics
        },
        buildingFeature: buildings[0],
        buildings,
        ancestorKey: PARCEL_ID,
        takeWholeParcels: false,
        metadata: { sourceStatistics }
    };
    const proposal = {
        proposalId: PROPOSAL_ID,
        city: 'zagreb',
        name: 'Borongajska–Čavićeva – devet volumena iz lokacijske dozvole 2022.',
        title: 'Borongajska–Čavićeva – devet volumena iz lokacijske dozvole 2022.',
        description: 'Datirana rekonstrukcija prihvaćene lokacijske sheme iz 2022.: devet nadzemnih volumena A1–C3 na dijelu k.č. 2692/7. Šest oznaka A/B potvrđeno je izravnim prostornim podudaranjem s pojedinačnim građevinskim dozvolama; C1 je povezan s potpisanom dozvolom i kasnijim poligonom. Oznake C2 i C3 ostaju izričito označene kao izvedene iz redoslijeda preostalih poligona. Kasnija izmjena lokacijske dozvole iz 2025. nije stopljena u ovu povijesnu shemu.',
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
            locationPermitCaseId: LOCATION_CASE_ID,
            migratedLocationPermitCaseId: MIGRATED_LOCATION_CASE_ID,
            locationPermitClass: 'UP/I-350-05/22-001/22',
            locationPermitDecisionAt: '2022-05-16',
            locationPermitFinalAt: '2022-06-09',
            laterAmendmentCaseId: 'P20250825-1836121-Z06',
            laterAmendmentFinalAt: '2025-12-05',
            publicWfs: 'https://oss.uredjenazemlja.hr/OssWebServices/external/eDozvole',
            parcel: 'k.č. 2692/7, MB 335533, k.o. Peščenica; proposal site is the 33,742 m² permit-area polygon, not the whole later 67,956 m² parcel',
            sourceStatistics
        }
    };
    return { proposal, stats, buildings };
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

async function exportObservedContext(pool, siteFeature) {
    const result = await pool.query(`
        WITH site AS (
            SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765) AS geom
        ), features AS (
            SELECT 0::bigint AS ordering,
                   jsonb_build_object(
                       'type', 'Feature',
                       'properties', $2::jsonb || jsonb_build_object('context:role', 'accepted-2022-permit-area'),
                       'geometry', $3::jsonb
                   ) AS feature
            UNION ALL
            SELECT d.zgrada_id AS ordering,
                   jsonb_build_object(
                       'type', 'Feature',
                       'properties', jsonb_build_object(
                           'context:role', 'current-dgu-building',
                           'dguBuildingId', d.zgrada_id,
                           'dguBuildingNumber', d.broj_zgrade,
                           'dguBuildingType', d.naziv_vrste_zgrade,
                           'footprintAreaM2', d.area_m2,
                           'source', 'DGU katastar, aktualna zgrada'
                       ),
                       'geometry', ST_AsGeoJSON(ST_Transform(d.geom, 4326))::jsonb
                   ) AS feature
            FROM public.dgu_building d
            CROSS JOIN site
            WHERE d.current = true
              AND ST_Intersects(d.geom, site.geom)
              AND ST_Area(ST_Intersection(d.geom, site.geom)) > 10
              AND ST_Area(ST_Intersection(d.geom, site.geom)) / NULLIF(ST_Area(d.geom), 0) >= 0.5
        )
        SELECT jsonb_build_object(
            'type', 'FeatureCollection',
            'name', 'Borongajska–Čavićeva – aktualno DGU stanje unutar obuhvata iz 2022.',
            'context', jsonb_build_object(
                'schema', 'consensus-builder.reconstruction-context.v1',
                'capturedAt', $4::text,
                'plannedGeometry', 'proposal.geojson',
                'note', 'Current legal building footprints are context only and may lag construction; the proposal geometry comes from the accepted permit.'
            ),
            'features', jsonb_agg(feature ORDER BY ordering)
        ) AS collection
        FROM features
    `, [JSON.stringify(siteFeature.geometry), JSON.stringify(siteFeature.properties), JSON.stringify(siteFeature.geometry), RECONSTRUCTION_DATE]);
    const collection = result.rows[0]?.collection;
    if (!collection || collection.features.length < 1) throw new Error('Could not export Borongaj observed context.');
    await writeFile(OBSERVED_CONTEXT_PATH, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
    console.log(`Exported permit area plus ${collection.features.length - 1} current DGU objects to ${OBSERVED_CONTEXT_PATH}.`);
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

    const { proposal, stats } = await constructBorongajProposal();
    console.log(JSON.stringify({
        proposalId: proposal.proposalId,
        buildings: stats.buildingCount,
        developmentAreaM2: Number(stats.parcelAreaM2.toFixed(2)),
        footprintAreaM2: Number(stats.footprintAreaM2.toFixed(2)),
        siteCoveragePercent: Number(stats.siteCoveragePercent.toFixed(3)),
        displayHeightEquivalentAboveGroundGbpM2: Number(stats.aboveGroundGbpM2.toFixed(2)),
        displayHeightEquivalentKin: Number(stats.kin.toFixed(4))
    }, null, 2));

    let pool;
    try {
        if (args.includes('--apply') || args.includes('--export')) {
            assertLocalDatabase();
            pool = new Pool();
        }
        if (args.includes('--apply')) {
            const stored = await upsertProposal(pool, proposal);
            console.log(`Stored local proposal row ${stored.id} (${stored.proposal_id}).`);
        } else {
            console.log('Dry run complete; no database row was written.');
        }
        if (args.includes('--export')) {
            await exportProposal(proposal);
            await exportObservedContext(pool, proposal.geometry.superParcel);
        }
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
