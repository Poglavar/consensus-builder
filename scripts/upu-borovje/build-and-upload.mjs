#!/usr/bin/env node

// Build consensus-builder proposals from the extracted UPU "Borovje - zona jug"
// geometry (see extract-plan.py) and upload them to the backend via POST /proposals.
// Buildings become single-building proposals (one per kazeta, heights from the
// plan's PP rules), green zones become park structure proposals, street corridors
// become first-class road proposals (polygon-driven carve), and the plan's new
// parcelation becomes ONE land-readjustment (reparcellization) proposal.
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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const require = createRequire(path.join(repoRoot, 'backend', 'package.json'));
const turf = require('@turf/turf');

const CITY = 'zagreb';
// The parcelation id deliberately starts with p- so its synthetic children get
// ids containing '#p-' (see _composeSyntheticParcelId / _buildSyntheticToken):
// the shared-plan queue classifies '#p-' parents as DERIVED and waits for the
// earlier apply in the link to mint them instead of fetching them from the server.
const PARCELATION_ID = 'p-upu-borovje-parcelacija';
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

function parcelIntersectors(parcels) {
    // Pre-wrap parcel features once; return a lookup of parcelIds whose overlap with
    // a polygon is substantive. Raster-traced outlines carry ~0.5 m jitter, so plain
    // booleanIntersects would report boundary-touching neighbours as parents; require
    // the overlap to exceed 10 m2 or 2% of the smaller of the two areas.
    const wrapped = parcels.features.map(f => ({
        id: f.properties.parcelId,
        feature: f,
        bbox: turf.bbox(f),
        area: turf.area(f),
    }));
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
                if (a > 10 || a > 0.02 * Math.min(p.area, targetArea)) ids.push(p.id);
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

const SLICE_COLORS = { M1: '#e8a24a', Z1: '#69b86b', R2: '#3aa88a', IS: '#9aa0a6' };

function sliceDisplayName(props) {
    if (props.kind === 'M1') return `Građevna čestica ${props.name}`;
    if (props.kind === 'R2') return `Rekreacija ${props.name}`;
    if (props.kind === 'Z1') return `Javni park ${props.name}`;
    return `Prometna površina ${props.name}`;
}

function corridorStripProfile(widthM) {
    // Cross-section from the measured corridor width. Narrow corridors are the
    // plan's pedestrian surfaces (IS-2) - one paved pedestrian strip; wider ones
    // (IS-1 shared streets, the collector) get two driving lanes + sidewalks.
    const w = Math.max(3, Math.round(widthM * 4) / 4);
    if (w < 12) {
        return { strips: [{ type: 'sidewalk', width: w }] };
    }
    const sidewalk = 2;
    const lane = Math.round(((w - 2 * sidewalk) / 2) * 4) / 4;
    return {
        strips: [
            { type: 'sidewalk', width: sidewalk },
            { type: 'driving', width: lane, direction: 'forward' },
            { type: 'driving', width: lane, direction: 'backward' },
            { type: 'sidewalk', width: sidewalk },
        ],
    };
}

function buildRoadProposal(corridorFeature, streetFeatures, intersecting, index, total) {
    const { area_m2 } = corridorFeature.properties;
    const parentParcelIds = intersecting(corridorFeature.geometry);
    if (!parentParcelIds.length) {
        throw new Error(`corridor ${index}: no intersecting parcels found`);
    }
    if (!streetFeatures.length) {
        throw new Error(`corridor ${index}: no centerline segments extracted`);
    }
    // centerline segments: [{lat,lng}, ...] per segment, endpoints shared at junctions
    const segments = streetFeatures.map(f =>
        f.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })));
    const segmentIds = streetFeatures.map((f, n) => `upu-u${index + 1}-s${n + 1}`);
    const segmentProfiles = {};
    streetFeatures.forEach((f, n) => {
        segmentProfiles[segmentIds[n]] = corridorStripProfile(f.properties.width_m);
    });
    const widths = streetFeatures.map(f => f.properties.width_m).sort((a, b) => a - b);
    const medianWidth = widths[Math.floor(widths.length / 2)];
    const isMain = index === 0;
    const title = isMain
        ? 'UPU Borovje – ulična mreža (prometne površine IS)'
        : `UPU Borovje – prometna površina ${index + 1}/${total}`;
    const definition = {
        kind: 'road',
        width: medianWidth,
        points: segments,
        segments,
        segmentIds,
        segmentProfiles,
        tunnels: [],
        demolishedBuildings: [],
        // the real street-land geometry from the plan; the apply path carves
        // parcels from this polygon rather than from buffered centerlines
        polygon: corridorFeature.geometry,
    };
    return {
        proposalId: `upu-borovje-ulice-${index + 1}`,
        city: CITY,
        goal: 'road-track',
        type: 'road',
        title,
        name: title,
        description: `Planirane prometne površine (${area_m2} m²): ${segments.length}`
            + ' međusobno povezanih uličnih segmenata (sabirna ulica, kolno-pješačke'
            + ' površine IS-1, pješačke površine IS-2) s profilima prema izmjerenim'
            + ' širinama koridora. Izvedeno iz kartografskog prikaza 1. Korištenje'
            + ' i namjena površina, UPU Borovje – zona jug (prijedlog plana, 2026).',
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
        geometry: { roadPlan: definition, roadGeometry: { polygon: corridorFeature.geometry } },
    };
}

function buildReparcellizationProposal(slices, intersecting) {
    const totalArea = slices.features.reduce((sum, f) => sum + f.properties.area_m2, 0);
    const parents = new Set();
    const polygons = slices.features.map(f => {
        for (const id of intersecting(f.geometry)) parents.add(id);
        return {
            ownerKey: slugify(f.properties.name),
            displayName: sliceDisplayName(f.properties),
            color: SLICE_COLORS[f.properties.kind] || '#999999',
            percent: Math.round((f.properties.area_m2 / totalArea) * 1000) / 10,
            geometry: f.geometry,
        };
    });
    const parentParcelIds = Array.from(parents).sort();
    const title = 'UPU Borovje – nova parcelacija (urbana komasacija)';
    return {
        proposalId: PARCELATION_ID,
        city: CITY,
        goal: 'reparcellization',
        type: 'parcel',
        title,
        name: title,
        description: `Nova parcelacija obuhvata: ${polygons.length} građevnih čestica`
            + ' (po jedna za svaku zgradu M1-1…M1-11, parkove Z1, rekreaciju R2 i prometne'
            + ' površine). Kazeta M1-12 zadržava postojeće čestice (PP-5).'
            + ' Izvedeno iz UPU Borovje – zona jug (prijedlog plana za javnu raspravu, 2026).',
        author: AUTHOR,
        lifecycleStatus: 'Active',
        parentParcelIds,
        acceptedParcelIds: [],
        reparcellization: {
            algorithm: 'upu-plan',
            generatedAt: new Date().toISOString(),
            parcelIds: parentParcelIds,
            totalArea: Math.round(totalArea),
            ownerShares: [],
            polygons,
            applied: false,
        },
    };
}

async function postProposal(baseUrl, proposal) {
    const response = await fetch(`${baseUrl}/proposals`, {
        method: 'POST',
        // the backend's write guard requires a recognised Origin (CSRF protection)
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
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

    const [buildings, zones, corridors, streets, parcelation, parcels] = await Promise.all([
        loadGeojson('buildings.geojson'),
        loadGeojson('zones.geojson'),
        loadGeojson('corridors.geojson'),
        loadGeojson('streets.geojson'),
        loadGeojson('parcelation.geojson'),
        loadGeojson('parcels.geojson'),
    ]);
    const intersecting = parcelIntersectors(parcels);

    // The plan is a SEQUENCED package: the land readjustment goes first and mints
    // one gradevna cestica per building/zone/street; everything else anchors to
    // those NEW parcels (matching the real plan, and avoiding parcel-occupancy
    // conflicts between kazete that share one big source parcel today).
    const repar = buildReparcellizationProposal(parcelation, intersecting);
    const primaryParent = repar.parentParcelIds[0];
    const sliceChildId = (sliceIndex) => `${primaryParent}#${PARCELATION_ID}-${sliceIndex + 1}`;
    const sliceForPoint = (geometry) => {
        const pt = turf.pointOnFeature({ type: 'Feature', properties: {}, geometry });
        const idx = parcelation.features.findIndex(f => {
            try { return turf.booleanPointInPolygon(pt, f); } catch (_) { return false; }
        });
        return idx >= 0 ? { index: idx, feature: parcelation.features[idx] } : null;
    };
    const anchorToSlice = (proposal, geometry, label) => {
        const slice = sliceForPoint(geometry);
        if (!slice) {
            console.warn(`${label}: no parcelation slice found - keeping original parcels`);
            return;
        }
        const childId = sliceChildId(slice.index);
        proposal.parentParcelIds = [childId];
        proposal.description += ` Gradi se na građevnoj čestici ${slice.feature.properties.name}`
            + ' nastaloj parcelacijom plana.';
        if (proposal.buildingProposal) {
            proposal.buildingProposal.parentParcelIds = [childId];
            proposal.buildingProposal.ancestorKey = childId;
        }
        if (proposal.structureProposal) proposal.structureProposal.parentParcelIds = [childId];
        if (proposal.roadProposal) proposal.roadProposal.parentParcelIds = [childId];
    };

    const proposals = [repar];
    for (const f of buildings.features) {
        const p = buildBuildingProposal(f, intersecting);
        if (!p) continue;
        anchorToSlice(p, f.geometry, p.proposalId);
        proposals.push(p);
    }
    for (const f of zones.features) {
        const p = buildParkProposal(f, intersecting);
        anchorToSlice(p, f.geometry, p.proposalId);
        proposals.push(p);
    }
    corridors.features.forEach((f, i) => {
        const segs = streets.features.filter(sf => sf.properties.corridor === i);
        const p = buildRoadProposal(f, segs, intersecting, i, corridors.features.length);
        anchorToSlice(p, f.geometry, p.proposalId);
        proposals.push(p);
    });

    for (const p of proposals) {
        console.log(`${p.proposalId}  [${p.goal}]  parcels: ${p.parentParcelIds.length}  "${p.title}"`);
    }
    console.log(`\n${proposals.length} proposals built`
        + ` (${buildings.features.length - 1} buildings + ${zones.features.length} parks`
        + ` + ${corridors.features.length} roads + 1 reparcellization).`);

    if (dryRun) {
        console.log('Dry run - nothing uploaded.');
        return;
    }

    let ok = 0;
    for (const p of proposals) {
        try {
            const saved = await postProposal(baseUrl, p);
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
