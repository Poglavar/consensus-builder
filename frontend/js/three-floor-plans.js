// Batch architectural prisms into shared Three.js meshes with floor cutaway and owned disposal.
(function (global) {
    'use strict';
    const COLORS = { wall: 0xf2eee5, slab: 0xbfc4c7, door: 0x8b654b, frame: 0x30363b, glass: 0x8cb8c9, stair: 0xb0aaa0, railing: 0x525b61 };
    // A generated default layout is a suggestion, so it reads in a cooler, bluer palette than an
    // evidence-backed interior; the two must never be mistaken for one another in the same scene.
    const SUGGESTED_COLORS = { wall: 0xd8e4ef, slab: 0xa9b7c4, door: 0x7a8ea2, frame: 0x3a4a5a, glass: 0x9ccbe0, stair: 0xa3b1bd, railing: 0x5a6b7a };

    function materialFor(THREE, kind, colors = COLORS) {
        return new THREE.MeshPhongMaterial({
            color: colors[kind], side: THREE.DoubleSide, depthTest: true,
            depthWrite: kind !== 'glass', transparent: kind === 'glass',
            opacity: kind === 'glass' ? .4 : 1, shininess: kind === 'glass' ? 50 : 8
        });
    }

    function geometryFor(THREE, parts) {
        const positions = [], normals = [];
        for (const part of parts) {
            const shape = new THREE.Shape(part.rings[0].map(p => new THREE.Vector2(p[0], p[1])));
            for (const ring of part.rings.slice(1)) {
                shape.holes.push(new THREE.Path(ring.map(p => new THREE.Vector2(p[0], p[1]))));
            }
            // ExtrudeGeometry emits nonindexed triangles, so merging attributes preserves
            // its hole triangulation and normals without one draw call per wall or stair.
            const source = new THREE.ExtrudeGeometry(shape, { depth: part.heightM, bevelEnabled: false, steps: 1 });
            source.translate(0, 0, part.baseM);
            for (const value of source.attributes.position.array) positions.push(value);
            for (const value of source.attributes.normal.array) normals.push(value);
            source.dispose();
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        return geometry;
    }

    function createBuildingGroup(THREE, feature, project, geometryApi, options = {}) {
        const api = geometryApi || global.__buildingFloorPlans;
        const floors = api.buildFloorPlanGeometry(feature, project);
        if (!floors.length) return null;
        const props = feature.properties, registration = props.floorPlans.registration, corners = registration.corners;
        const suggested = props.floorPlans.suggested === true;
        const colors = suggested ? SUGGESTED_COLORS : COLORS;
        const wrapper = new THREE.Group(), layouts = new Map(), materials = new Map();
        wrapper.userData = {
            cbFloorPlan: true, suggested, proposalId: props.proposalId ?? props.proposal_id ?? null,
            parcelId: props.parcelId ?? props.parcel_id ?? null, isNearbyBuilding3D: true,
            footprintLatLng: [corners.reduce((s,p) => s+p[0],0)/4, corners.reduce((s,p) => s+p[1],0)/4],
            floorCount: floors.length, estimatedFloorCount: floors.filter(f => f.elevationBasis === 'estimated').length,
            apartmentCount: floors.reduce((s,f) => s+f.apartmentCount,0),
            buildingName: props.buildingName || props.name || null,
            availableLevels: floors.map(f => f.level), registrationAccuracy: registration.accuracy,
            maxEdgeResidualM: registration.maxEdgeResidualM
        };
        for (const floor of floors) {
            let layout = layouts.get(floor.layoutId);
            if (!layout) {
                const byKind = new Map();
                for (const part of floor.parts) {
                    if (!byKind.has(part.kind)) byKind.set(part.kind, []);
                    byKind.get(part.kind).push(part);
                }
                layout = new Map();
                for (const [kind, parts] of byKind) {
                    layout.set(kind, geometryFor(THREE, parts));
                    if (!materials.has(kind)) materials.set(kind, materialFor(THREE, kind, colors));
                }
                layouts.set(floor.layoutId, layout);
            }
            const floorGroup = new THREE.Group();
            floorGroup.name = `FloorPlan:${floor.id}`;
            floorGroup.position.z = floor.elevationM;
            floorGroup.userData = {
                cbFloorPlanFloor: true, id: floor.id, level: floor.level,
                elevationM: floor.elevationM, elevationBasis: floor.elevationBasis,
                layoutId: floor.layoutId, sourceUrl: floor.sourceUrl, apartmentCount: floor.apartmentCount
            };
            for (const [kind, geometry] of layout) {
                const mesh = new THREE.Mesh(geometry, materials.get(kind));
                mesh.name = `FloorPart:${kind}`;
                mesh.userData.floorPartKind = kind;
                floorGroup.add(mesh);
            }
            wrapper.add(floorGroup);
        }
        // Keep source massing only in intervals with no reconstructed floor. This also
        // preserves an above-ground building whose only evidence is its basement.
        const bands = api.uncoveredFloorBands ? api.uncoveredFloorBands(feature, options.proxyHeightM) : [];
        const polygons = feature.geometry?.type === 'Polygon' ? [feature.geometry.coordinates]
            : feature.geometry?.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
        if (bands.length && polygons.length && options.proxyMaterial) {
            const material = options.proxyMaterial.clone();
            const declaredLevels = props.floors ?? props.storeys;
            wrapper.userData.proxyStoreyHeightM = Number.isFinite(declaredLevels) && declaredLevels > 0
                ? options.proxyHeightM / declaredLevels : 3;
            for (const band of bands) {
                const parts = polygons.map(rings => ({ rings: rings.map(ring => ring.map(p => project(p[0],p[1]))),
                    baseM: 0, heightM: band.heightM }));
                const mesh = new THREE.Mesh(geometryFor(THREE, parts), material);
                mesh.name = 'UnmodeledFloorVolume';
                mesh.position.z = band.baseM;
                mesh.userData = { cbFloorPlanProxy: true, ...band };
                wrapper.add(mesh);
            }
        }
        return wrapper;
    }

    function setCutaway(group, maxLevel) {
        if (!group?.userData?.cbFloorPlan) return;
        group.children.forEach(floor => {
            if (floor.userData.cbFloorPlanProxy) {
                const { baseM, heightM } = floor.userData;
                const top = maxLevel === null ? Infinity : maxLevel < 0 ? 0
                    : (maxLevel + 1) * group.userData.proxyStoreyHeightM;
                const visibleHeight = Math.max(0, Math.min(heightM, top - baseM));
                floor.visible = visibleHeight > 0;
                floor.scale.z = visibleHeight / heightM;
            } else floor.visible = maxLevel === null || floor.userData.level <= maxLevel;
        });
    }

    function disposeGroup(group) {
        if (!group?.userData?.cbFloorPlan) return;
        const geometries = new Set(), materials = new Set();
        group.traverse(object => {
            if (object.geometry) geometries.add(object.geometry);
            if (object.material) materials.add(object.material);
        });
        geometries.forEach(geometry => geometry.dispose());
        materials.forEach(material => material.dispose());
        while (group.children.length) group.remove(group.children[group.children.length-1]);
    }

    function summarize(group) {
        if (!group?.userData?.cbFloorPlan || group.visible === false) return { floors: 0, buildings: 0, estimatedFloors: 0, apartments: 0, suggestedBuildings: 0 };
        const visible = group.children.filter(floor => floor.userData.cbFloorPlanFloor && floor.visible !== false);
        return {
            floors: visible.length, buildings: visible.length ? 1 : 0,
            estimatedFloors: visible.filter(floor => floor.userData.elevationBasis === 'estimated').length,
            apartments: visible.reduce((sum,floor) => sum+(floor.userData.apartmentCount || 0),0),
            suggestedBuildings: visible.length && group.userData.suggested ? 1 : 0
        };
    }
    // A below-ground cut removes the context for this draw only. Restoring visibility
    // immediately preserves every layer toggle, isolation and asynchronously arriving group.
    function renderCutaway(renderer, scene, camera, floorGroup, belowGround) {
        if (!belowGround) { renderer.render(scene, camera); return; }
        const hidden = scene.children.filter(child => child !== floorGroup && !child.isLight && child.visible);
        try {
            hidden.forEach(child => { child.visible = false; });
            renderer.render(scene, camera);
        } finally { hidden.forEach(child => { child.visible = true; }); }
    }
    function createLocalUnitGroup(THREE, architecture, geometryApi) {
        const parts = (geometryApi || global.__buildingFloorPlans).buildLocalUnitParts(architecture);
        const group = new THREE.Group(), byKind = new Map();
        group.userData.cbFloorPlan = true;
        for (const part of parts) {
            if (!byKind.has(part.kind)) byKind.set(part.kind, []);
            byKind.get(part.kind).push(part);
        }
        for (const [kind, values] of byKind) {
            const mesh = new THREE.Mesh(geometryFor(THREE,values),materialFor(THREE,kind));
            mesh.name = `UnitPart:${kind}`;
            group.add(mesh);
        }
        return group;
    }
    const api = { createLocalUnitGroup, createBuildingGroup, setCutaway, disposeGroup, summarize, renderCutaway };
    global.__threeFloorPlans = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
