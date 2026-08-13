// Reconstructs the six-volume Špansko-Sjever A–F scheme from the official 2022
// location-permit polygons, matched to the six current DGU buildings on the parcel.

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
const PARCEL_ID = 'HR-340057-2795/3';
const PROPOSAL_ID = 'pionir-spansko-sjever-a-f-location-permit-2022';
const PROJECT_ROOT = fileURLToPath(new URL('../../rekonstrukcije/pionir-paron/spansko-sjever-a-f/', import.meta.url));
const SOURCE_PATH = `${PROJECT_ROOT}location-permit-amendment-2022.geojson`;
const PROPOSAL_PATH = `${PROJECT_ROOT}proposal.geojson`;
const OBSERVED_CONTEXT_PATH = `${PROJECT_ROOT}observed-context.geojson`;
const LOCATION_CASE_ID = 'P20221230-1168647-Z06';

const VOLUMES = Object.freeze({
    'eDozvola_building_polygon.180341': { name: 'A', apartments: 116, offices: 0, color: '#2f6fed' },
    'eDozvola_building_polygon.180590': { name: 'B', apartments: 116, offices: 0, color: '#d63384' },
    'eDozvola_building_polygon.180574': { name: 'C', apartments: 188, offices: 0, color: '#198754' },
    'eDozvola_building_polygon.180371': { name: 'D', apartments: 188, offices: 0, color: '#fd7e14' },
    'eDozvola_building_polygon.180327': { name: 'E', apartments: 142, offices: 0, color: '#6f42c1' },
    'eDozvola_building_polygon.180619': { name: 'F', apartments: 146, offices: 8, color: '#20c997' }
});

const OFFICIAL_TOTALS = Object.freeze({
    locationPermitApartments: 896,
    locationPermitOffices: 8,
    plannedAboveGroundVolumes: 6,
    laterKnownF: {
        apartments: 141,
        offices: 4,
        storeys: 'P+7+Uk',
        permitUrl: 'https://pionir.hr/wp-content/dokumentacija_dozvole/spansko_sjever/objekt_f/rjesenje-o-izmjeni-i-dopuni-gradevinske-dozvole-nadzemno-f.pdf'
    }
});

function usage() {
    console.log(`Usage: node backend/scripts/seed-spansko-sjever-proposal.mjs --dry-run|--apply [--export]

  --dry-run  Validate the local parcel and permit/DGU matching without writing a row.
  --apply    Upsert the proposal in the local Consensus Builder database.
  --export   Write canonical proposal GeoJSON plus current DGU context.`);
}

function assertLocalDatabase() {
    const host = String(process.env.PGHOST || 'localhost').trim().toLowerCase();
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
        throw new Error(`Refusing to seed non-local PGHOST=${host || '(empty)'}.`);
    }
}

async function readPermitVolumes() {
    const collection = JSON.parse(await readFile(SOURCE_PATH, 'utf8'));
    if (collection.edozvola?.caseId !== LOCATION_CASE_ID) {
        throw new Error(`Expected eDozvola case ${LOCATION_CASE_ID} in ${SOURCE_PATH}.`);
    }
    const features = collection.features
        .filter(feature => feature.properties?.['edozvola:sourceLayer'] === 'eDozvola_building_polygon')
        .map(feature => {
            const sourceFeatureId = feature.properties?.['edozvola:sourceFeatureId'];
            const config = VOLUMES[sourceFeatureId];
            if (!config) throw new Error(`Unknown Špansko location-permit polygon ${sourceFeatureId}.`);
            return { feature, sourceFeatureId, ...config };
        })
        .sort((left, right) => left.name.localeCompare(right.name));
    if (features.length !== Object.keys(VOLUMES).length) {
        throw new Error(`Expected ${Object.keys(VOLUMES).length} permit volumes; found ${features.length}.`);
    }
    const apartments = features.reduce((sum, entry) => sum + entry.apartments, 0);
    const offices = features.reduce((sum, entry) => sum + entry.offices, 0);
    if (apartments !== OFFICIAL_TOTALS.locationPermitApartments || offices !== OFFICIAL_TOTALS.locationPermitOffices) {
        throw new Error(`Permit-unit totals do not match: ${apartments} apartments, ${offices} offices.`);
    }
    return features;
}

async function readParcel(pool) {
    const result = await pool.query(`
        SELECT cestica_id,
               ST_Area(geom)::double precision AS area_m2,
               ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
        FROM public.parcel
        WHERE current = true
          AND maticni_broj_ko = 340057
          AND broj_cestice = '2795/3'
        LIMIT 1
    `);
    if (result.rowCount !== 1) throw new Error('Current parcel 2795/3, k.o. Stenjevec Jug was not found.');
    const row = result.rows[0];
    return {
        type: 'Feature',
        properties: {
            id: PARCEL_ID,
            cestica_id: row.cestica_id,
            maticni_broj_ko: 340057,
            broj_cestice: '2795/3',
            areaM2: Number(row.area_m2),
            source: 'DGU katastar, aktualna čestica',
            permitCadastre: 'k.o. Stenjevec (MB 335592)',
            currentCadastre: 'k.o. Stenjevec Jug (MB 340057)'
        },
        geometry: row.geometry
    };
}

async function matchCurrentBuildings(pool, permitVolumes) {
    const input = permitVolumes.map(entry => ({
        sourceFeatureId: entry.sourceFeatureId,
        geometry: entry.feature.geometry
    }));
    const result = await pool.query(`
        WITH input AS (
            SELECT item->>'sourceFeatureId' AS source_feature_id,
                   ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON((item->'geometry')::text), 4326), 3765) AS geom
            FROM jsonb_array_elements($1::jsonb) item
        ), host AS (
            SELECT geom
            FROM public.parcel
            WHERE current = true
              AND maticni_broj_ko = 340057
              AND broj_cestice = '2795/3'
            LIMIT 1
        )
        SELECT input.source_feature_id,
               ST_Area(input.geom)::double precision AS permit_area_m2,
               ST_Area(ST_Intersection(input.geom, host.geom)) / NULLIF(ST_Area(input.geom), 0) AS parcel_overlap,
               matched.zgrada_id,
               matched.broj_zgrade,
               matched.naziv_vrste_zgrade,
               matched.dgu_area_m2,
               matched.permit_overlap_ratio,
               matched.dgu_overlap_ratio,
               matched.geometry,
               matched.gdi_object_id,
               matched.gdi_height_m,
               matched.gdi_match_overlap_ratio,
               matched.gdi_survey_year
        FROM input
        CROSS JOIN host
        LEFT JOIN LATERAL (
            SELECT d.zgrada_id,
                   d.broj_zgrade,
                   d.naziv_vrste_zgrade,
                   d.area_m2::double precision AS dgu_area_m2,
                   ST_Area(ST_Intersection(input.geom, d.geom)) / NULLIF(ST_Area(input.geom), 0) AS permit_overlap_ratio,
                   ST_Area(ST_Intersection(input.geom, d.geom)) / NULLIF(ST_Area(d.geom), 0) AS dgu_overlap_ratio,
                   ST_AsGeoJSON(ST_Transform(d.geom, 4326))::json AS geometry,
                   observed.object_id AS gdi_object_id,
                   observed.height_m::double precision AS gdi_height_m,
                   observed.building_overlap_ratio AS gdi_match_overlap_ratio,
                   observed.survey_year AS gdi_survey_year
            FROM public.dgu_building d
            LEFT JOIN LATERAL (
                SELECT m.object_id, g.height_m, m.building_overlap_ratio, g.survey_year
                FROM public.dgu_gdi_building_match m
                JOIN public.gdi_building g ON g.object_id = m.object_id
                WHERE m.zgrada_id = d.zgrada_id
                ORDER BY m.building_overlap_ratio DESC NULLS LAST, m.overlap_area_m2 DESC
                LIMIT 1
            ) observed ON true
            WHERE d.current = true
              AND d.naziv_vrste_zgrade NOT ILIKE 'PODZEMNA GARAŽA%'
              AND d.naziv_vrste_zgrade NOT ILIKE 'TRAFOSTANICA%'
              AND ST_Intersects(input.geom, d.geom)
            ORDER BY ST_Area(ST_Intersection(input.geom, d.geom)) DESC
            LIMIT 1
        ) matched ON true
        ORDER BY input.source_feature_id
    `, [JSON.stringify(input)]);
    if (result.rowCount !== permitVolumes.length) {
        throw new Error(`Expected ${permitVolumes.length} permit/DGU matches; received ${result.rowCount}.`);
    }
    const bySourceId = new Map(result.rows.map(row => [row.source_feature_id, row]));
    for (const entry of permitVolumes) {
        const row = bySourceId.get(entry.sourceFeatureId);
        if (!row?.zgrada_id) throw new Error(`No current DGU building matched volume ${entry.name}.`);
        if (Number(row.parcel_overlap) < 0.995) throw new Error(`Volume ${entry.name} is not fully inside the current parcel.`);
        if (Number(row.permit_overlap_ratio) < 0.8 || Number(row.dgu_overlap_ratio) < 0.8) {
            throw new Error(`Weak permit/DGU geometry match for volume ${entry.name}: permit=${Number(row.permit_overlap_ratio).toFixed(3)}, DGU=${Number(row.dgu_overlap_ratio).toFixed(3)}.`);
        }
    }
    return bySourceId;
}

function buildBuildingFeatures(permitVolumes, matches) {
    return permitVolumes.map(entry => {
        const match = matches.get(entry.sourceFeatureId);
        const measuredHeight = Number(match.gdi_height_m);
        const measuredOverlap = Number(match.gdi_match_overlap_ratio);
        const hasUsefulMeasuredHeight = Number.isFinite(measuredHeight)
            && measuredHeight >= 20
            && measuredOverlap >= 0.8;
        const displayStoreys = entry.name === 'F' ? 9 : null;
        const heightM = hasUsefulMeasuredHeight ? measuredHeight : 27;
        return {
            type: 'Feature',
            properties: {
                name: entry.name,
                block: 'Špansko-Sjever A–F – k.č. 2795/3',
                type: 'proposedBuildingSingle',
                footprintMode: 'polygon',
                height: heightM,
                heightM,
                floors: displayStoreys,
                storeys: displayStoreys,
                floorCountBasis: entry.name === 'F'
                    ? 'P+7+Uk in the signed building permit; nine above-ground levels'
                    : 'unresolved in the archived source; 27 m is used only as a temporary display height',
                heightBasis: hasUsefulMeasuredHeight
                    ? `matched GDI ${match.gdi_survey_year} ridge height`
                    : '27 m display proxy (nine levels × 3 m); GDI predates completion',
                color: entry.color,
                source: 'official national eDozvola WFS, 2022 location-permit amendment',
                sourceCaseId: LOCATION_CASE_ID,
                sourceFeatureId: entry.sourceFeatureId,
                permitFootprintAreaM2: Number(match.permit_area_m2),
                locationPermitApartments: entry.apartments,
                locationPermitOffices: entry.offices,
                laterKnownApartments: entry.name === 'F' ? OFFICIAL_TOTALS.laterKnownF.apartments : null,
                laterKnownOffices: entry.name === 'F' ? OFFICIAL_TOTALS.laterKnownF.offices : null,
                matchedDguBuildingId: match.zgrada_id,
                matchedDguBuildingNumber: match.broj_zgrade,
                matchedDguBuildingType: match.naziv_vrste_zgrade,
                observedDguFootprintAreaM2: Number(match.dgu_area_m2),
                permitOverlapRatio: Number(match.permit_overlap_ratio),
                dguOverlapRatio: Number(match.dgu_overlap_ratio),
                gdiObjectId: match.gdi_object_id,
                gdiHeightM: Number.isFinite(measuredHeight) ? measuredHeight : null,
                gdiMatchOverlapRatio: Number.isFinite(measuredOverlap) ? measuredOverlap : null,
                geometryBasis: 'permit-planned-footprint'
            },
            geometry: entry.feature.geometry
        };
    });
}

export async function constructSpanskoProposal(pool) {
    const permitVolumes = await readPermitVolumes();
    const parcelFeature = await readParcel(pool);
    const matches = await matchCurrentBuildings(pool, permitVolumes);
    const buildings = buildBuildingFeatures(permitVolumes, matches);
    const stats = densityStats.summarizeDensity({
        parcelFeature,
        buildings,
        turf,
        floorHeightM: 3,
        preferHeight: false
    });
    const sourceStatistics = {
        geometryDerivedFrom2022LocationPermit: {
            parcelAreaM2: stats.parcelAreaM2,
            footprintAreaM2: stats.footprintAreaM2,
            siteCoveragePercent: stats.siteCoveragePercent,
            buildingCount: stats.buildingCount
        },
        displayOnlyHeightEstimate: {
            heightEquivalentAboveGroundGbpM2: stats.aboveGroundGbpM2,
            heightEquivalentKin: stats.kin,
            method: 'footprint × current GDI height where reliable, otherwise 27 m, divided by 3 m; not permit GBP'
        },
        locationPermitStated: OFFICIAL_TOTALS,
        caveat: 'The proposal preserves the 2022 location-permit scheme. Later phase permits changed at least volume F, so this is not asserted to be the final as-built apartment total.'
    };
    const parentParcelNumbers = [{ id: PARCEL_ID, number: '2795/3', cadastre: 'Stenjevec Jug' }];
    const buildingProposal = {
        parentParcelIds: [PARCEL_ID],
        parentParcelNumbers,
        createdFrom: 'single-building',
        typologyType: 'single',
        blockName: 'Špansko-Sjever A–F – k.č. 2795/3',
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
        name: 'Špansko-Sjever A–F – volumeni iz lokacijske dozvole',
        title: 'Špansko-Sjever A–F – volumeni iz lokacijske dozvole',
        description: 'Radna rekonstrukcija šest nadzemnih volumena A–F na k.č. 2795/3. Tlocrti su iz službene izmjene lokacijske dozvole iz 2022. i svaki je prostorno uparen s današnjom DGU zgradom. Lokacijski akt navodi ukupno 896 stanova i 8 ureda; kasnija izmjena za F smanjila je taj volumen na 141 stan i 4 ureda, pa se ukupni broj iz lokacijske dozvole ne predstavlja kao konačno izvedeno stanje.',
        author: 'zagreb.lol – lokalna analiza',
        type: 'building',
        goal: 'single',
        primaryType: 'Urban Rule',
        typologyType: 'single',
        lifecycleStatus: 'Active',
        createdAt: RECONSTRUCTION_DATE,
        updatedAt: RECONSTRUCTION_DATE,
        tags: ['buildings', 'research', 'reconstruction', 'location-permit'],
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
            locationPermitClass: 'UP/I-350-05/22-001/121',
            locationPermitDecisionAt: '2022-07-19',
            locationPermitFinalAt: '2022-08-16',
            publicWfs: 'https://oss.uredjenazemlja.hr/OssWebServices/external/eDozvole',
            parcel: 'current k.č. 2795/3, MB 340057, k.o. Stenjevec Jug; permit records use k.o. Stenjevec, MB 335592',
            sourceStatistics
        }
    };
    return { proposal, stats, matches };
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

async function exportObservedContext(pool) {
    const result = await pool.query(`
        WITH host AS (
            SELECT cestica_id, geom
            FROM public.parcel
            WHERE current = true
              AND maticni_broj_ko = 340057
              AND broj_cestice = '2795/3'
            LIMIT 1
        ), features AS (
            SELECT 0 AS ordering,
                   jsonb_build_object(
                       'type', 'Feature',
                       'properties', jsonb_build_object(
                           'context:role', 'site',
                           'id', $1::text,
                           'cestica_id', host.cestica_id,
                           'maticni_broj_ko', 340057,
                           'broj_cestice', '2795/3',
                           'areaM2', ST_Area(host.geom),
                           'source', 'DGU katastar, aktualna čestica'
                       ),
                       'geometry', ST_AsGeoJSON(ST_Transform(host.geom, 4326))::jsonb
                   ) AS feature
            FROM host
            UNION ALL
            SELECT d.zgrada_id AS ordering,
                   jsonb_build_object(
                       'type', 'Feature',
                       'properties', jsonb_build_object(
                           'context:role', CASE
                               WHEN d.naziv_vrste_zgrade ILIKE 'PODZEMNA GARAŽA%' THEN 'underground-garage'
                               WHEN d.naziv_vrste_zgrade ILIKE 'TRAFOSTANICA%' THEN 'transformer'
                               ELSE 'above-ground-building'
                           END,
                           'dguBuildingId', d.zgrada_id,
                           'dguBuildingNumber', d.broj_zgrade,
                           'dguBuildingType', d.naziv_vrste_zgrade,
                           'footprintAreaM2', d.area_m2,
                           'source', 'DGU katastar, aktualna zgrada'
                       ),
                       'geometry', ST_AsGeoJSON(ST_Transform(d.geom, 4326))::jsonb
                   ) AS feature
            FROM public.dgu_building d
            CROSS JOIN host
            WHERE d.current = true
              AND ST_Intersects(d.geom, host.geom)
              AND ST_Area(ST_Intersection(d.geom, host.geom)) > 10
              AND ST_Area(ST_Intersection(d.geom, host.geom)) / NULLIF(ST_Area(d.geom), 0) >= 0.95
        )
        SELECT jsonb_build_object(
            'type', 'FeatureCollection',
            'name', 'Špansko-Sjever A–F – aktualno DGU stanje',
            'context', jsonb_build_object(
                'schema', 'consensus-builder.reconstruction-context.v1',
                'capturedAt', $2::text,
                'plannedGeometry', 'location-permit-amendment-2022.geojson',
                'note', 'Contains six above-ground buildings, three underground-garage polygons and one transformer polygon.'
            ),
            'features', jsonb_agg(feature ORDER BY ordering)
        ) AS collection
        FROM features
    `, [PARCEL_ID, RECONSTRUCTION_DATE]);
    const collection = result.rows[0]?.collection;
    if (!collection || collection.features.length !== 11) {
        throw new Error(`Špansko context expected 1 site + 10 DGU objects; found ${collection?.features?.length ?? 0}.`);
    }
    await writeFile(OBSERVED_CONTEXT_PATH, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
    console.log(`Exported current parcel plus 10 DGU objects to ${OBSERVED_CONTEXT_PATH}.`);
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
        const { proposal, stats } = await constructSpanskoProposal(pool);
        console.log(JSON.stringify({
            proposalId: proposal.proposalId,
            buildings: stats.buildingCount,
            locationPermitApartments: OFFICIAL_TOTALS.locationPermitApartments,
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
        if (args.includes('--export')) {
            await exportProposal(proposal);
            await exportObservedContext(pool);
        }
    } finally {
        await pool.end();
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
