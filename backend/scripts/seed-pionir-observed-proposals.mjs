// Reconstructs older, completed Pionir/Paron sites from current DGU legal footprints and
// matched GDI survey heights. The geometry is observed built state, not permit-derived design.

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
const ARCHIVE_ROOT = fileURLToPath(new URL('../../rekonstrukcije/pionir-paron/', import.meta.url));

export const PROJECTS = Object.freeze([
    {
        key: 'folnegoviceva-rapska',
        proposalId: 'paron-folnegoviceva-rapska-observed',
        title: 'Folnegovićeva–Rapska – rekonstrukcija izvedenog stanja',
        blockName: 'Folnegovićeva–Rapska – k.č. 2708/1',
        description: 'Rekonstrukcija triju izvedenih zgrada na k.č. 2708/1, k.o. Trnje. Tlocrti su aktualne pravne DGU geometrije, a visine su iz podudarnih GDI objekata snimljenih 2022. Broj etaža i izvedeni nadzemni GBP nisu preuzeti iz dozvole: prikaz etaža procjena je visine uz 3 m po etaži.',
        municipalityId: 335649,
        municipalityName: 'Trnje',
        parcelNumber: '2708/1',
        expectedBuildings: 3,
        sourceUrl: 'https://web.zagreb.hr/Sjednice/2013/Big_Attach_2013.nsf/0/4CDAF8356CA24D72C1257BE40035B06A/%24FILE/palijativna3.pdf',
        dates: 'Glavni projekt 2008.; uporabne dozvole 2010.–2011.',
        colors: ['#2f6fed', '#198754', '#fd7e14']
    },
    {
        key: 'lovinciceva-f1-f5',
        proposalId: 'paron-lovinciceva-f1-f5-observed',
        title: 'Lovinčićeva F1–F5 – rekonstrukcija izvedenog stanja',
        blockName: 'Lovinčićeva F1–F5 – k.č. 4091/5',
        description: 'Rekonstrukcija pet izvedenih zgrada F1–F5 na k.č. 4091/5, k.o. Peščenica. Tlocrti su aktualne pravne DGU geometrije, a visine su iz podudarnih GDI objekata snimljenih 2022. Oznake F1–F5 još nisu sigurno pridružene pojedinim DGU poligonima, pa su zgrade imenovane katastarskim brojem. Broj etaža i nadzemni GBP procijenjeni su iz visine uz 3 m po etaži.',
        municipalityId: 335533,
        municipalityName: 'Peščenica',
        parcelNumber: '4091/5',
        expectedBuildings: 5,
        sourceUrl: 'https://web.zagreb.hr/Sjednice/2013/Big_Attach_2013.nsf/0/E3D3DCECDA0D6ACEC1257E4D0046B8D7/%24FILE/Paron%20d%20o%20o%20.pdf',
        dates: 'Dozvole po fazama od 2013.; datum završetka još nije utvrđen.',
        colors: ['#6f42c1', '#d63384', '#198754', '#fd7e14', '#2f6fed']
    },
    {
        key: 'pergosiceva-a1-a4',
        proposalId: 'pionir-pergosiceva-a1-a4-observed',
        title: 'Pergošićeva A1–A4 – rekonstrukcija izvedenog stanja',
        blockName: 'Pergošićeva A1–A4 – k.č. 2859/15',
        description: 'Rekonstrukcija četiriju izvedenih stambeno-poslovnih zgrada na k.č. 2859/15, k.o. Stenjevec Jug. Tlocrti su aktualne pravne DGU geometrije, a visine su iz podudarnih GDI objekata snimljenih 2008. Pionirova referenca navodi ukupno 189 stanova, 31 lokal i 86 garaža, ali ne raspodjeljuje ih po zgradama. Oznake A1–A4 nisu sigurno pridružene pojedinim tlocrtima; interni nazivi samo opisuju položaj od zapada prema istoku.',
        municipalityId: 340057,
        municipalityName: 'Stenjevec Jug',
        parcelNumber: '2859/15',
        expectedBuildings: 4,
        sourceUrl: 'https://pionir.hr/reference/stambeno-poslovni-objekti/',
        dates: 'Kompleks je postojao pri GDI snimanju 2008.; točan početak i završetak nisu utvrđeni.',
        colors: ['#2f6fed', '#d63384', '#198754', '#fd7e14'],
        positionLabels: [
            'Zgrada 1 (zapadna)',
            'Zgrada 2 (središnja zapadna)',
            'Zgrada 3 (središnja istočna)',
            'Zgrada 4 (istočna)'
        ],
        positionLabelBasis: 'interni naziv prema položaju od zapada prema istoku; nije oznaka A1–A4 iz dozvole',
        officialLabels: ['A1', 'A2', 'A3', 'A4'],
        projectTotals: {
            apartments: 189,
            commercialUnits: 31,
            garages: 86,
            source: 'GIP PIONIR službena referenca; ukupno za cijelu lokaciju, bez raspodjele po zgradama'
        },
        companyRoleNote: 'GIP PIONIR objavljuje kompleks u svojim referencama; pronađeni izvor ne navodi investitora ni preciznu ugovornu ulogu.'
    }
]);

function usage() {
    console.log(`Usage: node backend/scripts/seed-pionir-observed-proposals.mjs --dry-run|--apply [--export]

  --dry-run  Build and validate proposals without writing database rows.
  --apply    Upsert all configured proposals in the local Consensus Builder database.
  --export   Write canonical proposal GeoJSON files and the Rudeš existing-site context.`);
}

function assertLocalDatabase() {
    const host = String(process.env.PGHOST || 'localhost').trim().toLowerCase();
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
        throw new Error(`Refusing to seed non-local PGHOST=${host || '(empty)'}.`);
    }
}

function geometryBounds(feature) {
    return turf.bbox(feature);
}

async function readObservedSite(pool, config) {
    const parcelResult = await pool.query(`
        SELECT cestica_id,
               ST_Area(geom)::double precision AS area_m2,
               ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
        FROM public.parcel
        WHERE current = true
          AND maticni_broj_ko = $1
          AND broj_cestice = $2
        LIMIT 1
    `, [config.municipalityId, config.parcelNumber]);
    if (parcelResult.rowCount !== 1) {
        throw new Error(`Parcel ${config.parcelNumber}, k.o. ${config.municipalityName} was not found.`);
    }
    const parcelRow = parcelResult.rows[0];
    const parcelId = `HR-${config.municipalityId}-${config.parcelNumber}`;
    const parcelFeature = {
        type: 'Feature',
        properties: {
            id: parcelId,
            cestica_id: parcelRow.cestica_id,
            maticni_broj_ko: config.municipalityId,
            broj_cestice: config.parcelNumber,
            areaM2: Number(parcelRow.area_m2),
            source: 'DGU katastar, aktualna čestica'
        },
        geometry: parcelRow.geometry
    };

    const buildingResult = await pool.query(`
        WITH host AS (
            SELECT geom
            FROM public.parcel
            WHERE current = true
              AND maticni_broj_ko = $1
              AND broj_cestice = $2
            LIMIT 1
        )
        SELECT d.zgrada_id,
               d.broj_zgrade,
               d.naziv_vrste_zgrade,
               d.area_m2,
               ST_Area(ST_Intersection(d.geom, host.geom)) / NULLIF(ST_Area(d.geom), 0) AS parcel_overlap,
               ST_AsGeoJSON(ST_Transform(d.geom, 4326))::json AS geometry,
               observed.object_id AS gdi_object_id,
               observed.height_m::double precision AS height_m,
               observed.survey_year,
               observed.use_class,
               observed.use_group,
               observed.building_overlap_ratio
        FROM public.dgu_building d
        CROSS JOIN host
        LEFT JOIN LATERAL (
            SELECT m.object_id,
                   g.height_m,
                   g.survey_year,
                   g.use_class,
                   g.use_group,
                   m.building_overlap_ratio
            FROM public.dgu_gdi_building_match m
            JOIN public.gdi_building g ON g.object_id = m.object_id
            WHERE m.zgrada_id = d.zgrada_id
            ORDER BY m.building_overlap_ratio DESC NULLS LAST, m.overlap_area_m2 DESC
            LIMIT 1
        ) observed ON true
        WHERE d.current = true
          AND ST_Intersects(d.geom, host.geom)
          AND ST_Area(ST_Intersection(d.geom, host.geom)) > 10
          AND ST_Area(ST_Intersection(d.geom, host.geom)) / NULLIF(ST_Area(d.geom), 0) >= 0.95
        ORDER BY ST_X(ST_Centroid(d.geom)), ST_Y(ST_Centroid(d.geom)), d.zgrada_id
    `, [config.municipalityId, config.parcelNumber]);
    if (buildingResult.rowCount !== config.expectedBuildings) {
        throw new Error(`${config.key}: expected ${config.expectedBuildings} DGU buildings, found ${buildingResult.rowCount}.`);
    }

    const buildings = buildingResult.rows.map((row, index) => {
        const heightM = Number(row.height_m);
        if (!Number.isFinite(heightM) || heightM <= 0) {
            throw new Error(`${config.key}: DGU building ${row.zgrada_id} has no matched positive GDI height.`);
        }
        const floorEstimate = Math.max(1, Math.round(heightM / 3));
        return {
            type: 'Feature',
            properties: {
                name: config.positionLabels?.[index] || `DGU zgrada ${row.broj_zgrade}`,
                block: config.blockName,
                type: 'proposedBuildingSingle',
                footprintMode: 'polygon',
                height: heightM,
                heightM,
                floors: floorEstimate,
                storeys: floorEstimate,
                floorCountBasis: 'procjena iz GDI visine / 3 m; nije podatak iz dozvole',
                color: config.colors[index % config.colors.length],
                source: 'DGU tlocrt + podudarna GDI izmjerena visina',
                positionalLabelBasis: config.positionLabelBasis || null,
                officialProjectLabels: config.officialLabels || null,
                dguBuildingId: row.zgrada_id,
                dguBuildingNumber: row.broj_zgrade,
                dguBuildingType: row.naziv_vrste_zgrade,
                dguFootprintAreaM2: Number(row.area_m2),
                parcelOverlapRatio: Number(row.parcel_overlap),
                gdiObjectId: row.gdi_object_id,
                gdiSurveyYear: row.survey_year,
                gdiHeightM: heightM,
                gdiMatchOverlapRatio: Number(row.building_overlap_ratio),
                observedUseClass: row.use_class,
                observedUseGroup: row.use_group
            },
            geometry: row.geometry
        };
    });
    return { parcelFeature, parcelId, buildings };
}

export async function constructObservedProposal(pool, config) {
    const { parcelFeature, parcelId, buildings } = await readObservedSite(pool, config);
    const stats = densityStats.summarizeDensity({
        parcelFeature,
        buildings,
        turf,
        floorHeightM: 3,
        preferHeight: true
    });
    const sourceStatistics = {
        geometryDerived: {
            parcelAreaM2: stats.parcelAreaM2,
            footprintAreaM2: stats.footprintAreaM2,
            siteCoveragePercent: stats.siteCoveragePercent,
            heightEquivalentAboveGroundGbpM2: stats.aboveGroundGbpM2,
            heightEquivalentKin: stats.kin,
            buildingCount: stats.buildingCount,
            method: 'DGU footprint area × GDI height / 3 m; diagnostic estimate, not permit GBP'
        },
        ...(config.projectTotals ? { publishedProjectTotals: config.projectTotals } : {})
    };
    const parentParcelNumbers = [{
        id: parcelId,
        number: config.parcelNumber,
        cadastre: config.municipalityName
    }];
    const buildingProposal = {
        parentParcelIds: [parcelId],
        parentParcelNumbers,
        createdFrom: 'single-building',
        typologyType: 'single',
        blockName: config.blockName,
        parameters: {
            typology: 'single',
            floorHeightM: 3,
            geometryBasis: 'observed-built-state',
            sourceStatistics
        },
        buildingFeature: buildings[0],
        buildings,
        ancestorKey: parcelId,
        takeWholeParcels: true,
        metadata: { sourceStatistics }
    };
    const proposal = {
        proposalId: config.proposalId,
        city: 'zagreb',
        name: config.title,
        title: config.title,
        description: config.description,
        author: 'zagreb.lol – lokalna analiza',
        type: 'building',
        goal: 'single',
        primaryType: 'Urban Rule',
        typologyType: 'single',
        lifecycleStatus: 'Active',
        createdAt: RECONSTRUCTION_DATE,
        updatedAt: RECONSTRUCTION_DATE,
        tags: ['buildings', 'research', 'reconstruction', 'observed-built-state'],
        parentParcelIds: [parcelId],
        cadastreParcelIds: [parcelId],
        parcelIds: [parcelId],
        acceptedParcelIds: [],
        buildingGeometry: buildings[0].geometry,
        buildingProperties: buildings[0].properties,
        properties: buildings[0].properties,
        geometry: { superParcel: parcelFeature, buildings },
        buildingProposal,
        bounds: geometryBounds(parcelFeature),
        source: {
            projectSource: config.sourceUrl,
            projectDates: config.dates,
            parcel: `k.č. ${config.parcelNumber}, MB ${config.municipalityId}, k.o. ${config.municipalityName}`,
            coordinateSystem: 'DGU/GDI HTRS96/TM (EPSG:3765), transformed to WGS84 for the app',
            footprintBasis: 'current DGU legal building geometry',
            heightBasis: 'matched GDI surveyed object',
            companyRoleNote: config.companyRoleNote || null,
            officialProjectLabels: config.officialLabels || null,
            sourceStatistics
        }
    };
    return { proposal, stats };
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

async function exportProposal(config, proposal) {
    const { collection, buildingCount } = assertReconstructionGeoJSONRoundTrip(proposal);
    const outputPath = `${ARCHIVE_ROOT}${config.key}/proposal.geojson`;
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
    console.log(`Exported ${buildingCount} buildings to ${outputPath}; round trip passed.`);
}

async function exportRudesContext(pool) {
    const result = await pool.query(`
        WITH host AS (
            SELECT cestica_id, geom
            FROM public.parcel
            WHERE current = true
              AND maticni_broj_ko = 335614
              AND broj_cestice = '799/1'
            LIMIT 1
        ), features AS (
            SELECT 0 AS ordering,
                   jsonb_build_object(
                       'type', 'Feature',
                       'properties', jsonb_build_object(
                           'context:role', 'site',
                           'id', 'HR-335614-799/1',
                           'cestica_id', host.cestica_id,
                           'maticni_broj_ko', 335614,
                           'broj_cestice', '799/1',
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
                           'context:role', 'existing-building',
                           'dguBuildingId', d.zgrada_id,
                           'dguBuildingNumber', d.broj_zgrade,
                           'dguBuildingType', d.naziv_vrste_zgrade,
                           'footprintAreaM2', d.area_m2,
                           'source', 'DGU katastar, aktualna zgrada',
                           'plannedGeometry', false
                       ),
                       'geometry', ST_AsGeoJSON(ST_Transform(d.geom, 4326))::jsonb
                   ) AS feature
            FROM public.dgu_building d
            CROSS JOIN host
            WHERE d.current = true
              AND ST_Intersects(d.geom, host.geom)
              AND ST_Area(ST_Intersection(d.geom, host.geom)) > 1
              AND ST_Area(ST_Intersection(d.geom, host.geom)) / NULLIF(ST_Area(d.geom), 0) >= 0.95
        )
        SELECT jsonb_build_object(
            'type', 'FeatureCollection',
            'name', 'Zagrebačka avenija–Rudeš – postojeće stanje prije projekta',
            'context', jsonb_build_object(
                'schema', 'consensus-builder.reconstruction-context.v1',
                'capturedAt', $1::text,
                'plannedGeometryStatus', 'unresolved; obtain amended location/building-permit attachments',
                'article', 'https://baustela.hr/nekretnine/vijesti/76275/nove-zgrade-na-zagrebackoj-zili-kucavici-jos-jedno-pionirovo-naselje-ovog-puta-na-zapadu-grada/vijest',
                'gup2016Comment', 'https://www.zagreb.hr/userdocsimages/arhiva/prostorni_planovi/GUP%20ZAGREBA_KP%20lipanj%202016/izvjesca_preth_jr_pjr/ponovna%20javna%20rasprava/03_IZID%20GUP%20GZ_PJR2016_gospodarstvenici%20tablica.pdf'
            ),
            'features', jsonb_agg(feature ORDER BY ordering)
        ) AS collection
        FROM features
    `, [RECONSTRUCTION_DATE]);
    const collection = result.rows[0]?.collection;
    if (!collection || collection.features.length !== 22) {
        throw new Error(`Rudeš context expected 1 site + 21 buildings; found ${collection?.features?.length ?? 0} features.`);
    }
    const outputPath = `${ARCHIVE_ROOT}zagrebacka-avenija-rudes/existing-context.geojson`;
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
    console.log(`Exported Rudeš site plus 21 existing DGU buildings to ${outputPath}.`);
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
        for (const config of PROJECTS) {
            const { proposal, stats } = await constructObservedProposal(pool, config);
            console.log(JSON.stringify({
                proposalId: proposal.proposalId,
                buildings: stats.buildingCount,
                parcelAreaM2: Number(stats.parcelAreaM2.toFixed(2)),
                footprintAreaM2: Number(stats.footprintAreaM2.toFixed(2)),
                siteCoveragePercent: Number(stats.siteCoveragePercent.toFixed(3)),
                heightEquivalentAboveGroundGbpM2: Number(stats.aboveGroundGbpM2.toFixed(2)),
                heightEquivalentKin: Number(stats.kin.toFixed(4))
            }, null, 2));
            if (args.includes('--apply')) {
                const stored = await upsertProposal(pool, proposal);
                console.log(`Stored local proposal row ${stored.id} (${stored.proposal_id}).`);
            }
            if (args.includes('--export')) await exportProposal(config, proposal);
        }
        if (args.includes('--export')) await exportRudesContext(pool);
        if (args.includes('--dry-run')) console.log('Dry run complete; no database row was written.');
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
