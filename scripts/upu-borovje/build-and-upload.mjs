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

const SLICE_COLORS = { M1: '#e8a24a', Z1: '#69b86b', R2: '#3aa88a', IS: '#9aa0a6', OST: '#b9b3a8' };

function sliceDisplayName(props) {
    if (props.kind === 'M1') return `Građevna čestica ${props.name}`;
    if (props.kind === 'R2') return `Rekreacija ${props.name}`;
    if (props.kind === 'Z1') return `Javni park ${props.name}`;
    if (props.kind === 'OST') return `Preostala čestica ${props.name}`;
    return `Prometna površina ${props.name}`;
}

const areaOf = (geometry) => turf.area({ type: 'Feature', properties: {}, geometry });

// The parcelation must be clipped against the CADASTRE THE APP ACTUALLY SERVES
// (its parcel table), not the UPU FeatureServer snapshot: the snapshot carries a
// different parcel generation in places (e.g. its 1791/69 overlaps land the live
// cadastre assigns to 1791/7), so remainders computed from it would double-claim
// land. Fetching from the target backend keeps this correct for local AND prod.
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

function unionAll(features) {
    let u = null;
    for (const f of features) {
        if (!f) continue;
        try { u = u ? turf.union(u, f) : f; }
        catch (error) { console.warn(`union failed on a piece: ${error.message}`); }
    }
    return u;
}

function explodeToPolygons(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return [geometry];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(c => ({ type: 'Polygon', coordinates: c }));
    if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap(g => explodeToPolygons(g));
    return [];
}

// Turn the raster-extracted parcelation into an EXACT planar partition of its
// parent parcels. The extractor's slices deliberately overshoot the drawn plan
// boundary by ~3.6 m so no boundary-line sliver stays unclaimed; here that
// overshoot is trimmed to the vector union of the parent parcels, and every
// piece of parent land NOT covered by a slice becomes an explicit remainder
// parcel. The app replaces a reparcellization's parents wholesale and takes the
// slice geometry as-is, so this step is what guarantees the Zagreb principle:
// all land stays under a parcel, and under at most one (no gaps, no double claims).
function clipParcelationToParents(parcelation, parcels) {
    // Parents = parcels genuinely under the DRAWN plan area. Erode each slice by
    // the overshoot margin first, so a ~3.6 m spill over the plan edge cannot
    // drag a neighbouring parcel into the readjustment.
    const parentIds = new Set();
    for (const f of parcelation.features) {
        let core = f;
        try {
            const eroded = turf.buffer(f, -4, { units: 'meters' });
            if (eroded && turf.area(eroded) > 1) core = eroded;
        } catch (_) { /* thin slice - keep unbuffered */ }
        const cb = turf.bbox(core);
        for (const p of parcels.features) {
            if (parentIds.has(p.properties.parcelId)) continue;
            const pb = turf.bbox(p);
            if (pb[0] > cb[2] || pb[2] < cb[0] || pb[1] > cb[3] || pb[3] < cb[1]) continue;
            try {
                const overlap = turf.intersect(core, p);
                if (overlap && turf.area(overlap) > 10) parentIds.add(p.properties.parcelId);
            } catch (_) { /* degenerate ring - skip */ }
        }
    }
    const parentFeatures = parcels.features.filter(f => parentIds.has(f.properties.parcelId));
    const parentUnion = unionAll(parentFeatures);

    // Clip every slice to the parent union. A clip can split a slice; the largest
    // part keeps the slice identity (building/park/street anchors reference the
    // slice by INDEX, so slices stay index-aligned with parcelation.features),
    // extra parts are appended as their own entries so no land is dropped.
    const slices = [];
    const extras = [];
    for (const f of parcelation.features) {
        let clipped = null;
        try { clipped = turf.intersect(f, parentUnion); } catch (error) {
            console.warn(`${f.properties.name}: clip failed (${error.message}) - keeping raster outline`);
        }
        const parts = (clipped ? explodeToPolygons(clipped.geometry) : [f.geometry])
            .map(g => ({ g, a: areaOf(g) }))
            .sort((x, y) => y.a - x.a);
        const [main, ...rest] = parts;
        slices.push({ kind: f.properties.kind, name: f.properties.name, area_m2: Math.round(main.a), geometry: main.g });
        rest.filter(x => x.a > 0.5).forEach((x, n) => extras.push({
            kind: f.properties.kind,
            name: `${f.properties.name} (dio ${n + 2})`,
            area_m2: Math.round(x.a),
            geometry: x.g,
        }));
    }

    // Remainders: per parent, whatever the slices do not cover stays a parcel of
    // its own. Road/canal parents run far beyond the plan - without this, their
    // land outside the plan would silently vanish from the map on apply.
    const sliceUnion = unionAll([...slices, ...extras].map(e => ({ type: 'Feature', properties: {}, geometry: e.geometry })));
    const remainders = [];
    for (const p of parentFeatures) {
        let rem = null;
        try { rem = turf.difference(p, sliceUnion); } catch (error) {
            console.warn(`${p.properties.parcelId}: remainder failed (${error.message})`);
        }
        if (!rem) continue;
        const broj = p.properties.BROJ_CESTICE || p.properties.KATASTARSKA_CESTICA || p.properties.parcelId.split('-').pop();
        const kept = explodeToPolygons(rem.geometry)
            .map(g => ({ g, a: areaOf(g) }))
            .filter(x => x.a > 0.5)
            .sort((x, y) => y.a - x.a);
        kept.forEach((x, n) => remainders.push({
            kind: 'OST',
            name: kept.length > 1 ? `k.č. ${broj} – ostatak ${n + 1}` : `k.č. ${broj} – ostatak`,
            area_m2: Math.round(x.a),
            geometry: x.g,
        }));
    }

    // Coverage report: the children must tile the parents exactly (± numeric dust).
    const all = [...slices, ...extras, ...remainders];
    const totalChildren = all.reduce((s, e) => s + areaOf(e.geometry), 0);
    const totalParents = parentUnion ? turf.area(parentUnion) : 0;
    let maxOverlap = 0; let overlapPair = null;
    for (let i = 0; i < all.length; i++) {
        const bi = turf.bbox({ type: 'Feature', properties: {}, geometry: all[i].geometry });
        for (let j = i + 1; j < all.length; j++) {
            const bj = turf.bbox({ type: 'Feature', properties: {}, geometry: all[j].geometry });
            if (bj[0] > bi[2] || bj[2] < bi[0] || bj[1] > bi[3] || bj[3] < bi[1]) continue;
            try {
                const ov = turf.intersect(
                    { type: 'Feature', properties: {}, geometry: all[i].geometry },
                    { type: 'Feature', properties: {}, geometry: all[j].geometry });
                const a = ov ? turf.area(ov) : 0;
                if (a > maxOverlap) { maxOverlap = a; overlapPair = `${all[i].name} × ${all[j].name}`; }
            } catch (_) { /* degenerate - skip */ }
        }
    }
    console.log(`parcelation: ${slices.length} slices + ${extras.length} split parts + ${remainders.length} remainders`
        + ` over ${parentIds.size} parents`);
    console.log(`  coverage: parents ${Math.round(totalParents)} m² vs children ${Math.round(totalChildren)} m²`
        + ` (diff ${(totalParents - totalChildren).toFixed(1)} m²)`);
    console.log(`  max pairwise overlap: ${maxOverlap.toFixed(2)} m²${overlapPair ? ` (${overlapPair})` : ''}`);
    if (Math.abs(totalParents - totalChildren) > 50 || maxOverlap > 5) {
        throw new Error('parcelation coverage check failed - children do not tile the parents');
    }

    return { slices, extras, remainders, parentParcelIds: Array.from(parentIds).sort() };
}

const ROAD_PROFILES = {
    // sabirna ulica: 19 m corridor per the plan text - carriageway + cycleway
    // (sheet 2a draws it along the collector) + sidewalks + verges
    'SP': { strips: [
        { type: 'verge', width: 2.75 },
        { type: 'sidewalk', width: 2 },
        { type: 'driving', width: 3.5, direction: 'forward' },
        { type: 'driving', width: 3.5, direction: 'backward' },
        { type: 'cycleway', width: 2.5 },
        { type: 'sidewalk', width: 2 },
        { type: 'verge', width: 2.75 },
    ] },
    // kolno-pjesacka povrsina (IS-1): 18 m shared-surface calmed street
    'IS-1': { strips: [
        { type: 'sidewalk', width: 5 },
        { type: 'driving', width: 4, direction: 'forward' },
        { type: 'driving', width: 4, direction: 'backward' },
        { type: 'sidewalk', width: 5 },
    ] },
    // pjesacka povrsina (IS-2): pedestrian surface
    'IS-2': { strips: [{ type: 'sidewalk', width: 9 }] },
};

function buildStreetNetworkProposal(streets, parentParcelIds) {
    const segments = streets.features.map(f =>
        f.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })));
    const segmentIds = streets.features.map(f => `upu-${f.properties.name}`);
    const segmentProfiles = {};
    streets.features.forEach((f, n) => {
        segmentProfiles[segmentIds[n]] = ROAD_PROFILES[f.properties.kind];
    });
    const totalLen = Math.round(streets.features.reduce((s2, f) => s2 + f.properties.length_m, 0));
    const definition = {
        kind: 'road',
        width: 19,
        points: segments,
        segments,
        segmentIds,
        segmentProfiles,
        tunnels: [],
        demolishedBuildings: [],
    };
    const title = 'UPU Borovje – ulična mreža';
    return {
        proposalId: 'upu-borovje-ulice',
        city: CITY,
        goal: 'road-track',
        type: 'road',
        title,
        name: title,
        description: `Planirana ulična mreža (${totalLen} m osi): sabirna ulica (19 m koridor,`
            + ' kolnik + biciklistička staza + nogostupi) po južnom i istočnom rubu, dvije'
            + ' kolno-pješačke površine IS-1 (18 m), pješačke površine IS-2 (9 m) te spoj na'
            + ' sjeveroistoku - međusobno povezane u čvorovima. Osi izvedene iz kartografskog'
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

function buildReparcellizationProposal(clip) {
    // Slices FIRST and in extractor order - building/park/street anchors compose
    // child ids from the slice's index in this array. Extras + remainders append.
    const all = [...clip.slices, ...clip.extras, ...clip.remainders];
    const totalArea = all.reduce((sum, e) => sum + e.area_m2, 0);
    const polygons = all.map(e => ({
        ownerKey: slugify(e.name),
        displayName: sliceDisplayName(e),
        color: SLICE_COLORS[e.kind] || '#999999',
        percent: Math.round((e.area_m2 / totalArea) * 1000) / 10,
        geometry: e.geometry,
    }));
    const parentParcelIds = clip.parentParcelIds;
    const title = 'UPU Borovje – nova parcelacija (urbana komasacija)';
    return {
        proposalId: PARCELATION_ID,
        city: CITY,
        goal: 'reparcellization',
        type: 'parcel',
        title,
        name: title,
        description: `Nova parcelacija obuhvata: ${clip.slices.length + clip.extras.length} građevnih čestica`
            + ' (po jedna za svaku zgradu M1-1…M1-11, parkove Z1, rekreaciju R2 i prometne'
            + ` površine) te ${clip.remainders.length} preostalih čestica za dijelove ulaznih`
            + ' parcela izvan zahvata plana. Kazeta M1-12 zadržava postojeće čestice (PP-5).'
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

    // The plan is a SEQUENCED package: the land readjustment goes first and mints
    // one gradevna cestica per building/zone/street; everything else anchors to
    // those NEW parcels (matching the real plan, and avoiding parcel-occupancy
    // conflicts between kazete that share one big source parcel today).
    const clip = clipParcelationToParents(parcelation, parcels);
    const repar = buildReparcellizationProposal(clip);
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
        if (proposal.structureProposal) {
            proposal.structureProposal.parentParcelIds = [childId];
            // park/recreation surfaces adopt the exact građevna-čestica geometry so
            // the structure fills its parcel edge-to-edge (the zones.geojson trace
            // has raster jitter and would leave slivers against the parcel border)
            const clippedGeom = clip.slices[slice.index]?.geometry;
            if (clippedGeom && ['Z1', 'R2'].includes(slice.feature.properties.kind)) {
                proposal.structureProposal.geometry = clippedGeom;
            }
        }
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
    const streetParcelIds = parcelation.features
        .map((f, i) => ({ f, i }))
        .filter(x => x.f.properties.kind === 'IS')
        .map(x => sliceChildId(x.i));
    proposals.push(buildStreetNetworkProposal(streets, streetParcelIds));

    for (const p of proposals) {
        console.log(`${p.proposalId}  [${p.goal}]  parcels: ${p.parentParcelIds.length}  "${p.title}"`);
    }
    console.log(`\n${proposals.length} proposals built`
        + ` (${buildings.features.length - 1} buildings + ${zones.features.length} parks`
        + ` + 1 street network + 1 reparcellization).`);

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
