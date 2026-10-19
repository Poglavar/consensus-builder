// Frame math for the photoreal tile layer: how a true-metre, ENU-oriented world (Google 3D
// Tiles reoriented by 3d-tiles-renderer's ReorientationPlugin) maps into three-mode's scene
// frame (EPSG:3857 — XY inflated by 1/cos(lat), Z true metres, Z-up, X east, Y north). Pure
// math, no THREE: the browser layer feeds these into its scale/rotation nodes, and the node
// test asserts the axis mapping so the isochrone sim's "world yawed 180°" trap cannot recur
// silently here.
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.__photorealFrame = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Horizontal Mercator inflation at a latitude: scene-XY metres per true metre. Applied as
    // an anisotropic (k, k, 1) scale on the tiles root — heights stay 1:1, matching how the
    // scene extrudes buildings (true-metre Z over inflated XY).
    function mercatorScaleFactor(latDeg) {
        return 1 / Math.max(0.1, Math.cos(latDeg * Math.PI / 180));
    }

    // ReorientationPlugin's object frame is east=−X / north=+Z / up=+Y, while the scene frame
    // is east=+X / north=+Y / up=+Z. Those differ by Rx(+90°) followed by Rz(180°) — the same
    // 180° yaw the isochrone sim needed. THREE's Euler order 'ZYX' composes exactly Rz·Ry·Rx.
    var TILES_FRAME_EULER = { x: Math.PI / 2, y: 0, z: Math.PI, order: 'ZYX' };

    // The same rotation as plain math (for tests and any non-THREE consumer):
    // R = Rz(π) · Rx(π/2) applied to an [x, y, z] vector in the tiles frame.
    function applyTilesFrame(v) {
        var x1 = v[0], y1 = -v[2], z1 = v[1]; // Rx(+90°): (x, y, z) → (x, −z, y)
        // + 0 normalises the −0 the sign flips produce on zero components.
        return [-x1 + 0, -y1 + 0, z1 + 0];    // Rz(180°): (x, y, z) → (−x, −y, z)
    }

    return {
        mercatorScaleFactor: mercatorScaleFactor,
        TILES_FRAME_EULER: TILES_FRAME_EULER,
        applyTilesFrame: applyTilesFrame
    };
});
