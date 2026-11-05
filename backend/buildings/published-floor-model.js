// Converts the floor plans one building has in the shared floor-plan publication (GET /api/floor-plans,
// one plan per unit or whole floor, each registered on the map on its own) into the single
// building-floor-plans.v3 model the X-ray renders. Pure: plans in, model out, no I/O.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SCHEMA, validateArchitecture, validateFloorPlans } = require('../../frontend/js/building-floor-plans.js');

const finite = value => typeof value === 'number' && Number.isFinite(value);
const METRES_PER_DEGREE = 111320;
// A plan whose corners stray this far outside the reference plan's quad gets a common bounding frame.
const FRAME_TOLERANCE_M = 0.5;
const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scale = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const norm = a => Math.hypot(a[0], a[1]);
const clamp01 = value => Math.min(1, Math.max(0, value));

function validCorners(registration) {
    const corners = registration?.corners;
    return Array.isArray(corners) && corners.length === 4
        && corners.every(c => Array.isArray(c) && c.length === 2 && c.every(finite) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90);
}
const sameCorners = (a, b) => a.every((corner, i) => Math.abs(corner[0] - b[i][0]) < 1e-9 && Math.abs(corner[1] - b[i][1]) < 1e-9);

// The renderer's bilinear map from a plan's unit square to WGS84 (building-floor-plans.js).
const bilinear = (c, u, v) => [
    (1 - u) * (1 - v) * c[0][0] + u * (1 - v) * c[1][0] + u * v * c[2][0] + (1 - u) * v * c[3][0],
    (1 - u) * (1 - v) * c[0][1] + u * (1 - v) * c[1][1] + u * v * c[2][1] + (1 - u) * v * c[3][1]
];

// Plans of one building span tens of metres: a local equirectangular plane is exact enough.
function localPlane([lng0, lat0]) {
    const kx = Math.cos(lat0 * Math.PI / 180) * METRES_PER_DEGREE;
    return { toM: ([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * METRES_PER_DEGREE],
        toLngLat: ([x, y]) => [lng0 + x / kx, lat0 + y / METRES_PER_DEGREE] };
}

// The common frame every chosen plan is expressed in: the reference plan's own quad when every plan
// lies inside it (the usual case: whole floors drawn in one footprint rectangle, flats inside them),
// otherwise the rectangle along the reference's u axis that bounds them all.
function buildFrame(reference, registrations) {
    const plane = localPlane(reference[0]);
    const [o, p1, , p3] = reference.map(plane.toM);
    const U = sub(p1, o), V = sub(p3, o);
    const affine = (origin, u, v) => {
        const det = cross(u, v);
        return point => { const d = sub(point, origin); return [cross(d, v) / det, cross(u, d) / det]; };
    };
    const inReference = affine(o, U, V);
    const tolU = FRAME_TOLERANCE_M / norm(U), tolV = FRAME_TOLERANCE_M / norm(V);
    const points = registrations.flatMap(corners => corners.map(plane.toM));
    if (points.every(point => { const [u, v] = inReference(point); return u >= -tolU && u <= 1 + tolU && v >= -tolV && v <= 1 + tolV; })) {
        return { corners: reference, plane, toUv: inReference, dimensionsM: [norm(U), norm(V)], composed: false };
    }
    const uHat = scale(U, 1 / norm(U));
    const vHat = scale([-uHat[1], uHat[0]], Math.sign(cross(U, V)) || 1);
    const us = points.map(point => dot(point, uHat)), vs = points.map(point => dot(point, vHat));
    const origin = add(scale(uHat, Math.min(...us)), scale(vHat, Math.min(...vs)));
    const frameU = scale(uHat, Math.max(...us) - Math.min(...us)), frameV = scale(vHat, Math.max(...vs) - Math.min(...vs));
    const corners = [origin, add(origin, frameU), add(add(origin, frameU), frameV), add(origin, frameV)]
        .map(point => plane.toLngLat(point).map(value => round(value, 9)));
    return { corners, plane, toUv: affine(origin, frameU, frameV), dimensionsM: [norm(frameU), norm(frameV)], composed: true };
}

// One plan's architecture with its u/v points moved from its own registration into the frame.
// Metric fields (depths, widths, heights) are unchanged because the frame is metric too.
function intoFrame(architecture, corners, frame) {
    if (sameCorners(corners, frame.corners)) return architecture;
    const point = p => frame.toUv(frame.plane.toM(bilinear(corners, p[0], p[1]))).map(value => round(clamp01(value), 9));
    const polygons = list => (list || []).map(rings => rings.map(ring => ring.map(point)));
    const segment = item => ({ ...item, a: point(item.a), b: point(item.b),
        ...(item.hinge ? { hinge: point(item.hinge) } : {}), ...(item.openTip ? { openTip: point(item.openTip) } : {}) });
    return { ...architecture, dimensionsM: frame.dimensionsM,
        walls: polygons(architecture.walls), slabs: polygons(architecture.slabs), landings: polygons(architecture.landings),
        platforms: (architecture.platforms || []).map(platform => ({ ...platform, rings: platform.rings.map(ring => ring.map(point)) })),
        openings: (architecture.openings || []).map(segment), stairs: (architecture.stairs || []).map(segment),
        railings: (architecture.railings || []).map(segment) };
}

// Several plans of one storey (flats, or the parts of a survey block) as one layout.
function mergeArchitectures(parts, frame) {
    if (parts.length === 1) return parts[0];
    const all = kind => parts.flatMap(part => part[kind] || []);
    return { schema: parts[0].schema, dimensionsM: frame.dimensionsM,
        wallHeightM: Math.max(...parts.map(part => part.wallHeightM)), slabThicknessM: Math.max(...parts.map(part => part.slabThicknessM)),
        walls: all('walls'), slabs: all('slabs'), landings: all('landings'), platforms: all('platforms'),
        openings: all('openings'), stairs: all('stairs'), railings: all('railings') };
}

// Walls fill the storey the envelope estimates, so consecutive storeys meet without solid proxy
// slivers between them; never below the tallest opening.
function fitStoreyHeight(architecture, storeyHeightM) {
    const target = finite(storeyHeightM) ? round(storeyHeightM - architecture.slabThicknessM, 3) : NaN;
    const tallestOpening = Math.max(0, ...(architecture.openings || []).map(item => item.sillM + item.heightM));
    if (!(target >= Math.max(1, tallestOpening) && target <= 12) || target === architecture.wallHeightM) return architecture;
    return { ...architecture, wallHeightM: target };
}

function planLevels(plan) {
    const levels = plan.scope === 'floor' && Array.isArray(plan.levels) && plan.levels.length ? plan.levels : [plan.floor];
    return [...new Set(levels.filter(level => Number.isInteger(level)))];
}
const originalUrl = plan => [plan.source?.url, ...(plan.source?.urls || [])].find(url => typeof url === 'string' && /^https?:\/\//.test(url)) || null;
const httpUrl = value => typeof value === 'string' && /^https?:\/\//.test(value) ? value : null;

/**
 * @param plans published plans (GET /api/floor-plans `plans[]`) that belong to one building
 * @param publicationUrl planId → http(s) URL of that plan in the publication API
 * @returns {{ floorPlans, footprint, updatedAt, planIds, skipped }} or null when no plan can be placed
 */
export function publishedPlansToFloorModel(plans, { publicationUrl = () => null } = {}) {
    const skipped = { unregistered: 0, invalidArchitecture: 0, noLevel: 0, noStorey: 0 };
    const byLevel = new Map();
    const unique = [...new Map((plans || []).filter(plan => typeof plan?.id === 'string').map(plan => [plan.id, plan])).values()]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const plan of unique) {
        if (!validCorners(plan.registration)) { skipped.unregistered++; continue; }
        if (validateArchitecture(plan.architecture).length) { skipped.invalidArchitecture++; continue; }
        const levels = planLevels(plan);
        if (!levels.length) { skipped.noLevel++; continue; }
        for (const level of levels) {
            const storey = (plan.building?.envelope?.storeys || []).find(entry => entry?.level === level && finite(entry.elevationM));
            if (!storey) { skipped.noStorey++; continue; }
            if (!byLevel.has(level)) byLevel.set(level, { floors: [], units: [] });
            byLevel.get(level)[plan.scope === 'floor' ? 'floors' : 'units'].push({ plan, storey });
        }
    }
    if (!byLevel.size) return null;

    // A whole-floor plan already composes its flats (and the corridor between them): it owns its
    // storey. Unit plans draw a storey only where no whole-floor plan exists; they still list the
    // storey's apartments either way.
    const levels = [...byLevel.keys()].sort((a, b) => a - b);
    const chosen = new Map(levels.map(level => { const entry = byLevel.get(level); return [level, entry.floors.length ? entry.floors : entry.units]; }));
    const chosenPlans = [...new Map([...chosen.values()].flat().map(({ plan }) => [plan.id, plan])).values()];
    const reference = chosenPlans.find(plan => plan.scope === 'floor') || chosenPlans[0];
    const frame = buildFrame(reference.registration.corners, chosenPlans.map(plan => plan.registration.corners));

    const layouts = [], layoutIds = new Map(), storeys = [];
    for (const level of levels) {
        const entries = chosen.get(level);
        const architecture = fitStoreyHeight(mergeArchitectures(entries.map(({ plan }) =>
            intoFrame(plan.architecture, plan.registration.corners, frame)), frame), entries[0].storey.heightM);
        const key = JSON.stringify([entries.map(({ plan }) => plan.id), architecture.wallHeightM]);
        if (!layoutIds.has(key)) {
            const first = entries[0].plan;
            layoutIds.set(key, `layout-${layouts.length + 1}`);
            layouts.push({ id: layoutIds.get(key), architecture, source: {
                // A merged layout names its first plan's document and lists every component plan.
                url: originalUrl(first) || publicationUrl(first.id), sha256: first.source?.sha256,
                ...(Number.isInteger(first.source?.page) && first.source.page > 0 ? { page: first.source.page } : {}),
                ...(Array.isArray(first.source?.crop) && first.source.crop.length === 4 && first.source.crop.every(finite) ? { crop: first.source.crop } : {}),
                ...(first.source?.attribution ? { attribution: first.source.attribution } : {}),
                publication: entries.map(({ plan }) => ({ planId: plan.id, url: publicationUrl(plan.id), label: plan.label ?? null,
                    quality: plan.quality?.status ?? null })) } });
        }
        const basis = String(entries[0].storey.heightBasis ?? entries[0].plan.building?.envelope?.heightBasis ?? '');
        const units = byLevel.get(level).units.map(({ plan }) => ({ id: plan.unitId || plan.id, kind: 'apartment',
            ...(finite(plan.areaM2) && plan.areaM2 > 0 ? { areaM2: plan.areaM2 } : {}),
            ...(httpUrl(plan.source?.listingUrl) || originalUrl(plan) || publicationUrl(plan.id)
                ? { url: httpUrl(plan.source?.listingUrl) || originalUrl(plan) || publicationUrl(plan.id) } : {}) }));
        storeys.push({ id: `level-${level}`, level, elevationM: entries[0].storey.elevationM,
            // Only an envelope that says its heights are documented is presented as documented.
            elevationBasis: /^documented/i.test(basis) ? 'documented' : 'estimated',
            layoutId: layoutIds.get(key), units,
            source: { url: originalUrl(entries[0].plan) || publicationUrl(entries[0].plan.id), planIds: entries.map(({ plan }) => plan.id) } });
    }
    const accuracyM = Math.max(...chosenPlans.map(plan => finite(plan.registration.accuracyM) ? plan.registration.accuracyM : Infinity));
    const approximate = !(accuracyM <= FRAME_TOLERANCE_M) || chosenPlans.some(plan => /approx/i.test(plan.registration.basis || ''));
    const floorPlans = {
        schema: SCHEMA,
        registration: { corners: frame.corners, accuracy: approximate ? 'approximate' : 'stated',
            basis: frame.composed ? `Bounding frame of ${chosenPlans.length} published plan registrations` : String(reference.registration.basis || 'Published plan registration'),
            ...(Number.isFinite(accuracyM) ? { accuracyM } : {}) },
        layouts, storeys,
        notes: [
            'Read from the shared floor-plan publication; plans are reconstructions and may await review.',
            'Storey elevations come from the publication\'s building envelope; walls are fitted to its storey heights.',
            ...(levels.some(level => byLevel.get(level).floors.length && byLevel.get(level).units.length)
                ? ['Storeys with a whole-floor plan show it; unit plans draw only storeys without one.'] : [])
        ],
        publication: { planIds: chosenPlans.map(plan => plan.id), quality: [...new Set(chosenPlans.map(plan => plan.quality?.status).filter(Boolean))], skipped }
    };
    const errors = validateFloorPlans(floorPlans);
    if (errors.length) throw new Error(`Published plans do not form a valid floor model: ${errors.slice(0, 5).join('; ')}`);
    const footprint = chosenPlans.map(plan => plan.building?.envelope?.footprint || plan.building?.footprint)
        .find(geometry => geometry && ['Polygon', 'MultiPolygon'].includes(geometry.type)) || null;
    const updatedAt = chosenPlans.map(plan => plan.updatedAt).filter(value => typeof value === 'string').sort().at(-1) || null;
    return { floorPlans, footprint, updatedAt, planIds: floorPlans.publication.planIds, skipped };
}
