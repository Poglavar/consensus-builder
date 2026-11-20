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

    function extrudeInto(THREE, part, positions, normals) {
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
    function mergedGeometry(THREE, positions, normals) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        return geometry;
    }
    function geometryFor(THREE, parts) {
        const positions = [], normals = [];
        for (const part of parts) extrudeInto(THREE, part, positions, normals);
        return mergedGeometry(THREE, positions, normals);
    }
    // Parts of each layout and kind, the unit a building group shares between storeys.
    function layoutParts(floors) {
        const byLayout = new Map();
        for (const floor of floors) {
            if (byLayout.has(floor.layoutId)) continue;
            const byKind = new Map();
            for (const part of floor.parts) {
                if (!byKind.has(part.kind)) byKind.set(part.kind, []);
                byKind.get(part.kind).push(part);
            }
            byLayout.set(floor.layoutId, byKind);
        }
        return byLayout;
    }

    // Subtract apartment boundaries once per layout, before pointer picking. Keep each slab,
    // landing and tread at its real height, including holes and disconnected common areas.
    function nonApartmentRegionBuilder(floor, turf) {
        const feature = polygons => ({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon',
            coordinates: polygons.map(polygon => polygon.map(ring => {
                const first = ring[0], last = ring[ring.length - 1];
                return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
            })) } });
        const bounds = polygon => polygon[0].reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]),
            Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
        const apartments = (floor.apartmentRegions || []).flatMap(region => region.polygons)
            .map(polygon => ({ polygon, bounds: bounds(polygon) }));
        return (part, index) => {
            const box = bounds(part.rings);
            // Most treads are wholly in the common core: avoid clipping them against distant
            // apartment boundaries, and never repeat this work for another storey of the layout.
            const candidates = apartments.filter(({ bounds: b }) => b[0] < box[2] && b[2] > box[0] && b[1] < box[3] && b[3] > box[1]);
            const surface = feature([part.rings]);
            const remaining = candidates.length ? turf.difference(surface, feature(candidates.map(item => item.polygon))) : surface;
            if (!remaining) return null;
            return { id: `non-apartment-${index}`, kind: 'non-apartment', elevationM: part.baseM + part.heightM,
                polygons: remaining.geometry.type === 'Polygon' ? [remaining.geometry.coordinates] : remaining.geometry.coordinates };
        };
    }
    const hoverSurfaces = floor => floor.parts.filter(part => part.kind === 'slab' || part.kind === 'stair');

    // `prepared` ({ floors, geometries: Map(layoutId → Map(kind → geometry)) }) comes from
    // createBuildingGroupCooperative, which builds the same geometry a few milliseconds at a time.
    function createBuildingGroup(THREE, feature, project, geometryApi, options = {}, prepared = null) {
        const api = geometryApi || global.__buildingFloorPlans;
        const floors = prepared?.floors || api.buildFloorPlanGeometry(feature, project);
        if (!floors.length) return null;
        const props = feature.properties, registration = props.floorPlans.registration, corners = registration.corners;
        const suggested = props.floorPlans.suggested === true;
        const colors = suggested ? SUGGESTED_COLORS : COLORS;
        const wrapper = new THREE.Group(), layouts = new Map(), materials = new Map(), tops = new Map();
        const nonApartmentRegions = prepared?.nonApartmentRegions || new Map();
        for (const floor of floors) if (!tops.has(floor.layoutId)) {
            tops.set(floor.layoutId, floor.parts.reduce((top, part) => Math.max(top, part.baseM + part.heightM), 0));
        }
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
                const byKind = prepared ? null : layoutParts([floor]).get(floor.layoutId);
                layout = prepared ? prepared.geometries.get(floor.layoutId)
                    : new Map([...byKind].map(([kind, parts]) => [kind, geometryFor(THREE, parts)]));
                for (const kind of layout.keys()) if (!materials.has(kind)) materials.set(kind, materialFor(THREE, kind, colors));
                layouts.set(floor.layoutId, layout);
                if (!prepared && options.turf) nonApartmentRegions.set(floor.layoutId,
                    hoverSurfaces(floor).map(nonApartmentRegionBuilder(floor, options.turf)).filter(Boolean));
            }
            const triangleCount = [...layout.values()].reduce((sum, geometry) => sum + geometry.attributes.position.count / 3, 0);
            const floorGroup = new THREE.Group();
            floorGroup.name = `FloorPlan:${floor.id}`;
            floorGroup.position.z = floor.elevationM;
            floorGroup.userData = {
                cbFloorPlanFloor: true, id: floor.id, level: floor.level, heightM: tops.get(floor.layoutId), triangleCount,
                elevationM: floor.elevationM, elevationBasis: floor.elevationBasis,
                layoutId: floor.layoutId, sourceUrl: floor.sourceUrl, apartmentCount: floor.apartmentCount,
                apartmentRegions: floor.apartmentRegions || [],
                nonApartmentRegions: nonApartmentRegions.get(floor.layoutId) || []
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
        if (options.withDistantShell !== false && polygons.length && options.proxyMaterial && Number.isFinite(options.proxyHeightM) && options.proxyHeightM > 0) {
            const shell = new THREE.Mesh(geometryFor(THREE, polygons.map(rings => ({
                rings: rings.map(ring => ring.map(p => project(p[0], p[1]))), baseM: 0, heightM: options.proxyHeightM
            }))), options.proxyMaterial.clone());
            shell.name = 'DistantFloorPlanShell';
            shell.userData.cbFloorPlanDistantShell = true;
            shell.userData.heightM = options.proxyHeightM;
            shell.visible = false;
            wrapper.add(shell);
        }
        const xy = corners.map(p => project(p[0], p[1]));
        wrapper.userData.detailBounds = {
            min: [Math.min(...xy.map(p => p[0])), Math.min(...xy.map(p => p[1])), Math.min(0, ...floors.map(f => f.elevationM))],
            max: [Math.max(...xy.map(p => p[0])), Math.max(...xy.map(p => p[1])), Math.max(options.proxyHeightM || 0,
                ...floors.map(f => f.elevationM + tops.get(f.layoutId)))]
        };
        return wrapper;
    }

    function createFloorOverlay(THREE, polygons, material) {
        return new THREE.Mesh(geometryFor(THREE, polygons.map(rings => ({ rings, baseM: .02, heightM: .05 }))), material);
    }

    function setDetailVisibility(group, visible) {
        if (!group?.userData?.cbFloorPlan || group.userData.detailVisible === visible) return false;
        group.userData.detailVisible = visible;
        setCutaway(group, group.userData.cutawayLevel ?? null);
        return true;
    }

    function setVisibleStoreys(THREE, group, levels) {
        const previous = group.userData.visibleStoreys;
        if (group.userData.storeyBandCutaway === group.userData.cutawayLevel && previous && previous.size === levels.size && [...levels].every(level => previous.has(level))) return false;
        group.userData.storeyBandCutaway = group.userData.cutawayLevel;
        group.userData.visibleStoreys = levels;
        setCutaway(group, group.userData.cutawayLevel ?? null);
        // Other storeys retain coarse massing. Merge adjoining intervals and reuse the
        // distant shell's geometry/material, rather than drawing their interior meshes.
        const shell = group.children.find(child => child.userData.cbFloorPlanDistantShell);
        group.children.filter(child => child.userData.cbFloorPlanCoarseBand).forEach(child => group.remove(child));
        if (!shell || !levels.size) return true;
        const maxLevel = group.userData.cutawayLevel;
        const floors = group.children.filter(child => child.userData.cbFloorPlanFloor).sort((a,b) => a.position.z - b.position.z);
        const intervals = [];
        floors.forEach((floor, index) => {
            if (levels.has(floor.userData.level) || (maxLevel !== null && floor.userData.level > maxLevel)) return;
            const base = floor.position.z;
            const next = floors[index + 1];
            const top = next ? next.position.z : base + floor.userData.heightM;
            const last = intervals[intervals.length - 1];
            if (last && Math.abs(last[1] - base) < .01) last[1] = top;
            else intervals.push([base, top]);
        });
        for (const [base, top] of intervals) {
            const band = new THREE.Mesh(shell.geometry, shell.material);
            band.userData.cbFloorPlanCoarseBand = true;
            band.position.z = base; band.scale.z = Math.max(.001, top - base - .01) / shell.userData.heightM;
            group.add(band);
        }
        return true;
    }

    function setCutaway(group, maxLevel) {
        if (!group?.userData?.cbFloorPlan) return;
        group.userData.cutawayLevel = maxLevel;
        const details = group.userData.detailVisible !== false;
        group.children.forEach(floor => {
            if (floor.userData.cbFloorPlanDistantShell) {
                const height = floor.userData.heightM;
                const top = maxLevel === null ? height : Math.max(0, ...group.children
                    .filter(child => child.userData.cbFloorPlanFloor && child.userData.level <= maxLevel)
                    .map(child => child.position.z + child.userData.heightM));
                floor.scale.z = Math.min(height, top) / height;
                floor.visible = !details && top > 0;
            } else if (floor.userData.cbFloorPlanCoarseBand) {
                floor.visible = details;
            } else if (floor.userData.cbFloorPlanProxy) {
                const { baseM, heightM } = floor.userData;
                const top = maxLevel === null ? Infinity : maxLevel < 0 ? 0
                    : (maxLevel + 1) * group.userData.proxyStoreyHeightM;
                const visibleHeight = Math.max(0, Math.min(heightM, top - baseM));
                floor.visible = details && visibleHeight > 0;
                floor.scale.z = visibleHeight / heightM;
            } else floor.visible = details && (maxLevel === null || floor.userData.level <= maxLevel)
                && (!group.userData.visibleStoreys || group.userData.visibleStoreys.has(floor.userData.level));
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
    // `kept` is the floor-plan group, or a list of objects anywhere in the scene (an X-ray-cut
    // building model inside the buildings group): they stay, and everything beside them and their
    // ancestors is hidden.
    function renderCutaway(renderer, scene, camera, kept, belowGround) {
        if (!belowGround) { renderer.render(scene, camera); return; }
        const keep = new Set((Array.isArray(kept) ? kept : [kept]).filter(Boolean));
        const ancestors = new Set();
        keep.forEach(object => { for (let node = object.parent; node && node !== scene; node = node.parent) ancestors.add(node); });
        const hidden = [];
        const hideBeside = node => node.children.forEach(child => {
            if (keep.has(child)) return;
            if (ancestors.has(child)) { hideBeside(child); return; }
            if (!child.isLight && child.visible) hidden.push(child);
        });
        hideBeside(scene);
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
    // The same group as createBuildingGroup, with its extrusions spread over tasks by `work.forEach`
    // (three-scene-work.js: a time budget per task), so adding one building does not hold a frame.
    // Resolves null when `work.isCurrent()` turns false; the geometry built so far is disposed.
    async function createBuildingGroupCooperative(THREE, feature, project, geometryApi, options, work) {
        const api = geometryApi || global.__buildingFloorPlans;
        const floors = api.buildFloorPlanGeometry(feature, project);
        if (!floors.length) return null;
        const isCurrent = work.isCurrent || (() => true);
        const geometries = new Map(), nonApartmentRegions = new Map(), built = [];
        let completed = false;
        try {
            for (const [layoutId, byKind] of layoutParts(floors)) {
                const layout = new Map();
                for (const [kind, parts] of byKind) {
                    const positions = [], normals = [];
                    if (!await work.forEach(parts, part => extrudeInto(THREE, part, positions, normals), { isCurrent })) {
                        return null;
                    }
                    const geometry = mergedGeometry(THREE, positions, normals);
                    built.push(geometry);
                    layout.set(kind, geometry);
                }
                geometries.set(layoutId, layout);
                if (options.turf) {
                    const floor = floors.find(floor => floor.layoutId === layoutId), regions = [];
                    const regionFor = nonApartmentRegionBuilder(floor, options.turf);
                    if (!await work.forEach(hoverSurfaces(floor), (part, index) => {
                        const region = regionFor(part, index);
                        if (region) regions.push(region);
                    }, { isCurrent })) return null;
                    nonApartmentRegions.set(layoutId, regions);
                }
            }
            const group = createBuildingGroup(THREE, feature, project, api, options, { floors, geometries, nonApartmentRegions });
            completed = true;
            return group;
        } finally {
            if (!completed) built.forEach(geometry => geometry.dispose());
        }
    }
    const api = { createLocalUnitGroup, createBuildingGroup, createBuildingGroupCooperative, setCutaway, setDetailVisibility, setVisibleStoreys, createFloorOverlay, disposeGroup, summarize, renderCutaway };
    global.__threeFloorPlans = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
