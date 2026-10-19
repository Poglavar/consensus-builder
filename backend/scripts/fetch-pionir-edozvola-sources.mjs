// Archives the official public eDozvola geometry used to reconstruct large Pionir/Paron
// projects. These files are source snapshots, not proposals: a later amendment may replace
// an earlier design, and underground/area geometry must not be mistaken for a building volume.

import * as turf from '@turf/turf';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WFS_URL = 'https://oss.uredjenazemlja.hr/OssWebServices/external/eDozvole';
const TYPE_PREFIX = 'eEditorDozvola_MGIPU_Public:';
const ARCHIVE_DATE = '2026-08-13';
const ARCHIVE_ROOT = fileURLToPath(new URL('../../rekonstrukcije/pionir-paron/', import.meta.url));
const LAYERS = Object.freeze([
    'eDozvola_area_polygon',
    'eDozvola_building_line',
    'eDozvola_building_point',
    'eDozvola_building_polygon'
]);

export const CASES = Object.freeze([
    {
        project: 'savica-f1-f3',
        caseId: 'A20211027-2824386-V020101',
        output: 'location-permit-amendment-2021.geojson',
        title: 'Savica F1–F3 – izmjena lokacijske dozvole 2021.',
        note: 'Stariji javni zapis izričito označava nadzemne volumene F1, F2 i F3 te trafostanicu; služi za sigurno pridruživanje oznaka geometriji.',
        expectedMinimum: { eDozvola_building_polygon: 4 }
    },
    {
        project: 'savica-f1-f3',
        caseId: 'P20230927-1364307-Z06',
        output: 'location-permit-amendment-2023.geojson',
        title: 'Savica F1–F3 – izmjena lokacijske dozvole 2023.',
        note: 'Kasnija prihvaćena lokacijska izmjena sadrži tri nadzemna volumena i trafostanicu, ali bez oznaka volumena u javnom WFS-u.',
        expectedMinimum: { eDozvola_building_polygon: 4 }
    },
    {
        project: 'savica-f1-f3',
        caseId: 'A20220330-2833642-V010101',
        output: 'building-permit-f1-f2-2022.geojson',
        title: 'Savica F1–F2 – građevinska dozvola 2022.',
        note: 'Zajednički akt za dva nadzemna stambena volumena; svaki je u javnom zapisu opisan sa 70 stanova.',
        expectedMinimum: { eDozvola_building_polygon: 2 }
    },
    {
        project: 'savica-f1-f3',
        caseId: 'P20240131-1445130-Z01',
        output: 'building-permit-f3-2024.geojson',
        title: 'Savica F3 – građevinska dozvola 2024.',
        note: 'Pojedinačni akt za nadzemni poslovni volumen F3.',
        expectedMinimum: { eDozvola_building_polygon: 1 }
    },
    {
        project: 'zagrebacka-avenija-rudes',
        caseId: 'P20221230-1130193-Z01',
        output: 'building-permit-2022.geojson',
        title: 'Zagrebačka avenija–Rudeš – građevinska dozvola iz 2022.',
        note: 'Ranija dozvola prikazuje faze F1, F2, F3, G1 i G2 točkastom geometrijom; nije dokaz aktualnog projekta iz 2025.',
        expectedMinimum: { eDozvola_building_point: 5 }
    },
    {
        project: 'zagrebacka-avenija-rudes',
        caseId: 'P20250513-1768397-Z06',
        output: 'location-permit-amendment-2025.geojson',
        title: 'Zagrebačka avenija–Rudeš – izmjena lokacijske dozvole 2025.',
        note: 'Pravomoćna izmjena sadrži sedam nadzemnih poligona i jedan zajednički podzemni poligon.',
        expectedMinimum: { eDozvola_building_polygon: 8 }
    },
    {
        project: 'zagrebacka-avenija-rudes',
        caseId: 'P20251224-1934214-Z11',
        output: 'building-permit-amendment-request-2025.geojson',
        title: 'Zagrebačka avenija–Rudeš – zahtjev za izmjenu građevinske dozvole 2025.',
        note: 'Predmet je još u obradi. Objavljeni poligon presijeca više volumena iz prethodne lokacijske dozvole pa se geometrije ne smiju zbrojiti.',
        expectedMinimum: { eDozvola_building_polygon: 1 }
    },
    {
        project: 'spansko-sjever-a-f',
        caseId: 'P20221230-1168647-Z06',
        output: 'location-permit-amendment-2022.geojson',
        title: 'Špansko-Sjever A–F – izmjena lokacijske dozvole 2022.',
        note: 'Šest nadzemnih volumena kompleksa. Brojevi stanova su opisni podaci lokacijske dozvole i kasnije su se u pojedinim fazama mijenjali.',
        expectedMinimum: { eDozvola_building_polygon: 6 }
    },
    {
        project: 'spansko-sjever-a-f',
        caseId: 'P20221230-1098789-Z11',
        output: 'building-a-amendment-2021.geojson',
        title: 'Špansko-Sjever – volumen A, izmjena građevinske dozvole',
        note: 'Imenovani pojedinačni akt služi za pridruživanje oznake A odgovarajućem poligonu lokacijske dozvole.',
        expectedMinimum: { eDozvola_building_polygon: 1 }
    },
    {
        project: 'spansko-sjever-a-f',
        caseId: 'P20221230-1014725-Z11',
        output: 'building-b-amendment-2021.geojson',
        title: 'Špansko-Sjever – volumen B, izmjena građevinske dozvole',
        note: 'Imenovani pojedinačni akt služi za pridruživanje oznake B odgovarajućem poligonu lokacijske dozvole.',
        expectedMinimum: { eDozvola_building_polygon: 1 }
    },
    {
        project: 'spansko-sjever-a-f',
        caseId: 'P20221230-1076644-Z11',
        output: 'building-c-amendment-2021.geojson',
        title: 'Špansko-Sjever – volumen C, izmjena građevinske dozvole',
        note: 'Imenovani pojedinačni akt služi za pridruživanje oznake C odgovarajućem poligonu lokacijske dozvole.',
        expectedMinimum: { eDozvola_building_polygon: 1 }
    },
    {
        project: 'spansko-sjever-a-f',
        caseId: 'P20220913-921965-Z11',
        output: 'building-d-amendment-2023.geojson',
        title: 'Špansko-Sjever – volumen D, izmjena građevinske dozvole',
        note: 'Imenovani pojedinačni akt potvrđuje položaj volumena D.',
        expectedMinimum: { eDozvola_building_polygon: 1 }
    },
    {
        project: 'spansko-sjever-a-f',
        caseId: 'P20220913-921955-Z11',
        output: 'building-e-amendment-2023.geojson',
        title: 'Špansko-Sjever – volumen E, izmjena građevinske dozvole',
        note: 'Imenovani pojedinačni akt potvrđuje položaj volumena E.',
        expectedMinimum: { eDozvola_building_polygon: 1 }
    },
    {
        project: 'spansko-sjever-a-f',
        caseId: 'P20240302-1469305-Z11',
        output: 'building-f-amendment-2024.geojson',
        title: 'Špansko-Sjever – volumen F, izmjena građevinske dozvole',
        note: 'Kasnija izmjena smanjuje F sa 148 na 141 stan i s osam na četiri poslovna prostora; izvorna dozvola navodi P+7+Uk.',
        expectedMinimum: { eDozvola_building_polygon: 1 }
    },
    {
        project: 'borongajska-caviceva',
        caseId: 'A20220613-2838627-V020101',
        output: 'location-permit-2022-full.geojson',
        title: 'Borongajska–Čavićeva – lokacijska dozvola 2022., puni izvorni zapis',
        note: 'Prihvaćeni izvorni zapis s devet nadzemnih volumena, jednom pomoćnom geometrijom i trafostanicom. Taj stariji javni ID čuva potpuniju geometriju zgrada od migriranog P-zapisa istog akta; poligon obuhvata ostao je uz P-zapis.',
        expectedMinimum: { eDozvola_building_polygon: 11 }
    },
    {
        project: 'borongajska-caviceva',
        caseId: 'P20221230-1037184-Z02',
        output: 'location-permit-2022.geojson',
        title: 'Borongajska–Čavićeva – lokacijska dozvola 2022.',
        note: 'Izvorna lokacijska dozvola kompleksa; pojedinačne faze treba rekonstruirati iz kasnijih građevinskih dozvola.',
        expectedMinimum: {}
    },
    {
        project: 'borongajska-caviceva',
        caseId: 'P20241001-1610904-Z06',
        output: 'location-permit-amendment-2024.geojson',
        title: 'Borongajska–Čavićeva – izmjena lokacijske dozvole 2024.',
        note: 'Postupak je završio rješenjem o obustavi, pa je ova geometrija samo revizijski trag i nije prihvaćeno projektno stanje.',
        expectedMinimum: {}
    },
    {
        project: 'borongajska-caviceva',
        caseId: 'P20250825-1836121-Z06',
        output: 'location-permit-amendment-2025.geojson',
        title: 'Borongajska–Čavićeva – izmjena lokacijske dozvole 2025.',
        note: 'Aktualnija službena geometrija s komponentama koje se preklapaju; prije izrade prijedloga treba ih svesti na devet pravnih nadzemnih volumena.',
        expectedMinimum: {}
    },
    {
        project: 'borongajska-caviceva',
        caseId: 'P20240312-1476435-Z01',
        output: 'building-a1-permit-2024.geojson',
        title: 'Borongajska–Čavićeva – volumen A1, građevinska dozvola',
        note: 'Pojedinačni akt za volumen A1; oznaka i brojčani podaci provjereni su u potpisanoj dozvoli koju objavljuje Pionir.',
        expectedMinimum: { eDozvola_building_polygon: 1 }
    },
    {
        project: 'borongajska-caviceva',
        caseId: 'P20230630-1310132-Z01',
        output: 'building-a2-permit-2023.geojson',
        title: 'Borongajska–Čavićeva – volumen A2, građevinska dozvola',
        note: 'Pojedinačni akt za nadzemni volumen A2.',
        expectedMinimum: { eDozvola_building_polygon: 1 }
    },
    {
        project: 'borongajska-caviceva',
        caseId: 'P20241001-1609912-Z01',
        output: 'building-b1-permit-2025.geojson',
        title: 'Borongajska–Čavićeva – volumen B1, građevinska dozvola',
        note: 'Oznaka B1 proizlazi iz projektne faze i pripadajuće Pionirove dokumentacije.',
        expectedMinimum: { eDozvola_building_polygon: 1 }
    },
    {
        project: 'borongajska-caviceva',
        caseId: 'P20250717-1815302-Z01',
        output: 'building-b2-permit-2025.geojson',
        title: 'Borongajska–Čavićeva – volumen B2, građevinska dozvola',
        note: 'Pojedinačni akt za 2.4. fazu, volumen B2.',
        expectedMinimum: { eDozvola_building_polygon: 1 }
    },
    {
        project: 'borongajska-caviceva',
        caseId: 'P20250321-1729062-Z01',
        output: 'building-b3-permit-2025.geojson',
        title: 'Borongajska–Čavićeva – volumen B3, građevinska dozvola',
        note: 'Pojedinačni akt za 2.3. fazu, volumen B3.',
        expectedMinimum: { eDozvola_building_polygon: 1 }
    },
    {
        project: 'borongajska-caviceva',
        caseId: 'P20250428-1757572-Z01',
        output: 'building-b4-permit-2025.geojson',
        title: 'Borongajska–Čavićeva – volumen B4, građevinska dozvola',
        note: 'Pojedinačni akt za 2.5. fazu, volumen B4.',
        expectedMinimum: { eDozvola_building_polygon: 1 }
    }
]);

function usage() {
    console.log(`Usage: node backend/scripts/fetch-pionir-edozvola-sources.mjs [--project <folder>] [--case <id>]

Fetches public national eDozvola WFS features in EPSG:4326 and writes reproducible
source snapshots below rekonstrukcije/pionir-paron. No database rows are changed.`);
}

function parseArgs(args) {
    const filters = {};
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--help' || arg === '-h') return { help: true };
        if (arg === '--project' || arg === '--case') {
            const value = args[index + 1];
            if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
            filters[arg.slice(2)] = value;
            index += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return filters;
}

function wfsUrl(layer, caseId) {
    const url = new URL(WFS_URL);
    url.searchParams.set('service', 'WFS');
    url.searchParams.set('version', '2.0.0');
    url.searchParams.set('request', 'GetFeature');
    url.searchParams.set('typeNames', `${TYPE_PREFIX}${layer}`);
    url.searchParams.set('outputFormat', 'application/json');
    url.searchParams.set('srsName', 'EPSG:4326');
    url.searchParams.set('CQL_FILTER', `predmet_web_id='${caseId.replaceAll("'", "''")}'`);
    return url;
}

async function fetchLayer(layer, caseId) {
    const url = wfsUrl(layer, caseId);
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${caseId}/${layer}: WFS returned HTTP ${response.status}.`);
    const collection = await response.json();
    if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
        throw new Error(`${caseId}/${layer}: expected a GeoJSON FeatureCollection.`);
    }
    return collection.features.map(entry => {
        if (entry.properties?.predmet_web_id !== caseId) {
            throw new Error(`${caseId}/${layer}: received feature for ${entry.properties?.predmet_web_id || 'unknown case'}.`);
        }
        const properties = {
            ...(entry.properties || {}),
            'edozvola:sourceLayer': layer,
            'edozvola:sourceFeatureId': entry.id
        };
        if (entry.geometry && ['Polygon', 'MultiPolygon'].includes(entry.geometry.type)) {
            properties['edozvola:geometryAreaM2'] = Number(turf.area(entry).toFixed(2));
        }
        return { type: 'Feature', properties, geometry: entry.geometry };
    });
}

function representativeProperties(features) {
    const properties = features[0]?.properties || {};
    return {
        caseId: properties.predmet_web_id || null,
        caseClass: properties.predmet_klasa || null,
        caseType: properties.predmet_vrsta || null,
        caseStatus: properties.predmet_status || null,
        requestReceivedAt: properties.zahtjev_dat_zaprimanja || null,
        requestCompleteAt: properties.zahtjev_dat_urednosti || null,
        decisionName: properties.zavrsni_akt_naziv || null,
        decisionNumber: properties.zavrsni_akt_urbroj_rjesenja || null,
        decisionAt: properties.zavrsni_akt_dat_rjesavanja || null,
        finalAt: properties.zavrsni_akt_dat_pravomocnosti || null
    };
}

export async function fetchCase(config) {
    const layerFeatures = await Promise.all(LAYERS.map(async layer => [layer, await fetchLayer(layer, config.caseId)]));
    const counts = Object.fromEntries(layerFeatures.map(([layer, features]) => [layer, features.length]));
    for (const [layer, minimum] of Object.entries(config.expectedMinimum || {})) {
        if ((counts[layer] || 0) < minimum) {
            throw new Error(`${config.caseId}: expected at least ${minimum} ${layer} features; received ${counts[layer] || 0}.`);
        }
    }
    const features = layerFeatures
        .flatMap(([, entries]) => entries)
        .sort((left, right) => {
            const layerDelta = LAYERS.indexOf(left.properties['edozvola:sourceLayer'])
                - LAYERS.indexOf(right.properties['edozvola:sourceLayer']);
            return layerDelta || String(left.properties['edozvola:sourceFeatureId'])
                .localeCompare(String(right.properties['edozvola:sourceFeatureId']), 'en', { numeric: true });
        });
    if (!features.length) throw new Error(`${config.caseId}: no public WFS features found.`);

    const collection = {
        type: 'FeatureCollection',
        name: config.title,
        bbox: turf.bbox(turf.featureCollection(features)),
        edozvola: {
            schema: 'consensus-builder.edozvola-source.v1',
            archivedAt: ARCHIVE_DATE,
            source: WFS_URL,
            sourceService: 'public national eDozvola WFS 2.0.0',
            sourceCrs: 'EPSG:3765',
            outputCrs: 'EPSG:4326',
            geometryOnly: true,
            caveat: 'Public WFS geometry and case metadata are evidence, not a substitute for the signed permit and main project.',
            note: config.note,
            layerFeatureCounts: counts,
            ...representativeProperties(features)
        },
        features
    };
    return collection;
}

async function main() {
    const filters = parseArgs(process.argv.slice(2));
    if (filters.help) {
        usage();
        return;
    }
    const selected = CASES.filter(config => (!filters.project || config.project === filters.project)
        && (!filters.case || config.caseId === filters.case));
    if (!selected.length) throw new Error('No configured case matches the supplied filters.');

    for (const config of selected) {
        const collection = await fetchCase(config);
        const outputPath = `${ARCHIVE_ROOT}${config.project}/${config.output}`;
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
        console.log(`${config.caseId}: wrote ${collection.features.length} features to ${outputPath}`);
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
