// Furniture models: a park or square may assign one uploaded GLB per furniture kind (all benches in
// this square use this model), and market stalls with coloured canopies are furniture on both. This module holds the pure rules shared by the structure editor, the 3D
// renderer, the MCP tools and tests: the kinds, the asset limits (the asset is instanced everywhere, so
// it stays small), the record shape under decorationDesign.models, and the instance transform.
// UMD: window.FurnitureModels in the browser, require()-able in node.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FurnitureModels = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    // Furniture kind -> the decorationDesign array that holds its placements. Lamps are new: a point with
    // an optional bearing, lit at night. Trees keep their own record shape (park-planting.js treeOf).
    const ARRAY_BY_KIND = Object.freeze({ bench: 'benches', statue: 'statues', fountain: 'fountains', stall: 'stalls', tree: 'trees', lamp: 'lamps' });
    const KINDS = Object.freeze(Object.keys(ARRAY_BY_KIND));
    const KINDS_BY_STRUCTURE = Object.freeze({ park: ['bench', 'stall', 'tree', 'lamp'], square: ['bench', 'statue', 'fountain', 'stall', 'tree', 'lamp'] });
    // Limits per asset. A furniture model is drawn once per placement, so 5k triangles x 200 benches is
    // already a million triangles; textures above 1024 px cost GPU memory for every structure that loads.
    const LIMITS = Object.freeze({ maxTriangles: 5000, maxTextureSize: 1024, maxBytes: 4 * 1024 * 1024, maxNameLength: 120 });

    function isKind(kind) { return KINDS.includes(kind); }
    function kindsFor(structureKind) { return KINDS_BY_STRUCTURE[structureKind] || []; }

    // Validates a parsed-model summary: { triangles, textures: [{ width, height }], bytes }.
    // Returns { ok: true } or { ok: false, code: 'triangles' | 'texture' | 'bytes' | 'empty', detail }.
    function validateModelSummary(summary) {
        const triangles = Number(summary?.triangles);
        const bytes = Number(summary?.bytes);
        if (!(triangles > 0)) return { ok: false, code: 'empty', detail: { triangles } };
        if (triangles > LIMITS.maxTriangles) return { ok: false, code: 'triangles', detail: { triangles, max: LIMITS.maxTriangles } };
        if (bytes > LIMITS.maxBytes) return { ok: false, code: 'bytes', detail: { bytes, max: LIMITS.maxBytes } };
        for (const texture of Array.isArray(summary?.textures) ? summary.textures : []) {
            const w = Number(texture?.width), h = Number(texture?.height);
            if (w > LIMITS.maxTextureSize || h > LIMITS.maxTextureSize) return { ok: false, code: 'texture', detail: { width: w, height: h, max: LIMITS.maxTextureSize } };
        }
        return { ok: true };
    }

    // decorationDesign.models: { [kind]: { url, name } }. Unknown kinds and entries without a string url
    // are dropped; names are trimmed to the limit. Returns null when nothing remains, so a record never
    // carries an empty object.
    function normalizeModels(models, structureKind) {
        if (!models || typeof models !== 'object') return null;
        const allowed = structureKind ? kindsFor(structureKind) : KINDS;
        const out = {};
        for (const kind of allowed) {
            const entry = models[kind];
            const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
            if (!url) continue;
            const name = typeof entry?.name === 'string' ? entry.name.trim().slice(0, LIMITS.maxNameLength) : '';
            out[kind] = name ? { url, name } : { url };
        }
        return Object.keys(out).length ? out : null;
    }

    // A lamp placement: { coordinate: [lng, lat], bearing }. Bearing is degrees from north, kept in [0, 360).
    function normalizeLamps(lamps, coordinate) {
        if (!Array.isArray(lamps)) return [];
        return lamps.map(lamp => {
            const point = coordinate(lamp?.coordinate || lamp?.position || lamp);
            return point ? { coordinate: point, bearing: ((Number(lamp?.bearing) || 0) % 360 + 360) % 360 } : null;
        }).filter(Boolean);
    }

    // Market stalls: { coordinate: [lng, lat], bearing, color? }. The canopy colour is the record's own
    // hex colour when given, else one of the palette by placement index, so a row of stalls is colourful
    // without anyone picking colours. Bearing is where the counter faces, degrees from north.
    const STALL_PALETTE = Object.freeze(['#d64545', '#f2a93b', '#2f9e6b', '#2d7dd2', '#8e5bd1', '#e86aa6', '#1fa9a6', '#f0d43a']);
    function normalizeStalls(stalls, coordinate) {
        if (!Array.isArray(stalls)) return [];
        return stalls.map(stall => {
            const point = coordinate(stall?.coordinate || stall?.position || stall);
            if (!point) return null;
            const color = typeof stall?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(stall.color.trim()) ? stall.color.trim().toLowerCase() : null;
            return { coordinate: point, bearing: ((Number(stall?.bearing) || 0) % 360 + 360) % 360, ...(color ? { color } : {}) };
        }).filter(Boolean);
    }
    function stallColor(stall, index) {
        return stall?.color || STALL_PALETTE[Math.abs(Number(index) || 0) % STALL_PALETTE.length];
    }

    // Instance transform for one placement in the scene frame: scene XY is Mercator-inflated by k while
    // Z is metric, so a model authored in metres is scaled (k, k, 1); the model's own +X faces the
    // bearing, matching the default bench (rotation.z = (90 - bearing) degrees). Pure numbers; the renderer
    // composes the matrix.
    function instanceTransform({ x, y, z = 0, bearingDeg = 0, k = 1 }) {
        const rotationZ = ((90 - (Number(bearingDeg) || 0)) * Math.PI) / 180;
        return { position: [Number(x) || 0, Number(y) || 0, Number(z) || 0], rotationZ, scale: [k, k, 1] };
    }

    // Night glow: lamps light when the sun is below the horizon; the strength eases in over the first
    // few degrees so a sunset does not switch them on in one frame. altitudeDeg null = sun layer off:
    // no glow.
    function lampGlowStrength(altitudeDeg) {
        if (!Number.isFinite(altitudeDeg)) return 0;
        if (altitudeDeg >= 0) return 0;
        return Math.min(1, -altitudeDeg / 6);
    }

    return { KINDS, KINDS_BY_STRUCTURE, ARRAY_BY_KIND, LIMITS, STALL_PALETTE, isKind, kindsFor, validateModelSummary, normalizeModels, normalizeLamps, normalizeStalls, stallColor, instanceTransform, lampGlowStrength };
});
