/**
 * Building blocks (blocks of buildings) functionality.
 * 
 * This file contains the functionality for building blocks (blocks of buildings).
 * NOTE: this is not the same things as parcel blocks (blocks of parcels).
 * 
 * It includes the logic for creating blocks of buildings on top of parcels,
 * updating the blockify button, and showing the blockify modal.
 * 
 */

// Building blocks functionality
window.selectedBlockName = null;
let selectedBlockName = window.selectedBlockName;
// Add blockify modal variables
let blockifyMap = null;
let blockifyParcelLayer = null;
let blockifyBuildingLayer = null;
let generatedBuildingFeature = null;
// Default parameter values
const DEFAULT_SETBACK = 2; // meters
const DEFAULT_BUILDING_WIDTH = 10; // meters
const DEFAULT_BUILDING_HEIGHT = 12; // meters
let currentSetback = DEFAULT_SETBACK;
let currentBuildingWidth = DEFAULT_BUILDING_WIDTH;
let currentBuildingHeight = DEFAULT_BUILDING_HEIGHT;
let currentSmoothingRadius = 1.5; // meters
let livePreviewEnabled = false;
let blockifyBlock = null;

// --- 3D preview state ---
let blockify3D = {
    renderer: null,
    scene: null,
    camera: null,
    controls: null,
    frameId: null,
    container: null,
    originHTRS: null,
    parcelGroup: null,
    buildingGroup: null,
    resizeHandler: null
};

// Algorithm descriptions
const algorithmDescriptions = {
    "donji-grad": "Fully enclosed blocks with no gaps, courtyards in the middle.",
    "spansko-1": "Blocks enclosed from three sides, one side is open.",
    "stenjevec-1": "Rounded blocks with two gaps."
};

// --- Geometry utilities to improve robustness ---
const GEOM_BUFFER_STEPS = 16;
const GEOM_EPSILON_M = 0.1; // small clean-up buffer in meters

// Ensure polygon/multipolygon is simple, closed, proper winding and without duplicate points
function sanitizePolygonFeature(inputFeature) {
    if (!inputFeature) return null;
    try {
        let feature = inputFeature;
        // Standardize ring winding: outer CCW, inner CW
        try { feature = turf.rewind(feature, { reverse: false }); } catch (_) { }
        // Remove consecutive duplicate coordinates
        try { feature = turf.cleanCoords(feature, { mutate: false }); } catch (_) { }
        // Split self-intersections into simple pieces
        try {
            const unkinked = turf.unkinkPolygon(feature);
            if (unkinked && unkinked.features && unkinked.features.length > 0) {
                // Merge pieces via tiny buffer dissolve
                let dissolved = null;
                for (const f of unkinked.features) {
                    const fbuf = turf.buffer(f, GEOM_EPSILON_M, { units: 'meters', steps: GEOM_BUFFER_STEPS });
                    dissolved = dissolved ? (turf.union(dissolved, fbuf) || dissolved) : fbuf;
                }
                if (dissolved) {
                    // Remove the cleaning buffer
                    const unbuf = turf.buffer(dissolved, -GEOM_EPSILON_M, { units: 'meters', steps: GEOM_BUFFER_STEPS });
                    if (unbuf) feature = unbuf;
                }
            }
        } catch (_) { }
        return feature;
    } catch (e) {
        console.warn('sanitizePolygonFeature failed:', e);
        return inputFeature;
    }
}

// Robust negative buffer (inset). Performs incremental buffering in small steps to avoid topology collapses
function robustNegativeBuffer(feature, targetInsetMeters) {
    const step = Math.max(0.5, Math.min(2, targetInsetMeters / 5)); // 0.5–2m steps
    let remaining = targetInsetMeters;
    let current = feature;
    while (remaining > 1e-6) {
        const d = Math.min(step, remaining);
        try {
            const next = turf.buffer(current, -d, { units: 'meters', steps: GEOM_BUFFER_STEPS });
            if (!next || !next.geometry) return null;
            current = next;
            remaining -= d;
        } catch (e) {
            // Try tiny clean-up and retry once
            try {
                const cleaned = turf.buffer(current, GEOM_EPSILON_M, { units: 'meters', steps: GEOM_BUFFER_STEPS });
                const retried = turf.buffer(cleaned, -(d + GEOM_EPSILON_M), { units: 'meters', steps: GEOM_BUFFER_STEPS });
                if (!retried || !retried.geometry) return null;
                current = retried;
                remaining -= d;
            } catch (_) {
                return null;
            }
        }
    }
    return current;
}

// Union many polygons robustly with clean-up buffers
function robustUnion(features) {
    if (!features || features.length === 0) return null;
    let acc = null;
    for (const raw of features) {
        const f = sanitizePolygonFeature(raw);
        if (!f) continue;
        try {
            const fb = turf.buffer(f, GEOM_EPSILON_M, { units: 'meters', steps: GEOM_BUFFER_STEPS });
            acc = acc ? (turf.union(acc, fb) || acc) : fb;
        } catch (e) {
            // As a fallback, skip this piece
            console.warn('robustUnion: skipping one piece due to error', e);
        }
    }
    if (!acc) return null;
    // Remove the dissolve buffer
    try {
        const unbuf = turf.buffer(acc, -GEOM_EPSILON_M, { units: 'meters', steps: GEOM_BUFFER_STEPS });
        if (unbuf) acc = unbuf;
    } catch (_) { }
    return acc;
}

// Select the largest-area Polygon from a Polygon or MultiPolygon feature
function toSingleLargestPolygon(feature) {
    try {
        if (!feature || !feature.geometry) return null;
        if (feature.geometry.type === 'Polygon') return feature;
        if (feature.geometry.type !== 'MultiPolygon') return feature;
        const polys = feature.geometry.coordinates;
        let best = null;
        let bestArea = -Infinity;
        for (const rings of polys) {
            try {
                const polyFeat = turf.polygon(rings);
                const area = turf.area(polyFeat);
                if (area > bestArea) {
                    bestArea = area;
                    best = rings;
                }
            } catch (_) { }
        }
        if (!best) return null;
        return {
            type: 'Feature',
            properties: feature.properties || {},
            geometry: { type: 'Polygon', coordinates: best }
        };
    } catch (e) {
        console.warn('toSingleLargestPolygon failed:', e);
        return feature;
    }
}

// Morphological smoothing: fills slivers (close gaps) and removes spikes (open), then optional simplify
function smoothPolygonMorph(feature, radiusMeters) {
    try {
        if (!feature || radiusMeters <= 0) return feature;
        const steps = GEOM_BUFFER_STEPS;
        // Close tiny gaps/slivers
        let f = turf.buffer(feature, radiusMeters, { units: 'meters', steps });
        f = turf.buffer(f, -radiusMeters, { units: 'meters', steps });
        // Remove narrow spikes/notches
        f = turf.buffer(f, -radiusMeters, { units: 'meters', steps });
        f = turf.buffer(f, radiusMeters, { units: 'meters', steps });
        // Light simplify (post-smoothing) ~ about half of radius
        const tolDeg = Math.max(1e-6, radiusMeters * 0.5 / 111320); // rough meters→degrees for small tolerances
        try { f = turf.simplify(f, { tolerance: tolDeg, highQuality: true }); } catch (_) { }
        return f;
    } catch (e) {
        console.warn('smoothPolygonMorph failed:', e);
        return feature;
    }
}

// Compute minimum edge length (meters) for a polygon outer ring
function computeMinEdgeLengthMeters(coords) {
    let minLen = Infinity;
    let minPair = null;
    if (!coords || coords.length < 2) return { minLen, minPair };
    for (let i = 0; i < coords.length - 1; i++) {
        const p1 = coords[i];
        const p2 = coords[i + 1];
        try {
            const d = turf.distance(turf.point(p1), turf.point(p2), { units: 'meters' });
            if (d < minLen) {
                minLen = d;
                minPair = [p1, p2];
            }
        } catch (_) { }
    }
    return { minLen, minPair };
}

// Incrementally inset a polygon by applying multiple small negative buffers
function incrementalInsetPolygon(startFeature, targetInsetMeters, minEdgeMeters) {
    const result = {
        feature: null,
        achievedInset: 0,
        reason: 'ok', // ok | min_edge | invalid
        minEdgePair: null,
        minEdgeValue: null
    };
    if (!startFeature || targetInsetMeters <= 0) {
        result.feature = startFeature;
        return result;
    }

    const step = Math.max(0.25, Math.min(1.0, targetInsetMeters / 10));
    let remaining = targetInsetMeters;
    let current = toSingleLargestPolygon(startFeature) || startFeature;
    let lastValid = current;

    while (remaining > 1e-6) {
        const d = Math.min(step, remaining);
        let candidate = robustNegativeBuffer(current, d);
        candidate = toSingleLargestPolygon(candidate) || candidate;
        if (!candidate || !candidate.geometry || candidate.geometry.type !== 'Polygon') {
            result.reason = 'invalid';
            break;
        }
        const outer = candidate.geometry.coordinates[0];
        if (minEdgeMeters > 0) {
            const { minLen, minPair } = computeMinEdgeLengthMeters(outer);
            if (isFinite(minLen) && minLen < minEdgeMeters) {
                result.reason = 'min_edge';
                result.minEdgePair = minPair;
                result.minEdgeValue = minLen;
                break;
            }
        }
        // Accept this step
        lastValid = candidate;
        current = candidate;
        result.achievedInset += d;
        remaining -= d;
    }

    result.feature = lastValid;
    return result;
}

function updateBlockifyButton() {
    // Use the updateBlockButtonStates function in index.html to handle all button states
    if (typeof updateBlockButtonStates === 'function') {
        updateBlockButtonStates();
    } else {
        // Fallback if the function doesn't exist yet (to prevent errors during page load)
        const blockifyButton = document.getElementById('blockifyButton');
        const showBlocks = document.getElementById('parcelBlocksCheckbox').checked;
        blockifyButton.style.display = showBlocks && selectedBlockName ? 'inline-block' : 'none';
    }
}

// Function to show error popup
function showErrorPopup(message) {
    // Create modal container
    const modal = document.createElement('div');
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100%';
    modal.style.height = '100%';
    modal.style.backgroundColor = 'rgba(0,0,0,0.5)';
    modal.style.display = 'flex';
    modal.style.justifyContent = 'center';
    modal.style.alignItems = 'center';
    modal.style.zIndex = '2000';

    // Create modal content
    const modalContent = document.createElement('div');
    modalContent.style.backgroundColor = 'white';
    modalContent.style.padding = '20px';
    modalContent.style.borderRadius = '5px';
    modalContent.style.maxWidth = '400px';
    modalContent.style.textAlign = 'center';

    // Add message
    const messageElement = document.createElement('p');
    messageElement.textContent = message;
    messageElement.style.marginBottom = '20px';

    // Add OK button
    const okButton = document.createElement('button');
    okButton.textContent = 'OK';
    okButton.style.padding = '8px 16px';
    okButton.style.backgroundColor = '#007bff';
    okButton.style.color = 'white';
    okButton.style.border = 'none';
    okButton.style.borderRadius = '4px';
    okButton.style.cursor = 'pointer';
    okButton.onclick = function () {
        document.body.removeChild(modal);
    };

    // Assemble modal
    modalContent.appendChild(messageElement);
    modalContent.appendChild(okButton);
    modal.appendChild(modalContent);

    // Add to document
    document.body.appendChild(modal);
}

// Update the highlightBlock function to handle blockify button
const originalHighlightBlock = highlightBlock;
highlightBlock = function (blockName) {
    selectedBlockName = blockName;
    window.selectedBlockName = selectedBlockName;
    updateBlockifyButton();
    originalHighlightBlock(blockName);
};

// Update the toggleLayer function to handle blockify button
const originalToggleLayer = toggleLayer;
toggleLayer = function (layerType) {
    originalToggleLayer(layerType);
    if (layerType === 'blocks') {
        // updateBlockifyButton(); // This is now called by updateBlockButtonStates, which is called by toggleAccordion
    }
};

// Add these variables at the top with other layer variables
let proposedBuildingLayer = null;
let proposedBuildings = [];
let blockifyDebugLayer = null;

// --- 3D helper functions ---
function initBlockify3D(block) {
    console.log('[3D] initBlockify3D called', { block, THREE: typeof THREE });
    const container = document.getElementById('blockify-3d');
    console.log('[3D] container:', container, 'clientWidth:', container?.clientWidth, 'clientHeight:', container?.clientHeight);
    if (!container || typeof THREE === 'undefined') {
        console.warn('[3D] Cannot init: container or THREE missing', { container, THREE: typeof THREE });
        return;
    }

    // Reset
    if (blockify3D && blockify3D.renderer) {
        try { if (blockify3D.frameId) cancelAnimationFrame(blockify3D.frameId); } catch (_) { }
        try { if (blockify3D.controls && blockify3D.controls.dispose) blockify3D.controls.dispose(); } catch (_) { }
        try { if (blockify3D.renderer && blockify3D.renderer.dispose) blockify3D.renderer.dispose(); } catch (_) { }
    }

    const width = Math.max(1, container.clientWidth || 600);
    const height = Math.max(1, container.clientHeight || 300);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf8f9fa);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    camera.position.set(200, 200, 200);
    camera.up.set(0, 0, 1);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.innerHTML = '';
    container.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.style.cursor = 'grab';
    console.log('[3D] Renderer appended, canvas size:', renderer.domElement.width, 'x', renderer.domElement.height);

    const OrbitControlsCtor = (typeof THREE !== 'undefined' && THREE.OrbitControls)
        ? THREE.OrbitControls
        : (typeof window !== 'undefined' ? window.OrbitControls : null);
    if (!OrbitControlsCtor) {
        console.warn('OrbitControls missing; 3D will be static');
    }
    const controls = OrbitControlsCtor ? new OrbitControlsCtor(camera, renderer.domElement) : { update: () => { }, dispose: () => { } };
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;

    // Lights
    const amb = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(amb);
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(300, 300, 500);
    scene.add(dir);

    // Ground grid - GridHelper is naturally in XZ plane (Y-up), rotate to XY plane for Z-up
    const grid = new THREE.GridHelper(2000, 40, 0x999999, 0xbbbbbb);
    grid.rotation.x = Math.PI / 2; // Rotate to XY plane for Z-up system
    scene.add(grid);

    // Axes helper (X:red, Y:green, Z:blue) for visibility/debug
    const axes = new THREE.AxesHelper(100);
    scene.add(axes);

    const parcelGroup = new THREE.Group();
    const buildingGroup = new THREE.Group();
    scene.add(parcelGroup);
    scene.add(buildingGroup);

    // Compute origin in HTRS to keep coordinates small
    try {
        const allCoords = [];
        block.parcels.forEach(p => {
            const ring = p?.feature?.geometry?.coordinates?.[0];
            if (Array.isArray(ring)) ring.forEach(c => allCoords.push(c));
        });
        let sumX = 0, sumY = 0, count = 0;
        allCoords.forEach(([lng, lat]) => {
            const [x, y] = wgs84ToHTRS96(lat, lng);
            sumX += x; sumY += y; count += 1;
        });
        const origin = count > 0 ? [sumX / count, sumY / count] : [0, 0];
        blockify3D.originHTRS = origin;
    } catch (_) {
        blockify3D.originHTRS = [0, 0];
    }

    // Draw parcels footprint in 3D as flat shapes
    drawParcelsIn3D(parcelGroup, block);

    // Fit camera to parcels (FOV-aware)
    const bbox = new THREE.Box3().setFromObject(parcelGroup);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    console.log('[3D] BBox:', { size, center, parcelCount: block.parcels.length });
    controls.target.copy(center);
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const fov = camera.fov * (Math.PI / 180);
    const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.3;
    camera.near = Math.max(0.1, dist / 1000);
    camera.far = Math.max(10000, dist * 10);
    camera.updateProjectionMatrix();
    camera.position.set(center.x + dist, center.y + dist, center.z + dist);
    camera.lookAt(center);
    console.log('[3D] Camera positioned at:', camera.position, 'looking at:', center);

    function animate() {
        controls.update();
        renderer.render(scene, camera);
        blockify3D.frameId = requestAnimationFrame(animate);
    }
    animate();

    function handleResize() {
        if (!container) return;
        const w = container.clientWidth || width;
        const h = container.clientHeight || height;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    }
    window.addEventListener('resize', handleResize);

    blockify3D.renderer = renderer;
    blockify3D.scene = scene;
    blockify3D.camera = camera;
    blockify3D.controls = controls;
    blockify3D.container = container;
    blockify3D.parcelGroup = parcelGroup;
    blockify3D.buildingGroup = buildingGroup;
    blockify3D.resizeHandler = handleResize;
}

function drawParcelsIn3D(parcelGroup, block) {
    try {
        // Clear previous
        for (let i = parcelGroup.children.length - 1; i >= 0; i--) {
            const ch = parcelGroup.children[i];
            if (ch.geometry) ch.geometry.dispose();
            if (ch.material) ch.material.dispose();
            parcelGroup.remove(ch);
        }
        const origin = blockify3D.originHTRS || [0, 0];
        const material = new THREE.MeshLambertMaterial({ color: 0xcc6666, transparent: true, opacity: 0.35, depthWrite: false });
        const lineMaterial = new THREE.LineBasicMaterial({ color: 0xaa3333, linewidth: 1 });

        block.parcels.forEach(p => {
            const geom = p?.feature?.geometry;
            if (!geom || !Array.isArray(geom.coordinates)) return;
            const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates?.[0]?.[0];
            if (!Array.isArray(ring) || ring.length < 3) return;

            const shape = new THREE.Shape();
            ring.forEach(([lng, lat], idx) => {
                const [x, y] = wgs84ToHTRS96(lat, lng);
                const px = x - origin[0];
                const py = y - origin[1];
                if (idx === 0) shape.moveTo(px, py); else shape.lineTo(px, py);
            });
            const geom3 = new THREE.ShapeGeometry(shape);
            const mesh = new THREE.Mesh(geom3, material);
            parcelGroup.add(mesh);

            // Outline - parcels in XY plane at Z=0
            const points = ring.map(([lng, lat]) => {
                const [x, y] = wgs84ToHTRS96(lat, lng);
                return new THREE.Vector3(x - origin[0], y - origin[1], 0);
            });
            const closed = points[0] && points[points.length - 1] && !points[0].equals(points[points.length - 1])
                ? [...points, points[0].clone()] : points;
            const lineGeom = new THREE.BufferGeometry().setFromPoints(closed);
            const line = new THREE.Line(lineGeom, lineMaterial);
            parcelGroup.add(line);
        });
    } catch (e) {
        console.warn('drawParcelsIn3D failed', e);
    }
}

function updateBlockify3DScene(buildingFeature) {
    console.log('[3D] updateBlockify3DScene called', { buildingFeature, blockify3D });
    try {
        if (!blockify3D || !blockify3D.scene || !blockify3D.buildingGroup || typeof THREE === 'undefined') {
            console.warn('[3D] Cannot update scene: missing deps', {
                blockify3D: !!blockify3D,
                scene: !!blockify3D?.scene,
                buildingGroup: !!blockify3D?.buildingGroup,
                THREE: typeof THREE
            });
            return;
        }
        const origin = blockify3D.originHTRS || [0, 0];

        // Clear previous building meshes
        const group = blockify3D.buildingGroup;
        for (let i = group.children.length - 1; i >= 0; i--) {
            const ch = group.children[i];
            if (ch.geometry) ch.geometry.dispose();
            if (ch.material) ch.material.dispose();
            group.remove(ch);
        }

        const heightMeters = Math.max(3, Math.min(80, Math.round(currentBuildingHeight || DEFAULT_BUILDING_HEIGHT)));
        const mat = new THREE.MeshPhongMaterial({ color: 0x007bff, transparent: true, opacity: 0.9 });
        const edgeMat = new THREE.LineBasicMaterial({ color: 0x003f7f });

        const polygons = [];
        if (buildingFeature.geometry.type === 'Polygon') {
            polygons.push(buildingFeature.geometry.coordinates);
        } else if (buildingFeature.geometry.type === 'MultiPolygon') {
            buildingFeature.geometry.coordinates.forEach(poly => polygons.push(poly));
        } else if (buildingFeature.geometry.type === 'MultiLineString') {
            // Fallback: extrude a thin wall along lines if that ever happens
            buildingFeature.geometry.coordinates.forEach(line => {
                const shape = new THREE.Shape();
                line.forEach(([lng, lat], idx) => {
                    const [x, y] = wgs84ToHTRS96(lat, lng);
                    const px = x - origin[0];
                    const py = y - origin[1];
                    if (idx === 0) shape.moveTo(px, py); else shape.lineTo(px, py);
                });
                const extrudeGeom = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false, steps: 1 });
                const mesh = new THREE.Mesh(extrudeGeom, mat);
                group.add(mesh);
            });
        }

        polygons.forEach(rings => {
            const outer = rings[0];
            const shape = new THREE.Shape();
            outer.forEach(([lng, lat], idx) => {
                const [x, y] = wgs84ToHTRS96(lat, lng);
                const px = x - origin[0];
                const py = y - origin[1];
                if (idx === 0) shape.moveTo(px, py); else shape.lineTo(px, py);
            });
            // Holes
            for (let h = 1; h < rings.length; h++) {
                const holePath = new THREE.Path();
                const ring = rings[h];
                ring.forEach(([lng, lat], idx) => {
                    const [x, y] = wgs84ToHTRS96(lat, lng);
                    const px = x - origin[0];
                    const py = y - origin[1];
                    if (idx === 0) holePath.moveTo(px, py); else holePath.lineTo(px, py);
                });
                shape.holes.push(holePath);
            }

            // ExtrudeGeometry extrudes in the -Z direction by default
            // We want it to extrude in +Z (upward), so we need to handle the geometry orientation
            const extrudeSettings = {
                depth: heightMeters,
                bevelEnabled: false,
                steps: 1
            };
            const extrudeGeom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
            const mesh = new THREE.Mesh(extrudeGeom, mat);
            group.add(mesh);

            // Remove extra wireframe outline to avoid visual confusion
        });
    } catch (e) {
        console.warn('updateBlockify3DScene failed', e);
    }
}

// Load executed buildings from localStorage
function loadExecutedBuildingsFromStorage() {
    try {
        const stored = localStorage.getItem('executedBuildings');
        if (stored) {
            const executedBuildings = JSON.parse(stored);
            proposedBuildings.push(...executedBuildings);
            console.log(`Loaded ${executedBuildings.length} executed buildings from localStorage`);

            // If there are executed buildings and checkbox is checked, update the layer
            const showProposedBuildingsCheckbox = document.getElementById('showProposedBuildings');
            if (executedBuildings.length > 0 && showProposedBuildingsCheckbox && showProposedBuildingsCheckbox.checked) {
                // Use setTimeout to ensure map is ready
                setTimeout(() => {
                    updateProposedBuildingsLayer();
                }, 100);
            }
        }
    } catch (error) {
        console.error('Error loading executed buildings from localStorage:', error);
    }
}

// Save executed buildings to localStorage (only buildings from executed proposals)
function saveExecutedBuildingsToStorage() {
    try {
        const executedBuildings = proposedBuildings.filter(building =>
            building.properties && building.properties.type === 'executed_proposal'
        );
        localStorage.setItem('executedBuildings', JSON.stringify(executedBuildings));
        console.log(`Saved ${executedBuildings.length} executed buildings to localStorage`);
    } catch (error) {
        console.error('Error saving executed buildings to localStorage:', error);
    }
}

// Remove executed building by proposal hash
function removeExecutedBuildingByProposalHash(proposalHash) {
    const initialLength = proposedBuildings.length;
    proposedBuildings = proposedBuildings.filter(building =>
        !(building.properties && building.properties.proposalHash === proposalHash)
    );

    if (proposedBuildings.length < initialLength) {
        saveExecutedBuildingsToStorage();
        updateProposedBuildingsLayer();
        console.log(`Removed executed building for proposal ${proposalHash}`);
    }
}

// Load executed buildings on page load
loadExecutedBuildingsFromStorage();

// Add this function to update the proposed buildings layer
function updateProposedBuildingsLayer() {
    if (proposedBuildingLayer) {
        map.removeLayer(proposedBuildingLayer);
        proposedBuildingLayer = null;
    }

    if (proposedBuildings.length > 0) {
        proposedBuildingLayer = L.featureGroup().addTo(map);

        proposedBuildings.forEach((building, index) => {
            try {
                L.geoJSON(building, {
                    style: {
                        fillColor: '#ff3300',
                        fillOpacity: 0.4,
                        color: '#ff3300',
                        weight: 2
                    }
                }).addTo(proposedBuildingLayer);
            } catch (error) {
                console.error(`Error rendering proposed building at index ${index}:`, error, building);
                // Remove the faulty building from the array to prevent further errors
                proposedBuildings.splice(index, 1);
                // Show the popup to the user
                showErrorPopup('Building block creation failed -- Error rendering the generated building shape. The parcel might be too complex.');
                // Optionally, stop processing further buildings if one fails
                // return; // Uncomment this line if you want to stop after the first error
            }
        });
    }
}

// Function to show the blockify modal
function showBlockifyModal() {
    if (!selectedBlockName || !blockStorage.blocks.has(selectedBlockName)) {
        updateStatus('No block selected')
        return;
    }

    const block = blockStorage.blocks.get(selectedBlockName);
    if (!block.parcels.length) {
        updateStatus('Block has no parcels')
        return;
    }

    // Store the block globally for the modal
    blockifyBlock = block;

    console.log('[Blockify] showBlockifyModal called for block:', selectedBlockName, 'with', block.parcels.length, 'parcels');

    // Create modal elements
    if (!document.getElementById('blockify-modal')) {
        const modalDiv = document.createElement('div');
        modalDiv.id = 'blockify-modal';
        modalDiv.style.position = 'fixed';
        modalDiv.style.top = '0';
        modalDiv.style.left = '0';
        modalDiv.style.width = '100%';
        modalDiv.style.height = '100%';
        modalDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
        modalDiv.style.zIndex = '1000';
        modalDiv.style.display = 'flex';
        modalDiv.style.alignItems = 'center';
        modalDiv.style.justifyContent = 'center';

        const container = document.createElement('div');
        container.id = 'blockify-container';
        container.style.backgroundColor = 'white';
        container.style.padding = '0';
        container.style.borderRadius = '8px';
        container.style.maxWidth = '90%';
        container.style.maxHeight = '90%';
        container.style.display = 'flex';
        container.style.flexDirection = 'row';

        container.innerHTML = `
            <div id="blockify-main" style="flex: 1; display: flex; flex-direction: column; min-width: 0;">
                <div id="blockify-header">
                    <h2>Blockify - Block ${selectedBlockName}</h2>
                    <button id="blockify-close">×</button>
                </div>
                <div id="blockify-map"></div>
                <div id="blockify-3d"></div>
                <div id="blockify-controls">
                    <div id="blockify-info">Generating building...</div>
                    <div id="blockify-buttons">
                        <button class="btn btn-proposal" id="btn-create-proposal">Create Proposal</button>
                        <button class="blockify-button" id="btn-cancel">Cancel</button>
                    </div>
                </div>
            </div>
            <div id="blockify-sidebar">
                <div class="parameter-group">
                    <label for="algorithm-select">Algorithm:</label>
                    <select id="algorithm-select" disabled>
                        <option value="donji-grad" selected>Donji Grad</option>
                        <option value="spansko-1">Spansko 1</option>
                        <option value="stenjevec-1">Stenjevec 1</option>
                    </select>
                    <div id="algorithm-description" class="algorithm-description">
                        ${algorithmDescriptions["donji-grad"]}
                    </div>
                </div>
                <h3>Parameters</h3>
                <div class="parameter-group">
                    <label for="setback-slider">Setback (m): <span id="setback-value">${DEFAULT_SETBACK}</span></label>
                    <input type="range" id="setback-slider" min="0" max="50" value="${DEFAULT_SETBACK}" step="0.5">
                </div>
                <div class="parameter-group">
                    <label for="smoothing-slider">Smoothing radius (m): <span id="smoothing-value">1.5</span></label>
                    <input type="range" id="smoothing-slider" min="0" max="5" value="1.5" step="0.1">
                </div>
                <div class="parameter-group">
                    <label for="width-slider">Building Width (m): <span id="width-value">${DEFAULT_BUILDING_WIDTH}</span></label>
                    <input type="range" id="width-slider" min="1" max="100" value="${DEFAULT_BUILDING_WIDTH}" step="0.5">
                </div>
                <div class="parameter-group">
                    <label for="height-slider">Building Height (m): <span id="height-value">${DEFAULT_BUILDING_HEIGHT}</span></label>
                    <input type="range" id="height-slider" min="3" max="80" value="${DEFAULT_BUILDING_HEIGHT}" step="1">
                </div>
                <div class="parameter-group">
                    <label for="gaps-slider">Number of gaps: <span id="gaps-value">0</span></label>
                    <input type="range" id="gaps-slider" min="0" max="10" value="0" step="1" disabled>
                </div>
                <div class="parameter-group">
                    <label for="gap-width-slider">Gap width (m): <span id="gap-width-value">5</span></label>
                    <input type="range" id="gap-width-slider" min="1" max="20" value="5" step="1" disabled>
                </div>
                <div class="parameter-info">
                    <p>Adjust parameters using the sliders to modify the building shape.</p>
                    <p>Setback is the distance from the parcel boundary to the outer building edge.</p>
                    <p>Building width is the thickness of the building from outer to inner edge.</p>
                </div>
            </div>
        `;

        modalDiv.appendChild(container);
        document.body.appendChild(modalDiv);

        // Add event listeners
        document.getElementById('blockify-close').addEventListener('click', closeBlockifyModal);
        document.getElementById('btn-create-proposal').addEventListener('click', createProposalFromBlockify);
        document.getElementById('btn-cancel').addEventListener('click', closeBlockifyModal);

        // Add slider event listeners
        document.getElementById('setback-slider').addEventListener('input', function (e) {
            currentSetback = parseFloat(e.target.value);
            document.getElementById('setback-value').textContent = currentSetback.toFixed(1);
            generateBuildingInModal();
        });

        const smoothingSlider = document.getElementById('smoothing-slider');
        if (smoothingSlider) {
            smoothingSlider.addEventListener('input', function (e) {
                currentSmoothingRadius = parseFloat(e.target.value);
                document.getElementById('smoothing-value').textContent = currentSmoothingRadius.toFixed(1);
                generateBuildingInModal();
            });
        }

        document.getElementById('width-slider').addEventListener('input', function (e) {
            currentBuildingWidth = parseFloat(e.target.value);
            document.getElementById('width-value').textContent = currentBuildingWidth.toFixed(1);
            generateBuildingInModal();
        });

        const heightSlider = document.getElementById('height-slider');
        if (heightSlider) {
            heightSlider.addEventListener('input', function (e) {
                currentBuildingHeight = parseFloat(e.target.value);
                document.getElementById('height-value').textContent = currentBuildingHeight.toFixed(0);
                // Only affects 3D extrusion; regenerate 3D using the current geometry
                if (generatedBuildingFeature) {
                    updateBlockify3DScene(generatedBuildingFeature);
                }
            });
        }

        // Enable gap sliders
        const gapsSlider = document.getElementById('gaps-slider');
        const gapWidthSlider = document.getElementById('gap-width-slider');
        if (gapsSlider) {
            gapsSlider.disabled = false;
            gapsSlider.value = 0;
            document.getElementById('gaps-value').textContent = '0';
            gapsSlider.addEventListener('input', function (e) {
                document.getElementById('gaps-value').textContent = e.target.value;
                generateBuildingInModal();
            });
        }
        if (gapWidthSlider) {
            gapWidthSlider.disabled = false;
            gapWidthSlider.addEventListener('input', function (e) {
                document.getElementById('gap-width-value').textContent = e.target.value;
                generateBuildingInModal();
            });
        }

        // Close modal when clicking outside the container
        modalDiv.addEventListener('click', (e) => {
            if (e.target === modalDiv) {
                closeBlockifyModal();
            }
        });
        // Prevent the 3D canvas from being occluded by map interactions
        const threeDiv = document.getElementById('blockify-3d');
        if (threeDiv) {
            threeDiv.style.pointerEvents = 'auto';
            console.log('[Blockify] 3D div found and styled:', threeDiv);
        } else {
            console.warn('[Blockify] 3D div NOT found after modal creation');
        }
    }

    // Initialize the blockify map if needed
    if (!blockifyMap) {
        blockifyMap = L.map('blockify-map', {
            zoomControl: true,
            dragging: true,
            scrollWheelZoom: true
        });

        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap contributors'
        }).addTo(blockifyMap);
    }

    // Display the block on the map
    displayBlockOnMap(block);

    // Reset parameter values
    currentSetback = DEFAULT_SETBACK;
    currentBuildingWidth = DEFAULT_BUILDING_WIDTH;
    currentSmoothingRadius = 1.5;

    // Update sliders if they exist
    const setbackSlider = document.getElementById('setback-slider');
    const widthSlider = document.getElementById('width-slider');

    if (setbackSlider) {
        setbackSlider.value = currentSetback;
        document.getElementById('setback-value').textContent = currentSetback.toFixed(1);
    }
    const smoothingSlider = document.getElementById('smoothing-slider');
    if (smoothingSlider) {
        smoothingSlider.value = currentSmoothingRadius;
        document.getElementById('smoothing-value').textContent = currentSmoothingRadius.toFixed(1);
    }
    if (widthSlider) {
        widthSlider.value = currentBuildingWidth;
        document.getElementById('width-value').textContent = currentBuildingWidth.toFixed(1);
    }

    // Generate building immediately
    setTimeout(() => {
        generateBuildingInModal();
    }, 500); // Small delay to ensure the map is fully initialized
}

// Function to close the blockify modal
function closeBlockifyModal() {
    // Remove the map instance properly
    if (blockifyMap) {
        if (blockifyParcelLayer) {
            blockifyMap.removeLayer(blockifyParcelLayer);
            blockifyParcelLayer = null;
        }
        if (blockifyBuildingLayer) {
            blockifyMap.removeLayer(blockifyBuildingLayer);
            blockifyBuildingLayer = null;
        }
        blockifyMap.remove();
        blockifyMap = null;
    }

    // Clear the generated building
    generatedBuildingFeature = null;
    blockifyBlock = null;

    // Dispose 3D resources
    try {
        if (blockify3D && blockify3D.renderer) {
            if (blockify3D.frameId) cancelAnimationFrame(blockify3D.frameId);
            if (blockify3D.controls && blockify3D.controls.dispose) blockify3D.controls.dispose();
            if (blockify3D.renderer && blockify3D.renderer.dispose) blockify3D.renderer.dispose();
            if (blockify3D.resizeHandler) window.removeEventListener('resize', blockify3D.resizeHandler);
        }
        blockify3D = { renderer: null, scene: null, camera: null, controls: null, frameId: null, container: null, originHTRS: null, parcelGroup: null, buildingGroup: null, resizeHandler: null };
    } catch (_) { }

    // Remove the modal from DOM
    const modal = document.getElementById('blockify-modal');
    if (modal) {
        // Remove all event listeners
        const closeBtn = document.getElementById('blockify-close');
        const createProposalBtn = document.getElementById('btn-create-proposal');
        const cancelBtn = document.getElementById('btn-cancel');
        const setbackSlider = document.getElementById('setback-slider');
        const widthSlider = document.getElementById('width-slider');

        if (closeBtn) closeBtn.removeEventListener('click', closeBlockifyModal);
        if (createProposalBtn) createProposalBtn.removeEventListener('click', createProposalFromBlockify);
        if (cancelBtn) cancelBtn.removeEventListener('click', closeBlockifyModal);
        if (setbackSlider) setbackSlider.removeEventListener('input', null);
        if (widthSlider) widthSlider.removeEventListener('input', null);

        modal.removeEventListener('click', closeBlockifyModal);

        // Remove the modal
        modal.remove();
    }

    // Force a reflow of the main map
    if (map) {
        map.invalidateSize();
    }

    // Reset parameters to defaults
    currentSetback = DEFAULT_SETBACK;
    currentBuildingWidth = DEFAULT_BUILDING_WIDTH;
}

// Display the block on the blockify map
function displayBlockOnMap(block) {
    console.log('[Blockify] displayBlockOnMap called with block:', block);
    // Clear existing layers
    if (blockifyParcelLayer) {
        blockifyMap.removeLayer(blockifyParcelLayer);
        blockifyParcelLayer = null;
    }

    // Create a feature collection for all parcels in the block
    const features = block.parcels.map(parcel => parcel.feature);
    const featureCollection = {
        type: 'FeatureCollection',
        features: features
    };

    // Add the parcels to the map
    blockifyParcelLayer = L.geoJSON(featureCollection, {
        style: {
            fillColor: 'red',
            fillOpacity: 0.2,
            color: 'red',
            weight: 2
        }
    }).addTo(blockifyMap);

    // Fit the map to the bounds of the block
    blockifyMap.fitBounds(blockifyParcelLayer.getBounds(), {
        padding: [50, 50]
    });

    // Initialize 3D preview after map bounds fit
    try { initBlockify3D(block); } catch (e) { console.warn('3D init failed', e); }
}

// Function to generate building in the modal only
function generateBuildingInModal() {
    if (!selectedBlockName || !blockStorage.blocks.has(selectedBlockName)) {
        return;
    }

    const block = blockStorage.blocks.get(selectedBlockName);
    if (!block.parcels.length) {
        return;
    }

    // Update info text to show generating status
    const infoElement = document.getElementById('blockify-info');
    if (infoElement) {
        infoElement.textContent = "Generating building...";
    }

    try {
        // Ensure 3D is initialized (in case init earlier was skipped)
        try { if (!blockify3D || !blockify3D.renderer) initBlockify3D(block); } catch (_) { }

        // Clear previous debug overlays
        if (blockifyDebugLayer && blockifyMap) {
            blockifyMap.removeLayer(blockifyDebugLayer);
            blockifyDebugLayer = null;
        }
        // Create a superparcel by merging all parcels in the block (robust)
        console.log(`Creating superparcel from ${block.parcels.length} parcels`);
        const parcelFeatures = block.parcels.map(p => p.feature);
        let superparcel = robustUnion(parcelFeatures);

        if (!superparcel) {
            throw new Error('Failed to create superparcel');
        }

        // Sanitize and morphologically smooth the superparcel
        superparcel = sanitizePolygonFeature(superparcel) || superparcel;
        let smoothed = smoothPolygonMorph(superparcel, currentSmoothingRadius) || superparcel;
        smoothed = toSingleLargestPolygon(smoothed) || smoothed;
        if (!smoothed || !smoothed.geometry) {
            throw new Error('Failed to smooth superparcel');
        }

        // Calculate the maximum possible setback
        const area = turf.area(smoothed);
        let perimeter = turf.length(smoothed);
        const maxSetback = Math.sqrt(area / Math.PI) * 0.5; // Use 50% of the radius as max setback

        // Validate and adjust setback if needed
        let SETBACK = currentSetback;
        if (SETBACK > maxSetback) {
            SETBACK = maxSetback;
            // Update the slider and display value
            const setbackSlider = document.getElementById('setback-slider');
            if (setbackSlider) {
                setbackSlider.value = SETBACK;
                document.getElementById('setback-value').textContent = SETBACK.toFixed(1);
                currentSetback = SETBACK;
            }
        }

        // Create the outer building polygon (setback from superparcel) with robust negative buffer
        let outerBuilding = robustNegativeBuffer(smoothed, SETBACK);
        outerBuilding = toSingleLargestPolygon(outerBuilding) || outerBuilding;
        if (!outerBuilding || !outerBuilding.geometry) {
            throw new Error('Failed to create outer building polygon');
        }

        // Incrementally inset inner ring; keep last valid geometry even if a step fails the 2 m rule
        let innerBuilding = null;
        let currentWidth = currentBuildingWidth;
        let minSideLength = Infinity; // no longer enforces a threshold; kept only for diagnostic display
        let attempts = 0;
        const MAX_ATTEMPTS = 10;
        while (currentWidth > 0 && attempts < MAX_ATTEMPTS) {
            const inc = incrementalInsetPolygon(outerBuilding, currentWidth, 0);
            if (inc && inc.feature) {
                innerBuilding = inc.feature; // keep last valid
                if (inc.reason === 'ok' && Math.abs(inc.achievedInset - currentWidth) < 1e-3) {
                    // achieved full width cleanly
                    break;
                }
                // record min edge for debug
                if (isFinite(inc.minEdgeValue)) {
                    minSideLength = inc.minEdgeValue;
                }
                const debugMode = document.getElementById('debugModeCheckbox');
                if (debugMode && debugMode.checked && inc.minEdgePair) {
                    try {
                        const a = [inc.minEdgePair[0][1], inc.minEdgePair[0][0]];
                        const b = [inc.minEdgePair[1][1], inc.minEdgePair[1][0]];
                        blockifyDebugLayer = L.featureGroup().addTo(blockifyMap);
                        L.polyline([a, b], { color: '#ff0000', weight: 5, opacity: 0.8 }).addTo(blockifyDebugLayer)
                            .bindTooltip(`Narrow edge: ${(inc.minEdgeValue || 0).toFixed(2)} m`, { permanent: false });
                    } catch (_) { }
                }
            }
            if (inc && inc.reason === 'ok') {
                break;
            }
            // didn’t achieve full width → reduce and retry
            currentWidth *= 0.9;
            attempts++;
        }

        if (!innerBuilding) {
            // Fallback: produce a solid building (no courtyard) rather than failing
            console.warn('Inner courtyard collapsed; producing solid building polygon');
            const solidFeature = toSingleLargestPolygon(outerBuilding) || outerBuilding;
            const outerCoordsOnly = solidFeature.geometry.coordinates[0];
            const buildingFeature = {
                type: 'Feature',
                properties: {
                    type: 'proposedBuilding',
                    width: 0,
                    setback: SETBACK,
                    block: selectedBlockName,
                    minSideLength: 0,
                    height: Math.round(currentBuildingHeight || DEFAULT_BUILDING_HEIGHT),
                    numGaps: 0,
                    gapWidth: 0,
                    note: 'Inner courtyard omitted due to narrow geometry'
                },
                geometry: {
                    type: 'Polygon',
                    coordinates: [outerCoordsOnly]
                }
            };
            generatedBuildingFeature = buildingFeature;
            displayBuildingInModal(buildingFeature);
            const infoEl = document.getElementById('blockify-info');
            if (infoEl) {
                infoEl.textContent = `Building generated (solid; setback: ${SETBACK.toFixed(1)}m). Courtyard omitted because inner offset split or produced edges < 2.0 m. Try decreasing width or increasing smoothing radius.`;
            }
            const createProposalButton = document.getElementById('btn-create-proposal');
            if (createProposalButton) createProposalButton.disabled = false;
            return;
        }

        // If we had to reduce the width significantly, show a warning
        if (currentWidth < currentBuildingWidth * 0.5) {
            console.warn(`Building width was reduced from ${currentBuildingWidth}m to ${currentWidth}m to maintain minimum side length of 2m`);
        }

        // Get gap parameters
        const gapsSlider = document.getElementById('gaps-slider');
        const gapWidthSlider = document.getElementById('gap-width-slider');
        const numGaps = gapsSlider ? parseInt(gapsSlider.value) : 0;
        const gapWidth = gapWidthSlider ? parseFloat(gapWidthSlider.value) : 0; // in meters
        const outerCoords = outerBuilding.geometry.coordinates[0];
        const innerCoords = innerBuilding.geometry.coordinates[0].reverse();
        let buildingFeature;
        if (numGaps === 0) {
            // Default: closed polygon with hole
            buildingFeature = {
                type: 'Feature',
                properties: {
                    type: 'proposedBuilding',
                    width: currentWidth,
                    setback: SETBACK,
                    block: selectedBlockName,
                    minSideLength: minSideLength,
                    height: Math.round(currentBuildingHeight || DEFAULT_BUILDING_HEIGHT),
                    numGaps,
                    gapWidth
                },
                geometry: {
                    type: 'Polygon',
                    coordinates: [outerCoords, innerCoords]
                }
            };
        } else {
            // N gaps: split the ring into N bars, each separated by gapWidth
            // Compute perimeter of outer ring
            let perimeter = 0;
            const cumDist = [0];
            for (let i = 0; i < outerCoords.length - 1; i++) {
                const segLen = turf.distance(turf.point(outerCoords[i]), turf.point(outerCoords[i + 1]), { units: 'meters' });
                perimeter += segLen;
                cumDist.push(perimeter);
            }
            // Compute bar length for each bar
            const totalGap = numGaps * gapWidth;
            const barLen = (perimeter - totalGap) / numGaps;
            // For each bar, find start and end positions
            let barStarts = [];
            let pos = 0;
            for (let g = 0; g < numGaps; g++) {
                barStarts.push(pos);
                pos += barLen + gapWidth;
            }
            // Helper to get points along a path between two distances
            function getPointsBetween(cumDist, coords, startDist, endDist) {
                let pts = [];
                for (let i = 0; i < cumDist.length - 1; i++) {
                    if (cumDist[i] >= endDist) break;
                    if (cumDist[i + 1] <= startDist) continue;
                    // If segment crosses startDist, interpolate
                    if (cumDist[i] < startDist && cumDist[i + 1] > startDist) {
                        const t = (startDist - cumDist[i]) / (cumDist[i + 1] - cumDist[i]);
                        pts.push([
                            coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
                            coords[i][1] + t * (coords[i + 1][1] - coords[i][1])
                        ]);
                    }
                    // Add the point if within the bar
                    if (cumDist[i] >= startDist && cumDist[i] < endDist) {
                        pts.push(coords[i]);
                    }
                    // If segment crosses endDist, interpolate
                    if (cumDist[i] < endDist && cumDist[i + 1] > endDist) {
                        const t = (endDist - cumDist[i]) / (cumDist[i + 1] - cumDist[i]);
                        pts.push([
                            coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
                            coords[i][1] + t * (coords[i + 1][1] - coords[i][1])
                        ]);
                    }
                }
                return pts;
            }
            // For each bar, collect points along the outer ring
            const multiPolygons = [];
            for (let g = 0; g < numGaps; g++) {
                const startDist = barStarts[g];
                const endDist = startDist + barLen;
                // Outer bar
                const outerBar = getPointsBetween(cumDist, outerCoords, startDist, endDist);
                // For each point on the outer bar, offset inward by building width to get the inner bar
                // We'll use Turf's lineOffset for this
                let outerLine = turf.lineString(outerBar);
                let innerLine;
                try {
                    innerLine = turf.lineOffset(outerLine, -currentBuildingWidth, { units: 'meters' });
                } catch (e) {
                    // Fallback: use the inner ring segment that matches the bar
                    // Find proportional start/end on inner ring
                    let innerPerimeter = 0;
                    const innerCumDist = [0];
                    for (let i = 0; i < innerCoords.length - 1; i++) {
                        const segLen = turf.distance(turf.point(innerCoords[i]), turf.point(innerCoords[i + 1]), { units: 'meters' });
                        innerPerimeter += segLen;
                        innerCumDist.push(innerPerimeter);
                    }
                    const innerStartDist = (startDist / perimeter) * innerPerimeter;
                    const innerEndDist = (endDist / perimeter) * innerPerimeter;
                    let innerBar = getPointsBetween(innerCumDist, innerCoords, innerStartDist, innerEndDist);
                    innerLine = turf.lineString(innerBar);
                }
                let innerBarCoords = innerLine.geometry.coordinates;
                // Reverse inner bar to close the polygon
                innerBarCoords = innerBarCoords.reverse();
                // Build polygon: outerBar, innerBar, close
                let poly = [];
                poly = poly.concat(outerBar);
                poly = poly.concat(innerBarCoords);
                if (poly.length > 0 && (poly[0][0] !== poly[poly.length - 1][0] || poly[0][1] !== poly[poly.length - 1][1])) {
                    poly.push(poly[0]);
                }
                multiPolygons.push([poly]);
            }
            buildingFeature = {
                type: 'Feature',
                properties: {
                    type: 'proposedBuilding',
                    width: currentWidth,
                    setback: SETBACK,
                    block: selectedBlockName,
                    minSideLength: minSideLength,
                    numGaps,
                    gapWidth
                },
                geometry: {
                    type: 'MultiPolygon',
                    coordinates: multiPolygons
                }
            };
        }
        generatedBuildingFeature = buildingFeature;
        displayBuildingInModal(buildingFeature);

        // Update the sliders to reflect the actual values used
        const setbackSlider = document.getElementById('setback-slider');
        const widthSlider = document.getElementById('width-slider');

        if (setbackSlider) {
            // Only update if the value is different to avoid triggering another regeneration
            if (Math.abs(parseFloat(setbackSlider.value) - SETBACK) > 0.01) {
                // Temporarily remove the event listener
                const oldSetbackListener = setbackSlider.onchange;
                setbackSlider.onchange = null;

                setbackSlider.value = SETBACK;
                document.getElementById('setback-value').textContent = SETBACK.toFixed(1);
                currentSetback = SETBACK;

                // Restore the event listener
                setTimeout(() => {
                    setbackSlider.onchange = oldSetbackListener;
                }, 10);
            }
        }

        if (widthSlider) {
            // Only update if the value is different to avoid triggering another regeneration
            if (Math.abs(parseFloat(widthSlider.value) - currentWidth) > 0.01) {
                // Temporarily remove the event listener
                const oldWidthListener = widthSlider.onchange;
                widthSlider.onchange = null;

                widthSlider.value = currentWidth;
                document.getElementById('width-value').textContent = currentWidth.toFixed(1);
                currentBuildingWidth = currentWidth;

                // Restore the event listener
                setTimeout(() => {
                    widthSlider.onchange = oldWidthListener;
                }, 10);
            }
        }

        // Update the info text
        document.getElementById('blockify-info').textContent =
            `Building generated (width: ${currentWidth.toFixed(1)}m, height: ${Math.round(currentBuildingHeight).toFixed(0)}m, setback: ${SETBACK.toFixed(1)}m)`;

        // Enable the create proposal button
        const createProposalButton = document.getElementById('btn-create-proposal');
        if (createProposalButton) {
            createProposalButton.disabled = false;
        }

    } catch (error) {
        console.error('Error creating building block:', error);
        document.getElementById('blockify-info').textContent = `Error: ${error.message}`;

        // Only show error popup for algorithmic failures, not for slider validation
        if (!error.message.includes('Failed to create outer building polygon')) {
            showErrorPopup('Building block creation failed -- perhaps the parcel is too complex. Consider breaking it up with roads or try a different blockification algorithm.');
        }

        // Disable create proposal button if there was an error
        const createProposalButton = document.getElementById('btn-create-proposal');
        if (createProposalButton) {
            createProposalButton.disabled = true;
        }
    }
}

// Function to display the building in the modal map
function displayBuildingInModal(buildingFeature) {
    if (blockifyBuildingLayer) {
        blockifyMap.removeLayer(blockifyBuildingLayer);
        blockifyBuildingLayer = null;
    }
    if (!buildingFeature) return;
    if (buildingFeature.geometry.type === 'MultiLineString' || buildingFeature.geometry.type === 'MultiPolygon' || buildingFeature.geometry.type === 'Polygon') {
        blockifyBuildingLayer = L.geoJSON(buildingFeature, {
            style: {
                color: '#007bff',
                weight: 4,
                opacity: 1,
                fillOpacity: 0.2
            }
        }).addTo(blockifyMap);
        try { updateBlockify3DScene(buildingFeature); } catch (e) { console.warn('3D update failed', e); }
    }
}

// Function to apply the building to the main map
function applyBuildingToMap() {
    if (generatedBuildingFeature) {
        // Add the building to the proposed buildings array
        proposedBuildings.push(generatedBuildingFeature);

        // Update the proposed buildings layer
        updateProposedBuildingsLayer();

        // Show proposed buildings layer
        document.getElementById('showProposedBuildings').checked = true;

        updateStatus(`Created proposed building block in parcel block ${selectedBlockName} (width: ${generatedBuildingFeature.properties.width.toFixed(1)}m, setback: ${generatedBuildingFeature.properties.setback.toFixed(1)}m)`)
        // Close the modal
        closeBlockifyModal();
    } else {
        // Show error message if no building has been generated
        document.getElementById('blockify-info').textContent = "No building generated yet. Please try regenerating.";
    }
}

// Replace the existing generateBuilding function
function generateBuilding() {
    // This function is deprecated, using generateBuildingInModal instead
    generateBuildingInModal();
}

// Update the blockifySelectedBlock function to show modal
function blockifySelectedBlock() {
    if (!selectedBlockName) {
        console.warn('No block selected for building block placement');
        updateStatus('No block selected');
        return;
    }

    const block = blockStorage.blocks.get(selectedBlockName);
    if (!block || !block.parcels || block.parcels.length === 0) {
        console.warn('Selected block has no parcels');
        updateStatus('Block has no parcels');
        return;
    }

    console.log('Blockify selected block');
    showBlockifyModal();
}

// Function to create proposal from blockify modal
function createProposalFromBlockify() {
    console.log('createProposalFromBlockify called');
    console.log('generatedBuildingFeature:', generatedBuildingFeature);
    console.log('selectedBlockName:', selectedBlockName);

    if (!generatedBuildingFeature) {
        document.getElementById('blockify-info').textContent = "No building generated yet. Please try regenerating.";
        return;
    }

    if (!selectedBlockName) {
        document.getElementById('blockify-info').textContent = "No block selected.";
        return;
    }

    // Get the block to access its parcels
    const block = blockStorage.blocks.get(selectedBlockName);
    console.log('Block:', block);
    if (!block || !block.parcels || block.parcels.length === 0) {
        document.getElementById('blockify-info').textContent = "Block has no parcels.";
        return;
    }

    // Clear any existing selections and set up multi-parcel selection for the block
    if (typeof multiParcelSelection !== 'undefined') {
        console.log('multiParcelSelection available, clearing selection');
        multiParcelSelection.clearSelection();

        // Select all parcels in the block
        block.parcels.forEach(parcel => {
            const parcelId = parcel.feature?.properties?.CESTICA_ID;
            console.log('Processing parcel with CESTICA_ID:', parcelId);
            if (parcelId) {
                multiParcelSelection.selectedParcels.add(parcelId.toString());
                console.log('Added parcel to selection:', parcelId.toString());
            }
        });
        console.log('Final selection size:', multiParcelSelection.selectedParcels.size);
    } else {
        console.error('multiParcelSelection not available');
    }

    // Store the building feature to apply it after proposal creation
    window.pendingBuildingFromBlockify = generatedBuildingFeature;

    // Show the proposal dialog with pre-filled data (keep blockify modal open)
    console.log('About to call showProposalDialogForBlockify');
    showProposalDialogForBlockify(selectedBlockName);
}

// Function to show proposal dialog with pre-filled data for blockify
function showProposalDialogForBlockify(blockName) {
    console.log('showProposalDialogForBlockify called with blockName:', blockName);
    console.log('showProposalDialog function available:', typeof showProposalDialog === 'function');

    // First call the regular showProposalDialog to set up the basic structure
    if (typeof showProposalDialog === 'function') {
        console.log('Calling showProposalDialog...');
        showProposalDialog();

        // After the dialog is created, pre-fill the specific data
        setTimeout(() => {
            const proposalTypeSelect = document.getElementById('proposalType');
            const descriptionTextarea = document.getElementById('proposalDescription');

            if (proposalTypeSelect) {
                proposalTypeSelect.value = 'Residences';
            }

            if (descriptionTextarea) {
                descriptionTextarea.value = `Proposal for urban rule for Block ${blockName}`;
            }

            // Replace the create proposal button's onclick to handle building application
            const createButton = document.querySelector('.proposal-modal-footer .btn-proposal');
            if (createButton) {
                // Remove the existing onclick
                createButton.removeAttribute('onclick');

                // Add new event listener
                createButton.addEventListener('click', createProposalWithBuilding);
            }

            // Replace the cancel button to not close blockify modal
            const cancelButton = document.querySelector('.proposal-modal-footer .btn-secondary');
            if (cancelButton) {
                // Remove the existing onclick
                cancelButton.removeAttribute('onclick');

                // Add new event listener that only closes the proposal dialog
                cancelButton.addEventListener('click', function () {
                    if (typeof closeProposalDialog === 'function') {
                        closeProposalDialog();
                    }
                    // Don't close blockify modal - user can continue adjusting building
                });
            }

            // Replace the X button to not close blockify modal
            const closeXButton = document.querySelector('.proposal-modal-close');
            if (closeXButton) {
                // Remove the existing onclick
                closeXButton.removeAttribute('onclick');

                // Add new event listener that only closes the proposal dialog
                closeXButton.addEventListener('click', function () {
                    if (typeof closeProposalDialog === 'function') {
                        closeProposalDialog();
                    }
                    // Don't close blockify modal - user can continue adjusting building
                });
            }
        }, 100);
    }
}

// Function to create proposal and apply building
function createProposalWithBuilding() {
    const author = document.getElementById('proposalAuthor').value.trim();
    const proposalType = document.getElementById('proposalType').value;
    const description = document.getElementById('proposalDescription').value.trim();
    const offer = parseFloat(document.getElementById('proposalOffer').value) || 0;

    // Validation
    if (!author) {
        alert('Please enter an author name.');
        return;
    }
    if (!proposalType) {
        alert('Please select a proposal type.');
        return;
    }
    if (!description) {
        alert('Please enter a description.');
        return;
    }
    if (offer <= 0) {
        alert('Please enter a valid offer amount.');
        return;
    }

    try {
        // Get the parcelIds that were set up in createProposalFromBlockify
        let finalParcelIds = [];

        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.selectedParcels.size > 0) {
            finalParcelIds = Array.from(multiParcelSelection.selectedParcels);
        }

        if (finalParcelIds.length === 0) {
            alert('No parcels selected. Please select parcels before creating a proposal.');
            return;
        }

        const proposal = {
            author,
            title: proposalType,
            description,
            offer,
            parcelIds: finalParcelIds,
            type: 'parcel',
            buildingGeometry: window.pendingBuildingFromBlockify ? window.pendingBuildingFromBlockify.geometry : null
        };

        // Create the proposal
        const hash = proposalStorage.addProposal(proposal);

        // Enable show proposals mode and clear multi-selection
        if (typeof enableShowProposalsMode === 'function') {
            enableShowProposalsMode();
        } else {
            // Fallback if helper function not available
            const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
            if (showProposalsCheckbox && !showProposalsCheckbox.checked) {
                showProposalsCheckbox.checked = true;
            }
            // Update proposal layer
            updateProposalLayer();
        }

        // Apply the building to the map (what the old "Apply to Map" button did)
        if (window.pendingBuildingFromBlockify) {
            // Add the building to the proposed buildings array
            proposedBuildings.push(window.pendingBuildingFromBlockify);

            // Update the proposed buildings layer
            updateProposedBuildingsLayer();

            // Show proposed buildings layer
            const showProposedBuildingsCheckbox = document.getElementById('showProposedBuildings');
            if (showProposedBuildingsCheckbox) {
                showProposedBuildingsCheckbox.checked = true;
            }

            // Clear the pending building
            window.pendingBuildingFromBlockify = null;
        }

        // Clear selection
        if (typeof multiParcelSelection !== 'undefined') {
            multiParcelSelection.clearSelection();
        }
        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        }

        // Close both dialogs (proposal first, then blockify)
        if (typeof closeProposalDialog === 'function') {
            closeProposalDialog();
        }

        // Close the blockify modal now that proposal was created
        closeBlockifyModal();

        // Update proposal list if open
        if (typeof updateProposalList === 'function') {
            updateProposalList();
        }

        updateStatus(`Proposal "${proposalType}" created successfully with building applied to map.`);

    } catch (error) {
        alert(error.message);
    }
}
