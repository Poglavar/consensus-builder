// Unit tests for map-style 3D panning and the fixed data-query anchor used during a scene session.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const {
    MAX_APPLIED_WORK_SPAN_M,
    captureSceneLoadAnchor,
    resolveSceneLoadGeometry,
    buildLoadRadiusPreview,
    configurePannableOrbitControls,
    resolveExitMapCenter
} = require('../../frontend/js/three-snapshot-navigation.js');
const threeModeSource = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');

describe('3D snapshot navigation', () => {
    it('maps the primary pointer gesture to pan while retaining rotate and zoom', () => {
        const three = {
            MOUSE: { PAN: 10, DOLLY: 11, ROTATE: 12 },
            TOUCH: { PAN: 20, DOLLY_ROTATE: 21 }
        };
        const controls = { mouseButtons: {}, touches: {} };

        expect(configurePannableOrbitControls(controls, three)).toBe(controls);
        expect(controls).toMatchObject({
            enablePan: true,
            enableRotate: true,
            enableZoom: true,
            enableDamping: false,
            dampingFactor: 0,
            screenSpacePanning: false,
            panSpeed: 1.25,
            mouseButtons: { LEFT: 10, MIDDLE: 11, RIGHT: 12 },
            touches: { ONE: 20, TWO: 21 }
        });
    });

    it('keeps a cloned entry anchor instead of following later camera movement', () => {
        const focus = { type: 'Point', coordinates: [15.97, 45.81] };
        const anchor = captureSceneLoadAnchor(focus);
        focus.coordinates[0] = 16.5;

        expect(anchor).toEqual({ type: 'Point', coordinates: [15.97, 45.81] });
        expect(resolveSceneLoadGeometry({ entryAnchorGeometry: anchor })).toBe(anchor);
    });

    // A box around [lng, lat] about `halfM` metres to each side (Zagreb's latitude).
    const boxAround = ([lng, lat], halfM) => {
        const dLat = halfM / 111195, dLng = halfM / (111195 * Math.cos(lat * Math.PI / 180));
        return { type: 'Polygon', coordinates: [[[lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat], [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]]] };
    };

    it('prefers a focused proposal, then applied work the view is on, before the entry anchor', () => {
        const proposal = { type: 'Polygon', coordinates: [] };
        const anchor = { type: 'Point', coordinates: [15.977, 45.805] };
        const applied = boxAround([15.978, 45.805], 300);

        expect(resolveSceneLoadGeometry({ proposalGeometry: proposal, appliedWorkGeometry: applied, entryAnchorGeometry: anchor, radiusMeters: 300 })).toBe(proposal);
        expect(resolveSceneLoadGeometry({ appliedWorkGeometry: applied, entryAnchorGeometry: anchor, radiusMeters: 300 })).toBe(applied);
        expect(resolveSceneLoadGeometry({ entryAnchorGeometry: anchor })).toBe(anchor);
    });

    it('loads where the view is when the applied work lies elsewhere or spans too far to load', () => {
        // The view in the city centre; a plan applied in Borovje, about 3.5 km east.
        const centre = { type: 'Point', coordinates: [15.977, 45.805] };
        const borovje = boxAround([16.022, 45.802], 250);
        expect(resolveSceneLoadGeometry({ appliedWorkGeometry: borovje, entryAnchorGeometry: centre, radiusMeters: 300 })).toBe(centre);
        // Just outside the box but within the load radius still frames the plan.
        const besideBorovje = { type: 'Point', coordinates: [16.022 + 400 / (111195 * Math.cos(45.802 * Math.PI / 180)), 45.802] };
        expect(resolveSceneLoadGeometry({ appliedWorkGeometry: borovje, entryAnchorGeometry: besideBorovje, radiusMeters: 300 })).toBe(borovje);
        // Proposals kilometres apart: their box contains the view, but it is too large to load at once.
        const scattered = { type: 'MultiPolygon', coordinates: [boxAround([15.95, 45.79], 50).coordinates, boxAround([16.05, 45.83], 50).coordinates] };
        expect(resolveSceneLoadGeometry({ appliedWorkGeometry: scattered, entryAnchorGeometry: { type: 'Point', coordinates: [16.0, 45.81] }, radiusMeters: 300 })).toEqual({ type: 'Point', coordinates: [16.0, 45.81] });
        expect(MAX_APPLIED_WORK_SPAN_M).toBe(1500);
    });

    it.each([0, 45, 70])('draws the selected metre radius around a frozen anchor at latitude %s', lat => {
        const anchor = { type: 'Point', coordinates: [12, lat] };
        const original = structuredClone(anchor);
        for (const radius of [100, 300, 500]) {
            const preview = buildLoadRadiusPreview(anchor, radius, turf);
            expect(preview.center).toEqual({ lng: 12, lat });
            expect(preview.ring).toHaveLength(97);
            expect(preview.ring[0]).toEqual(preview.ring.at(-1));
            for (const point of preview.ring) {
                expect(turf.distance(anchor.coordinates, point, { units: 'meters' })).toBeCloseTo(radius, 5);
            }
            for (const point of preview.innerRing) {
                expect(turf.distance(anchor.coordinates, point, { units: 'meters' })).toBeLessThan(radius);
            }
        }
        expect(anchor).toEqual(original);
    });

    it('centers a focused proposal circle on the frozen bounds and rejects absent or invalid radii', () => {
        const geometry = turf.bboxPolygon([12, 45, 12.01, 45.02]).geometry;
        const center = buildLoadRadiusPreview(geometry, 300, turf).center;
        expect(center.lng).toBeCloseTo(12.005, 10);
        expect(center.lat).toBeCloseTo(45.01, 10);
        for (const radius of [0, -1, NaN, Infinity]) expect(buildLoadRadiusPreview(geometry, radius, turf)).toBeNull();
        expect(buildLoadRadiusPreview(null, 300, turf)).toBeNull();
    });

    it('returns the geographic center represented by the current 3D target', () => {
        const seen = [];
        const center = resolveExitMapCenter({ x: 125, y: -80, z: 40 }, (x, y) => {
            seen.push([x, y]);
            return { lat: 45.81, lng: 15.97 };
        });

        expect(seen).toEqual([[125, -80]]);
        expect(center).toEqual({ lat: 45.81, lng: 15.97 });
    });

    it('does not move the 2D map for an invalid 3D target', () => {
        expect(resolveExitMapCenter(null, () => ({ lat: 1, lng: 2 }))).toBeNull();
        expect(resolveExitMapCenter({ x: NaN, y: 0 }, () => ({ lat: 1, lng: 2 }))).toBeNull();
        expect(resolveExitMapCenter({ x: 0, y: 0 }, () => null)).toBeNull();
    });

    it('keeps parcel data events out of an active scene and hands the 3D target to Leaflet on exit', () => {
        expect(threeModeSource).not.toContain("addEventListener('parcelDataLoaded'");
        expect(threeModeSource).toContain('snapshotNavigation.resolveExitMapCenter(');
        expect(threeModeSource).toContain('map.setView([exitMapCenter.lat, exitMapCenter.lng], zoom, { animate: false });');
    });

    it('starts the nearby-building query from the frozen entry anchor before parcel rendering', () => {
        const initScene = threeModeSource.slice(
            threeModeSource.indexOf('    async function initScene()'),
            threeModeSource.indexOf('    function startLoop()')
        );
        expect(initScene).toMatch(
            /captureSceneLoadGeometry\(\);[\s\S]*?ensureNearbyProposalBuildings\(\);[\s\S]*?const parcelGeneration = \+\+parcelGroundGeneration;[\s\S]*?await buildParcels3D\(flatGroup,\s*parcelGeneration,\s*isCurrent\);/
        );
    });
});
