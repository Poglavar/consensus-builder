// The two rules behind the road-editing deep zoom: what a tile layer needs so it keeps drawing above
// its own range, and when the ceiling may safely be put back. Both are pure — the Leaflet wiring
// around them is not, but it is only bookkeeping over these two answers.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { roadEditingZoomLayerPatch, roadEditingZoomShouldDefer, DEEP_ZOOM } = require('../../frontend/js/road-editing-zoom.js');

describe('roadEditingZoomLayerPatch', () => {
    it('keeps a layer requesting tiles at its own limit while allowing the map past it', () => {
        expect(roadEditingZoomLayerPatch({ maxZoom: 19 }, DEEP_ZOOM)).toEqual({ maxZoom: DEEP_ZOOM, maxNativeZoom: 19 });
    });

    it('leaves a layer that already reaches the deep ceiling alone', () => {
        expect(roadEditingZoomLayerPatch({ maxZoom: DEEP_ZOOM }, DEEP_ZOOM)).toBeNull();
        expect(roadEditingZoomLayerPatch({ maxZoom: 23 }, DEEP_ZOOM)).toBeNull();
    });

    it('never overwrites a native zoom the layer stated itself', () => {
        expect(roadEditingZoomLayerPatch({ maxZoom: 21, maxNativeZoom: 18 }, DEEP_ZOOM))
            .toEqual({ maxZoom: DEEP_ZOOM, maxNativeZoom: 18 });
    });

    it('leaves alone anything that declares no range', () => {
        expect(roadEditingZoomLayerPatch({}, DEEP_ZOOM)).toBeNull();
        expect(roadEditingZoomLayerPatch(null, DEEP_ZOOM)).toBeNull();
    });
});

describe('roadEditingZoomShouldDefer', () => {
    it('holds the ceiling while the view is still past it', () => {
        expect(roadEditingZoomShouldDefer(21, 19)).toBe(true);
    });

    it('lets it go once the view is back inside the basemap range', () => {
        expect(roadEditingZoomShouldDefer(19, 19)).toBe(false);
        expect(roadEditingZoomShouldDefer(17, 19)).toBe(false);
    });

    it('does not defer on a map with no ceiling to restore', () => {
        expect(roadEditingZoomShouldDefer(21, null)).toBe(false);
        expect(roadEditingZoomShouldDefer(undefined, 19)).toBe(false);
    });
});
