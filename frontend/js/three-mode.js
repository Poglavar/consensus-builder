// Three.js 3D Map Mode Overlay for Leaflet map
// - Renders parcels and roads as flat geometry
// - Renders buildings as extruded volumes (default 10m if unknown)
// - Provides tilt-in animation and OrbitControls

(function () {
    if (typeof THREE === 'undefined') {
        console.warn('[3D] THREE.js not available. Skipping 3D mode initialization.');
        return;
    }

    // Internal state
    let isActive = false;
    let scene = null;
    let camera = null;
    let renderer = null;
    let controls = null;
    let frameId = null;
    let origin3857 = null; // Leaflet EPSG:3857 origin for local XY
    let renderingOverlayEl = null; // transient overlay while 3D initializes
    let isTransitioning3D = false; // avoid double-activation

    // URL-driven entry: optionally start a gentle camera rotation until the user interacts.
    const INTRO_AUTO_ROTATE_SPEED = 0.7; // OrbitControls: ~86s per revolution (1.0 ≈ 60s)
    const INTRO_MANUAL_AUTO_ROTATE_RAD_PER_SEC = 0.18; // fallback if OrbitControls is missing
    const ORIGIN = new THREE.Vector3(0, 0, 0);
    let pendingIntroAutoRotate = false;
    let introAutoRotateCleanup = null;
    let manualAutoRotateActive = false;
    let manualAutoRotateLastTs = 0;

    // Groups for layers
    let flatGroup = null; // parcels + roads + park ground
    let buildingGroup = null; // buildings extrusion
    let parkGroup = null; // park decorations (trees)
    let squareGroup = null; // square decorations (fountains, stalls)
    let lakeGroup = null; // lake decorations (fish)

    // Checkbox listeners to sync 3D buildings with sidebar
    let onShowExistingBuildingsChange = null;
    let onShowProposedBuildingsChange = null;

    const threeContainer = document.getElementById('three-container');
    const toggleBtn = document.getElementById('mode-3d-toggle');

    // Basic materials
    const materials = {
        parcels: new THREE.MeshLambertMaterial({ color: 0xdddddd, emissive: 0x000000 }),
        parcelEdges: new THREE.LineBasicMaterial({ color: 0x999999, linewidth: 1 }),
        roads: new THREE.MeshLambertMaterial({ color: 0xb0b0b0, emissive: 0x000000 }),
        roadLines: new THREE.LineBasicMaterial({ color: 0x666666, linewidth: 1 }),
        buildings: new THREE.MeshPhongMaterial({ color: 0x9aa4ad, specular: 0x333333, shininess: 20, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
        sliceEdges: new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 })
    };

    // Scale factor to control how close the camera is vs top-down fit distance
    const CAMERA_DISTANCE_SCALE = 0.25; // closer (25% of top-down fit distance)

    function getOrigin3857() {
        // Use map center projected to EPSG:3857 to produce small local XY coordinates
        const center = (typeof map !== 'undefined' && map) ? map.getCenter() : { lat: 0, lng: 0 };
        const p = L.CRS.EPSG3857.project(L.latLng(center.lat, center.lng));
        return p; // {x,y}
    }

    function latLngToXY(lat, lng) {
        const p = L.CRS.EPSG3857.project(L.latLng(lat, lng));
        return [p.x - origin3857.x, p.y - origin3857.y];
    }

    function coordsToXY(coords) {
        // coords: [lng, lat]
        return latLngToXY(coords[1], coords[0]);
    }

    function arrayOfLngLatRingsToShape(rings) {
        // rings: [ [ [lng, lat], ... ], hole1, hole2, ...]
        if (!rings || rings.length === 0) return null;
        const toVec2 = (pt) => {
            const xy = coordsToXY(pt);
            return new THREE.Vector2(xy[0], xy[1]);
        };

        const outer = rings[0].map(toVec2);
        const shape = new THREE.Shape(outer);
        for (let i = 1; i < rings.length; i++) {
            const holePath = new THREE.Path(rings[i].map(toVec2));
            shape.holes.push(holePath);
        }
        return shape;
    }

    function polygonFeatureToMeshes(feature, material, z = 0, depth = 0) {
        // Returns array of THREE.Mesh (flat if depth=0, extruded if depth>0)
        const meshes = [];
        const geom = feature.geometry;
        if (!geom) return meshes;

        const addShape = (rings) => {
            const shape = arrayOfLngLatRingsToShape(rings);
            if (!shape) return;
            let geometry;
            if (depth > 0) {
                geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
            } else {
                geometry = new THREE.ShapeGeometry(shape);
            }
            geometry.translate(0, 0, z);
            const mesh = new THREE.Mesh(geometry, material);
            meshes.push(mesh);
        };

        if (geom.type === 'Polygon') {
            addShape(geom.coordinates);
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates.forEach(addShape);
        }
        return meshes;
    }

    function polygonFeatureToBorderLines(feature, material, z = 0.01) {
        // Returns array of THREE.LineLoop objects for each polygon ring
        const lines = [];
        const geom = feature.geometry;
        if (!geom) return lines;

        const addRingLines = (rings) => {
            if (!rings || rings.length === 0) return;
            rings.forEach((ring) => {
                const points = ring.map((pt) => {
                    const xy = coordsToXY(pt);
                    return new THREE.Vector3(xy[0], xy[1], z);
                });
                const g = new THREE.BufferGeometry().setFromPoints(points);
                const loop = new THREE.LineLoop(g, material);
                lines.push(loop);
            });
        };

        if (geom.type === 'Polygon') {
            addRingLines(geom.coordinates);
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates.forEach(addRingLines);
        }
        return lines;
    }

    function lineFeatureToLine(feature, material, z = 0) {
        const geom = feature.geometry;
        if (!geom) return null;

        const toLine = (coords) => {
            const points = coords.map(c => {
                const xy = coordsToXY(c);
                return new THREE.Vector3(xy[0], xy[1], z);
            });
            const g = new THREE.BufferGeometry().setFromPoints(points);
            return new THREE.Line(g, material);
        };

        if (geom.type === 'LineString') {
            return toLine(geom.coordinates);
        }
        if (geom.type === 'MultiLineString') {
            const group = new THREE.Group();
            geom.coordinates.forEach(coords => {
                const line = toLine(coords);
                if (line) group.add(line);
            });
            return group;
        }
        return null;
    }

    function buildParks3D(flatTarget, decoTarget) {
        const parks = (typeof window !== 'undefined' && Array.isArray(window.parks)) ? window.parks : [];
        if (!parks || parks.length === 0) return;
        // Use polygonOffset to float slightly over base to avoid z-fighting and flicker
        const grassMat = new THREE.MeshLambertMaterial({ color: 0x1b5e20, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6d4c41 });
        const treeMat = new THREE.MeshLambertMaterial({ color: 0x2e7d32 });
        const waterMat = new THREE.MeshPhongMaterial({ color: 0x2b6cb0, specular: 0x1f3a60, shininess: 40, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
        const pathLineMat = new THREE.LineBasicMaterial({ color: 0xdfe8d6, depthTest: false });

        parks.forEach(p => {
            try {
                if (!p || !p.geometry) return;
                // Ground at slight z offset
                const groundMeshes = polygonFeatureToMeshes(p, grassMat, 0.06, 0);
                groundMeshes.forEach(m => { m.userData.isParkGround = true; flatTarget.add(m); });

                // Draw ponds (slightly above ground)
                const deco = (p.properties && p.properties.decorations) ? p.properties.decorations : null;
                if (deco && Array.isArray(deco.ponds)) {
                    deco.ponds.forEach(ring => {
                        try {
                            const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
                            const waterMeshes = polygonFeatureToMeshes(feature, waterMat, 0.065, 0);
                            waterMeshes.forEach(m => flatTarget.add(m));
                        } catch (_) { }
                    });
                }

                // Draw footpaths as lines above ground (ensure visible over ponds/ground)
                if (deco && Array.isArray(deco.paths)) {
                    deco.paths.forEach(pathCoords => {
                        try {
                            const feature = { type: 'Feature', geometry: { type: 'LineString', coordinates: pathCoords }, properties: {} };
                            const line = lineFeatureToLine(feature, pathLineMat, 0.075);
                            if (line) {
                                // Elevate and ensure render on top
                                line.renderOrder = 9999;
                                if (line.material) { line.material.depthTest = false; }
                                // If it's a Group (MultiLineString), apply to children
                                if (line.isGroup) {
                                    line.traverse(obj => {
                                        if (obj.isLine) {
                                            obj.renderOrder = 9999;
                                            if (obj.material) obj.material.depthTest = false;
                                        }
                                    });
                                }
                                decoTarget.add(line);
                            }
                        } catch (_) { }
                    });
                }

                // Simple 3D trees as trunk + cone crown at sampled interior points
                let area = 0; try { area = turf.area(p); } catch (_) { }
                const count = Math.max(3, Math.min(60, Math.round(area / 2000)));
                let bbox = null; try { bbox = turf.bbox(p); } catch (_) { }
                if (!bbox) return;
                let placed = 0, safety = 0;
                while (placed < count && safety < count * 20) {
                    safety++;
                    const rnd = turf.randomPoint(1, { bbox }).features[0];
                    try { if (!turf.booleanPointInPolygon(rnd, p)) continue; } catch (_) { continue; }
                    // Avoid placing in ponds
                    try {
                        if (deco && Array.isArray(deco.ponds)) {
                            let inPond = false;
                            for (let i = 0; i < deco.ponds.length; i++) {
                                const ring = deco.ponds[i];
                                const pondPoly = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
                                if (turf.booleanPointInPolygon(rnd, pondPoly)) { inPond = true; break; }
                            }
                            if (inPond) continue;
                        }
                    } catch (_) { }
                    const [lng, lat] = rnd.geometry.coordinates;
                    const [x, y] = latLngToXY(lat, lng);
                    const trunkH = 3 + Math.random() * 2;
                    const crownH = 4 + Math.random() * 3;
                    const trunkR = 0.45 + Math.random() * 0.35;
                    const crownR = 1.8 + Math.random() * 1.2;

                    const trunkGeo = new THREE.CylinderGeometry(trunkR, trunkR, trunkH, 8);
                    trunkGeo.rotateX(Math.PI / 2); // stand upright along Z
                    trunkGeo.translate(x, y, trunkH / 2);
                    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
                    decoTarget.add(trunk);

                    const crownGeo = new THREE.ConeGeometry(crownR, crownH, 8);
                    crownGeo.rotateX(Math.PI / 2); // stand upright along Z
                    crownGeo.translate(x, y, trunkH + crownH / 2);
                    const crown = new THREE.Mesh(crownGeo, treeMat);
                    decoTarget.add(crown);
                    placed++;
                }
            } catch (_) { }
        });
    }

    // Build Squares (ground + simple fountain)
    function buildSquares3D(flatTarget, decoTarget) {
        const squares = (typeof window !== 'undefined' && Array.isArray(window.squares)) ? window.squares : [];
        if (!squares || squares.length === 0) return;

        const stoneMat = new THREE.MeshLambertMaterial({ color: 0xbdbdbd, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const rimMat = new THREE.MeshLambertMaterial({ color: 0x9a9a9a });
        const waterMat = new THREE.MeshPhongMaterial({ color: 0x3a8ad3, specular: 0x1f4f7a, shininess: 60 });

        squares.forEach(sq => {
            try {
                if (!sq || !sq.geometry) return;
                // Ground slightly above base to avoid z-fighting
                const groundMeshes = polygonFeatureToMeshes(sq, stoneMat, 0.06, 0);
                groundMeshes.forEach(m => { m.userData.isSquareGround = true; flatTarget.add(m); });

                const dec = sq.properties && sq.properties.decorations;
                if (!dec || !Array.isArray(dec.fountain)) return;
                const [lng, lat] = dec.fountain;
                const [x, y] = latLngToXY(lat, lng);

                // Simple fountain: pedestal + basin + water disk + small spout
                const group = new THREE.Group();

                // Pedestal
                const pedH = 0.3;
                const pedR = 0.8;
                const pedGeo = new THREE.CylinderGeometry(pedR, pedR, pedH, 24);
                pedGeo.rotateX(Math.PI / 2);
                pedGeo.translate(x, y, 0.06 + pedH / 2);
                const pedestal = new THREE.Mesh(pedGeo, rimMat);
                group.add(pedestal);

                // Basin rim
                const basinH = 0.2;
                const basinR = 2.0;
                const basinGeo = new THREE.CylinderGeometry(basinR, basinR, basinH, 48, 1, false);
                basinGeo.rotateX(Math.PI / 2);
                basinGeo.translate(x, y, 0.06 + pedH + basinH / 2);
                const basin = new THREE.Mesh(basinGeo, rimMat);
                group.add(basin);

                // Water disk inside basin
                const waterR = basinR * 0.85;
                const waterGeo = new THREE.CylinderGeometry(waterR, waterR, 0.06, 48);
                waterGeo.rotateX(Math.PI / 2);
                waterGeo.translate(x, y, 0.06 + pedH + basinH + 0.03);
                const water = new THREE.Mesh(waterGeo, waterMat);
                water.renderOrder = 8000;
                group.add(water);

                // Central spout
                const spoutH = 0.8;
                const spoutR = 0.12;
                const spoutGeo = new THREE.CylinderGeometry(spoutR, spoutR, spoutH, 12);
                spoutGeo.rotateX(Math.PI / 2);
                spoutGeo.translate(x, y, 0.06 + pedH + basinH + spoutH / 2);
                const spout = new THREE.Mesh(spoutGeo, waterMat);
                spout.material.transparent = true;
                spout.material.opacity = 0.9;
                group.add(spout);

                decoTarget.add(group);
            } catch (_) { }
        });
    }

    // Build Lakes (shore + water + fish)
    function buildLakes3D(flatTarget, decoTarget) {
        const lakes = (typeof window !== 'undefined' && Array.isArray(window.lakes)) ? window.lakes : [];
        if (!lakes || lakes.length === 0) return;

        const shoreMat = new THREE.MeshLambertMaterial({ color: 0xf3d7a0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const transitionMat = new THREE.MeshLambertMaterial({ color: 0x3c92d6, polygonOffset: true, polygonOffsetFactor: -2.5, polygonOffsetUnits: -2.5 });
        const waterMat = new THREE.MeshPhongMaterial({ color: 0x3fa7f5, specular: 0x1b6fa8, shininess: 50, transparent: true, opacity: 0.88 });
        const fishMat = new THREE.MeshLambertMaterial({ color: 0xffa500 });

        lakes.forEach(lake => {
            try {
                if (!lake || !lake.geometry) return;

                // Ensure lake graphics are generated
                try {
                    if (typeof ensureLakeGraphics === 'function') ensureLakeGraphics(lake);
                } catch (_) { }

                const graphics = lake.properties && lake.properties.lakeGraphics;
                const shoreGeom = graphics && graphics.shore ? graphics.shore : lake.geometry;
                const waterGeom = graphics && graphics.water ? graphics.water : null;
                const transitionGeom = graphics && graphics.transition ? graphics.transition : null;

                // Render shore (sandy beach) at ground level
                if (shoreGeom) {
                    const shoreFeature = { type: 'Feature', geometry: shoreGeom, properties: {} };
                    const shoreMeshes = polygonFeatureToMeshes(shoreFeature, shoreMat, 0.06, 0);
                    shoreMeshes.forEach(m => { m.userData.isLakeShore = true; flatTarget.add(m); });
                }

                // Render transition zone (shallow water) slightly above ground
                if (transitionGeom) {
                    const transitionFeature = { type: 'Feature', geometry: transitionGeom, properties: {} };
                    const transitionMeshes = polygonFeatureToMeshes(transitionFeature, transitionMat, 0.07, 0);
                    transitionMeshes.forEach(m => flatTarget.add(m));
                }

                // Render water (deep water) slightly above ground
                if (waterGeom) {
                    const waterFeature = { type: 'Feature', geometry: waterGeom, properties: {} };
                    const waterMeshes = polygonFeatureToMeshes(waterFeature, waterMat, 0.08, 0);
                    waterMeshes.forEach(m => {
                        m.renderOrder = 8000;
                        flatTarget.add(m);
                    });
                } else {
                    // Fallback: render entire lake as water if no water geometry
                    const waterMeshes = polygonFeatureToMeshes(lake, waterMat, 0.08, 0);
                    waterMeshes.forEach(m => {
                        m.renderOrder = 8000;
                        flatTarget.add(m);
                    });
                }

                // Render fish as small decorative elements
                const fishCoords = (graphics && Array.isArray(graphics.fish)) ? graphics.fish : [];
                fishCoords.forEach(([lng, lat]) => {
                    try {
                        const [x, y] = latLngToXY(lat, lng);
                        // Simple fish: small ellipsoid
                        const fishGeo = new THREE.SphereGeometry(0.15, 8, 8);
                        const fish = new THREE.Mesh(fishGeo, fishMat);
                        fish.scale.set(1.5, 0.6, 0.4); // Make it fish-shaped
                        fish.position.set(x, y, 0.08);
                        decoTarget.add(fish);
                    } catch (_) { }
                });
            } catch (_) { }
        });
    }

    function estimateBuildingHeightMeters(feature) {
        try {
            const props = feature.properties || {};
            if (typeof props.height === 'number' && isFinite(props.height) && props.height > 0) return props.height;
            if (typeof props.HEIGHT === 'number' && isFinite(props.HEIGHT) && props.HEIGHT > 0) return props.HEIGHT;
            if (typeof props.elevation === 'number' && isFinite(props.elevation) && props.elevation > 0) return props.elevation;
            // stories/levels fallback
            const levels = props.levels || props.storeys || props.stories || props.LEVELS || props.STORIES;
            if (typeof levels === 'number' && isFinite(levels) && levels > 0) return levels * 3.3;
        } catch (_) { }
        return 10; // default 3 stories ~10 meters
    }

    function buildParcels3D(targetGroup) {
        if (typeof parcelLayer === 'undefined' || !parcelLayer) return;
        // parcels at z=0
        parcelLayer.getLayers().forEach(l => {
            const f = l.feature;
            if (!f || !f.geometry) return;
            const props = f.properties || {};
            let isRoadParcel = props.isRoad === true;
            try {
                if (!isRoadParcel && props.parcelId && typeof window.isRoadParcel === 'function') {
                    isRoadParcel = window.isRoadParcel(props.parcelId);
                }
            } catch (_) { }

            const fillMat = isRoadParcel ? materials.roads : materials.parcels;
            const edgeMat = isRoadParcel ? materials.roadLines : materials.parcelEdges;

            const meshes = polygonFeatureToMeshes(f, fillMat, 0, 0);
            meshes.forEach(m => targetGroup.add(m));
            const borders = polygonFeatureToBorderLines(f, edgeMat, 0.03);
            borders.forEach(line => targetGroup.add(line));
        });
    }

    function buildRoads3D(targetGroup) {
        // OSM lines as polylines at z=0.05, DGU road parcels as filled at z=0.02
        if (typeof window.osmRoadLayer !== 'undefined' && window.osmRoadLayer) {
            window.osmRoadLayer.getLayers().forEach(l => {
                const f = l.feature;
                if (!f || !f.geometry) return;
                const ln = lineFeatureToLine(f, materials.roadLines, 0.05);
                if (ln) targetGroup.add(ln);
            });
        }

        if (typeof window.wfsRoadUseLayer !== 'undefined' && window.wfsRoadUseLayer) {
            window.wfsRoadUseLayer.getLayers().forEach(l => {
                const f = l.feature;
                if (!f || !f.geometry) return;
                const meshes = polygonFeatureToMeshes(f, materials.roads, 0.02, 0);
                meshes.forEach(m => targetGroup.add(m));
            });
        }
    }

    function buildExistingBuildings3D(targetGroup) {
        if (typeof buildingLayer === 'undefined' || !buildingLayer) return;
        try {
            buildingLayer.getLayers().forEach(l => {
                const f = l.feature;
                if (!f || !f.geometry) return;
                const height = estimateBuildingHeightMeters(f);
                createBuildingSlices(f, height, materials.buildings, targetGroup);
            });
        } catch (_) { }
    }

    function buildProposedBuildings3D(targetGroup) {
        const arr = (typeof window !== 'undefined' && Array.isArray(window.proposedBuildings)) ? window.proposedBuildings : [];
        if (!arr || arr.length === 0) return;
        for (let i = 0; i < arr.length; i++) {
            const feat = arr[i];
            if (!feat || !feat.geometry) continue;
            try {
                const height = estimateBuildingHeightMeters(feat);
                createBuildingSlices(feat, height, materials.buildings, targetGroup);
            } catch (_) { }
        }
    }

    function stringToColor(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        let color = '#';
        for (let i = 0; i < 3; i++) {
            let value = (hash >> (i * 8)) & 0xFF;
            color += ('00' + value.toString(16)).substr(-2);
        }
        return color;
    }

    function createBuildingSlices(buildingFeature, height, material, targetGroup) {
        if (!buildingFeature || !buildingFeature.geometry || typeof parcelLayer === 'undefined' || !parcelLayer) {
            const meshes = polygonFeatureToMeshes(buildingFeature, material, 0, height);
            meshes.forEach(m => targetGroup.add(m));
            return;
        }

        const candidateParcels = [];
        try {
            const bBbox = turf.bbox(buildingFeature);
            parcelLayer.getLayers().forEach(l => {
                const pf = l && l.feature;
                if (!pf || !pf.geometry) return;
                try {
                    const pBbox = turf.bbox(pf);
                    const overlaps = !(pBbox[2] < bBbox[0] || pBbox[0] > bBbox[2] || pBbox[3] < bBbox[1] || pBbox[1] > bBbox[3]);
                    if (overlaps) {
                        candidateParcels.push(pf);
                    }
                } catch (_) { }
            });
        } catch (_) { }

        let totalBuildingArea = 0;
        try { totalBuildingArea = turf.area(buildingFeature); } catch (_) { }
        let slicedArea = 0;
        let slices = 0;

        let buildingId;
        try {
            buildingId = JSON.stringify(buildingFeature.geometry.coordinates[0][0]);
        } catch (e) {
            buildingId = Math.random().toString();
        }
        const baseColor = new THREE.Color(stringToColor(buildingId));

        if (candidateParcels.length > 0) {
            candidateParcels.forEach(parcelFeature => {
                try {
                    const intersection = turf.intersect(buildingFeature, parcelFeature);
                    if (intersection) {
                        try { slicedArea += turf.area(intersection); } catch (_) { }
                        slices++;
                        const sliceMaterial = material.clone();

                        const shadedColor = baseColor.clone();
                        let hsl = {};
                        shadedColor.getHSL(hsl);
                        const lightnessShift = (Math.random() - 0.5) * 0.3; // -0.15 to 0.15
                        hsl.l = Math.max(0.2, Math.min(0.8, hsl.l + lightnessShift));
                        shadedColor.setHSL(hsl.h, hsl.s, hsl.l);
                        sliceMaterial.color.set(shadedColor);

                        const sliceMeshes = polygonFeatureToMeshes(intersection, sliceMaterial, 0, height);

                        sliceMeshes.forEach(mesh => {
                            targetGroup.add(mesh);
                            const edges = new THREE.EdgesGeometry(mesh.geometry);
                            const line = new THREE.LineSegments(edges, materials.sliceEdges);
                            targetGroup.add(line);
                        });
                    }
                } catch (e) {
                    console.warn("Error creating building slice", e);
                }
            });
        }

        if (slices === 0 || (totalBuildingArea > 0 && (slicedArea / totalBuildingArea) < 0.95)) {
            if (slices > 0) {
                console.warn("Slicing did not cover the whole building, drawing remainder.");
            }
            const meshes = polygonFeatureToMeshes(buildingFeature, material, 0, height);
            meshes.forEach(m => targetGroup.add(m));
        }
    }

    function getBuildingParcelIntersectionPoints(buildingFeature) {
        const intersectionPoints = [];
        if (!buildingFeature || !buildingFeature.geometry) return intersectionPoints;
        if (typeof parcelLayer === 'undefined' || !parcelLayer) return intersectionPoints;

        let buildingLine = null;
        try {
            // Use a simplified representation to avoid self-intersection issues in source data
            const simplified = turf.simplify(buildingFeature, { tolerance: 0.1, highQuality: false });
            buildingLine = turf.polygonToLine(simplified);
        } catch (e) {
            console.warn('Could not convert building polygon to line', e);
            return intersectionPoints; // Cannot proceed
        }

        if (!buildingLine) return intersectionPoints;

        parcelLayer.getLayers().forEach(l => {
            const pf = l && l.feature;
            if (!pf || !pf.geometry) return;

            // Bbox pre-filter for performance
            try {
                const bBbox = turf.bbox(buildingFeature);
                const pBbox = turf.bbox(pf);
                const overlaps = !(pBbox[2] < bBbox[0] || pBbox[0] > bBbox[2] || pBbox[3] < bBbox[1] || pBbox[1] > bBbox[3]);
                if (!overlaps) return;
            } catch (_) { /* continue */ }

            let parcelLine = null;
            try {
                parcelLine = turf.polygonToLine(pf);
            } catch (e) { /* ignore parcels that can't be converted */
                return;
            }

            if (!parcelLine) return;

            try {
                const intersections = turf.lineIntersect(buildingLine, parcelLine);
                if (intersections && intersections.features) {
                    intersections.features.forEach(feat => {
                        intersectionPoints.push(feat.geometry.coordinates);
                    });
                }
            } catch (e) {
                console.warn('turf.lineIntersect failed', e);
            }
        });

        return intersectionPoints;
    }

    function pointsToVerticalLines(points, height, material) {
        const lines = [];
        if (!points || points.length === 0) return lines;

        points.forEach(p => {
            try {
                const [lng, lat] = p;
                const xy = coordsToXY([lng, lat]);
                const x = xy[0];
                const y = xy[1];

                const points = [
                    new THREE.Vector3(x, y, 0),
                    new THREE.Vector3(x, y, height)
                ];

                const geometry = new THREE.BufferGeometry().setFromPoints(points);
                const line = new THREE.Line(geometry, material);
                line.renderOrder = 9999;
                lines.push(line);
            } catch (e) { console.warn('Failed to create vertical line', e); }
        });
        return lines;
    }

    function clearGroupChildren(group) {
        if (!group) return;
        for (let i = group.children.length - 1; i >= 0; i--) group.remove(group.children[i]);
    }

    function rebuild3DBuildingsOnly() {
        if (!isActive || !buildingGroup) return;
        clearGroupChildren(buildingGroup);
        const showExisting = !!document.getElementById('showBuildings')?.checked;
        const showProposed = !!document.getElementById('showProposedBuildings')?.checked;
        if (showExisting) buildExistingBuildings3D(buildingGroup);
        if (showProposed) buildProposedBuildings3D(buildingGroup);
    }

    function computeContentBoundsXY() {
        // Try parcelLayer bounds primarily, fall back to map bounds
        let bounds = null;
        if (typeof parcelLayer !== 'undefined' && parcelLayer && parcelLayer.getBounds) {
            try { bounds = parcelLayer.getBounds(); } catch (_) { bounds = null; }
        }
        if (!bounds && typeof map !== 'undefined' && map) bounds = map.getBounds();
        if (!bounds) return { width: 100, height: 100 };
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const [x0, y0] = latLngToXY(sw.lat, sw.lng);
        const [x1, y1] = latLngToXY(ne.lat, ne.lng);
        return { width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
    }

    function initScene() {
        // Preserve pendingIntroAutoRotate across dispose/init cycle
        const preserveAutoRotate = pendingIntroAutoRotate;
        // Clean up if re-initializing
        disposeScene();
        // Restore the flag after dispose
        pendingIntroAutoRotate = preserveAutoRotate;

        const width = Math.max(1, threeContainer.clientWidth || 800);
        const height = Math.max(1, threeContainer.clientHeight || 600);

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0xf8f9fb);

        camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200000);
        camera.up.set(0, 0, 1);

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        threeContainer.innerHTML = '';
        threeContainer.appendChild(renderer.domElement);

        // Lights
        const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 0.6);
        hemi.position.set(0, 0, 1);
        scene.add(hemi);

        const dir = new THREE.DirectionalLight(0xffffff, 0.8);
        dir.position.set(200, 200, 400);
        scene.add(dir);

        // Groups
        flatGroup = new THREE.Group();
        buildingGroup = new THREE.Group();
        parkGroup = new THREE.Group();
        squareGroup = new THREE.Group();
        lakeGroup = new THREE.Group();
        scene.add(flatGroup);
        scene.add(buildingGroup);
        scene.add(parkGroup);
        scene.add(squareGroup);
        scene.add(lakeGroup);

        // Controls
        const OrbitControlsCtor = (THREE.OrbitControls) ? THREE.OrbitControls : (window.OrbitControls || null);
        if (OrbitControlsCtor) {
            controls = new OrbitControlsCtor(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.dampingFactor = 0.05;
            controls.screenSpacePanning = true;
            controls.maxPolarAngle = Math.PI * 0.49; // limit below horizon
        }

        // Build content
        origin3857 = getOrigin3857();
        buildParcels3D(flatGroup);
        buildRoads3D(flatGroup);
        try { buildParks3D(flatGroup, parkGroup); } catch (_) { }
        try { buildSquares3D(flatGroup, squareGroup); } catch (_) { }
        try { buildLakes3D(flatGroup, lakeGroup); } catch (_) { }
        rebuild3DBuildingsOnly();

        // Camera framing that preserves current 2D view scale and center
        const content = computeContentBoundsXY();
        const target = new THREE.Vector3(0, 0, 0);
        if (controls) controls.target.copy(target);

        // Keep track of current pitch for resize
        let currentPitchRad = 0;
        const finalPitchRad = (35 * Math.PI) / 180; // ~35° tilt

        function placeCameraForPitch(pitchRad) {
            // Compute distance to fit current visible content given pitch
            const vFov = THREE.MathUtils.degToRad(camera.fov);
            const aspect = camera.aspect;
            const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);

            const width = Math.max(1, content.width);
            const height = Math.max(1, content.height);

            const distForHeightTopDown = (height / 2) / Math.tan(vFov / 2);
            const distForWidthTopDown = (width / 2) / Math.tan(hFov / 2);
            const distTopDown = Math.max(distForHeightTopDown, distForWidthTopDown);

            // Adjust for pitch: foreshortening reduces vertical ground coverage by cos(pitch)
            const distance = (distTopDown / Math.max(0.1, Math.cos(pitchRad))) * CAMERA_DISTANCE_SCALE;

            // Keep north-up orientation consistent with 2D (flip Y)
            const y = -Math.sin(pitchRad) * distance;
            const z = Math.cos(pitchRad) * distance;
            camera.position.set(0, y, z);
            camera.lookAt(target);
            if (controls) controls.update();
        }

        // Start at top-down, then animate to final tilt while maintaining scale
        placeCameraForPitch(0);
        const start = performance.now();
        const duration = 700; // ms
        function tiltStep(now) {
            const t = Math.min(1, (now - start) / duration);
            const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
            const pitch = finalPitchRad * ease;
            currentPitchRad = pitch;
            placeCameraForPitch(pitch);
            renderer.render(scene, camera);
            if (t < 1) {
                frameId = requestAnimationFrame(tiltStep);
            } else {
                startLoop();
            }
        }
        frameId = requestAnimationFrame(tiltStep);

        // Resize handling
        window.addEventListener('resize', handleResize, { passive: true });

        // Checkbox listeners (sync 3D buildings with sidebar state)
        const showExistingEl = document.getElementById('showBuildings');
        const showProposedEl = document.getElementById('showProposedBuildings');
        onShowExistingBuildingsChange = () => { rebuild3DBuildingsOnly(); };
        onShowProposedBuildingsChange = () => { rebuild3DBuildingsOnly(); };
        if (showExistingEl) showExistingEl.addEventListener('change', onShowExistingBuildingsChange);
        if (showProposedEl) showProposedEl.addEventListener('change', onShowProposedBuildingsChange);
    }

    function showRenderingOverlay() {
        try {
            if (renderingOverlayEl) return;
            const el = document.createElement('div');
            el.id = 'three-rendering-overlay';
            el.textContent = 'Rendering…';
            el.style.position = 'fixed';
            el.style.left = '50%';
            el.style.top = '50%';
            el.style.transform = 'translate(-50%, -50%)';
            el.style.padding = '10px 14px';
            el.style.background = 'rgba(0,0,0,0.66)';
            el.style.color = '#fff';
            el.style.borderRadius = '8px';
            el.style.fontSize = '16px';
            el.style.fontWeight = '600';
            el.style.zIndex = '999999';
            el.style.pointerEvents = 'none';
            document.body.appendChild(el);
            renderingOverlayEl = el;
        } catch (_) { }
    }

    function hideRenderingOverlay() {
        try {
            if (renderingOverlayEl && renderingOverlayEl.parentNode) {
                renderingOverlayEl.parentNode.removeChild(renderingOverlayEl);
            }
        } catch (_) { }
        renderingOverlayEl = null;
    }

    function stopIntroAutoRotate() {
        try {
            const wasPending = pendingIntroAutoRotate;
            pendingIntroAutoRotate = false;
            if (wasPending) {
                console.log('[3D] stopIntroAutoRotate() called, clearing pendingIntroAutoRotate');
            }
            manualAutoRotateActive = false;
            manualAutoRotateLastTs = 0;
            if (controls) {
                try { controls.autoRotate = false; } catch (_) { }
            }
            if (typeof introAutoRotateCleanup === 'function') {
                try { introAutoRotateCleanup(); } catch (_) { }
            }
        } catch (_) { }
        introAutoRotateCleanup = null;
    }

    function startIntroAutoRotate() {
        // Idempotent: clear any previous listeners/state first
        stopIntroAutoRotate();

        const controlsInstance = controls;
        try {
            if (controlsInstance) {
                controlsInstance.autoRotate = true;
                controlsInstance.autoRotateSpeed = INTRO_AUTO_ROTATE_SPEED;
                console.log('[3D] Enabled OrbitControls auto-rotate, speed:', INTRO_AUTO_ROTATE_SPEED);
            } else {
                manualAutoRotateActive = true;
                manualAutoRotateLastTs = 0;
                console.log('[3D] OrbitControls not available, using manual auto-rotate');
            }
        } catch (err) {
            console.warn('[3D] Failed to enable auto-rotate:', err);
        }

        const stop = () => { stopIntroAutoRotate(); };

        // Stop as soon as the user clicks/touches/presses anywhere.
        try { document.addEventListener('pointerdown', stop, { passive: true, capture: true }); } catch (_) { }
        try { document.addEventListener('mousedown', stop, { passive: true, capture: true }); } catch (_) { }
        try { document.addEventListener('touchstart', stop, { passive: true, capture: true }); } catch (_) { }
        try {
            if (controlsInstance && typeof controlsInstance.addEventListener === 'function') {
                controlsInstance.addEventListener('start', stop);
            }
        } catch (_) { }

        introAutoRotateCleanup = () => {
            try { document.removeEventListener('pointerdown', stop, true); } catch (_) { }
            try { document.removeEventListener('mousedown', stop, true); } catch (_) { }
            try { document.removeEventListener('touchstart', stop, true); } catch (_) { }
            try {
                if (controlsInstance && typeof controlsInstance.removeEventListener === 'function') {
                    controlsInstance.removeEventListener('start', stop);
                }
            } catch (_) { }
            try { if (controlsInstance) controlsInstance.autoRotate = false; } catch (_) { }
        };
    }

    function stepManualAutoRotate(now) {
        if (!manualAutoRotateActive || !camera) return;
        if (!Number.isFinite(now)) return;
        if (!manualAutoRotateLastTs) {
            manualAutoRotateLastTs = now;
            return;
        }
        const dt = (now - manualAutoRotateLastTs) / 1000;
        manualAutoRotateLastTs = now;
        if (!Number.isFinite(dt) || dt <= 0) return;
        const angle = dt * INTRO_MANUAL_AUTO_ROTATE_RAD_PER_SEC;
        if (!Number.isFinite(angle) || angle === 0) return;
        const x = camera.position.x;
        const y = camera.position.y;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        camera.position.x = (x * cos) - (y * sin);
        camera.position.y = (x * sin) + (y * cos);
        camera.lookAt(ORIGIN);
    }

    function startLoop() {
        cancelLoop();
        // We are ready: hide overlay and set the button label to 2D
        hideRenderingOverlay();
        isTransitioning3D = false;
        if (toggleBtn && isActive) {
            toggleBtn.textContent = '2D';
            toggleBtn.title = 'Switch to 2D';
        }
        console.log('[3D] startLoop() called, pendingIntroAutoRotate:', pendingIntroAutoRotate);
        if (pendingIntroAutoRotate) {
            pendingIntroAutoRotate = false;
            console.log('[3D] Starting intro auto-rotate');
            startIntroAutoRotate();
        }
        const loop = (now) => {
            stepManualAutoRotate(now);
            if (controls) controls.update();
            renderer.render(scene, camera);
            frameId = requestAnimationFrame(loop);
        };
        frameId = requestAnimationFrame(loop);
    }

    function cancelLoop() {
        if (frameId) {
            try { cancelAnimationFrame(frameId); } catch (_) { }
            frameId = null;
        }
    }

    function handleResize() {
        if (!renderer || !camera) return;
        const w = Math.max(1, threeContainer.clientWidth || 800);
        const h = Math.max(1, threeContainer.clientHeight || 600);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        // Re-place camera to preserve view scale on resize (using last known pitch via controls orientation)
        try {
            // Approximate pitch from camera position
            const pos = camera.position;
            const distance = Math.max(1, Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z));
            const pitchRad = Math.acos(Math.min(1, Math.max(-1, pos.z / distance)));
            // Recompute placement with current content bounds
            const content = computeContentBoundsXY();
            const vFov = THREE.MathUtils.degToRad(camera.fov);
            const aspect = camera.aspect;
            const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
            const width = Math.max(1, content.width);
            const height = Math.max(1, content.height);
            const distForHeightTopDown = (height / 2) / Math.tan(vFov / 2);
            const distForWidthTopDown = (width / 2) / Math.tan(hFov / 2);
            const distTopDown = Math.max(distForHeightTopDown, distForWidthTopDown);
            const newDistance = (distTopDown / Math.max(0.1, Math.cos(pitchRad))) * CAMERA_DISTANCE_SCALE;
            // Keep north-up orientation consistent with 2D (flip Y)
            const y = -Math.sin(pitchRad) * newDistance;
            const z = Math.cos(pitchRad) * newDistance;
            camera.position.set(0, y, z);
            camera.lookAt(new THREE.Vector3(0, 0, 0));
        } catch (_) { }
    }

    function disposeScene() {
        cancelLoop();
        stopIntroAutoRotate();
        hideRenderingOverlay();
        isTransitioning3D = false;
        if (controls && controls.dispose) {
            try { controls.dispose(); } catch (_) { }
        }
        controls = null;
        if (renderer) {
            try { renderer.forceContextLoss && renderer.forceContextLoss(); } catch (_) { }
            try { renderer.dispose(); } catch (_) { }
        }
        renderer = null;
        scene = null;
        camera = null;
        flatGroup = null;
        buildingGroup = null;
        threeContainer && (threeContainer.innerHTML = '');
        window.removeEventListener('resize', handleResize);

        // Remove checkbox listeners
        try {
            const showExistingEl = document.getElementById('showBuildings');
            const showProposedEl = document.getElementById('showProposedBuildings');
            if (showExistingEl && onShowExistingBuildingsChange) showExistingEl.removeEventListener('change', onShowExistingBuildingsChange);
            if (showProposedEl && onShowProposedBuildingsChange) showProposedEl.removeEventListener('change', onShowProposedBuildingsChange);
        } catch (_) { }
        onShowExistingBuildingsChange = null;
        onShowProposedBuildingsChange = null;
    }

    function disableLeafletInteractions() {
        try { map.dragging && map.dragging.disable(); } catch (_) { }
        try { map.scrollWheelZoom && map.scrollWheelZoom.disable(); } catch (_) { }
        try { map.doubleClickZoom && map.doubleClickZoom.disable(); } catch (_) { }
        try { map.boxZoom && map.boxZoom.disable(); } catch (_) { }
        try { map.keyboard && map.keyboard.disable(); } catch (_) { }
        // Hide attribution if desired? Keep it.
    }

    function enableLeafletInteractions() {
        try { map.dragging && map.dragging.enable(); } catch (_) { }
        try { map.scrollWheelZoom && map.scrollWheelZoom.enable(); } catch (_) { }
        try { map.doubleClickZoom && map.doubleClickZoom.enable(); } catch (_) { }
        try { map.boxZoom && map.boxZoom.enable(); } catch (_) { }
        try { map.keyboard && map.keyboard.enable(); } catch (_) { }
    }

    function disableSidebarFor3D() {
        try {
            const sidebar = document.getElementById('sidebar');
            if (!sidebar) return;
            const buildingsSection = document.querySelector('.accordion-section[data-section="buildings"]');
            const interactive = sidebar.querySelectorAll('input, button, select, textarea');
            interactive.forEach(el => {
                const inBuildings = buildingsSection && el.closest('.accordion-section') === buildingsSection;
                if (!inBuildings) {
                    if (!el.disabled) el.setAttribute('data-three-disabled', '1');
                    el.disabled = true;
                }
            });
        } catch (_) { }
    }

    function enableSidebarAfter3D() {
        try {
            const sidebar = document.getElementById('sidebar');
            if (!sidebar) return;
            const toEnable = sidebar.querySelectorAll('[data-three-disabled="1"]');
            toEnable.forEach(el => {
                try { el.disabled = false; } catch (_) { }
                try { el.removeAttribute('data-three-disabled'); } catch (_) { }
            });
        } catch (_) { }
    }

    function closeAllPanelsAndModalsFor3D() {
        try { typeof hideParcelInfoPanel === 'function' && hideParcelInfoPanel(); } catch (_) { }
        try { typeof hideProposalDetailsPanel === 'function' && hideProposalDetailsPanel(); } catch (_) { }
        try { typeof hideBlockInfo === 'function' && hideBlockInfo(); } catch (_) { }
        try { typeof hideRoadInfoPanel === 'function' && hideRoadInfoPanel(); } catch (_) { }
        try { typeof hideRoadAnalysisPanel === 'function' && hideRoadAnalysisPanel(); } catch (_) { }
        try { typeof hideOSMRoadSegmentListPopup === 'function' && hideOSMRoadSegmentListPopup(); } catch (_) { }
        try { typeof hideBlocksList === 'function' && hideBlocksList(); } catch (_) { }
        try { typeof closeProposalDialog === 'function' && closeProposalDialog(); } catch (_) { }
        try {
            const blockifyModal = document.getElementById('blockify-modal');
            if (blockifyModal && typeof closeBlockifyModal === 'function') closeBlockifyModal();
        } catch (_) { }
        // Close share modals (e.g., shared proposal inspector/summary) so they don't block 3D controls.
        try {
            document.querySelectorAll('.share-modal-overlay .share-modal-close').forEach(btn => {
                try { btn.click(); } catch (_) { }
            });
        } catch (_) { }
        // Ensure built-in static modals are hidden
        ['welcome-modal', 'logout-modal', 'locate-parcel-modal', 'osm-road-segment-list-popup']
            .forEach(id => { try { const el = document.getElementById(id); if (el) el.style.display = 'none'; } catch (_) { } });
    }

    function enter3D(options = {}) {
        if (isActive) return;
        isActive = true;
        pendingIntroAutoRotate = !!(options && options.fromUrl);
        if (pendingIntroAutoRotate) {
            console.log('[3D] URL-driven entry detected, will start auto-rotate after tilt animation');
        }
        try { document.body.classList.add('three-mode-active'); } catch (_) { }
        if (threeContainer) threeContainer.classList.add('active');
        if (toggleBtn) {
            toggleBtn.classList.add('active');
            toggleBtn.textContent = 'Rendering…';
            toggleBtn.title = 'Preparing 3D view';
        }
        showRenderingOverlay();
        disableLeafletInteractions();
        closeAllPanelsAndModalsFor3D();
        disableSidebarFor3D();
        initScene();
    }

    function exit3D() {
        try { document.body.classList.remove('three-mode-active'); } catch (_) { }
        if (!isActive) return;
        isActive = false;
        stopIntroAutoRotate();
        if (threeContainer) threeContainer.classList.remove('active');
        if (toggleBtn) {
            toggleBtn.classList.remove('active');
            toggleBtn.textContent = '3D';
            toggleBtn.title = 'Switch to 3D';
        }
        enableLeafletInteractions();
        enableSidebarAfter3D();
        disposeScene();
    }

    function toggle3D() {
        if (isActive) exit3D(); else enter3D();
    }

    // Optional: rebuild content if parcel data reloads while in 3D
    window.addEventListener('parcelDataLoaded', () => {
        if (!isActive) return;
        // Rebuild scene content without re-creating renderer/camera
        if (!scene) { initScene(); return; }
        // Clear groups
        if (flatGroup) {
            for (let i = flatGroup.children.length - 1; i >= 0; i--) flatGroup.remove(flatGroup.children[i]);
        }
        clearGroupChildren(buildingGroup);
        clearGroupChildren(parkGroup);
        clearGroupChildren(squareGroup);
        clearGroupChildren(lakeGroup);
        origin3857 = getOrigin3857();
        buildParcels3D(flatGroup);
        buildRoads3D(flatGroup);
        try { buildParks3D(flatGroup, parkGroup); } catch (_) { }
        try { buildSquares3D(flatGroup, squareGroup); } catch (_) { }
        try { buildLakes3D(flatGroup, lakeGroup); } catch (_) { }
        rebuild3DBuildingsOnly();
    });

    // Rebuild buildings if the 2D buildings layer updates (e.g., after fetch)
    window.addEventListener('buildingsLayerUpdated', () => {
        if (!isActive) return;
        rebuild3DBuildingsOnly();
    });

    // Rebuild on proposed buildings updates
    window.addEventListener('proposedBuildingsUpdated', () => {
        if (!isActive) return;
        rebuild3DBuildingsOnly();
    });

    // Rebuild parks when updated in 2D
    window.addEventListener('parksUpdated', () => {
        if (!isActive) return;
        if (!scene) { initScene(); return; }
        // Remove any previous park ground meshes
        if (flatGroup) {
            for (let i = flatGroup.children.length - 1; i >= 0; i--) {
                const ch = flatGroup.children[i];
                if (ch && ch.userData && ch.userData.isParkGround) flatGroup.remove(ch);
            }
        }
        clearGroupChildren(parkGroup);
        try { buildParks3D(flatGroup, parkGroup); } catch (_) { }
    });

    // Rebuild squares when updated in 2D
    window.addEventListener('squaresUpdated', () => {
        if (!isActive) return;
        if (!scene) { initScene(); return; }
        // Remove any previous square ground meshes
        if (flatGroup) {
            for (let i = flatGroup.children.length - 1; i >= 0; i--) {
                const ch = flatGroup.children[i];
                if (ch && ch.userData && ch.userData.isSquareGround) flatGroup.remove(ch);
            }
        }
        clearGroupChildren(squareGroup);
        try { buildSquares3D(flatGroup, squareGroup); } catch (_) { }
    });

    // Rebuild lakes when updated in 2D
    window.addEventListener('lakesUpdated', () => {
        if (!isActive) return;
        if (!scene) { initScene(); return; }
        // Remove any previous lake meshes
        if (flatGroup) {
            for (let i = flatGroup.children.length - 1; i >= 0; i--) {
                const ch = flatGroup.children[i];
                if (ch && ch.userData && ch.userData.isLakeShore) flatGroup.remove(ch);
            }
        }
        clearGroupChildren(lakeGroup);
        try { buildLakes3D(flatGroup, lakeGroup); } catch (_) { }
    });

    // Wire button
    if (toggleBtn) {
        toggleBtn.addEventListener('click', function () {
            if (isActive) {
                // Exit immediately
                toggle3D();
                return;
            }
            if (isTransitioning3D) return;
            isTransitioning3D = true;
            // Show immediate feedback in 2D before heavy work starts
            if (toggleBtn) {
                toggleBtn.classList.add('active');
                toggleBtn.textContent = 'Rendering…';
                toggleBtn.title = 'Preparing 3D view';
            }
            showRenderingOverlay();
            // Defer heavy initialization to allow the overlay/button to paint first
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    enter3D();
                });
            });
        });
    }

    // Expose globals for debugging/manual control
    window.enterThreeMode = enter3D;
    window.exitThreeMode = exit3D;
    window.isThreeModeActive = function () { return isActive; };
})();


