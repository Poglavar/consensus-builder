// Deterministic architectural skins for proposed building extrusions. Wall coordinates are in
// real metres; shared uniforms switch the skins without rebuilding geometry or adding draw calls.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeBuildingFacades = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // The style laboratory: palette, masonry amount, window width and pilaster spacing.
    // Colours are sRGB; Three converts these to linear light when making the uniforms.
    const STYLES = Object.freeze([
        { id: 'brick', wall: '#a66d53', trim: '#e0d5bd', roof: '#62686a', brick: 1, window: 0.48, pilasters: 3 },
        { id: 'stone', wall: '#d4c8b3', trim: '#e8dfce', roof: '#717575', brick: 0, window: 0.44, pilasters: 2 },
        { id: 'plaster', wall: '#cdc6b8', trim: '#e6decf', roof: '#666f71', brick: 0, window: 0.52, pilasters: 4 }
    ].map(Object.freeze));

    // Window proportions repeat across a building; shutter positions vary per opening.
    const WINDOW_STYLES = Object.freeze([
        { id: 'casement', width: 1, height: 1, arch: 0 },
        { id: 'sash', width: 0.88, height: 1.08, arch: 0 },
        { id: 'arched', width: 0.96, height: 1.04, arch: 1 }
    ].map(Object.freeze));
    const SHUTTER_COLORS = Object.freeze(['#5e7461', '#607583', '#795c53', '#6e6a5e']);

    function hashKey(key) {
        let hash = 2166136261;
        for (const char of String(key)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
        return hash >>> 0;
    }

    function buildingKey(feature, city = '') {
        const p = feature.properties || {};
        const identity = p.buildingId ?? feature.id ?? p.id;
        if (identity != null) return JSON.stringify([city, p.proposalId, identity]);
        if (p.buildingIndex != null || p.variationSeed != null) {
            return JSON.stringify([city, p.proposalId, p.parcelId, p.buildingIndex, p.variationSeed]);
        }
        // Geometry is the last resort for imported anonymous shapes. Canonical point ordering
        // makes ring start, winding and MultiPolygon order irrelevant; camera origin is never used.
        const points = [];
        const visit = coords => {
            if (typeof coords?.[0] === 'number') points.push(coords.slice(0, 2).map(n => n.toFixed(6)).join(','));
            else if (Array.isArray(coords)) coords.forEach(visit);
        };
        visit(feature.geometry?.coordinates);
        return JSON.stringify([city, p.proposalId, p.parcelId, [...new Set(points)].sort()]);
    }

    function buildingDesign(key, height, storeyHeight = 3.3) {
        if (!(typeof height === 'number' && Number.isFinite(height) && height > 0)) {
            throw new TypeError('Facade height must be a positive number.');
        }
        const seed = hashKey(key);
        return {
            seed,
            style: seed % STYLES.length,
            bayWidth: 2.8 + ((seed >>> 8) % 9) * 0.1,
            tone: 0.94 + ((seed >>> 16) % 13) * 0.01,
            windowStyle: hashKey(key + ':windows') % WINDOW_STYLES.length,
            shutters: (hashKey(key + ':shutters') % 4) !== 0,
            shutterColor: hashKey(key + ':shutter-color') % SHUTTER_COLORS.length,
            floorHeight: height / Math.max(1, Math.round(height / storeyHeight)),
            height
        };
    }

    // Non-indexed, flat-normal ExtrudeGeometry. Group coplanar wall triangles first so a
    // triangulation seam cannot restart the window grid. Caps have span=0 and get no windows.
    function wallCoordinates(positions, normals, metresPerUnit = 1) {
        if (positions.length !== normals.length || positions.length % 9 !== 0
            || !(metresPerUnit > 0 && Number.isFinite(metresPerUnit))) {
            throw new TypeError('Facade coordinates require non-indexed triangles and a metric scale.');
        }
        const result = new Float32Array(positions.length);
        const walls = new Map();
        for (let i = 0; i < positions.length; i += 9) {
            if (Math.abs(normals[i + 2]) > 0.1) continue;
            const length = Math.hypot(normals[i], normals[i + 1]);
            if (length < 0.9) continue;
            const nx = normals[i] / length, ny = normals[i + 1] / length;
            const plane = nx * positions[i] + ny * positions[i + 1];
            const key = [Math.round(nx * 1e4), Math.round(ny * 1e4), Math.round(plane * 100)].join(':');
            let wall = walls.get(key);
            if (!wall) {
                wall = { nx, ny, min: Infinity, max: -Infinity, vertices: [] };
                walls.set(key, wall);
            }
            for (let j = i; j < i + 9; j += 3) {
                const u = -wall.ny * positions[j] + wall.nx * positions[j + 1];
                wall.min = Math.min(wall.min, u);
                wall.max = Math.max(wall.max, u);
                wall.vertices.push(j);
            }
        }
        for (const wall of walls.values()) {
            for (const i of wall.vertices) {
                result[i] = (-wall.ny * positions[i] + wall.nx * positions[i + 1] - wall.min) * metresPerUnit;
                result[i + 1] = positions[i + 2]; // scene Z is already real metres
                result[i + 2] = (wall.max - wall.min) * metresPerUnit;
            }
        }
        return result;
    }

    function createState(THREE) {
        return {
            cbFacadeEnabled: { value: 0 },
            cbFacadeStyleOverride: { value: -1 },
            cbFacadeWalls: { value: STYLES.map(s => new THREE.Color(s.wall)) },
            cbFacadeTrims: { value: STYLES.map(s => new THREE.Color(s.trim)) },
            cbFacadeRoofs: { value: STYLES.map(s => new THREE.Color(s.roof)) },
            cbFacadeWindowStyles: { value: WINDOW_STYLES.map(s => new THREE.Vector3(s.width, s.height, s.arch)) },
            cbFacadeSettings: { value: STYLES.map(s => new THREE.Vector3(s.brick, s.window, s.pilasters)) }
        };
    }

    function setState(state, enabled, style = 'mixed') {
        state.cbFacadeEnabled.value = enabled ? 1 : 0;
        state.cbFacadeStyleOverride.value = STYLES.findIndex(s => s.id === style);
    }

    const FRAGMENT_HEADER = `
varying vec3 vCbFacade;
varying float vCbFacadeFace;
uniform float cbFacadeEnabled;
uniform float cbFacadeStyleOverride;
uniform vec3 cbFacadeWalls[3];
uniform vec3 cbFacadeTrims[3];
uniform vec3 cbFacadeRoofs[3];
uniform vec3 cbFacadeSettings[3];
uniform vec3 cbFacadeDesign;
uniform vec3 cbFacadeBuilding;
uniform vec3 cbFacadeWindowStyles[3];
uniform vec3 cbFacadeWindows;
uniform vec3 cbFacadeShutterColor;
float cbFacadeBox(vec2 p, vec2 halfSize, vec2 aa) {
    vec2 edge = smoothstep(halfSize - aa, halfSize + aa, abs(p));
    return (1.0 - edge.x) * (1.0 - edge.y);
}
float cbFacadeNoise(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
// A shallow segmental arch, clipped to the same rectangle as ordinary windows.
float cbFacadeOpening(vec2 p, vec2 halfSize, vec2 aa, float arched) {
    float rise = halfSize.x * 0.55;
    vec2 arc = vec2(p.x, max(0.0, p.y - (halfSize.y - rise)) / 0.55);
    float cap = 1.0 - smoothstep(halfSize.x - aa.x, halfSize.x + max(aa.x, aa.y / 0.55), length(arc));
    return cbFacadeBox(p, halfSize, aa) * mix(1.0, cap, arched);
}
vec3 cbFacadeShutter(vec2 p, vec2 halfSize, vec2 aa, vec3 paint) {
    float slatDetail = 1.0 - smoothstep(0.02, 0.09, aa.y);
    float groove = 1.0 - smoothstep(0.10, 0.32, fract((p.y + halfSize.y) / 0.11));
    vec3 color = paint * (1.0 - 0.22 * groove * slatDetail);
    float frame = 1.0 - cbFacadeBox(p, halfSize - vec2(0.045, 0.085), aa);
    return mix(color, paint * 1.09, frame);
}
vec3 cbFacadeColor(vec3 original) {
    if (cbFacadeEnabled < 0.5) return original;
    int style = int(cbFacadeStyleOverride < 0.0 ? cbFacadeDesign.x : cbFacadeStyleOverride);
    if (vCbFacade.z < 0.01) return cbFacadeRoofs[style];
    vec3 settings = cbFacadeSettings[style];
    vec3 trim = cbFacadeTrims[style];
    vec3 wall = cbFacadeWalls[style] * cbFacadeDesign.z;
    float width = vCbFacade.z;
    float height = cbFacadeBuilding.x;
    float floorHeight = cbFacadeBuilding.y;
    vec2 p = vCbFacade.xy;
    vec2 aa = max(fwidth(p), vec2(0.004));
    float detail = 1.0 - smoothstep(0.22, 0.9, max(aa.x, aa.y));

    // Fine brick joints disappear before they become subpixel noise while orbiting.
    vec2 brick = vec2(p.x / 0.32, p.y / 0.105);
    brick.x += mod(floor(brick.y), 2.0) * 0.5;
    vec2 jointAA = max(fwidth(brick), vec2(0.005));
    vec2 joint = smoothstep(vec2(0.035), vec2(0.035) + jointAA, min(fract(brick), 1.0 - fract(brick)));
    float brickDetail = 1.0 - smoothstep(0.025, 0.12, max(aa.x, aa.y));
    vec3 brickColor = wall * (0.90 + 0.18 * cbFacadeNoise(floor(brick)));
    brickColor = mix(trim * 0.66, brickColor, joint.x * joint.y);
    wall = mix(wall, brickColor, settings.x * brickDetail);

    float margin = min(0.5, width * 0.12);
    float bays = max(1.0, floor((width - 2.0 * margin) / cbFacadeDesign.y));
    float bay = (width - 2.0 * margin) / bays;
    float column = floor((p.x - margin) / bay);
    float floorIndex = floor(p.y / floorHeight);
    vec2 cell = vec2(mod(p.x - margin, bay) - bay * 0.5, mod(p.y, floorHeight) - floorHeight * 0.54);
    float ground = 1.0 - step(0.5, floorIndex);

    // A stone base, thin storey bands, paired pilasters and a quiet two-part cornice.
    float base = 1.0 - smoothstep(floorHeight - 0.10, floorHeight + 0.02, p.y);
    wall = mix(wall, trim * 0.80, base * 0.7);
    float floorBand = 1.0 - smoothstep(0.055, 0.055 + aa.y, abs(cell.y + floorHeight * 0.54));
    wall = mix(wall, trim * 0.88, floorBand * detail);
    float pilasterX = mod(p.x - margin + bay * settings.z * 0.5, bay * settings.z) - bay * settings.z * 0.5;
    float pilaster = 1.0 - smoothstep(0.13, 0.13 + aa.x, abs(pilasterX));
    float corner = 1.0 - smoothstep(0.22, 0.22 + aa.x, min(p.x, width - p.x));
    wall = mix(wall, trim * 0.93, max(pilaster, corner) * detail);
    float pilasterShadow = (1.0 - smoothstep(0.035, 0.035 + aa.x, abs(pilasterX - 0.17))) * detail;
    wall *= 1.0 - pilasterShadow * 0.15;

    // Tall windows, a recessed reveal, pale surround, sill and slender mullions.
    // Each building repeats one window family; sash windows have six panes, casements a high
    // transom, and arched windows a curved head. Entrances share the family but never get shutters.
    vec3 windowStyle = cbFacadeWindowStyles[int(cbFacadeWindows.x)];
    vec2 windowSize = vec2(min(0.88, bay * settings.y * 0.5), floorHeight * 0.275) * windowStyle.xy;
    float entrance = ground * (1.0 - step(0.1, abs(column - floor(bays * 0.5)))) * step(6.0, width);
    float sash = 1.0 - step(0.1, abs(cbFacadeWindows.x - 1.0));
    float allowed = step(margin, p.x) * step(p.x, width - margin) * step(1.8, width) * detail;

    // The opening address is (building, wall direction, bay, storey), never camera position or
    // time. Opposite walls therefore do not repeat the same open/closed shutter pattern.
    float faceAddress = floor(vCbFacadeFace * 100.0 + 0.5);
    float shutterRandom = cbFacadeNoise(vec2(column + cbFacadeBuilding.z + faceAddress, floorIndex + 31.7));
    float closedLeft = 1.0 - step(0.29, shutterRandom);
    float closedRight = 1.0 - step(0.20, shutterRandom) + step(0.29, shutterRandom) * (1.0 - step(0.38, shutterRandom));
    float closedSide = mix(closedLeft, closedRight, step(0.0, cell.x));
    float hasShutters = cbFacadeWindows.y * (1.0 - entrance) * step(2.4, bay);
    float leafWidth = min(windowSize.x * 0.9, max(0.08, bay * 0.5 - windowSize.x - 0.22));
    vec2 leafSize = vec2(leafWidth * 0.5, windowSize.y);
    vec2 leaf = vec2(abs(cell.x) - (windowSize.x + 0.15 + leafSize.x), cell.y);
    float openLeaf = cbFacadeBox(leaf, leafSize, aa) * (1.0 - closedSide) * hasShutters * allowed;
    float leafShadow = cbFacadeBox(leaf - vec2(0.045, -0.035), leafSize + vec2(0.025), aa)
        * (1.0 - closedSide) * hasShutters * allowed;
    wall *= 1.0 - leafShadow * 0.22;
    wall = mix(wall, cbFacadeShutter(leaf, leafSize, aa, cbFacadeShutterColor), openLeaf);

    vec2 opening = cell;
    opening.y += entrance * floorHeight * 0.11;
    windowSize.y += entrance * floorHeight * 0.11;
    float surround = cbFacadeOpening(opening, windowSize + vec2(0.12, 0.10), aa, windowStyle.z);
    float reveal = cbFacadeOpening(opening, windowSize + vec2(0.035), aa, windowStyle.z);
    float glass = cbFacadeOpening(opening, windowSize - vec2(0.055), aa, windowStyle.z);
    float windowVariation = cbFacadeNoise(vec2(column + cbFacadeBuilding.z, floorIndex));
    vec3 glazing = mix(vec3(0.075, 0.12, 0.14), vec3(0.20, 0.28, 0.30), windowVariation);
    glazing *= 0.88 + 0.20 * (opening.y / floorHeight + 0.5);
    float verticalBar = 1.0 - smoothstep(0.021, 0.021 + aa.x, abs(opening.x));
    float transomY = mix(abs(opening.y - windowSize.y * 0.45), abs(abs(opening.y) - windowSize.y / 3.0), sash);
    float transom = 1.0 - smoothstep(0.021, 0.021 + aa.y, transomY);
    glazing = mix(glazing, trim * 0.60, max(verticalBar, transom) * 0.85);
    wall = mix(wall, trim, surround * allowed);
    wall = mix(wall, trim * 0.37, reveal * allowed);
    wall = mix(wall, glazing, glass * allowed);
    vec2 closedPanel = vec2(abs(opening.x) - windowSize.x * 0.5, opening.y);
    vec3 closedPaint = cbFacadeShutter(closedPanel, vec2(windowSize.x * 0.5, windowSize.y), aa,
        cbFacadeShutterColor * mix(0.95, 1.05, step(0.0, opening.x)));
    float closedMask = cbFacadeOpening(opening, windowSize, aa, windowStyle.z) * closedSide * hasShutters * allowed;
    wall = mix(wall, closedPaint, closedMask);
    float sill = cbFacadeBox(cell + vec2(0.0, windowSize.y + 0.15), vec2(windowSize.x + 0.17, 0.055), aa);
    wall = mix(wall, trim * 0.90, sill * allowed * (1.0 - entrance));

    float plinth = 1.0 - smoothstep(0.26, 0.26 + aa.y, p.y);
    float cornice = smoothstep(height - 0.32 - aa.y, height - 0.32, p.y);
    float corniceShadow = 1.0 - smoothstep(0.045, 0.045 + aa.y, abs(p.y - (height - 0.36)));
    wall = mix(wall, trim * 0.65, plinth);
    wall *= 1.0 - corniceShadow * 0.23 * detail;
    return mix(wall, trim, cornice);
}
`;

    function patchShader(shader) {
        if (!shader.vertexShader.includes('#include <begin_vertex>')
            || !shader.fragmentShader.includes('#include <color_fragment>')) {
            throw new Error('Procedural facades require the Three.js building material shader chunks.');
        }
        shader.vertexShader = 'attribute vec3 cbFacadeCoord;\nvarying vec3 vCbFacade;\nvarying float vCbFacadeFace;\n' + shader.vertexShader.replace(
            '#include <begin_vertex>', '#include <begin_vertex>\nvCbFacade = cbFacadeCoord;\nvCbFacadeFace = dot(normal.xy, vec2(17.13, 47.71));');
        shader.fragmentShader = FRAGMENT_HEADER + shader.fragmentShader.replace(
            '#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = cbFacadeColor(diffuseColor.rgb);');
        return shader;
    }

    function configureMaterial(material, design, state, THREE) {
        const priorCompile = material.onBeforeCompile;
        const priorKey = material.customProgramCacheKey?.() || '';
        material.userData.cbProceduralFacade = true;
        material.onBeforeCompile = function (shader, renderer) {
            priorCompile?.call(this, shader, renderer);
            Object.assign(shader.uniforms, state, {
                cbFacadeDesign: { value: new THREE.Vector3(design.style, design.bayWidth, design.tone) },
                cbFacadeBuilding: { value: new THREE.Vector3(design.height, design.floorHeight, design.seed % 10000) },
                cbFacadeWindows: { value: new THREE.Vector3(design.windowStyle, design.shutters ? 1 : 0, 0) },
                cbFacadeShutterColor: { value: new THREE.Color(SHUTTER_COLORS[design.shutterColor]) }
            });
            patchShader(shader);
        };
        material.customProgramCacheKey = () => priorKey + '|cb-facades-v2';
        material.needsUpdate = true;
        return material;
    }

    // Only facade-owned resources: imported glTF caches and shared building/line materials stay
    // with their existing owners. A set avoids disposing a geometry twice through its depth child.
    function disposeGroup(group) {
        const geometries = new Set(), materials = new Set();
        const roots = Array.isArray(group) ? group : [group];
        roots.forEach(root => root?.traverse(object => {
            if (!object.userData?.cbFacadeOwned) return;
            object.traverse(child => {
                if (child.geometry) geometries.add(child.geometry);
                for (const material of [].concat(child.material || [])) {
                    if (material.userData?.cbProceduralFacade || child.userData?.cbSmoothGhostDepthPrepass) materials.add(material);
                }
            });
        }));
        geometries.forEach(geometry => geometry.dispose());
        materials.forEach(material => material.dispose());
    }

    return { STYLES, WINDOW_STYLES, SHUTTER_COLORS, buildingKey, buildingDesign, wallCoordinates, createState, setState, patchShader, configureMaterial, disposeGroup };
});
