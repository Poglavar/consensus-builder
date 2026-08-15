// Reconstructs three recent Zagreb neighbourhood plans from local authoritative spatial data.
//
// Buildings use current DGU footprints and matched GDI heights. Podbrežje additionally carries
// seven explicitly marked plan-derived residential envelopes because only four of its eleven M1
// fields are in the current DGU building layer. Roads use the adopted plan's IS polygons as the
// authoritative footprint and local OSM only for editable centrelines/profiles. Parks and squares
// use the adopted plan polygons and follow the same parcel-formation rules as user-authored public
// spaces; the reconstruction does not carry a second, presentation-only application mode.
//
// Usage:
//   PGHOST=localhost node backend/scripts/seed-neighbourhood-reconstructions.mjs --dry-run --export
//   PGHOST=localhost node backend/scripts/seed-neighbourhood-reconstructions.mjs --apply --export

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import * as turf from '@turf/turf';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertReconstructionGeoJSONRoundTrip } from '../proposals/reconstruction-geojson.js';
import { assertCorridorReconstructionGeoJSONRoundTrip } from '../proposals/corridor-reconstruction-geojson.js';
import { assertStructureReconstructionGeoJSONRoundTrip } from '../proposals/structure-reconstruction-geojson.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const require = createRequire(import.meta.url);
const { corridorProfileFromOsmTags, corridorProfileWidth } = require('../../frontend/js/corridor-profile.js');
const { Pool } = pg;

const ARCHIVE_ROOT = fileURLToPath(new URL('../../rekonstrukcije/nova-naselja/', import.meta.url));
const RECONSTRUCTION_DATE = '2026-08-14T00:00:00.000Z';
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const MIN_PARENT_INTERSECTION_M2 = 0.25;
const MIN_ROAD_SEGMENT_LENGTH_M = 3;
const PODBREZJE_SLAB_WIDTH_M = 18.75;
const PODBREZJE_END_CLEARANCE_M = 3.5;

const OBSERVED_BUILDING_TYPES = Object.freeze([
    'KUĆA',
    'ZGRADA MJEŠOVITE UPORABE',
    'STAMBENA ZGRADA',
    'ŠKOLA',
    'SPORTSKA DVORANA',
    'ZATVORENI BAZEN',
    'JAVNA ZGRADA',
    'GARAŽA',
    'SAKRALNA ZGRADA',
    'POSLOVNA ZGRADA',
    'DJEČJI VRTIĆ'
]);

const BUILDING_COLORS = Object.freeze([
    '#2f6fed', '#6f42c1', '#d63384', '#198754', '#fd7e14', '#0dcaf0', '#ffc107', '#20c997'
]);

export const NEIGHBOURHOODS = Object.freeze([
    {
        key: 'novi-jelkovec',
        planName: 'DPU stambenog naselja na lokaciji Sopnica - Jelkovec',
        title: 'Novi Jelkovec – rekonstrukcija naselja',
        planTitle: 'Novi Jelkovec – zgrade, parkovi, trgovi i prometnice',
        buildingTitle: 'Novi Jelkovec – rekonstrukcija izvedenih zgrada',
        buildingDescription: 'Rekonstrukcija glavnih izvedenih zgrada unutar DPU-a Sopnica–Jelkovec. Tlocrti su aktualna pravna DGU geometrija, a visine su iz najboljega lokalnog podudaranja s GDI snimkom. Terase, stubišta, nadstrešnice, trafostanice i drugi pomoćni poligoni nisu zasebni volumeni.',
        buildingMode: 'observed',
        parkWhere: "oznaka IN ('JP', 'PA')",
        squareWhere: "oznaka LIKE 'JT%'",
        planYears: 'DPU 2003.; izmjene 2007., 2016. i 2020.',
        status: 'izvedeno u cijelosti prema službenoj ocjeni realizacije plana',
        sources: [
            'https://zagreb.hr/izmjene-i-dopune-detaljnog-plana-uredjenja-stamben/168074',
            'https://www.zagreb.hr/userdocsimages/arhiva/prostorni_planovi/dpu%20sopnica%20jelkovec/s-j_graficki%20dio_I%20%2820210120%29.pdf',
            'https://data.zagreb.hr/dataset/geoportal-urbanisticki-planovi-uredenja'
        ]
    },
    {
        key: 'podbrezje',
        planName: 'UPU Podbrežje',
        title: 'Podbrežje – rekonstrukcija UPU-a',
        planTitle: 'Podbrežje – izvedene i planirane zgrade, park i prometnice',
        buildingTitle: 'Podbrežje – jedanaest stambenih blokova UPU-a',
        buildingDescription: 'Četiri izvedena bloka imaju aktualne DGU tlocrte i podudarne GDI visine. Preostalih sedam prikazano je kao plan-derived envelope: položaj i os slijede jedanaest službenih polja M1 te pobjednički urbanistički koncept, a širina i završni odmaci kalibrirani su na četiri izvedena bloka. To nisu tlocrti iz budućih građevinskih dozvola niti sigurna veza s oznakama A1–A11.',
        buildingMode: 'podbrezje-plan',
        parkWhere: "oznaka = 'Z1'",
        squareWhere: 'FALSE',
        planYears: 'UPU 2007.; izmjene 2011.',
        status: 'četiri stambena bloka izvedena; A11 u gradnji; ostatak plana fazno neizveden',
        sources: [
            'https://zagreb.hr/izmjene-i-dopune-urbanistickog-plana-ure%C4%91enja-podb/89126',
            'https://www.log-urbis.hr/development-podbrezje',
            'https://www.zgh.hr/podbrezje/najcesca-pitanja-faq/4506',
            'https://zagreb.hr/gradonacelnik-tomasevic-obisao-radove-na-zgradi-za/217781',
            'https://data.zagreb.hr/dataset/geoportal-urbanisticki-planovi-uredenja'
        ]
    },
    {
        key: 'vrbani-iii',
        planName: 'UPU Vrbani III',
        title: 'Vrbani III – rekonstrukcija naselja',
        planTitle: 'Vrbani III – izvedene zgrade, parkovi i prometnice',
        buildingTitle: 'Vrbani III – rekonstrukcija izvedenih zgrada',
        buildingDescription: 'Rekonstrukcija glavnih izvedenih zgrada unutar UPU-a Vrbani III. Tlocrti su aktualna pravna DGU geometrija, a visine su iz najboljega lokalnog podudaranja s GDI snimkom. Uključene su i veće kuće koje službena granica UPU-a obuhvaća; pomoćni DGU poligoni nisu zasebni volumeni.',
        buildingMode: 'observed',
        parkWhere: "oznaka = 'Z1'",
        squareWhere: 'FALSE',
        planYears: 'UPU 2005.; izmjene 2006.',
        status: 'većim dijelom izvedeno prema službenoj ocjeni realizacije plana',
        sources: [
            'https://www.zagreb.hr/UserDocsImages/arhiva/SlGlasnik.nsf/10288f1421388ff8c1256f2d0049015b/d4c62cbed2fe586ec1256fba003490f1-OpenDocument.htm',
            'https://zagreb.hr/vrbani-iii-krajobrazno-uredjenje-naselja/12202',
            'https://data.zagreb.hr/dataset/geoportal-urbanisticki-planovi-uredenja'
        ]
    }
]);

function usage() {
    console.log(`Usage: node backend/scripts/seed-neighbourhood-reconstructions.mjs --dry-run|--apply [--export] [--only key,key]

  --dry-run  Build and validate all proposals without writing database rows.
  --apply    Upsert proposals and named plans in the local database.
  --export   Write canonical GeoJSON archives and plan manifests.
  --only     Limit the run to comma-separated keys: novi-jelkovec,podbrezje,vrbani-iii.`);
}

export function parseArgs(argv) {
    const args = { apply: false, dryRun: false, export: false, only: null, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--apply') args.apply = true;
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--export') args.export = true;
        else if (arg === '--only') {
            args.only = new Set(String(argv[++index] || '').split(',').map(value => value.trim()).filter(Boolean));
            if (!args.only.size) throw new Error('--only requires at least one project key.');
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!args.help && args.apply === args.dryRun) throw new Error('Choose exactly one of --dry-run or --apply.');
    return args;
}

function assertLocalDatabase() {
    const host = String(process.env.PGHOST || 'localhost').trim().toLowerCase();
    if (!LOCAL_DB_HOSTS.has(host)) {
        throw new Error(`Refusing to seed non-local PGHOST=${host || '(empty)'}.`);
    }
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function feature(geometry, properties = {}) {
    return { type: 'Feature', properties: clone(properties), geometry: clone(geometry) };
}

function isoOffset(minutes) {
    return new Date(Date.parse(RECONSTRUCTION_DATE) + minutes * 60_000).toISOString();
}

function planSource(config, extra = {}) {
    return {
        planName: config.planName,
        planYears: config.planYears,
        implementationStatus: config.status,
        sources: clone(config.sources),
        coordinateSystem: 'lokalni izvori u HTRS96/TM (EPSG:3765), izvoz za aplikaciju u WGS84',
        ...extra
    };
}

async function readPlanContext(pool, config) {
    const siteResult = await pool.query(`
        WITH selected AS (
            SELECT * FROM public.planned_land_use WHERE naziv_plana = $1
        ), merged AS (
            SELECT ST_UnaryUnion(ST_Collect(geom)) AS geom FROM selected
        )
        SELECT count(*)::integer AS feature_count,
               ST_Area(merged.geom)::double precision AS area_m2,
               ST_AsGeoJSON(ST_Transform(merged.geom, 4326))::json AS geometry
        FROM selected CROSS JOIN merged
        GROUP BY merged.geom
    `, [config.planName]);
    const row = siteResult.rows[0];
    if (!row?.geometry || !Number(row.feature_count)) throw new Error(`${config.key}: official plan geometry was not found.`);
    const site = feature(row.geometry, {
        id: `plan-site:${config.key}`,
        name: config.planName,
        source: 'Grad Zagreb – planirana namjena površina',
        areaM2: Number(row.area_m2),
        featureCount: Number(row.feature_count)
    });

    const landUseResult = await pool.query(`
        SELECT objectid,
               namjena,
               skupna_namjena,
               analitika,
               oznaka,
               naziv_kartografskog_prikaza,
               izradivac_plana,
               izvorno_kartografsko_mjerilo,
               godina_zadnje_izmjene,
               id_upu,
               razina_plana,
               ST_Area(geom)::double precision AS area_m2,
               ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
        FROM public.planned_land_use
        WHERE naziv_plana = $1
        ORDER BY objectid
    `, [config.planName]);
    const landUse = {
        type: 'FeatureCollection',
        name: `${config.planName} – službena planirana namjena površina`,
        source: planSource(config, {
            dataset: 'Grad Zagreb, Geoportal – planirana namjena površina',
            capturedAt: RECONSTRUCTION_DATE.slice(0, 10)
        }),
        features: landUseResult.rows.map(entry => feature(entry.geometry, {
            objectid: Number(entry.objectid),
            namjena: entry.namjena,
            skupnaNamjena: entry.skupna_namjena,
            analitika: entry.analitika,
            oznaka: entry.oznaka,
            kartografskiPrikaz: entry.naziv_kartografskog_prikaza,
            izradivacPlana: entry.izradivac_plana,
            izvornoMjerilo: entry.izvorno_kartografsko_mjerilo,
            godinaZadnjeIzmjene: entry.godina_zadnje_izmjene,
            planId: entry.id_upu,
            razinaPlana: entry.razina_plana,
            areaM2: Number(entry.area_m2)
        }))
    };
    return { site, landUse, areaM2: Number(row.area_m2) };
}

async function readParentParcelIds(pool, geometry) {
    const { rows } = await pool.query(`
        WITH footprint AS (
            SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326), 3765) AS geom
        ), hits AS (
            SELECT parcel.maticni_broj_ko,
                   parcel.broj_cestice,
                   ST_Area(ST_Intersection(parcel.geom, footprint.geom)) AS overlap_m2
            FROM public.parcel parcel
            CROSS JOIN footprint
            WHERE parcel.current = true
              AND parcel.geom && footprint.geom
              AND ST_Intersects(parcel.geom, footprint.geom)
        )
        SELECT maticni_broj_ko, broj_cestice, overlap_m2
        FROM hits
        WHERE overlap_m2 >= $2
        ORDER BY overlap_m2 DESC, maticni_broj_ko, broj_cestice
    `, [JSON.stringify(geometry), MIN_PARENT_INTERSECTION_M2]);
    return rows.map(row => `HR-${row.maticni_broj_ko}-${row.broj_cestice}`);
}

async function readObservedBuildings(pool, config, site) {
    const { rows } = await pool.query(`
        WITH site AS (
            SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326), 3765) AS geom
        )
        SELECT building.zgrada_id,
               building.broj_zgrade,
               building.naziv_vrste_zgrade,
               building.area_m2,
               ST_AsGeoJSON(ST_Transform(building.geom, 4326))::json AS geometry,
               observed.object_id AS gdi_object_id,
               observed.height_m::double precision AS height_m,
               observed.survey_year,
               observed.use_class,
               observed.use_group,
               observed.building_overlap_ratio
        FROM public.dgu_building building
        CROSS JOIN site
        LEFT JOIN LATERAL (
            SELECT match.object_id,
                   survey.height_m,
                   survey.survey_year,
                   survey.use_class,
                   survey.use_group,
                   match.building_overlap_ratio
            FROM public.dgu_gdi_building_match match
            JOIN public.gdi_building survey ON survey.object_id = match.object_id
            WHERE match.zgrada_id = building.zgrada_id
            ORDER BY match.building_overlap_ratio DESC NULLS LAST, match.overlap_area_m2 DESC
            LIMIT 1
        ) observed ON true
        WHERE building.current = true
          AND building.area_m2 >= 80
          AND building.naziv_vrste_zgrade = ANY($2::text[])
          AND ST_Covers(site.geom, ST_PointOnSurface(building.geom))
        ORDER BY ST_X(ST_Centroid(building.geom)), ST_Y(ST_Centroid(building.geom)), building.zgrada_id
    `, [JSON.stringify(site.geometry), OBSERVED_BUILDING_TYPES]);
    if (!rows.length) throw new Error(`${config.key}: no observed DGU buildings passed the reconstruction filter.`);
    return rows.map((row, index) => observedBuildingFeature(config, row, index));
}

function observedBuildingFeature(config, row, index) {
    const measuredHeight = Number(row.height_m);
    const hasMeasuredHeight = Number.isFinite(measuredHeight) && measuredHeight > 0;
    const heightM = hasMeasuredHeight ? measuredHeight : 9;
    const floors = Math.max(1, Math.round(heightM / 3));
    const typeLabel = String(row.naziv_vrste_zgrade || 'zgrada').toLocaleLowerCase('hr-HR');
    return feature(row.geometry, {
        name: `${typeLabel} ${row.broj_zgrade || row.zgrada_id}`,
        block: config.title,
        type: 'proposedBuildingSingle',
        footprintMode: 'polygon',
        height: heightM,
        heightM,
        floors,
        storeys: floors,
        floorCountBasis: hasMeasuredHeight
            ? 'procjena iz GDI izmjerene visine / 3 m; nije podatak iz dozvole'
            : 'rezervna procjena od 3 etaže; za ovaj DGU tlocrt nema podudarne GDI visine',
        color: BUILDING_COLORS[index % BUILDING_COLORS.length],
        reconstructionState: 'observed-built-state',
        source: hasMeasuredHeight ? 'DGU pravni tlocrt + podudarna GDI izmjerena visina' : 'DGU pravni tlocrt + eksplicitno označena rezervna visina',
        dguBuildingId: Number(row.zgrada_id),
        dguBuildingNumber: row.broj_zgrade,
        dguBuildingType: row.naziv_vrste_zgrade,
        dguFootprintAreaM2: Number(row.area_m2),
        gdiObjectId: row.gdi_object_id || null,
        gdiSurveyYear: row.survey_year ? Number(row.survey_year) : null,
        gdiHeightM: hasMeasuredHeight ? heightM : null,
        gdiMatchOverlapRatio: row.building_overlap_ratio === null ? null : Number(row.building_overlap_ratio),
        observedUseClass: row.use_class || null,
        observedUseGroup: row.use_group || null
    });
}

async function readPodbrezjeBuildings(pool, config) {
    const { rows } = await pool.query(`
        WITH zones AS (
            SELECT objectid, geom, ST_OrientedEnvelope(geom) AS envelope
            FROM public.planned_land_use
            WHERE naziv_plana = $1 AND oznaka = 'M1'
        ), rings AS (
            SELECT zones.*,
                   ST_Centroid(envelope) AS center,
                   ST_ExteriorRing(envelope) AS ring
            FROM zones
        ), edges AS (
            SELECT rings.*,
                   edge.index,
                   edge.start_point,
                   edge.end_point,
                   ST_Distance(edge.start_point, edge.end_point) AS length_m,
                   ST_Azimuth(edge.start_point, edge.end_point) AS azimuth
            FROM rings
            CROSS JOIN LATERAL (
                SELECT index,
                       ST_PointN(ring, index) AS start_point,
                       ST_PointN(ring, index + 1) AS end_point
                FROM generate_series(1, 4) AS index
            ) edge
        ), axes AS (
            SELECT DISTINCT ON (objectid)
                   objectid,
                   geom,
                   envelope,
                   center,
                   length_m AS long_dimension_m,
                   azimuth
            FROM edges
            ORDER BY objectid, length_m DESC, index
        ), derived AS (
            SELECT axes.*,
                   ST_Intersection(
                       ST_Rotate(
                           ST_Scale(
                               ST_Rotate(envelope, azimuth, center),
                               ST_MakePoint(
                                   $2 / NULLIF(ST_XMax(ST_Envelope(ST_Rotate(envelope, azimuth, center))) - ST_XMin(ST_Envelope(ST_Rotate(envelope, azimuth, center))), 0),
                                   GREATEST(30, long_dimension_m - $3) / NULLIF(ST_YMax(ST_Envelope(ST_Rotate(envelope, azimuth, center))) - ST_YMin(ST_Envelope(ST_Rotate(envelope, azimuth, center))), 0)
                               ),
                               center
                           ),
                           -azimuth,
                           center
                       ),
                       geom
                   ) AS inferred_geom
            FROM axes
        ), matched AS (
            SELECT derived.*,
                   observed.zgrada_id,
                   observed.broj_zgrade,
                   observed.naziv_vrste_zgrade,
                   observed.area_m2,
                   observed.building_geom,
                   observed.gdi_object_id,
                   observed.height_m,
                   observed.survey_year,
                   observed.building_overlap_ratio
            FROM derived
            LEFT JOIN LATERAL (
                SELECT building.zgrada_id,
                       building.broj_zgrade,
                       building.naziv_vrste_zgrade,
                       building.area_m2,
                       building.geom AS building_geom,
                       gdi.object_id AS gdi_object_id,
                       gdi.height_m,
                       gdi.survey_year,
                       gdi.building_overlap_ratio
                FROM public.dgu_building building
                LEFT JOIN LATERAL (
                    SELECT match.object_id,
                           survey.height_m,
                           survey.survey_year,
                           match.building_overlap_ratio
                    FROM public.dgu_gdi_building_match match
                    JOIN public.gdi_building survey ON survey.object_id = match.object_id
                    WHERE match.zgrada_id = building.zgrada_id
                    ORDER BY match.building_overlap_ratio DESC NULLS LAST, match.overlap_area_m2 DESC
                    LIMIT 1
                ) gdi ON true
                WHERE building.current = true
                  AND building.area_m2 >= 500
                  AND building.naziv_vrste_zgrade IN ('ZGRADA MJEŠOVITE UPORABE', 'STAMBENA ZGRADA')
                  AND ST_Covers(derived.geom, ST_PointOnSurface(building.geom))
                ORDER BY building.area_m2 DESC
                LIMIT 1
            ) observed ON true
        )
        SELECT objectid,
               long_dimension_m,
               zgrada_id,
               broj_zgrade,
               naziv_vrste_zgrade,
               area_m2,
               gdi_object_id,
               height_m,
               survey_year,
               building_overlap_ratio,
               ST_Area(COALESCE(building_geom, inferred_geom))::double precision AS footprint_area_m2,
               ST_AsGeoJSON(ST_Transform(COALESCE(building_geom, inferred_geom), 4326))::json AS geometry
        FROM matched
        ORDER BY objectid
    `, [config.planName, PODBREZJE_SLAB_WIDTH_M, PODBREZJE_END_CLEARANCE_M]);
    if (rows.length !== 11) throw new Error(`${config.key}: expected 11 M1 fields, found ${rows.length}.`);
    const observedCount = rows.filter(row => row.zgrada_id).length;
    if (observedCount !== 4) throw new Error(`${config.key}: expected 4 observed DGU blocks, found ${observedCount}.`);
    return rows.map((row, index) => {
        const observed = Boolean(row.zgrada_id);
        const measuredHeight = Number(row.height_m);
        const heightM = observed && Number.isFinite(measuredHeight) && measuredHeight > 0 ? measuredHeight : 27;
        const floors = observed ? Math.max(1, Math.round(heightM / 3)) : 9;
        return feature(row.geometry, {
            name: observed ? `izvedeni blok M1/${row.objectid}` : `planirani blok M1/${row.objectid}`,
            block: config.title,
            type: 'proposedBuildingSingle',
            footprintMode: 'polygon',
            height: heightM,
            heightM,
            floors,
            storeys: floors,
            floorCountBasis: observed
                ? 'procjena iz GDI izmjerene visine / 3 m; nije podatak iz dozvole'
                : 'P+8 prema izvedenim blokovima i programu aktualne A11; indikativno, nije buduća dozvola',
            color: observed ? '#2f6fed' : '#fd7e14',
            reconstructionState: observed ? 'observed-built-state' : 'plan-derived-envelope',
            source: observed
                ? 'DGU pravni tlocrt + podudarna GDI izmjerena visina'
                : 'službeno polje M1 + pobjednički masterplan; širina i završni odmaci kalibrirani na četiri izvedena bloka',
            officialLandUseObjectId: Number(row.objectid),
            officialLandUseCode: 'M1',
            inferredSlabWidthM: observed ? null : PODBREZJE_SLAB_WIDTH_M,
            inferredEndClearanceM: observed ? null : PODBREZJE_END_CLEARANCE_M,
            fieldLongDimensionM: Number(row.long_dimension_m),
            footprintAreaM2: Number(row.footprint_area_m2),
            dguBuildingId: observed ? Number(row.zgrada_id) : null,
            dguBuildingNumber: observed ? row.broj_zgrade : null,
            dguBuildingType: observed ? row.naziv_vrste_zgrade : null,
            gdiObjectId: observed ? row.gdi_object_id : null,
            gdiSurveyYear: observed && row.survey_year ? Number(row.survey_year) : null,
            gdiHeightM: observed ? heightM : null,
            gdiMatchOverlapRatio: observed && row.building_overlap_ratio !== null ? Number(row.building_overlap_ratio) : null,
            officialPhaseLabel: null,
            officialPhaseLabelStatus: 'A1–A11 nisu sigurno pridruženi pojedinim M1 poljima u korištenim izvorima'
        });
    });
}

function buildingStatistics(site, buildings) {
    const parcelAreaM2 = turf.area(site);
    const footprintAreaM2 = buildings.reduce((sum, entry) => sum + turf.area(entry), 0);
    const aboveGroundGbpM2 = buildings.reduce((sum, entry) => {
        const floors = Number(entry.properties?.floors) || 1;
        return sum + turf.area(entry) * floors;
    }, 0);
    return {
        parcelAreaM2,
        footprintAreaM2,
        siteCoveragePercent: parcelAreaM2 > 0 ? footprintAreaM2 / parcelAreaM2 * 100 : 0,
        heightEquivalentAboveGroundGbpM2: aboveGroundGbpM2,
        heightEquivalentKin: parcelAreaM2 > 0 ? aboveGroundGbpM2 / parcelAreaM2 : 0,
        buildingCount: buildings.length,
        observedBuildingCount: buildings.filter(entry => entry.properties?.reconstructionState === 'observed-built-state').length,
        planDerivedBuildingCount: buildings.filter(entry => entry.properties?.reconstructionState === 'plan-derived-envelope').length,
        method: 'zbroj površine tlocrta × procijenjeni broj etaža; dijagnostička vrijednost, nije službeni GBP'
    };
}

async function buildBuildingProposal(pool, config, site) {
    const buildings = config.buildingMode === 'podbrezje-plan'
        ? await readPodbrezjeBuildings(pool, config)
        : await readObservedBuildings(pool, config, site);
    const footprintUnion = buildings.slice(1).reduce((merged, entry) => turf.union(merged, entry), buildings[0]);
    const parentParcelIds = await readParentParcelIds(pool, footprintUnion.geometry);
    const stats = buildingStatistics(site, buildings);
    const proposalId = `reconstruction-${config.key}-buildings`;
    const parentParcelNumbers = parentParcelIds.map(id => ({ id, number: id }));
    const buildingProposal = {
        parentParcelIds,
        parentParcelNumbers,
        createdFrom: 'reconstructed-neighbourhood-plan',
        typologyType: 'single',
        blockName: config.title,
        parameters: {
            typology: 'single',
            floorHeightM: 3,
            geometryBasis: config.buildingMode === 'podbrezje-plan' ? 'mixed-observed-and-plan-derived' : 'observed-built-state',
            sourceStatistics: stats
        },
        buildingFeature: buildings[0],
        buildings,
        ancestorKey: parentParcelIds.slice().sort().join('|'),
        takeWholeParcels: false,
        metadata: { sourceStatistics: stats }
    };
    return {
        proposalId,
        city: 'zagreb',
        name: config.buildingTitle,
        title: config.buildingTitle,
        description: config.buildingDescription,
        author: 'zagreb.lol – lokalna analiza',
        type: 'building',
        goal: 'single',
        primaryType: 'Urban Rule',
        typologyType: 'single',
        lifecycleStatus: 'Active',
        createdAt: isoOffset(2),
        updatedAt: isoOffset(2),
        tags: ['buildings', 'research', 'reconstruction', 'neighbourhood-plan', config.buildingMode === 'podbrezje-plan' ? 'mixed-design-state' : 'observed-built-state'],
        parentParcelIds,
        cadastreParcelIds: clone(parentParcelIds),
        parcelIds: clone(parentParcelIds),
        acceptedParcelIds: [],
        buildingGeometry: clone(buildings[0].geometry),
        buildingProperties: clone(buildings[0].properties),
        properties: clone(buildings[0].properties),
        geometry: { superParcel: clone(site), buildings },
        buildingProposal,
        bounds: turf.bbox(site),
        source: planSource(config, {
            footprintBasis: config.buildingMode === 'podbrezje-plan'
                ? 'četiri aktualna DGU tlocrta + sedam izričito označenih indikativnih omotnica unutar M1 polja'
                : 'aktualni DGU pravni tlocrti glavnih zgrada',
            heightBasis: config.buildingMode === 'podbrezje-plan'
                ? 'GDI za izvedene blokove; P+8 za indikativne neizvedene blokove'
                : 'najbolje lokalno DGU–GDI prostorno podudaranje',
            sourceStatistics: stats
        })
    };
}

function roadBelowGrade(tags) {
    const source = tags || {};
    return ['yes', 'building_passage'].includes(String(source.tunnel || '').toLowerCase())
        || String(source.covered || '').toLowerCase() === 'yes'
        || String(source.location || '').toLowerCase() === 'underground'
        || (Number.isFinite(Number(source.layer)) && Number(source.layer) < 0);
}

async function readRoadGeometry(pool, config) {
    const footprintResult = await pool.query(`
        SELECT ST_Area(ST_UnaryUnion(ST_Collect(geom)))::double precision AS area_m2,
               ST_AsGeoJSON(ST_Transform(ST_UnaryUnion(ST_Collect(geom)), 4326))::json AS geometry
        FROM public.planned_land_use
        WHERE naziv_plana = $1 AND oznaka = 'IS'
    `, [config.planName]);
    const footprintRow = footprintResult.rows[0];
    if (!footprintRow?.geometry) throw new Error(`${config.key}: official IS road footprint was not found.`);

    const roadResult = await pool.query(`
        WITH footprint AS (
            SELECT ST_UnaryUnion(ST_Collect(geom)) AS geom
            FROM public.planned_land_use
            WHERE naziv_plana = $1 AND oznaka = 'IS'
        ), candidates AS (
            SELECT road.osm_id,
                   road.highway_type,
                   road.name,
                   road.width_meters,
                   road.tags,
                   ST_CollectionExtract(ST_Intersection(road.geom_3765, footprint.geom), 2) AS clipped
            FROM public.osm_road road
            CROSS JOIN footprint
            WHERE road.current = true
              AND road.city IN ('croatia', 'zagreb')
              AND road.highway_type IN ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'road')
              AND road.geom_3765 && footprint.geom
              AND ST_Intersects(road.geom_3765, footprint.geom)
        ), pieces AS (
            SELECT candidates.*,
                   COALESCE(dumped.path[1], 1)::integer AS part_index,
                   dumped.geom
            FROM candidates
            CROSS JOIN LATERAL ST_Dump(candidates.clipped) dumped
            WHERE GeometryType(dumped.geom) = 'LINESTRING'
              AND ST_Length(dumped.geom) >= $2
        )
        SELECT osm_id,
               highway_type,
               name,
               width_meters::double precision AS width_meters,
               tags,
               part_index,
               ST_Length(geom)::double precision AS length_m,
               ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
        FROM pieces
        ORDER BY osm_id, part_index
    `, [config.planName, MIN_ROAD_SEGMENT_LENGTH_M]);
    const segments = roadResult.rows
        .filter(row => !roadBelowGrade(row.tags))
        .map(row => ({
            osmId: Number(row.osm_id),
            partIndex: Number(row.part_index),
            id: `osm-${row.osm_id}-${row.part_index}`,
            highwayType: row.highway_type,
            name: row.name || null,
            widthMeters: row.width_meters === null ? null : Number(row.width_meters),
            tags: row.tags || {},
            lengthM: Number(row.length_m),
            geometry: row.geometry
        }));
    if (!segments.length) throw new Error(`${config.key}: official road footprint has no usable local OSM centreline.`);
    return {
        footprint: feature(footprintRow.geometry, {
            name: `${config.title} – površine infrastrukturnih sustava IS`,
            source: 'Grad Zagreb – službena planirana namjena površina',
            areaM2: Number(footprintRow.area_m2)
        }),
        segments
    };
}

function linePoints(geometry) {
    if (!geometry || geometry.type !== 'LineString') throw new Error('Road centreline must be a LineString.');
    return geometry.coordinates.map(([lng, lat]) => ({ lat: Number(lat), lng: Number(lng) }));
}

async function buildRoadProposal(pool, config, site) {
    const { footprint, segments } = await readRoadGeometry(pool, config);
    const profiled = segments.map(segment => {
        const profile = corridorProfileFromOsmTags(segment.tags, segment.widthMeters || undefined);
        const widthM = corridorProfileWidth(profile);
        if (!profile || !Number.isFinite(widthM) || widthM <= 0) {
            throw new Error(`${config.key}: OSM way ${segment.osmId} did not produce a usable profile.`);
        }
        return { ...segment, profile, modelledWidthM: widthM };
    });
    const defaultProfile = clone(profiled[0].profile);
    const segmentProfiles = {};
    profiled.forEach(segment => {
        if (JSON.stringify(segment.profile) !== JSON.stringify(defaultProfile)) {
            segmentProfiles[segment.id] = clone(segment.profile);
        }
    });
    const points = profiled.map(segment => linePoints(segment.geometry));
    const segmentIds = profiled.map(segment => segment.id);
    const parentParcelIds = await readParentParcelIds(pool, footprint.geometry);
    const lengthM = profiled.reduce((sum, segment) => sum + segment.lengthM, 0);
    const title = `${config.title} – planska prometna mreža`;
    const proposalId = `reconstruction-${config.key}-roads`;
    const definition = {
        points,
        segments: clone(points),
        segmentIds,
        profile: defaultProfile,
        width: corridorProfileWidth(defaultProfile),
        segmentProfiles,
        tunnels: [],
        gradeSeparations: [],
        polygon: clone(footprint.geometry),
        metadata: {
            mode: 'import',
            type: 'road',
            isTrack: false,
            isRoad: true,
            isCorridor: true,
            source: 'official-plan-footprint-with-local-osm-centrelines',
            reconstruction: true,
            sourceRows: profiled.map(segment => ({
                segmentId: segment.id,
                osmWayId: segment.osmId,
                osmPartIndex: segment.partIndex,
                highway: segment.highwayType,
                name: segment.name,
                widthMeters: segment.widthMeters,
                modelledWidthM: segment.modelledWidthM,
                lengthM: segment.lengthM,
                tags: clone(segment.tags)
            }))
        }
    };
    return {
        proposalId,
        city: 'zagreb',
        name: title,
        title,
        description: `Rekonstrukcija ${Math.round(lengthM)} m cestovnih središnjica unutar službenih površina IS plana. Poligon planske prometne površine preuzet je iz gradskoga sloja namjene, a položaj i profil izvedenih središnjica iz aktualnoga lokalnog OSM sloja. Pješačke i biciklističke staze nisu zasebno modelirane kao ceste.`,
        author: 'zagreb.lol – lokalna analiza',
        type: 'road',
        goal: 'road-track',
        primaryType: 'Road',
        lifecycleStatus: 'Active',
        createdAt: isoOffset(0),
        updatedAt: isoOffset(0),
        tags: ['roads', 'research', 'reconstruction', 'neighbourhood-plan', 'official-plan-footprint'],
        parentParcelIds,
        cadastreParcelIds: clone(parentParcelIds),
        parcelIds: clone(parentParcelIds),
        acceptedParcelIds: [],
        geometry: clone(footprint.geometry),
        bounds: turf.bbox(footprint),
        roadProposal: {
            definition,
            parentParcelIds: clone(parentParcelIds),
            childParcelIds: [],
            mode: 'import',
            isCorridor: true
        },
        source: planSource(config, {
            geometryBasis: 'aktualne lokalne OSM središnjice, odrezane na službenu površinu IS',
            profileBasis: 'OSM oznake pa standardni Consensus Builder OSM profili',
            footprintBasis: 'Grad Zagreb – planirana namjena površina, oznaka IS',
            osmWayIds: [...new Set(profiled.map(segment => segment.osmId))],
            lengthM,
            footprintAreaM2: Number(footprint.properties.areaM2),
            snapshotDate: RECONSTRUCTION_DATE.slice(0, 10)
        })
    };
}

async function readStructureRows(pool, config, whereSql, kind) {
    if (whereSql === 'FALSE') return [];
    const { rows } = await pool.query(`
        SELECT objectid,
               oznaka,
               namjena,
               skupna_namjena,
               ST_Area(geom)::double precision AS area_m2,
               ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
        FROM public.planned_land_use
        WHERE naziv_plana = $1 AND (${whereSql})
        ORDER BY oznaka, objectid
    `, [config.planName]);
    const totals = new Map();
    rows.forEach(row => totals.set(row.oznaka, (totals.get(row.oznaka) || 0) + 1));
    const seen = new Map();
    const proposals = [];
    for (const row of rows) {
        const ordinal = (seen.get(row.oznaka) || 0) + 1;
        seen.set(row.oznaka, ordinal);
        const parentParcelIds = await readParentParcelIds(pool, row.geometry);
        const descriptor = structureDescriptor(config, kind, row, ordinal, totals.get(row.oznaka));
        const proposalId = `reconstruction-${config.key}-${kind}-${String(row.oznaka || kind).toLowerCase()}-${row.objectid}`;
        proposals.push({
            proposalId,
            city: 'zagreb',
            name: descriptor.title,
            title: descriptor.title,
            description: descriptor.description,
            author: 'zagreb.lol – lokalna analiza',
            type: 'structure',
            goal: kind,
            primaryType: kind === 'park' ? 'Park' : 'Square',
            lifecycleStatus: 'Active',
            createdAt: isoOffset(1),
            updatedAt: isoOffset(1),
            tags: [kind, 'research', 'reconstruction', 'neighbourhood-plan', 'official-plan-footprint'],
            parentParcelIds,
            cadastreParcelIds: clone(parentParcelIds),
            parcelIds: clone(parentParcelIds),
            acceptedParcelIds: [],
            geometry: clone(row.geometry),
            bounds: turf.bbox(feature(row.geometry)),
            structureProposal: {
                kind,
                geometry: clone(row.geometry),
                blockName: `${config.title} – ${row.oznaka} ${ordinal}`,
                parentParcelIds: clone(parentParcelIds),
                applied: false
            },
            source: planSource(config, {
                geometryBasis: 'Grad Zagreb – službena planirana namjena površina',
                officialLandUseObjectId: Number(row.objectid),
                officialLandUseCode: row.oznaka,
                officialLandUseName: row.namjena,
                officialLandUseGroup: row.skupna_namjena,
                areaM2: Number(row.area_m2)
            })
        });
    }
    return proposals;
}

function structureDescriptor(config, kind, row, ordinal, total) {
    const suffix = total > 1 ? ` ${ordinal}` : '';
    if (kind === 'square') {
        return {
            title: `${config.title} – javni trg ${row.oznaka}${suffix}`,
            description: `Površina javnog trga ${row.oznaka} (${Math.round(Number(row.area_m2))} m²) iz službenoga kartografskog prikaza plana. U sustavu se primjenjuje kao redovan prijedlog javnog trga.`
        };
    }
    const label = row.oznaka === 'PA' ? 'parkovna površina' : 'javni park';
    return {
        title: `${config.title} – ${label} ${row.oznaka}${suffix}`,
        description: `${row.namjena || label} ${row.oznaka} (${Math.round(Number(row.area_m2))} m²) iz službenoga kartografskog prikaza plana. U sustavu se primjenjuje kao redovan prijedlog parka.`
    };
}

async function buildNeighbourhood(pool, config) {
    const context = await readPlanContext(pool, config);
    const road = await buildRoadProposal(pool, config, context.site);
    const parks = await readStructureRows(pool, config, config.parkWhere, 'park');
    const squares = await readStructureRows(pool, config, config.squareWhere, 'square');
    const buildings = await buildBuildingProposal(pool, config, context.site);
    return {
        config,
        context,
        road,
        parks,
        squares,
        buildings,
        proposals: [road, ...parks, ...squares, buildings]
    };
}

async function upsertProposal(pool, proposal) {
    const { rows } = await pool.query(`
        INSERT INTO public.proposal (
            proposal_id, city, name, title, description, author, type,
            lifecycle_status, created_at, updated_at,
            ancestor_parcel_ids, cadastre_parcel_ids,
            road_proposal, building_proposal, structure_proposal,
            bounds, proposal_data, applied
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10,
            $11::jsonb, $12::jsonb,
            $13::jsonb, $14::jsonb, $15::jsonb,
            $16::jsonb, $17::jsonb, false
        )
        ON CONFLICT (proposal_id) DO UPDATE SET
            city = EXCLUDED.city,
            name = EXCLUDED.name,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            author = EXCLUDED.author,
            type = EXCLUDED.type,
            lifecycle_status = EXCLUDED.lifecycle_status,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at,
            ancestor_parcel_ids = EXCLUDED.ancestor_parcel_ids,
            cadastre_parcel_ids = EXCLUDED.cadastre_parcel_ids,
            road_proposal = EXCLUDED.road_proposal,
            building_proposal = EXCLUDED.building_proposal,
            structure_proposal = EXCLUDED.structure_proposal,
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
        proposal.updatedAt,
        JSON.stringify(proposal.parentParcelIds || []),
        JSON.stringify(proposal.cadastreParcelIds || []),
        proposal.roadProposal ? JSON.stringify(proposal.roadProposal) : null,
        proposal.buildingProposal ? JSON.stringify(proposal.buildingProposal) : null,
        proposal.structureProposal ? JSON.stringify(proposal.structureProposal) : null,
        JSON.stringify(proposal.bounds || null),
        JSON.stringify(proposal)
    ]);
    return rows[0];
}

async function upsertNamedPlan(pool, config, proposalRows) {
    const tokenHash = crypto.createHash('sha256').update(`local-reconstruction:${config.key}`).digest('hex');
    const proposalIds = proposalRows.map(row => String(row.id));
    const { rows } = await pool.query(`
        INSERT INTO public.ens_plan (slug, proposal_ids, title, city, edit_token_hash)
        VALUES ($1, $2::jsonb, $3, 'zagreb', $4)
        ON CONFLICT (slug) DO UPDATE SET
            proposal_ids = EXCLUDED.proposal_ids,
            title = EXCLUDED.title,
            city = EXCLUDED.city,
            updated_at = NOW()
        RETURNING slug, proposal_ids
    `, [config.key, JSON.stringify(proposalIds), config.planTitle, tokenHash]);
    return rows[0];
}

function archiveFilename(proposal) {
    if (proposal.roadProposal) return 'proposal-roads.geojson';
    if (proposal.buildingProposal) return 'proposal-buildings.geojson';
    const kind = proposal.structureProposal?.kind || 'structure';
    const source = proposal.source || {};
    return `proposal-${kind}-${String(source.officialLandUseCode || kind).toLowerCase()}-${source.officialLandUseObjectId}.geojson`;
}

async function exportNeighbourhood(result) {
    const directory = `${ARCHIVE_ROOT}${result.config.key}`;
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/plan-land-use.geojson`, `${JSON.stringify(result.context.landUse, null, 2)}\n`, 'utf8');

    const entries = [];
    for (const proposal of result.proposals) {
        const filename = archiveFilename(proposal);
        let collection;
        let geometryCount;
        if (proposal.buildingProposal) {
            const roundTrip = assertReconstructionGeoJSONRoundTrip(proposal);
            collection = roundTrip.collection;
            geometryCount = roundTrip.buildingCount;
        } else if (proposal.roadProposal) {
            const roundTrip = assertCorridorReconstructionGeoJSONRoundTrip(proposal, result.context.site);
            collection = roundTrip.collection;
            geometryCount = roundTrip.segmentCount;
        } else {
            const roundTrip = assertStructureReconstructionGeoJSONRoundTrip(proposal, result.context.site);
            collection = roundTrip.collection;
            geometryCount = 1;
        }
        await writeFile(`${directory}/${filename}`, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
        entries.push({
            proposalId: proposal.proposalId,
            kind: proposal.roadProposal ? 'road' : (proposal.buildingProposal ? 'building' : proposal.structureProposal.kind),
            file: filename,
            geometryCount
        });
    }
    const stats = result.buildings.source.sourceStatistics;
    const manifest = {
        schema: 'consensus-builder.reconstruction-plan.v1',
        project: result.config.key,
        title: result.config.title,
        planTitle: result.config.planTitle,
        sourcePlan: result.config.planName,
        planYears: result.config.planYears,
        implementationStatus: result.config.status,
        generatedAt: RECONSTRUCTION_DATE,
        planSlug: result.config.key,
        localPath: `/proposals/${result.config.key}?city=zagreb`,
        sources: clone(result.config.sources),
        context: { file: 'plan-land-use.geojson', areaM2: result.context.areaM2 },
        proposals: entries,
        statistics: {
            proposalCount: entries.length,
            buildingCount: stats.buildingCount,
            observedBuildingCount: stats.observedBuildingCount,
            planDerivedBuildingCount: stats.planDerivedBuildingCount,
            parkCount: result.parks.length,
            squareCount: result.squares.length,
            roadCentrelineCount: result.road.roadProposal.definition.segmentIds.length,
            roadLengthM: result.road.source.lengthM,
            roadFootprintAreaM2: result.road.source.footprintAreaM2
        }
    };
    await writeFile(`${directory}/plan.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
}

function summary(result) {
    const stats = result.buildings.source.sourceStatistics;
    return {
        key: result.config.key,
        plan: result.config.planName,
        planAreaM2: Number(result.context.areaM2.toFixed(1)),
        proposals: result.proposals.length,
        buildings: stats.buildingCount,
        observedBuildings: stats.observedBuildingCount,
        planDerivedBuildings: stats.planDerivedBuildingCount,
        parks: result.parks.length,
        squares: result.squares.length,
        roadCentrelines: result.road.roadProposal.definition.segmentIds.length,
        roadLengthM: Number(result.road.source.lengthM.toFixed(1)),
        roadFootprintAreaM2: Number(result.road.source.footprintAreaM2.toFixed(1)),
        localPath: `/proposals/${result.config.key}?city=zagreb`
    };
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) { usage(); return; }
    assertLocalDatabase();
    const selected = args.only
        ? NEIGHBOURHOODS.filter(config => args.only.has(config.key))
        : [...NEIGHBOURHOODS];
    if (args.only && selected.length !== args.only.size) {
        const known = new Set(NEIGHBOURHOODS.map(config => config.key));
        const missing = [...args.only].filter(key => !known.has(key));
        throw new Error(`Unknown project key(s): ${missing.join(', ')}.`);
    }

    const pool = new Pool();
    try {
        for (const config of selected) {
            const result = await buildNeighbourhood(pool, config);
            console.log(JSON.stringify(summary(result), null, 2));
            let manifest = null;
            if (args.export) {
                manifest = await exportNeighbourhood(result);
                console.log(`Exported ${manifest.proposals.length} canonical proposal archives to ${ARCHIVE_ROOT}${config.key}/.`);
            }
            if (args.apply) {
                await pool.query('BEGIN');
                try {
                    const rows = [];
                    for (const proposal of result.proposals) rows.push(await upsertProposal(pool, proposal));
                    const plan = await upsertNamedPlan(pool, config, rows);
                    await pool.query('COMMIT');
                    console.log(`Stored ${rows.length} local proposals and /proposals/${plan.slug}?city=zagreb.`);
                } catch (error) {
                    await pool.query('ROLLBACK');
                    throw error;
                }
            }
        }
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
