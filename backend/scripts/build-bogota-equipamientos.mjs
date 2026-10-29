#!/usr/bin/env node
// Builds the Decreto 253/2026 Anexo 36.1 lookup (storeys per "Equipamientos" polygon of the Bogotá
// POT treatment map) from the annex's extracted text and the treatment layer, keyed by the layer's
// OBJECTID. The annex numbers its polygons 1–596; the layer's blank-height Consolidación polygons,
// sorted by OBJECTID, follow the same order (verified against the annex's lot codes, see
// docs/bogota-pot-source.md). Usage:
//   pdftotext -layout anexo-36-1.pdf anexo-36-1.txt
//   node scripts/build-bogota-equipamientos.mjs --annex anexo-36-1.txt --treatments layer-15.geojson \
//        --out planning/providers/bogota-pot-equipamientos.json
// `--treatments` may be omitted to read the live treatment layer from the ArcGIS service.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BOGOTA_POT_SERVICE, BOGOTA_POT_LAYERS } from '../planning/providers/bogota-pot.js';

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
const args = Object.fromEntries(process.argv.slice(2).map((arg, i, all) => arg.startsWith('--') ? [arg.slice(2), all[i + 1]] : []).filter(pair => pair.length));
if (isMain && (!args.annex || !args.out || process.argv.includes('--help'))) {
    console.log('Usage: build-bogota-equipamientos.mjs --annex <anexo-36-1.txt> --out <lookup.json> [--treatments <layer-15.geojson>]');
    process.exit(args.annex && args.out ? 0 : 1);
}
const log = (...parts) => console.log(`[${new Date().toISOString()}]`, ...parts);

// Lines of the annex that belong to no row: page furniture and the decree's running title.
const furniture = /CLASIFICACIÓN DE LA INFORMACIÓN|2310460-FT-078|Continuación del Decreto|Por medio del cual|Decreto Distrital 670|relativo a la altura|de Consolidación bajo|5\.4\.33|disposiciones”|^\s*ID polígono|^\s*dotacional\s+ALTURA|^\s*MAPA\s+NÚMERO|^\s*DE PISOS|ANEXO No\.|IDENTIFICACIÓN DE POLÍGONOS|DECRETO No\.|^\s*\(\s+\)\s*$/;
const rowStart = /^\s*ID\s+(\d+)\s+C\/(\S+)\s+(\S+)(?:\s+(.*))?$/;
const lotCode = /^\d{10}$/;

// Annex lot codes are sector(2) + barrio(4) + manzana(2) + lote(2); the UAECD lot layer writes
// manzana and lote with three digits each, so a code widens by one leading zero in each.
export function widenLotCode(code) {
    return /^\d{10}$/.test(code) ? `${code.slice(0, 6)}0${code.slice(6, 8)}0${code.slice(8, 10)}` : null;
}

export function parseAnnex(text) {
    const rows = [];
    let row = null;
    let notes = false;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim() || furniture.test(line)) continue;
        // The closing footnotes ("-   N/A: No aplica…") belong to no row.
        if (/^\s*-\s{2,}/.test(line)) notes = true;
        if (notes && !rowStart.test(line)) continue;
        notes = false;
        const start = rowStart.exec(line);
        if (start) {
            const [, id, legend, decision, rest] = start;
            row = { id: Number(id), legend: `C/${legend}`, storeys: /^\d+$/.test(decision) ? Number(decision) : null, decision, codes: [], condition: '' };
            rows.push(row);
            for (const token of (rest || '').trim().split(/\s{2,}/).filter(Boolean)) {
                if (lotCode.test(token)) row.codes.push(token);
                else if (token === 'NO TIENE') row.codes.push(null);
                else row.condition = row.condition ? `${row.condition} ${token}` : token;
            }
            continue;
        }
        if (!row) continue;
        const token = line.trim();
        if (lotCode.test(token)) row.codes.push(token);
        else if (token === 'NO TIENE') row.codes.push(null);
        else row.condition = row.condition ? `${row.condition} ${token}` : token;
    }
    for (const entry of rows) entry.codes = entry.codes.filter(Boolean);
    return rows;
}

async function treatmentFeatures() {
    if (args.treatments) return JSON.parse(readFileSync(args.treatments, 'utf8')).features;
    const features = [];
    let offset = 0;
    for (;;) {
        const url = new URL(`${BOGOTA_POT_SERVICE}/${BOGOTA_POT_LAYERS.treatment}/query`);
        for (const [key, value] of Object.entries({ f: 'geojson', outSR: '4326', outFields: 'OBJECTID,TRATAMIENTO,ALTURA_MAXIMA,OBSERVACION',
            returnGeometry: 'false', where: '1=1', orderByFields: 'OBJECTID', resultOffset: offset, resultRecordCount: 2000 })) url.searchParams.set(key, String(value));
        const page = await (await fetch(url)).json();
        if (!Array.isArray(page.features)) throw new Error('Treatment layer read failed.');
        features.push(...page.features);
        log(`treatment layer: ${features.length} features`);
        if (!page.properties?.exceededTransferLimit) return features;
        offset += page.features.length;
    }
}

if (isMain) {
    const annex = parseAnnex(readFileSync(args.annex, 'utf8'));
    const ids = annex.map(row => row.id);
    if (ids.some((id, i) => id !== i + 1)) throw new Error(`Annex rows are not 1..n: ${ids.filter((id, i) => id !== i + 1).slice(0, 5)}`);
    const blank = (await treatmentFeatures()).filter(f => String(f.properties.TRATAMIENTO).trim() === 'CONSOLIDACION' && !String(f.properties.ALTURA_MAXIMA ?? '').trim())
        .sort((a, b) => a.properties.OBJECTID - b.properties.OBJECTID);
    if (blank.length !== annex.length) throw new Error(`Annex has ${annex.length} rows, the layer ${blank.length} blank-height Consolidación polygons.`);
    // Sanity: the editors' notes on the map polygons match the annex's special conditions in rank order.
    const hints = [[/TORCA/, /Torca|Incorporaci/i], [/SUBESTACION|TANQUE/, /Servicios Públicos/i], [/PARQUES/, /Zona verde|EQUIPAMIENTO COMUNAL|Parque/i]];
    let checked = 0, agreed = 0;
    const lookup = {};
    blank.forEach((feature, i) => {
        const row = annex[i], note = String(feature.properties.OBSERVACION ?? '').trim();
        for (const [notePattern, conditionPattern] of hints) if (notePattern.test(note)) { checked++; if (conditionPattern.test(row.condition)) agreed++; }
        lookup[feature.properties.OBJECTID] = { id: row.id, legend: row.legend, storeys: row.storeys, decision: row.decision,
            lots: row.codes.map(widenLotCode), condition: row.condition || null };
    });
    log(`rank check: ${agreed}/${checked} annotated polygons agree with their annex row`);
    if (checked && agreed / checked < 0.8) throw new Error('The annex order does not match the layer order; not writing.');
    const storeys = annex.filter(row => row.storeys !== null).length;
    writeFileSync(args.out, `${JSON.stringify({ decree: 'Decreto Distrital 253 de 2026, Anexo 36.1 "Identificación de polígonos y predios"',
        source: 'https://www.bogotajuridica.gov.co/sisjur/normas/Norma1.jsp?i=193583', layer: BOGOTA_POT_LAYERS.treatment,
        builtAt: new Date().toISOString().slice(0, 10), polygons: lookup }, null, 1)}\n`);
    log(`wrote ${args.out}: ${annex.length} polygons, ${storeys} with storeys, ${annex.length - storeys} without (N/A)`);
}
