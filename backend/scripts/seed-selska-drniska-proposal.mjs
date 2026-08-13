// Reconstructs Pionir's completed Selska–Drniška complex from one current cadastral
// parcel, deduplicated DGU footprints and matched GDI survey heights.

import dotenv from 'dotenv';
import * as turf from '@turf/turf';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertReconstructionGeoJSONRoundTrip } from '../proposals/reconstruction-geojson.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
await import('../../frontend/js/building-density-stats.js');

const { Pool } = pg;
const densityStats = globalThis.BuildingDensityStats;
const RECONSTRUCTION_DATE = '2026-08-13T00:00:00.000Z';
const PARCEL_ID = 'HR-339270-5652/1';
const PROPOSAL_ID = 'pionir-selska-drniska-observed';
const PROJECT_ROOT = fileURLToPath(new URL('../../rekonstrukcije/pionir-paron/selska-drniska/', import.meta.url));
const PROPOSAL_PATH = `${PROJECT_ROOT}proposal.geojson`;
const CONTEXT_PATH = `${PROJECT_ROOT}observed-context.geojson`;
const PORTFOLIO_URL = 'https://pionir.hr/reference/stambeno-poslovni-objekti/';
const POSITIONS = Object.freeze([
    { name: 'Zgrada 1 (sjeverna)', position: 'north', color: '#2f6fed' },
    { name: 'Zgrada 2 (središnja)', position: 'middle', color: '#d63384' },
    { name: 'Zgrada 3 (južna)', position: 'south', color: '#198754' }
]);

function usage() {
    console.log(`Usage: node backend/scripts/seed-selska-drniska-proposal.mjs --dry-run|--apply [--export]

  --dry-run  Validate the three-building reconstruction without writing a row.
  --apply    Upsert the proposal in the local Consensus Builder database.
  --export   Write canonical proposal GeoJSON and observed DGU context.`);
}

function assertLocalDatabase() {
    const host = String(process.env.PGHOST || 'localhost').trim().toLowerCase();
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
        throw new Error(`Refusing to seed non-local PGHOST=${host || '(empty)'}.`);
    }
}

async function readBuiltState(pool) {
    const parcelResult = await pool.query(`
        SELECT cestica_id,
               ST_Area(geom)::double precision AS area_m2,
               ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
        FROM public.parcel
        WHERE current = true
          AND maticni_broj_ko = 339270
          AND broj_cestice = '5652/1'
        LIMIT 1
    `);
    if (parcelResult.rowCount !== 1) {
        throw new Error('Selska–Drniška parcel 5652/1, MB 339270 was not found.');
    }
    const parcel = parcelResult.rows[0];

    const buildingResult = await pool.query(`
        WITH host AS (
            SELECT geom
            FROM public.parcel
            WHERE current = true
              AND maticni_broj_ko = 339270
              AND broj_cestice = '5652/1'
            LIMIT 1
        ), intersecting AS (
            SELECT d.*,
                   ST_Area(ST_Intersection(d.geom, host.geom))
                       / NULLIF(ST_Area(d.geom), 0) AS parcel_overlap,
                   COUNT(*) OVER (PARTITION BY d.geom_hash) AS source_duplicate_count,
                   ROW_NUMBER() OVER (
                       PARTITION BY d.geom_hash
                       ORDER BY d.date_added DESC, d.zgrada_id DESC
                   ) AS geometry_rank
            FROM public.dgu_building d
            CROSS JOIN host
            WHERE d.current = true
              AND ST_Intersects(d.geom, host.geom)
              AND ST_Area(ST_Intersection(d.geom, host.geom)) > 1
              AND ST_Area(ST_Intersection(d.geom, host.geom))
                    / NULLIF(ST_Area(d.geom), 0) >= 0.95
        ), deduplicated AS (
            SELECT *
            FROM intersecting
            WHERE geometry_rank = 1
        )
        SELECT d.zgrada_id,
               d.broj_zgrade,
               d.naziv_vrste_zgrade,
               d.area_m2,
               d.geom_hash,
               d.date_added,
               d.parcel_overlap,
               d.source_duplicate_count,
               ST_Y(ST_Centroid(d.geom))::double precision AS centroid_y,
               ST_AsGeoJSON(ST_Transform(d.geom, 4326))::json AS geometry,
               observed.object_id AS gdi_object_id,
               observed.height_m::double precision AS gdi_height_m,
               observed.survey_year AS gdi_survey_year,
               observed.building_overlap_ratio AS gdi_overlap_ratio,
               osm.id AS overture_id,
               osm.osm_id,
               osm.height::double precision AS osm_height_m,
               osm.num_floors AS osm_floors,
               osm.class AS osm_class,
               osm.overlap_ratio AS osm_overlap_ratio
        FROM deduplicated d
        LEFT JOIN LATERAL (
            SELECT m.object_id,
                   g.height_m,
                   g.survey_year,
                   m.building_overlap_ratio
            FROM public.dgu_gdi_building_match m
            JOIN public.gdi_building g ON g.object_id = m.object_id
            WHERE m.zgrada_id = d.zgrada_id
            ORDER BY m.building_overlap_ratio DESC NULLS LAST, m.overlap_area_m2 DESC
            LIMIT 1
        ) observed ON true
        LEFT JOIN LATERAL (
            SELECT o.id,
                   o.osm_id,
                   o.height,
                   o.num_floors,
                   o.class,
                   ST_Area(ST_Intersection(d.geom, ST_Transform(o.geom, 3765)))
                       / NULLIF(ST_Area(d.geom), 0) AS overlap_ratio
            FROM public.overture_building_footprint o
            WHERE o.geom && ST_Envelope(ST_Transform(d.geom, 4326))
              AND ST_Intersects(o.geom, ST_Transform(d.geom, 4326))
            ORDER BY ST_Area(ST_Intersection(d.geom, ST_Transform(o.geom, 3765))) DESC
            LIMIT 1
        ) osm ON true
        ORDER BY centroid_y DESC, d.zgrada_id
    `);

    const parcelFeature = {
        type: 'Feature',
        properties: {
            id: PARCEL_ID,
            cestica_id: parcel.cestica_id,
            maticni_broj_ko: 339270,
            broj_cestice: '5652/1',
            areaM2: Number(parcel.area_m2),
            source: 'DGU katastar, aktualna čestica'
        },
        geometry: parcel.geometry
    };
    return { parcelFeature, rows: buildingResult.rows };
}

export function mapSelskaBuildings(rows) {
    const principal = rows
        .filter(row => row.naziv_vrste_zgrade === 'KUĆA' && Number(row.area_m2) > 200)
        .sort((left, right) => Number(right.centroid_y) - Number(left.centroid_y));
    if (principal.length !== 3) {
        throw new Error(`Selska–Drniška expected three deduplicated principal buildings; found ${principal.length}.`);
    }
    if (new Set(principal.map(row => row.geom_hash)).size !== 3) {
        throw new Error('Selska–Drniška principal DGU footprints were not deduplicated by geometry hash.');
    }

    return principal.map((row, index) => {
        const heightM = Number(row.gdi_height_m);
        const overlap = Number(row.gdi_overlap_ratio);
        if (!Number.isFinite(heightM) || heightM <= 0 || !Number.isFinite(overlap) || overlap < 0.95) {
            throw new Error(`DGU building ${row.zgrada_id} lacks a reliable matched GDI height.`);
        }
        const position = POSITIONS[index];
        return {
            type: 'Feature',
            properties: {
                name: position.name,
                block: 'SPO Selska–Drniška – izvedeno stanje',
                type: 'proposedBuildingSingle',
                footprintMode: 'polygon',
                height: heightM,
                heightM,
                floors: 6,
                storeys: 6,
                basementStoreys: 1,
                floorCountBasis: 'Pionirova službena referenca navodi podrum i šest nadzemnih etaža',
                heightBasis: `GDI izmjerena visina, snimanje ${row.gdi_survey_year}.`,
                color: position.color,
                source: 'aktualni, po geom_hashu deduplicirani DGU tlocrt + podudarna GDI visina',
                programme: 'mixed-use',
                groundFloorUse: 'commercial',
                groundFloorHeightM: 4,
                apartmentCount: null,
                apartmentCountStatus: 'nije objavljen u pronađenim izvorima',
                positionalLabel: position.position,
                positionalLabelBasis: 'interni naziv prema položaju, nije oznaka iz dozvole',
                dguBuildingId: row.zgrada_id,
                dguBuildingNumber: row.broj_zgrade,
                dguBuildingType: row.naziv_vrste_zgrade,
                dguFootprintAreaM2: Number(row.area_m2),
                dguGeometryHash: row.geom_hash,
                dguDuplicateRowsCollapsed: Number(row.source_duplicate_count) - 1,
                gdiObjectId: row.gdi_object_id,
                gdiSurveyYear: row.gdi_survey_year,
                gdiHeightM: heightM,
                gdiMatchOverlapRatio: overlap,
                overtureId: row.overture_id,
                osmId: row.osm_id,
                osmDeclaredHeightM: row.osm_height_m === null ? null : Number(row.osm_height_m),
                osmDeclaredFloors: row.osm_floors,
                osmClass: row.osm_class,
                osmDguOverlapRatio: row.osm_overlap_ratio === null ? null : Number(row.osm_overlap_ratio),
                geometryBasis: 'observed-built-footprint'
            },
            geometry: row.geometry
        };
    });
}

export async function constructSelskaProposal(pool) {
    const built = await readBuiltState(pool);
    const buildings = mapSelskaBuildings(built.rows);
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
            aboveGroundVolumes: stats.buildingCount
        },
        floorCountProxy: {
            aboveGroundGbpM2: stats.aboveGroundGbpM2,
            kin: stats.kin,
            method: 'aktualni DGU tlocrt × šest dokumentiranih nadzemnih etaža; nije GBP iz dozvole'
        },
        caveat: 'Broj stanova i točan datum završetka nisu utvrđeni. GDI snimanje iz 2008. dokazuje samo da je kompleks tada već bio izgrađen.'
    };
    const parentParcelNumbers = [{ id: PARCEL_ID, number: '5652/1', cadastre: 'Trešnjevka' }];
    const buildingProposal = {
        parentParcelIds: [PARCEL_ID],
        parentParcelNumbers,
        createdFrom: 'single-building',
        typologyType: 'single',
        blockName: 'SPO Selska–Drniška – izvedeno stanje',
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
        name: 'Selska–Drniška – rekonstrukcija izvedenog stanja',
        title: 'Selska–Drniška – rekonstrukcija izvedenog stanja',
        description: 'Rekonstrukcija triju izvedenih stambeno-poslovnih zgrada na aktualnoj k.č. 5652/1, MB 339270, k.o. Trešnjevka. Tlocrti su deduplicirane DGU geometrije, a visine su iz podudarnih GDI objekata snimljenih 2008. Pionirova službena referenca navodi podrum i šest nadzemnih etaža u svakoj zgradi te poslovnu namjenu prizemlja. Broj stanova i točan datum završetka nisu pronađeni.',
        author: 'zagreb.lol – lokalna analiza',
        type: 'building',
        goal: 'single',
        primaryType: 'Urban Rule',
        typologyType: 'single',
        lifecycleStatus: 'Active',
        createdAt: RECONSTRUCTION_DATE,
        updatedAt: RECONSTRUCTION_DATE,
        tags: ['buildings', 'research', 'reconstruction', 'observed-built-state', 'pionir-reference'],
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
            projectPage: PORTFOLIO_URL,
            projectImages: [
                'https://pionir.hr/wp-content/uploads/2023/11/01-3.jpg',
                'https://pionir.hr/wp-content/uploads/2023/11/02-3.jpg',
                'https://pionir.hr/wp-content/uploads/2023/11/03-3.jpg',
                'https://pionir.hr/wp-content/uploads/2023/11/04-2.jpg'
            ],
            parcel: 'k.č. 5652/1, MB 339270, k.o. Trešnjevka; DGU parcel id 41279125',
            identificationBasis: 'Pionirov naziv i fotografije + točan sklop od tri zgrade uz križanje Selske ceste i Drniške ulice',
            companyRoles: {
                gipPionir: 'objavio projekt u vlastitim referencama',
                piba: 'Pionir navodi da je projekt ostvaren u suradnji s tvrtkom PIBA d.o.o.; točna ugovorna uloga nije utvrđena'
            },
            completionEvidence: 'podudarni GDI objekti imaju godinu snimanja 2008.; to je najkasnija sigurna granica završetka, a ne točan datum',
            footprintBasis: 'current DGU legal building geometry, deduplicated by geom_hash',
            heightBasis: 'matched GDI surveyed objects',
            sourceStatistics
        }
    };
    return { proposal, stats, buildings, parcelFeature: built.parcelFeature, contextRows: built.rows };
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
    const principalIds = new Set(proposal.geometry.buildings.map(feature => feature.properties.dguBuildingId));
    const context = {
        type: 'FeatureCollection',
        name: 'Selska–Drniška – DGU izvedeni kontekst',
        context: {
            schema: 'consensus-builder.reconstruction-context.v1',
            capturedAt: RECONSTRUCTION_DATE,
            geometryBasis: 'current DGU cadastral geometry, deduplicated by geom_hash',
            caveat: 'Terase i stubište ostaju kontekst; samo tri zgrade ulaze u prijedlog.'
        },
        features: [
            { ...parcelFeature, properties: { ...parcelFeature.properties, 'context:role': 'site' } },
            ...contextRows.map(row => ({
                type: 'Feature',
                properties: {
                    'context:role': principalIds.has(row.zgrada_id) ? 'principal-building' : 'supporting-structure',
                    dguBuildingId: row.zgrada_id,
                    dguBuildingNumber: row.broj_zgrade,
                    dguBuildingType: row.naziv_vrste_zgrade,
                    footprintAreaM2: Number(row.area_m2),
                    dguGeometryHash: row.geom_hash,
                    dguSourceDuplicateCount: Number(row.source_duplicate_count),
                    dguDateAdded: row.date_added,
                    parcelOverlapRatio: Number(row.parcel_overlap),
                    centroidNorthing: Number(row.centroid_y),
                    gdiObjectId: row.gdi_object_id,
                    gdiHeightM: row.gdi_height_m === null ? null : Number(row.gdi_height_m),
                    gdiSurveyYear: row.gdi_survey_year,
                    gdiMatchOverlapRatio: row.gdi_overlap_ratio === null ? null : Number(row.gdi_overlap_ratio),
                    overtureId: row.overture_id,
                    osmId: row.osm_id,
                    osmDeclaredHeightM: row.osm_height_m === null ? null : Number(row.osm_height_m),
                    osmDeclaredFloors: row.osm_floors,
                    osmClass: row.osm_class,
                    osmDguOverlapRatio: row.osm_overlap_ratio === null ? null : Number(row.osm_overlap_ratio),
                    source: 'DGU katastar; GDI/OSM podudaranja gdje su dostupna'
                },
                geometry: row.geometry
            }))
        ]
    };
    await writeFile(CONTEXT_PATH, `${JSON.stringify(context, null, 2)}\n`, 'utf8');
    console.log(`Exported ${buildingCount} buildings to ${PROPOSAL_PATH}; round trip passed.`);
    console.log(`Exported ${context.features.length - 1} deduplicated DGU context structures to ${CONTEXT_PATH}.`);
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
        const { proposal, stats, parcelFeature, contextRows } = await constructSelskaProposal(pool);
        console.log(JSON.stringify({
            proposalId: proposal.proposalId,
            buildings: stats.buildingCount,
            parcelAreaM2: Number(stats.parcelAreaM2.toFixed(2)),
            footprintAreaM2: Number(stats.footprintAreaM2.toFixed(2)),
            siteCoveragePercent: Number(stats.siteCoveragePercent.toFixed(3)),
            sixFloorGbpProxyM2: Number(stats.aboveGroundGbpM2.toFixed(2)),
            sixFloorKinProxy: Number(stats.kin.toFixed(4))
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
        console.error(error?.stack || error?.message || error);
        process.exitCode = 1;
    });
}
