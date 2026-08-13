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
    },
    {
        key: 'spansko-c-d',
        proposalId: 'pionir-spansko-c-d-observed',
        title: 'Špansko C–D – rekonstrukcija izvedenog stanja',
        blockName: 'Špansko C–D – današnje k.č. 2811/1 i 2811/3',
        description: 'Rekonstrukcija četiriju izvedenih nadzemnih građevina između Ulice Vilima Korajca i Ulice Antuna Šoljana. Pionirova arhiva vodi ih kao projekte C i D na tadašnjoj k.č. 2811/1; današnji katastar dijeli sklop na k.č. 2811/1 i 2811/3. Pet DGU poligona svedeno je na četiri fizička tlocrta jer se zgrade 795 i 796 dodiruju i čine jedan spojeni objekt. Oznake C i D nisu pridružene pojedinim tlocrtima bez arhivskog situacijskog nacrta.',
        municipalityId: 340057,
        municipalityName: 'Stenjevec Jug',
        parcelNumbers: ['2811/1', '2811/3'],
        expectedBuildings: 4,
        sourceUrl: 'https://web.archive.org/web/20111116184239/http://pionir.hr/prodaja-nekretnina-spansko-objekt-c.html',
        sourceUrls: [
            'https://web.archive.org/web/20111116184239/http://pionir.hr/prodaja-nekretnina-spansko-objekt-c.html',
            'https://web.archive.org/web/20111116184239/http://pionir.hr/prodaja-nekretnina-spansko-objekt-d.html',
            'https://www.vecernji.hr/zagreb/parking-spansko-automat-zagreb-1200726'
        ],
        dates: 'Pionirova arhiva potvrđuje useljive objekte C i D najkasnije u ožujku 2011.; širi sklop nastajao je fazno od druge polovice 2000-ih.',
        colors: ['#2f6fed', '#6f42c1', '#198754', '#fd7e14'],
        officialLabels: ['C', 'D'],
        positionLabelBasis: 'interni naziv prema položaju; arhivske oznake C i D još nisu sigurno pridružene pojedinim tlocrtima',
        buildingGroups: [
            {
                dguIds: [13391660, 13391842],
                name: 'Tlocrt 1 (krajnji sjeverni; k.č. 2811/3)',
                heightM: 21,
                floors: 7,
                heightBasis: 'OpenStreetMap way 224229831 preko Overturea: 7 etaža × 3 m; GDI 2008 bilježi samo 1,4 m jer je snimanje prethodilo dovršetku'
            },
            { dguIds: [13391843], name: 'Tlocrt 2 (središnji sjeverni; k.č. 2811/3)' },
            { dguIds: [13391661], name: 'Tlocrt 3 (središnji južni; k.č. 2811/1)' },
            { dguIds: [13391844], name: 'Tlocrt 4 (krajnji južni; k.č. 2811/1)' }
        ],
        projectTotals: {
            apartments: 756,
            physicalBuildings: 4,
            source: 'Večernji list navodi 756 stanova u četiri zgrade cijelog sklopa između Korajca i Šoljana.'
        },
        companyRoleNote: 'Pionirove arhivirane prodajne stranice izravno vode projekte C i D.'
    },
    {
        key: 'spansko-stenjevecki-odvojak',
        proposalId: 'pionir-spansko-stenjevecki-odvojak-observed',
        title: 'Špansko – Stenjevečki odvojak – rekonstrukcija izvedenog stanja',
        blockName: 'Špansko – Stenjevečki odvojak – k.č. 2976/1',
        description: 'Rekonstrukcija svih sedam izvedenih zgrada Pionirova projekta Špansko – Stenjevečki odvojak na k.č. 2976/1, između Ulice Marije Radić i Ulice Antuna Šoljana. Arhiva potvrđuje faze N2, E, N1, F1, F2, N4 i N3 od 2014. do 2019. Današnji katastar ima točno sedam nadzemnih DGU poligona. Oznake faza nisu pridružene pojedinim tlocrtima bez situacijskog nacrta, pa interni nazivi opisuju samo položaj.',
        municipalityId: 340057,
        municipalityName: 'Stenjevec Jug',
        parcelNumbers: ['2976/1'],
        expectedBuildings: 7,
        sourceUrl: 'https://web.archive.org/web/20190111195457/http://pionir.hr/prodaja-nekretnina/pansko-stenjevaki-odvojak.html',
        sourceUrls: [
            'https://web.archive.org/web/20140321092231/http://www.pionir.hr/objekt-n2.html',
            'https://web.archive.org/web/20160127173003/http://pionir.hr/objekt-e.html',
            'https://web.archive.org/web/20160127173003/http://pionir.hr/objekt-n1.html',
            'https://web.archive.org/web/20160812094800/http://pionir.hr/objekt-f1-spansko-stenjevecki.html',
            'https://web.archive.org/web/20180318124812/http://pionir.hr/spansko-stenjecacki-objekt-f2.html',
            'https://web.archive.org/web/20180318124812/http://pionir.hr/pansko-stenjevaki-odvojak-objekt-n4.html',
            'https://web.archive.org/web/20190111195457/http://pionir.hr/spansko-stenjevecki-odvojak-n3.html'
        ],
        dates: 'N2: studeni 2014.; E: prosinac 2015.; N1: prosinac 2016.; F1: srpanj 2017.; F2: ožujak 2018.; N4: prosinac 2018.; N3: svibanj 2019.',
        colors: ['#2f6fed', '#6f42c1', '#d63384', '#198754', '#fd7e14', '#0dcaf0', '#ffc107'],
        officialLabels: ['N2', 'E', 'N1', 'F1', 'F2', 'N4', 'N3'],
        positionLabelBasis: 'interni naziv prema položaju; službene fazne oznake nisu sigurno pridružene pojedinim DGU tlocrtima',
        buildingGroups: [
            { dguIds: [13392284], name: 'Zgrada 1 (sjeverozapadna)' },
            { dguIds: [13392285], name: 'Zgrada 2 (sjeverna središnja)' },
            { dguIds: [13392294], name: 'Zgrada 3 (sjeveroistočna)' },
            { dguIds: [13392283], name: 'Zgrada 4 (zapadna središnja)' },
            { dguIds: [13392293], name: 'Zgrada 5 (istočna središnja)' },
            { dguIds: [13392281], name: 'Zgrada 6 (jugozapadna)' },
            { dguIds: [13392282], name: 'Zgrada 7 (jugoistočna)' }
        ],
        companyRoleNote: 'Pionirove arhivirane prodajne stranice izravno vode svih sedam faza.'
    },
    {
        key: 'selska-bastijanova-viteziceva',
        proposalId: 'pionir-selska-bastijanova-viteziceva-observed',
        title: 'Selska–Baštijanova–Vitezićeva – rekonstrukcija izvedenog stanja',
        blockName: 'Selska–Baštijanova–Vitezićeva – Pionirove faze S–S12',
        description: 'Rekonstrukcija Pionirova stambenog sklopa na prostoru bivšega Logora Krste Frankopana, između Selske ceste, Baštijanove, Vitezićeve i Stubičke. Arhivirane prodajne stranice izravno vežu faze S, S1–S12 uz osam današnjih čestica. Trinaest službenih oznaka prikazano je s jedanaest aktualnih DGU tlocrta: parovi S4–S5 i S6–S7 danas su svaki jedan spojeni pravni poligon. Kod ostalih parova naziv tlocrta navodi skup mogućih oznaka dok situacijski nacrt ne potvrdi pojedinačnu vezu.',
        municipalityId: 339270,
        municipalityName: 'Trešnjevka',
        parcelNumbers: ['2682/89', '2682/91', '2682/93', '2682/95', '2682/97', '2682/99', '2682/102', '2682/104'],
        expectedBuildings: 11,
        sourceUrl: 'https://web.archive.org/web/20190101000000/http://www.pionir.hr/selska-s.html',
        sourceUrls: [
            'https://web.archive.org/web/20110325060405/http://www.pionir.hr/prodaja-nekretnina-selska-objekti-s4-s5.html',
            'https://web.archive.org/web/20110325060405/http://www.pionir.hr/prodaja-nekretnina-selska-objekti-s6-s7.html',
            'https://web.archive.org/web/20130403061240/http://www.pionir.hr/prodaja-nekretnina-selska-objekti-s11-s12.html',
            'https://web.archive.org/web/20141022183448/http://www.pionir.hr/objekti-s9-s10.html',
            'https://web.archive.org/web/20150803100004/http://www.pionir.hr/objekt-s8-v2.html',
            'https://web.archive.org/web/20150803100004/http://www.pionir.hr/selska-s3.html',
            'https://web.archive.org/web/20151213093458/http://www.pionir.hr/selska-s2.html',
            'https://web.archive.org/web/20160617104904/http://www.pionir.hr/selska-s1.html',
            'https://web.archive.org/web/20190101000000/http://www.pionir.hr/selska-s.html'
        ],
        dates: 'S4–S7 su u Pionirovoj ponudi najkasnije 2011.; S11–S12 2013.; S9–S10 i S8 2015.; S2–S3 2016.; S1 2017.; S je useljiv u arhivi 2019. i dovršen 2018. prema projektantskoj referenci.',
        colors: ['#2f6fed', '#6f42c1', '#d63384', '#198754', '#fd7e14', '#0dcaf0', '#ffc107', '#20c997'],
        officialLabels: ['S', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12'],
        positionLabelBasis: 'arhivska oznaka potvrđena je na razini čestice; kod dvaju tlocrta na istoj čestici pojedinačna oznaka ostaje nerazriješena',
        buildingGroups: [
            { dguIds: [13499596], name: 'S4–S5 (k.č. 2682/95)', officialLabels: ['S4', 'S5'] },
            { dguIds: [13499569], name: 'S6–S7 (k.č. 2682/97)', officialLabels: ['S6', 'S7'] },
            { dguIds: [13499600], name: 'S11/S12 – sjeverni tlocrt (k.č. 2682/102)', officialLabels: ['S11', 'S12'] },
            { dguIds: [13499599], name: 'S11/S12 – južni tlocrt (k.č. 2682/102)', officialLabels: ['S11', 'S12'] },
            { dguIds: [13499587], name: 'S9/S10 – sjeverni tlocrt (k.č. 2682/104)', officialLabels: ['S9', 'S10'] },
            { dguIds: [13499598], name: 'S9/S10 – južni tlocrt (k.č. 2682/104)', officialLabels: ['S9', 'S10'] },
            { dguIds: [13499621], name: 'S8 (k.č. 2682/99)', officialLabels: ['S8'] },
            { dguIds: [13499570], name: 'S2/S3 – sjeverni tlocrt (k.č. 2682/93)', officialLabels: ['S2', 'S3'] },
            { dguIds: [13499597], name: 'S2/S3 – južni tlocrt (k.č. 2682/93)', officialLabels: ['S2', 'S3'] },
            { dguIds: [13499584], name: 'S1 (k.č. 2682/91)', officialLabels: ['S1'] },
            { dguIds: [13499564], name: 'S (k.č. 2682/89)', officialLabels: ['S'] }
        ],
        companyRoleNote: 'Pionirove arhivirane prodajne stranice izravno vode faze S i S1–S12.'
    }
]);

function usage() {
    console.log(`Usage: node backend/scripts/seed-pionir-observed-proposals.mjs --dry-run|--apply [--export] [--only key,key]

  --dry-run  Build and validate proposals without writing database rows.
  --apply    Upsert all configured proposals in the local Consensus Builder database.
  --export   Write canonical proposal GeoJSON files and, on a full run, the Rudeš existing-site context.
  --only     Limit the run to comma-separated project keys.`);
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

function configuredParcelNumbers(config) {
    const numbers = config.parcelNumbers || (config.parcelNumber ? [config.parcelNumber] : []);
    if (!numbers.length) throw new Error(`${config.key}: at least one parcel number is required.`);
    return numbers;
}

function mergeFeatures(features, label) {
    if (!features.length) throw new Error(`${label}: no geometry to merge.`);
    return features.slice(1).reduce((merged, entry) => {
        const next = turf.union(merged, entry);
        if (!next?.geometry) throw new Error(`${label}: Turf could not union the configured DGU polygons.`);
        return next;
    }, features[0]);
}

async function readObservedSite(pool, config) {
    const parcelNumbers = configuredParcelNumbers(config);
    const parcelResult = await pool.query(`
        WITH selected AS (
            SELECT cestica_id, broj_cestice, geom
            FROM public.parcel
            WHERE current = true
              AND maticni_broj_ko = $1
              AND broj_cestice = ANY($2::text[])
        ), merged AS (
            SELECT count(*)::integer AS parcel_count,
                   array_agg(cestica_id ORDER BY broj_cestice) AS cestica_ids,
                   ST_UnaryUnion(ST_Collect(geom)) AS geom
            FROM selected
        )
        SELECT parcel_count,
               cestica_ids,
               ST_Area(geom)::double precision AS area_m2,
               ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
        FROM merged
    `, [config.municipalityId, parcelNumbers]);
    const parcelRow = parcelResult.rows[0];
    if (Number(parcelRow?.parcel_count) !== parcelNumbers.length) {
        throw new Error(`${config.key}: expected ${parcelNumbers.length} current parcels, found ${parcelRow?.parcel_count || 0}.`);
    }
    const parcelIds = parcelNumbers.map(number => `HR-${config.municipalityId}-${number}`);
    const siteId = parcelIds.length === 1 ? parcelIds[0] : `site:${config.proposalId}`;
    const parcelFeature = {
        type: 'Feature',
        properties: {
            id: siteId,
            parcelIds,
            cestica_ids: parcelRow.cestica_ids,
            maticni_broj_ko: config.municipalityId,
            broj_cestice: parcelNumbers.length === 1 ? parcelNumbers[0] : null,
            brojevi_cestica: parcelNumbers,
            areaM2: Number(parcelRow.area_m2),
            source: parcelNumbers.length === 1
                ? 'DGU katastar, aktualna čestica'
                : 'DGU katastar, unija aktualnih čestica'
        },
        geometry: parcelRow.geometry
    };

    const configuredIds = config.buildingGroups
        ? [...new Set(config.buildingGroups.flatMap(group => group.dguIds))]
        : null;
    const buildingResult = await pool.query(`
        WITH host AS (
            SELECT ST_UnaryUnion(ST_Collect(geom)) AS geom
            FROM public.parcel
            WHERE current = true
              AND maticni_broj_ko = $1
              AND broj_cestice = ANY($2::text[])
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
          AND ($3::bigint[] IS NULL OR d.zgrada_id = ANY($3::bigint[]))
        ORDER BY ST_X(ST_Centroid(d.geom)), ST_Y(ST_Centroid(d.geom)), d.zgrada_id
    `, [config.municipalityId, parcelNumbers, configuredIds]);
    if (configuredIds && buildingResult.rowCount !== configuredIds.length) {
        throw new Error(`${config.key}: expected ${configuredIds.length} configured DGU polygons, found ${buildingResult.rowCount}.`);
    }
    if (!configuredIds && buildingResult.rowCount !== config.expectedBuildings) {
        throw new Error(`${config.key}: expected ${config.expectedBuildings} DGU buildings, found ${buildingResult.rowCount}.`);
    }

    const rowsById = new Map(buildingResult.rows.map(row => [Number(row.zgrada_id), row]));
    const groups = config.buildingGroups || buildingResult.rows.map((row, index) => ({
        dguIds: [Number(row.zgrada_id)],
        name: config.positionLabels?.[index] || `DGU zgrada ${row.broj_zgrade}`
    }));
    if (groups.length !== config.expectedBuildings) {
        throw new Error(`${config.key}: expected ${config.expectedBuildings} output buildings, configured ${groups.length}.`);
    }

    const buildings = groups.map((group, index) => {
        const rows = group.dguIds.map(id => rowsById.get(Number(id)));
        if (rows.some(row => !row)) {
            const missing = group.dguIds.filter(id => !rowsById.has(Number(id)));
            throw new Error(`${config.key}: configured DGU ids were not found on the site: ${missing.join(', ')}.`);
        }
        const measuredHeights = rows.map(row => Number(row.height_m)).filter(value => Number.isFinite(value) && value > 0);
        const heightM = Number.isFinite(Number(group.heightM))
            ? Number(group.heightM)
            : Math.max(...measuredHeights);
        if (!Number.isFinite(heightM) || heightM <= 0) {
            throw new Error(`${config.key}: DGU building group ${group.dguIds.join(', ')} has no positive height.`);
        }
        const floorEstimate = Number.isFinite(Number(group.floors))
            ? Number(group.floors)
            : Math.max(1, Math.round(heightM / 3));
        const sourceFeatures = rows.map(row => ({ type: 'Feature', properties: {}, geometry: row.geometry }));
        const merged = mergeFeatures(sourceFeatures, `${config.key}/${group.name}`);
        const footprintAreaM2 = rows.reduce((sum, row) => sum + Number(row.area_m2), 0);
        const weightedParcelOverlap = rows.reduce(
            (sum, row) => sum + Number(row.area_m2) * Number(row.parcel_overlap),
            0
        ) / footprintAreaM2;
        const explicitHeight = Number.isFinite(Number(group.heightM));
        return {
            type: 'Feature',
            properties: {
                name: group.name,
                block: config.blockName,
                type: 'proposedBuildingSingle',
                footprintMode: 'polygon',
                height: heightM,
                heightM,
                floors: floorEstimate,
                storeys: floorEstimate,
                floorCountBasis: group.heightBasis || 'procjena iz GDI visine / 3 m; nije podatak iz dozvole',
                color: config.colors[index % config.colors.length],
                source: explicitHeight
                    ? `DGU tlocrt + zamjenska visinska osnova: ${group.heightBasis}`
                    : 'DGU tlocrt + podudarna GDI izmjerena visina',
                positionalLabelBasis: config.positionLabelBasis || null,
                officialProjectLabels: group.officialLabels || config.officialLabels || null,
                dguBuildingId: rows.length === 1 ? rows[0].zgrada_id : null,
                dguBuildingIds: rows.map(row => row.zgrada_id),
                dguBuildingNumber: rows.length === 1 ? rows[0].broj_zgrade : null,
                dguBuildingNumbers: rows.map(row => row.broj_zgrade),
                dguBuildingType: rows.length === 1 ? rows[0].naziv_vrste_zgrade : 'spojeni aktualni DGU poligoni',
                dguBuildingTypes: rows.map(row => row.naziv_vrste_zgrade),
                dguFootprintAreaM2: footprintAreaM2,
                parcelOverlapRatio: weightedParcelOverlap,
                gdiObjectId: rows.length === 1 ? rows[0].gdi_object_id : null,
                gdiObjectIds: rows.map(row => row.gdi_object_id).filter(Boolean),
                gdiSurveyYear: explicitHeight ? null : Math.max(...rows.map(row => Number(row.survey_year)).filter(Number.isFinite)),
                gdiSurveyYears: rows.map(row => row.survey_year).filter(Boolean),
                gdiHeightM: explicitHeight ? null : heightM,
                gdiHeightsM: rows.map(row => Number(row.height_m)).filter(Number.isFinite),
                gdiMatchOverlapRatio: rows.length === 1 ? Number(rows[0].building_overlap_ratio) : null,
                gdiMatchOverlapRatios: rows.map(row => Number(row.building_overlap_ratio)).filter(Number.isFinite),
                observedUseClass: rows.length === 1 ? rows[0].use_class : null,
                observedUseClasses: [...new Set(rows.map(row => row.use_class).filter(Boolean))],
                observedUseGroup: rows.length === 1 ? rows[0].use_group : null,
                observedUseGroups: [...new Set(rows.map(row => row.use_group).filter(Boolean))]
            },
            geometry: merged.geometry
        };
    });
    return { parcelFeature, parcelIds, siteId, parcelNumbers, buildings };
}

export async function constructObservedProposal(pool, config) {
    const { parcelFeature, parcelIds, siteId, parcelNumbers, buildings } = await readObservedSite(pool, config);
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
    const parentParcelNumbers = parcelNumbers.map((number, index) => ({
        id: parcelIds[index],
        number,
        cadastre: config.municipalityName
    }));
    const buildingProposal = {
        parentParcelIds: parcelIds,
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
        ancestorKey: siteId,
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
        parentParcelIds: parcelIds,
        cadastreParcelIds: parcelIds,
        parcelIds,
        acceptedParcelIds: [],
        buildingGeometry: buildings[0].geometry,
        buildingProperties: buildings[0].properties,
        properties: buildings[0].properties,
        geometry: { superParcel: parcelFeature, buildings },
        buildingProposal,
        bounds: geometryBounds(parcelFeature),
        source: {
            projectSource: config.sourceUrl,
            projectSources: config.sourceUrls || [config.sourceUrl],
            projectDates: config.dates,
            parcel: `k.č. ${parcelNumbers.join(', ')}, MB ${config.municipalityId}, k.o. ${config.municipalityName}`,
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
    const allowed = new Set(['--dry-run', '--apply', '--export', '--only']);
    const unknown = args.filter((arg, index) => !allowed.has(arg) && args[index - 1] !== '--only');
    if (unknown.length || (args.includes('--dry-run') === args.includes('--apply'))) {
        usage();
        throw new Error('Choose exactly one of --dry-run or --apply.');
    }
    const onlyIndex = args.indexOf('--only');
    const onlyKeys = onlyIndex >= 0
        ? new Set(String(args[onlyIndex + 1] || '').split(',').map(value => value.trim()).filter(Boolean))
        : null;
    if (onlyKeys && !onlyKeys.size) throw new Error('--only requires at least one project key.');
    const selectedProjects = onlyKeys ? PROJECTS.filter(config => onlyKeys.has(config.key)) : PROJECTS;
    if (onlyKeys && selectedProjects.length !== onlyKeys.size) {
        const known = new Set(PROJECTS.map(config => config.key));
        const missing = [...onlyKeys].filter(key => !known.has(key));
        throw new Error(`Unknown project key(s): ${missing.join(', ')}.`);
    }

    assertLocalDatabase();
    const pool = new Pool();
    try {
        for (const config of selectedProjects) {
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
        if (args.includes('--export') && !onlyKeys) await exportRudesContext(pool);
        if (args.includes('--dry-run')) console.log('Dry run complete; no database row was written.');
    } finally {
        await pool.end();
    }
}

const invokedDirectly = process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
    main().catch(error => {
        console.error(error?.stack || error?.message || error);
        process.exitCode = 1;
    });
}
