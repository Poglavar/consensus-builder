#!/usr/bin/env node

// Build consensus-builder proposals from the extracted UPU "Borovje - zona jug"
// geometry (see extract-plan.py) and upload them to the backend via POST /proposals.
// Buildings become single-building proposals (one per kazeta, heights from the
// plan's PP rules), green zones become park structure proposals, and street corridors become
// first-class road proposals. The complementary non-road ground becomes three contiguous
// land-readjustment proposals, so road and plot proposals form one conserved tessellation.
//
// Usage:
//   node build-and-upload.mjs --dry-run                 # build + report, POST nothing
//   node build-and-upload.mjs --apply [--base-url URL]  # POST to the backend (default http://localhost:3000)
//
// Idempotent: proposalIds are deterministic (upu-borovje-*), so re-running
// --apply updates/duplicates nothing server-side that already exists under the
// same id (the backend upserts by proposal id).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { buildBorovjeTopology, roadDefinitionFor } from './plan-topology.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const require = createRequire(path.join(repoRoot, 'backend', 'package.json'));
const turf = require('@turf/turf');

const CITY = 'zagreb';
const COORDINATED_PLAN_ID = 'upu-borovje';
// Kept stable because the historical import and shared links already use these identifiers.
const PARCELATION_IDS = [
    'p-upu-borovje-parcelacija',
    'p-upu-borovje-parcelacija-2',
    'p-upu-borovje-parcelacija-3'
];
const AUTHOR = 'UPU Borovje – zona jug (Grad Zagreb, prijedlog plana 2026)';
const FLOOR_HEIGHT_M = 3.5;

// Per-kazeta rules from the plan's textual provisions (odredbe za provedbu):
// etažnost and above-ground utilisation coefficient per provedbeno pravilo.
const PP_RULES = {
    'PP-1': { etaznost: 'P+3', kisn: 1.5 },
    'PP-2': { etaznost: 'P+4', kisn: 1.7 },
    'PP-3': { etaznost: 'P+8', kisn: 1.6 },
    'PP-4': { etaznost: 'P+5', kisn: 2.1 },
    'PP-5': { etaznost: 'P+1+Pk', kisn: null }, // existing housing - not generated
};

async function loadGeojson(name) {
    const file = path.join(scriptDir, 'data', name);
    return JSON.parse(await readFile(file, 'utf8'));
}

function parcelIntersectors(parcels, options = {}) {
    // Pre-wrap parcel features once; return a lookup of parcelIds whose overlap with a polygon is
    // substantive. Raster-traced bodies use the 10 m² / 2% defaults to reject boundary jitter;
    // exact plan polygons opt into the app's measured 0.25 m² ancestry floor.
    const wrapped = parcels.features.map(f => ({
        id: f.properties.parcelId,
        feature: f,
        bbox: turf.bbox(f),
        area: turf.area(f),
    }));
    const minAreaM2 = Number.isFinite(options.minAreaM2) ? options.minAreaM2 : 10;
    const minShare = Number.isFinite(options.minShare) ? options.minShare : 0.02;
    return (geometry) => {
        const target = { type: 'Feature', properties: {}, geometry };
        const tb = turf.bbox(target);
        const targetArea = turf.area(target);
        const ids = [];
        for (const p of wrapped) {
            if (p.bbox[0] > tb[2] || p.bbox[2] < tb[0] || p.bbox[1] > tb[3] || p.bbox[3] < tb[1]) continue;
            try {
                const overlap = turf.intersect(p.feature, target);
                if (!overlap) continue;
                const a = turf.area(overlap);
                if (a >= minAreaM2 || (minShare > 0 && a > minShare * Math.min(p.area, targetArea))) ids.push(p.id);
            } catch (_) { /* degenerate ring - skip */ }
        }
        return ids.sort();
    };
}

function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function buildBuildingProposal(feature, intersecting) {
    const { name, pp, floors } = feature.properties;
    if (pp === 'PP-5') return null; // M1-12: existing houses are kept, nothing to build
    const rule = PP_RULES[pp] || {};
    const height = Math.round(floors * FLOOR_HEIGHT_M * 10) / 10;
    const parentParcelIds = intersecting(feature.geometry);
    if (!parentParcelIds.length) {
        throw new Error(`${name}: no intersecting parcels found`);
    }
    const buildingFeature = {
        type: 'Feature',
        properties: {
            type: 'proposedBuildingSingle',
            height,
            rotation: 0,
            block: `UPU Borovje ${name}`,
        },
        geometry: feature.geometry,
    };
    return {
        proposalId: `upu-borovje-${slugify(name)}`,
        coordinatedPlanId: COORDINATED_PLAN_ID,
        city: CITY,
        goal: 'single',
        type: 'building',
        title: `UPU Borovje – zgrada ${name} [${pp}]`,
        name: `UPU Borovje – zgrada ${name} [${pp}]`,
        description: `Kazeta ${name}, pravilo provedbe [${pp}]: ${rule.etaznost}`
            + ` (${floors} nadzemnih etaža${rule.kisn ? `, kisn ${rule.kisn}` : ''}),`
            + ` površina za smještaj zgrade ${feature.properties.area_m2} m².`
            + ' Izvedeno iz kartografskog prikaza 4. Način i uvjeti gradnje,'
            + ' UPU Borovje – zona jug (prijedlog plana za javnu raspravu, 2026).',
        author: AUTHOR,
        lifecycleStatus: 'Active',
        parentParcelIds,
        acceptedParcelIds: [],
        buildingProposal: {
            parentParcelIds,
            parameters: { height, floors, typology: 'single', rotation: 0 },
            ancestorKey: parentParcelIds.join('|'),
            buildings: [buildingFeature],
            applied: false,
        },
        geometry: { buildings: [buildingFeature] },
    };
}

function buildParkProposal(feature, intersecting) {
    const { name, kind, area_m2 } = feature.properties;
    const parentParcelIds = intersecting(feature.geometry);
    if (!parentParcelIds.length) {
        throw new Error(`${name}: no intersecting parcels found`);
    }
    const isRecreation = kind === 'R2';
    const title = isRecreation
        ? `UPU Borovje – rekreacija ${name} (otvorena igrališta)`
        : `UPU Borovje – javni park ${name}`;
    return {
        proposalId: `upu-borovje-${slugify(name)}`,
        coordinatedPlanId: COORDINATED_PLAN_ID,
        city: CITY,
        goal: 'park',
        type: 'structure',
        title,
        name: title,
        description: (isRecreation
            ? `Zona sportsko-rekreacijske namjene R2 (${area_m2} m²): otvoreni sportski tereni i igrališta.`
            : `Javna zelena površina – park Z1 (${area_m2} m²), uključuje dječja igrališta prema odredbama.`)
            + ' Izvedeno iz kartografskog prikaza 1. Korištenje i namjena površina,'
            + ' UPU Borovje – zona jug (prijedlog plana za javnu raspravu, 2026).',
        author: AUTHOR,
        lifecycleStatus: 'Active',
        parentParcelIds,
        acceptedParcelIds: [],
        structureProposal: {
            kind: 'park',
            geometry: feature.geometry,
            blockName: `UPU Borovje ${name}`,
            parentParcelIds,
            applied: false,
        },
    };
}

const SLICE_COLORS = { M1: '#e8a24a', Z1: '#69b86b', R2: '#3aa88a', IS: '#9aa0a6', OST: '#b9b3a8' };

function sliceDisplayName(props) {
    if (props.kind === 'M1') return `Građevna čestica ${props.name}`;
    if (props.kind === 'R2') return `Rekreacija ${props.name}`;
    if (props.kind === 'Z1') return `Javni park ${props.name}`;
    if (props.kind === 'OST') return `Preostala čestica ${props.name}`;
    return `Prometna površina ${props.name}`;
}

const areaOf = (geometry) => turf.area({ type: 'Feature', properties: {}, geometry });

// Proposal anchors must come from the cadastre the target app actually serves, not the UPU
// FeatureServer snapshot: the two sources carry different parcel generations in places.
// The plan geometry remains the canonical UPU mesh; these live parcels only anchor that geometry.
async function fetchAppParcels(baseUrl) {
    // plan-area bbox in EPSG:3765 (HTRS96/TM), generous margin around the obuhvat
    const bbox = '461744,5071628,462447,5072233';
    const res = await fetch(`${baseUrl}/parcels?bbox=${bbox}`);
    if (!res.ok) throw new Error(`GET /parcels?bbox failed (${res.status}) - is the backend at ${baseUrl} running?`);
    const fc = await res.json();
    if (!Array.isArray(fc.features) || !fc.features.length) {
        throw new Error('backend returned no parcels for the plan bbox');
    }
    return fc;
}

function buildStreetNetworkProposal(road, parentParcelIds, options = {}) {
    const definition = roadDefinitionFor(road.streets, road.geometry);
    const totalLen = Math.round(road.streets.reduce((sum, feature) => sum + Number(feature.properties?.length_m || 0), 0));
    const title = options.title || 'UPU Borovje – ulična mreža';
    return {
        proposalId: options.proposalId || 'upu-borovje-ulice',
        coordinatedPlanId: COORDINATED_PLAN_ID,
        city: CITY,
        goal: 'road-track',
        type: 'road',
        title,
        name: title,
        description: `Planirana ulična mreža (${totalLen} m osi). Osi su izvedene iz kartografskog`
            + ' prikaza 2a. Prometni i komunikacijski sustav, UPU Borovje – zona jug'
            + ' (prijedlog plana za javnu raspravu, 2026).',
        author: AUTHOR,
        lifecycleStatus: 'Active',
        parentParcelIds,
        acceptedParcelIds: [],
        roadProposal: {
            definition,
            parentParcelIds,
            childParcelIds: [],
            applied: false,
        },
        geometry: { roadPlan: definition, roadGeometry: null },
    };
}

function buildReparcellizationProposal(component, index, parentParcelIds) {
    // A road can split the UPU's non-road land into separate blocks. One readjustment is one
    // connected pool, so each component is published independently and persists its exact extent.
    const totalArea = component.plots.reduce((sum, plot) => sum + areaOf(plot.geometry), 0);
    const polygons = component.plots.map(plot => ({
        ownerKey: slugify(plot.properties.name),
        displayName: sliceDisplayName(plot.properties),
        color: SLICE_COLORS[plot.properties.kind] || '#999999',
        percent: Math.round((areaOf(plot.geometry) / totalArea) * 1000) / 10,
        area: Math.round(areaOf(plot.geometry) * 10) / 10,
        sourceKind: plot.properties.kind,
        sourceName: plot.properties.name,
        geometry: plot.geometry,
    }));
    const title = `UPU Borovje – nova parcelacija – blok ${index + 1}/3`;
    return {
        proposalId: PARCELATION_IDS[index],
        coordinatedPlanId: COORDINATED_PLAN_ID,
        city: CITY,
        goal: 'reparcellization',
        type: 'parcel',
        title,
        name: title,
        description: `Nova parcelacija povezanog bloka ${index + 1} od 3. Ulična mreža odvaja ga od ostalih dijelova obuhvata, zato su tri nepovezana područja objavljena kao tri zasebna prijedloga parcelacije.`,
        author: AUTHOR,
        lifecycleStatus: 'Active',
        parentParcelIds,
        acceptedParcelIds: [],
        reparcellization: {
            algorithm: 'upu-plan',
            parcelIds: parentParcelIds.slice(),
            parentParcelIds: parentParcelIds.slice(),
            poolGeometry: component.geometry,
            totalArea: Math.round(totalArea * 10) / 10,
            ownerShares: [],
            polygons,
            rebuiltBy: 'repair-upu-borovje/clean-connected-plan-v1',
            validated: true,
            applied: false,
        },
    };
}

async function postProposal(baseUrl, proposal, origin) {
    const response = await fetch(`${baseUrl}/proposals`, {
        method: 'POST',
        // the backend's write guard requires a recognised Origin (CSRF protection).
        // In production only the site origins are allowed, so uploads through an
        // SSH tunnel must state the site origin via --origin.
        headers: { 'Content-Type': 'application/json', Origin: origin || baseUrl },
        body: JSON.stringify(proposal),
    });
    const body = await response.text();
    if (!response.ok) {
        throw new Error(`POST ${proposal.proposalId} failed (${response.status}): ${body.slice(0, 300)}`);
    }
    return JSON.parse(body);
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const apply = args.includes('--apply');
    if (!dryRun && !apply) {
        console.log('Usage: node build-and-upload.mjs --dry-run | --apply [--base-url http://localhost:3000]');
        console.log('Builds UPU Borovje proposals from data/*.geojson and uploads them via POST /proposals.');
        process.exit(0);
    }
    const baseUrlIdx = args.indexOf('--base-url');
    const baseUrl = baseUrlIdx >= 0 ? args[baseUrlIdx + 1] : 'http://localhost:3000';
    const originIdx = args.indexOf('--origin');
    const origin = originIdx >= 0 ? args[originIdx + 1] : null;

    const [buildings, zones, streets, parcelation, parcels] = await Promise.all([
        loadGeojson('buildings.geojson'),
        loadGeojson('zones.geojson'),
        loadGeojson('streets.geojson'),
        loadGeojson('parcelation.geojson'),
        fetchAppParcels(baseUrl),
    ]);
    const intersecting = parcelIntersectors(parcels);
    const exactIntersecting = parcelIntersectors(parcels, { minAreaM2: 0.25, minShare: 0 });

    // The canonical plan extent, not every whole cadastral parcel touched by it, is authoritative.
    // The pure topology builder absorbs sub-parcel debris into the adjoining road and returns one
    // readjustment per connected non-road block.
    const topology = buildBorovjeTopology(parcelation, streets, turf);
    console.log(`plan mesh: ${topology.stats.poolM2.toFixed(1)} m²; ${topology.stats.readjustmentCount} connected readjustments; `
        + `${topology.stats.plotCount} plots; gap ${topology.stats.gapM2.toFixed(3)} m²; overlap ${topology.stats.overlapM2.toFixed(3)} m²`);
    const proposals = topology.readjustments.map((component, index) => {
        const parentParcelIds = exactIntersecting(component.geometry);
        if (!parentParcelIds.length) throw new Error(`readjustment block ${index + 1}: no cadastral anchors`);
        return buildReparcellizationProposal(component, index, parentParcelIds);
    });
    const roadOptions = [
        ['main', { proposalId: 'upu-borovje-ulice', title: 'UPU Borovje – ulična mreža' }],
        ['west', { proposalId: 'upu-borovje-ulice-split-1', title: 'UPU Borovje – ulična mreža (2)' }]
    ];
    roadOptions.forEach(([key, options]) => {
        const road = topology.roads[key];
        const parentParcelIds = exactIntersecting(road.geometry);
        if (!parentParcelIds.length) throw new Error(`${key} road: no cadastral anchors`);
        proposals.push(buildStreetNetworkProposal(road, parentParcelIds, options));
    });
    for (const f of buildings.features) {
        const p = buildBuildingProposal(f, intersecting);
        if (!p) continue;
        proposals.push(p);
    }
    for (const f of zones.features) {
        const p = buildParkProposal(f, intersecting);
        const sourceName = f.properties.kind === 'R2' ? 'R2-1' : f.properties.name;
        const plot = topology.plots.find(item => item.properties?.name === sourceName);
        if (!plot) throw new Error(`${p.proposalId}: no canonical plot ${sourceName}`);
        p.structureProposal.geometry = plot.geometry;
        p.parentParcelIds = exactIntersecting(plot.geometry);
        p.structureProposal.parentParcelIds = p.parentParcelIds.slice();
        proposals.push(p);
    }

    for (const p of proposals) {
        console.log(`${p.proposalId}  [${p.goal}]  parcels: ${p.parentParcelIds.length}  "${p.title}"`);
    }
    console.log(`\n${proposals.length} proposals built`
        + ` (${buildings.features.length - 1} buildings + ${zones.features.length} parks`
        + ` + 2 connected roads + 3 connected readjustments).`);

    if (dryRun) {
        console.log('Dry run - nothing uploaded.');
        return;
    }

    let ok = 0;
    for (const p of proposals) {
        try {
            const saved = await postProposal(baseUrl, p, origin);
            ok += 1;
            console.log(`uploaded ${p.proposalId} -> server id ${saved.proposalId ?? saved.id ?? '?'}`);
        } catch (error) {
            console.error(String(error));
        }
    }
    console.log(`${ok}/${proposals.length} uploaded to ${baseUrl}.`);
    if (ok < proposals.length) process.exitCode = 1;
}

await main();
