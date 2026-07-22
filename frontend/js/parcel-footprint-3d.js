// Projects parcel rings (lng/lat) into a local metric frame centred on the parcels, ready to lay
// flat under an uploaded building model in the building-upload 3D preview. Pure math built on
// LocalFrame (the one ground-truth degrees⇄metres frame) — no THREE, no DOM — so it is unit-testable.
// The building-upload scene turns the returned {x (east), y (north)} points into a flat THREE.Shape.

(function (root, factory) {
    const api = factory(root && root.LocalFrame);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelFootprint3D = api;
})(typeof window !== 'undefined' ? window : globalThis, function (LocalFrameGlobal) {
    'use strict';

    function getLocalFrame() {
        if (LocalFrameGlobal && typeof LocalFrameGlobal.makeLocalFrame === 'function') return LocalFrameGlobal;
        if (typeof require === 'function') {
            try { return require('./local-frame.js'); } catch (_) { /* browser */ }
        }
        return (typeof window !== 'undefined') ? window.LocalFrame : null;
    }

    // Centroid (plain average of vertices) of every ring's points, in lng/lat.
    function ringsCentroid(rings) {
        let sx = 0, sy = 0, n = 0;
        rings.forEach(ring => ring.forEach(pt => {
            const lng = Number(pt[0]);
            const lat = Number(pt[1]);
            if (Number.isFinite(lng) && Number.isFinite(lat)) { sx += lng; sy += lat; n += 1; }
        }));
        return n ? { lng: sx / n, lat: sy / n } : null;
    }

    // rings: array of rings, each an array of [lng, lat]. Returns { anchor, rings } where each output
    // ring is an array of { x (metres east of anchor), y (metres north of anchor) }, or null when
    // there is nothing usable to project.
    function projectRingsToLocalMeters(rings, anchor) {
        if (!Array.isArray(rings) || !rings.length) return null;
        const clean = rings.filter(ring => Array.isArray(ring) && ring.length >= 3);
        if (!clean.length) return null;

        const LocalFrame = getLocalFrame();
        if (!LocalFrame) return null;

        const anchorPt = anchor && Number.isFinite(anchor.lng) && Number.isFinite(anchor.lat)
            ? anchor
            : ringsCentroid(clean);
        if (!anchorPt) return null;

        const frame = LocalFrame.makeLocalFrame(anchorPt.lng, anchorPt.lat);
        const outRings = clean.map(ring => ring.map(pt => {
            const [x, y] = frame.toMeters(Number(pt[0]), Number(pt[1]));
            return { x, y };
        }));
        return { anchor: anchorPt, rings: outRings };
    }

    return { projectRingsToLocalMeters, ringsCentroid };
});
