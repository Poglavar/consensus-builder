// Deterministic architectural skins for proposed building extrusions. Wall coordinates are in
// real metres; shared uniforms switch the skins without rebuilding geometry or adding draw calls.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeBuildingFacades = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Masonry uses punched windows; curtain walls use metre-wide panels and rows per storey.
    // Colours are sRGB; Three converts these to linear light when making the uniforms.
    const STYLES = Object.freeze([
        { id: 'brick', wall: '#dc7952', trim: '#fff2da', roof: '#bf6846', brick: 1, window: 0.48, pilasters: 3 },
        { id: 'stone', wall: '#f2d18c', trim: '#fff7e5', roof: '#c78051', brick: 0, window: 0.44, pilasters: 2 },
        { id: 'plaster', wall: '#f4b99d', trim: '#fff9ed', roof: '#cd7957', brick: 0, window: 0.52, pilasters: 4 },
        { id: 'glass-small', trim: '#60727c', roof: '#4c5962', panelWidth: 1, rowsPerStorey: 3 },
        { id: 'glass-medium', trim: '#60727c', roof: '#4c5962', panelWidth: 1.6, rowsPerStorey: 2 },
        { id: 'glass-large', trim: '#60727c', roof: '#4c5962', panelWidth: 3.2, rowsPerStorey: 1 }
    ].map(Object.freeze));

    // Window proportions repeat across a building; shutter positions vary per opening.
    const WINDOW_STYLES = Object.freeze([
        { id: 'casement', width: 1, height: 1, arch: 0 },
        { id: 'sash', width: 0.88, height: 1.08, arch: 0 },
        { id: 'arched', width: 0.96, height: 1.04, arch: 1 }
    ].map(Object.freeze));
    const SHUTTER_COLORS = Object.freeze(['#288978', '#2f86a6', '#b64e3f', '#678b43']);
    const GLASS_COLORS = Object.freeze(['#538998', '#638d91', '#7696aa', '#699790', '#8a9ca6', '#867b68', '#45657d', '#5b797c']);

    function hashKey(key) {
        let hash = 2166136261;
        for (const char of String(key)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
        return hash >>> 0;
    }

    function buildingKey(feature, city = '') {
        const p = feature.properties || {};
        // Parcel ownership shares its shade and window details across volumes. Mixed style
        // and glass tint use the independent building identity below.
        const parcelId = p.parcelId == null ? '' : String(p.parcelId).trim();
        if (parcelId) return JSON.stringify([city, 'parcel', parcelId]);
        return buildingIdentityKey(feature, city);
    }

    // Glass colour belongs to the original building, including when it spans parcel slices.
    function buildingIdentityKey(feature, city = '') {
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

    function buildingDesign(key, height, storeyHeight = 3.3, identityKey = key) {
        if (!(typeof height === 'number' && Number.isFinite(height) && height > 0)) {
            throw new TypeError('Facade height must be a positive number.');
        }
        const seed = hashKey(key);
        const appearanceSeed = hashKey(identityKey + ':style');
        const glassSeed = hashKey(identityKey + ':glass');
        const storeys = Math.max(1, Math.round(height / storeyHeight));
        const eligibleStyles = STYLES.filter(style => !style.panelWidth || storeys >= 10);
        return {
            seed,
            style: STYLES.indexOf(eligibleStyles[appearanceSeed % eligibleStyles.length]),
            bayWidth: 2.8 + ((seed >>> 8) % 9) * 0.1,
            tone: 0.94 + ((seed >>> 16) % 13) * 0.01,
            windowStyle: hashKey(key + ':windows') % WINDOW_STYLES.length,
            shutters: (hashKey(key + ':shutters') % 4) !== 0,
            shutterColor: hashKey(key + ':shutter-color') % SHUTTER_COLORS.length,
            glassColor: glassSeed % GLASS_COLORS.length,
            glassTone: 0.85 + ((glassSeed >>> 8) % 31) * 0.01,
            floorHeight: height / storeys,
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
            cbFacadeWalls: { value: STYLES.map(s => new THREE.Color(s.wall || '#ffffff')) },
            cbFacadeTrims: { value: STYLES.map(s => new THREE.Color(s.trim)) },
            cbFacadeRoofs: { value: STYLES.map(s => new THREE.Color(s.roof)) },
            cbFacadeWindowStyles: { value: WINDOW_STYLES.map(s => new THREE.Vector3(s.width, s.height, s.arch)) },
            cbFacadeSettings: { value: STYLES.map(s => new THREE.Vector3(s.brick || 0, s.window || 0, s.pilasters || 0)) },
            cbFacadePanels: { value: STYLES.map(s => new THREE.Vector3(s.panelWidth || 0, s.rowsPerStorey || 0, 0)) }
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
uniform vec3 cbFacadeWalls[${STYLES.length}];
uniform vec3 cbFacadeTrims[${STYLES.length}];
uniform vec3 cbFacadeRoofs[${STYLES.length}];
uniform vec3 cbFacadeSettings[${STYLES.length}];
uniform vec3 cbFacadePanels[${STYLES.length}];
uniform vec3 cbFacadeDesign;
uniform vec3 cbFacadeBuilding;
uniform vec3 cbFacadeWindowStyles[3];
uniform vec3 cbFacadeWindows;
uniform vec3 cbFacadeShutterColor;
uniform vec3 cbFacadeGlassColor;
float cbFacadeGlazing = 0.0;
float cbFacadeBox(vec2 p, vec2 halfSize, vec2 aa) {
    vec2 edge = smoothstep(halfSize - aa, halfSize + aa, abs(p));
    return (1.0 - edge.x) * (1.0 - edge.y);
}
float cbFacadeNoise(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
// Area-preserving filtering keeps mortar and thin mullions from shimmering or widening
// when they become smaller than a pixel. Gap is the joint's fraction of one repeat.
float cbFacadeJointIntegral(float x, float gap) {
    float solid = 1.0 - gap;
    return floor(x) * solid + clamp(fract(x) - gap * 0.5, 0.0, solid);
}
float cbFacadeJointCoverage(float phase, float footprint, float gap) {
    float halfWidth = max(footprint, 0.00001) * 0.5;
    float center = fract(phase);
    return (cbFacadeJointIntegral(center + halfWidth, gap) - cbFacadeJointIntegral(center - halfWidth, gap)) / (2.0 * halfWidth);
}
vec3 cbFacadeCurtainWall(int style) {
    vec2 panels = cbFacadePanels[style].xy;
    float columns = max(1.0, floor(vCbFacade.z / panels.x + 0.5));
    vec2 size = vec2(vCbFacade.z / columns, cbFacadeBuilding.y / panels.y);
    vec2 grid = vCbFacade.xy / size;
    vec2 footprint = max(fwidth(grid), vec2(0.00001));
    vec2 gap = min(vec2(0.055, 0.065) / size, vec2(0.2));
    float pane = cbFacadeJointCoverage(grid.x, footprint.x, gap.x)
        * cbFacadeJointCoverage(grid.y, footprint.y, gap.y);
    cbFacadeGlazing = pane;
    float detail = 1.0 - smoothstep(0.35, 1.3, max(footprint.x, footprint.y));
    float variation = cbFacadeNoise(floor(grid) + vec2(cbFacadeBuilding.z, floor(vCbFacadeFace * 100.0)));
    // A restrained sky gradient and pane-to-pane reflectance keep the glazing legible.
    float sky = smoothstep(0.0, max(24.0, cbFacadeBuilding.x), vCbFacade.y);
    vec3 glass = cbFacadeGlassColor * cbFacadeDesign.z * mix(0.72, 1.2, sky);
    glass *= 1.0 + (variation - 0.5) * 0.06 * detail;
    return mix(cbFacadeTrims[style] * 0.65, glass, pane);
}
// An illustrative sky and skyline reflected in the surface normal. The reflection moves
// with the camera and strengthens at grazing angles; no scene capture or extra draw pass.
vec3 cbFacadeReflection(vec3 lit, vec3 viewDirection, vec3 surfaceNormal) {
    if (cbFacadeGlazing <= 0.0) return lit;
    vec3 ray = normalize(vec3(vec4(reflect(-viewDirection, surfaceNormal), 0.0) * viewMatrix));
    float elevation = ray.z;
    vec3 sky = mix(vec3(0.72, 0.82, 0.94), vec3(0.16, 0.38, 0.72), smoothstep(0.0, 0.8, elevation));
    float clouds = smoothstep(0.2, 0.8, sin(ray.x * 7.0 + sin(ray.y * 8.0)) * 0.25
        + sin(ray.y * 13.0 + ray.x * 4.0) * 0.15 + 0.5);
    sky = mix(sky, vec3(0.92, 0.95, 1.0), clouds * 0.55);
    float azimuth = atan(ray.y, ray.x) * 24.0;
    float skyline = -0.04 + cbFacadeNoise(vec2(floor(azimuth), 1.7)) * 0.18;
    float city = 1.0 - smoothstep(skyline - 0.015, skyline + 0.015, elevation);
    vec2 windows = vec2(azimuth * 5.0, elevation * 42.0);
    vec2 windowFootprint = max(fwidth(windows), vec2(0.0001));
    float reflectedWindows = cbFacadeJointCoverage(windows.x, windowFootprint.x, 0.16)
        * cbFacadeJointCoverage(windows.y, windowFootprint.y, 0.22);
    float towerTone = cbFacadeNoise(vec2(floor(azimuth), 4.1));
    vec3 buildings = mix(vec3(0.12, 0.16, 0.19), vec3(0.42, 0.52, 0.61), towerTone);
    buildings *= 0.58 + reflectedWindows * 0.62;
    vec3 environment = mix(sky, buildings, city);
    float fresnel = pow(1.0 - clamp(dot(viewDirection, surfaceNormal), 0.0, 1.0), 5.0);
    vec3 tint = mix(vec3(1.0), clamp(cbFacadeGlassColor * 2.0, 0.15, 1.0), 0.35);
    vec3 reflection = environment * tint;
    return mix(lit, mix(lit * 0.45, reflection, 0.58 + 0.36 * fresnel), cbFacadeGlazing);
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
    if (cbFacadePanels[style].x > 0.0) return cbFacadeCurtainWall(style);
    vec3 settings = cbFacadeSettings[style];
    vec3 trim = cbFacadeTrims[style];
    vec3 wall = cbFacadeWalls[style] * cbFacadeDesign.z;
    float width = vCbFacade.z;
    float height = cbFacadeBuilding.x;
    float floorHeight = cbFacadeBuilding.y;
    vec2 p = vCbFacade.xy;
    vec2 aa = max(fwidth(p), vec2(0.004));
    float detail = 1.0 - smoothstep(0.22, 0.9, max(aa.x, aa.y));

    // Measure the pixel footprint BEFORE the staggered row offset: derivatives across that
    // discontinuity otherwise stretch the mortar into alternating pale/dark strips.
    vec2 brick = vec2(p.x / 0.32, p.y / 0.105);
    vec2 brickFootprint = max(fwidth(brick), vec2(0.00001));
    brick.x += mod(floor(brick.y), 2.0) * 0.5;
    float brickCoverage = cbFacadeJointCoverage(brick.x, brickFootprint.x, 0.07)
        * cbFacadeJointCoverage(brick.y, brickFootprint.y, 0.07);
    float brickDetail = 1.0 - smoothstep(0.5, 2.0, max(brickFootprint.x, brickFootprint.y));
    vec3 mortar = trim * 0.84;
    vec3 brickColor = wall * (0.97 + 0.06 * cbFacadeNoise(floor(brick)));
    // Subpixel masonry fades to the same average colour, not bare brick with all mortar gone.
    vec3 averageMasonry = mix(mortar, wall, 0.93 * 0.93);
    brickColor = mix(mortar, brickColor, brickCoverage);
    wall = mix(wall, mix(averageMasonry, brickColor, brickDetail), settings.x);

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
    vec3 glazing = mix(vec3(0.16, 0.32, 0.42), vec3(0.29, 0.48, 0.58), windowVariation);
    glazing *= 0.88 + 0.20 * (opening.y / floorHeight + 0.5);
    float verticalBar = 1.0 - smoothstep(0.021, 0.021 + aa.x, abs(opening.x));
    float transomY = mix(abs(opening.y - windowSize.y * 0.45), abs(abs(opening.y) - windowSize.y / 3.0), sash);
    float transom = 1.0 - smoothstep(0.021, 0.021 + aa.y, transomY);
    glazing = mix(glazing, trim * 0.92, max(verticalBar, transom) * 0.85);
    wall = mix(wall, trim, surround * allowed);
    wall = mix(wall, trim * 0.52, reveal * allowed);
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
            || !shader.fragmentShader.includes('#include <color_fragment>')
            || !shader.fragmentShader.includes('#include <opaque_fragment>')) {
            throw new Error('Procedural facades require the Three.js building material shader chunks.');
        }
        shader.vertexShader = 'attribute vec3 cbFacadeCoord;\nvarying vec3 vCbFacade;\nvarying float vCbFacadeFace;\n' + shader.vertexShader.replace(
            '#include <begin_vertex>', '#include <begin_vertex>\nvCbFacade = cbFacadeCoord;\nvCbFacadeFace = dot(normal.xy, vec2(17.13, 47.71));');
        shader.fragmentShader = FRAGMENT_HEADER + shader.fragmentShader.replace(
            '#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = cbFacadeColor(diffuseColor.rgb);')
            .replace('#include <opaque_fragment>', 'outgoingLight = cbFacadeReflection(outgoingLight, normalize(vViewPosition), normal);\n#include <opaque_fragment>')
            .replace('#include <lights_phong_fragment>', '#include <lights_phong_fragment>\nmaterial.specularColor = mix(material.specularColor, vec3(0.7), cbFacadeGlazing);\nmaterial.specularShininess = mix(material.specularShininess, 180.0, cbFacadeGlazing);');
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
                cbFacadeShutterColor: { value: new THREE.Color(SHUTTER_COLORS[design.shutterColor]) },
                cbFacadeGlassColor: { value: new THREE.Color(GLASS_COLORS[design.glassColor]).multiplyScalar(design.glassTone) }
            });
            patchShader(shader);
        };
        material.customProgramCacheKey = () => priorKey + '|cb-facades-v6';
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

    return { STYLES, WINDOW_STYLES, SHUTTER_COLORS, GLASS_COLORS, buildingKey, buildingIdentityKey, buildingDesign, wallCoordinates, createState, setState, patchShader, configureMaterial, disposeGroup };
});
