// Unit tests for map-style 3D panning and the fixed data-query anchor used during a scene session.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
    captureSceneLoadAnchor,
    resolveSceneLoadGeometry,
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

    it('prefers a focused proposal, then applied work, before the entry anchor', () => {
        const proposal = { type: 'Polygon', coordinates: [] };
        const applied = { type: 'MultiPolygon', coordinates: [] };
        const anchor = { type: 'Point', coordinates: [0, 0] };

        expect(resolveSceneLoadGeometry({ proposalGeometry: proposal, appliedWorkGeometry: applied, entryAnchorGeometry: anchor })).toBe(proposal);
        expect(resolveSceneLoadGeometry({ appliedWorkGeometry: applied, entryAnchorGeometry: anchor })).toBe(applied);
        expect(resolveSceneLoadGeometry({ entryAnchorGeometry: anchor })).toBe(anchor);
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
});
