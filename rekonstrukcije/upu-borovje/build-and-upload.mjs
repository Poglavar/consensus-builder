#!/usr/bin/env node

// Build consensus-builder proposals from the extracted UPU "Borovje - zona jug"
// geometry (see extract-plan.py) and upload them to the backend via POST /proposals.
// Buildings become single-building proposals (one per kazeta, heights from the
// plan's PP rules), green zones become park structure proposals, and street corridors become
// first-class road proposals whose official IS polygons are their parcel footprint. The remaining
// non-road parcelation becomes one land-readjustment proposal, so the two proposal types form a
// conserved tessellation instead of claiming the street twice.
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
const COORDINATED_PLAN_ID = 'upu-borovje';
// Kept stable because the historical import and shared links already use it. Consumers anchor to
// cadastral ground and resolve live derived parcels geometrically; this id is never an input parent.
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

function buildStreetNetworkProposal(streets, parentParcelIds, roadPolygon) {
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
        polygon: roadPolygon,
        tunnels: [],
        demolishedBuildings: [],
    };
    const title = 'UPU Borovje – ulična mreža';
    return {
        proposalId: 'upu-borovje-ulice',
        coordinatedPlanId: COORDINATED_PLAN_ID,
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
    // Road proposals own every IS polygon. The readjustment claims only the complementary plots;
    // their union plus the road union is the exact full partition validated above.
    const all = [...clip.slices, ...clip.extras, ...clip.remainders]
        .filter(entry => entry.kind !== 'IS');
    const totalArea = all.reduce((sum, e) => sum + e.area_m2, 0);
    const polygons = all.map(e => ({
        ownerKey: slugify(e.name),
        displayName: sliceDisplayName(e),
        color: SLICE_COLORS[e.kind] || '#999999',
        percent: Math.round((e.area_m2 / totalArea) * 1000) / 10,
        geometry: e.geometry,
    }));
    const parentParcelIds = clip.parentParcelIds;
    const title = 'UPU Borovje – nova parcelacija';
    return {
        proposalId: PARCELATION_ID,
        coordinatedPlanId: COORDINATED_PLAN_ID,
        city: CITY,
        goal: 'reparcellization',
        type: 'parcel',
        title,
        name: title,
        description: `Nova parcelacija obuhvata: ${all.length - clip.remainders.length} građevnih čestica`
            + ' (po jedna za svaku zgradu M1-1…M1-11, parkove Z1 i rekreaciju R2) te'
            + ` ${clip.remainders.length} preostalih čestica za dijelove ulaznih`
            + ' parcela izvan zahvata plana. Kazeta M1-12 zadržava postojeće čestice (PP-5).'
            + ' Prometne površine tvore zasebni cestovni prijedlozi i nisu ponovno uključene u parcelaciju.'
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
    const exactIntersecting = parcelIntersectors(parcels, { minAreaM2: 0.25, minShare: 0 });

    // The plan is a coordinated package: the readjustment publishes the complementary non-road
    // plots first, official IS surfaces fill its reserved street bands, then buildings and parks
    // resolve the finished live parcels beneath them. Every stored parent remains a base cadastral
    // id; coordinatedPlanId carries only the package/materialisation relationship.
    const clip = clipParcelationToParents(parcelation, parcels);
    const streetEntries = [...clip.slices, ...clip.extras].filter(entry => entry.kind === 'IS');
    const roadFootprint = unionAll(streetEntries.map(entry => ({
        type: 'Feature',
        properties: {},
        geometry: entry.geometry
    })));
    if (!roadFootprint || !roadFootprint.geometry) {
        throw new Error('official IS slices did not produce a road footprint');
    }
    const nonRoadEntries = [...clip.slices, ...clip.extras, ...clip.remainders]
        .filter(entry => entry.kind !== 'IS');
    const nonRoadFootprint = unionAll(nonRoadEntries.map(entry => ({
        type: 'Feature',
        properties: {},
        geometry: entry.geometry
    })));
    if (!nonRoadFootprint || !nonRoadFootprint.geometry) {
        throw new Error('non-road slices did not produce a readjustment footprint');
    }
    const roadPlotOverlap = (() => {
        try {
            const hit = turf.intersect(roadFootprint, nonRoadFootprint);
            return hit ? turf.area(hit) : 0;
        } catch (_) { return Infinity; }
    })();
    const completePartition = unionAll([...clip.slices, ...clip.extras, ...clip.remainders].map(entry => ({
        type: 'Feature', properties: {}, geometry: entry.geometry
    })));
    const tessellation = unionAll([roadFootprint, nonRoadFootprint]);
    const coverageErrorM2 = Math.abs(turf.area(completePartition) - turf.area(tessellation));
    console.log(`road/readjustment tessellation: overlap ${roadPlotOverlap.toFixed(2)} m², coverage error ${coverageErrorM2.toFixed(2)} m²`);
    if (roadPlotOverlap > 0.25 || coverageErrorM2 > 1) {
        throw new Error('roads and readjustment do not form one conserved tessellation');
    }
    const repar = buildReparcellizationProposal(clip);
    const reparParents = exactIntersecting(nonRoadFootprint.geometry);
    repar.parentParcelIds = reparParents;
    repar.reparcellization.parcelIds = reparParents.slice();
    const sliceForPoint = (geometry) => {
        const pt = turf.pointOnFeature({ type: 'Feature', properties: {}, geometry });
        const idx = parcelation.features.findIndex(f => {
            try { return turf.booleanPointInPolygon(pt, f); } catch (_) { return false; }
        });
        return idx >= 0 ? { index: idx, feature: parcelation.features[idx] } : null;
    };
    const seatStructureOnSlice = (proposal, geometry, label) => {
        const slice = sliceForPoint(geometry);
        if (!slice) {
            console.warn(`${label}: no parcelation slice found - keeping the traced structure geometry`);
            return;
        }
        if (proposal.structureProposal) {
            // park/recreation surfaces adopt the exact građevna-čestica geometry so
            // the structure fills its parcel edge-to-edge (the zones.geojson trace
            // has raster jitter and would leave slivers against the parcel border)
            const clippedGeom = clip.slices[slice.index]?.geometry;
            if (clippedGeom && ['Z1', 'R2'].includes(slice.feature.properties.kind)) {
                proposal.structureProposal.geometry = clippedGeom;
                const baseParents = exactIntersecting(clippedGeom);
                proposal.parentParcelIds = baseParents;
                proposal.structureProposal.parentParcelIds = baseParents.slice();
            }
        }
    };

    const roadParents = exactIntersecting(roadFootprint.geometry);
    const proposals = [
        repar,
        buildStreetNetworkProposal(
            streets,
            roadParents.length ? roadParents : clip.parentParcelIds,
            roadFootprint.geometry)
    ];
    for (const f of buildings.features) {
        const p = buildBuildingProposal(f, intersecting);
        if (!p) continue;
        proposals.push(p);
    }
    for (const f of zones.features) {
        const p = buildParkProposal(f, intersecting);
        seatStructureOnSlice(p, f.geometry, p.proposalId);
        proposals.push(p);
    }

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
