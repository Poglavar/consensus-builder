/* InteriorMeshes 1.0.0 — generated from packages/interior-viewer; do not edit. */
var InteriorGeometryDependency = typeof module === "object" && module.exports ? require("./interior-geometry.js") : globalThis.InteriorGeometry;
"use strict";
var InteriorMeshes = (() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };

  // shared-interior:geometry
  var require_geometry = __commonJS({
    "shared-interior:geometry"(exports, module) {
      module.exports = InteriorGeometryDependency;
    }
  });

  // packages/interior-viewer/src/meshes.cjs
  var require_meshes = __commonJS({
    "packages/interior-viewer/src/meshes.cjs"(exports, module) {
      var ownedGroups = /* @__PURE__ */ new WeakMap();
      function rememberOwned(group) {
        const geometries = /* @__PURE__ */ new Set(), materials = /* @__PURE__ */ new Set();
        group.traverse((object) => {
          if (object.geometry) geometries.add(object.geometry);
          if (object.material) for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
        });
        ownedGroups.set(group, { geometries, materials });
        return group;
      }
      var COLORS = { wall: 15920869, slab: 12567751, door: 9135435, frame: 3159611, glass: 9222345, stair: 11578016, railing: 5397345 };
      var SUGGESTED_COLORS = { wall: 14214383, slab: 11122628, door: 8031906, frame: 3820122, glass: 10275808, stair: 10727869, railing: 5925754 };
      function materialFor(THREE, kind, colors = COLORS) {
        return new THREE.MeshPhongMaterial({
          color: colors[kind],
          side: THREE.DoubleSide,
          depthTest: true,
          depthWrite: kind !== "glass",
          transparent: kind === "glass",
          opacity: kind === "glass" ? 0.4 : 1,
          shininess: kind === "glass" ? 50 : 8
        });
      }
      function geometryFor(THREE, parts) {
        const positions = [], normals = [];
        for (const part of parts) {
          const shape = new THREE.Shape(part.rings[0].map((p) => new THREE.Vector2(p[0], p[1])));
          for (const ring of part.rings.slice(1)) {
            shape.holes.push(new THREE.Path(ring.map((p) => new THREE.Vector2(p[0], p[1]))));
          }
          const source = new THREE.ExtrudeGeometry(shape, { depth: part.heightM, bevelEnabled: false, steps: 1 });
          source.translate(0, 0, part.baseM);
          for (const value of source.attributes.position.array) positions.push(value);
          for (const value of source.attributes.normal.array) normals.push(value);
          source.dispose();
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
        return geometry;
      }
      function createBuildingGroup(THREE, feature, project, geometryApi, options = {}) {
        const api2 = geometryApi || require_geometry();
        const floors = api2.buildFloorPlanGeometry(feature, project);
        if (!floors.length) return null;
        const props = feature.properties, registration = props.floorPlans.registration, corners = registration.corners;
        const suggested = props.floorPlans.suggested === true;
        const colors = suggested ? SUGGESTED_COLORS : COLORS;
        const wrapper = new THREE.Group(), layouts = /* @__PURE__ */ new Map(), materials = /* @__PURE__ */ new Map();
        wrapper.userData = {
          cbFloorPlan: true,
          suggested,
          proposalId: props.proposalId ?? props.proposal_id ?? null,
          parcelId: props.parcelId ?? props.parcel_id ?? null,
          isNearbyBuilding3D: true,
          footprintLatLng: [corners.reduce((s, p) => s + p[0], 0) / 4, corners.reduce((s, p) => s + p[1], 0) / 4],
          floorCount: floors.length,
          estimatedFloorCount: floors.filter((f) => f.elevationBasis === "estimated").length,
          apartmentCount: floors.reduce((s, f) => s + f.apartmentCount, 0),
          buildingName: props.buildingName || props.name || null,
          availableLevels: floors.map((f) => f.level),
          registrationAccuracy: registration.accuracy,
          maxEdgeResidualM: registration.maxEdgeResidualM
        };
        for (const floor of floors) {
          let layout = layouts.get(floor.layoutId);
          if (!layout) {
            const byKind = /* @__PURE__ */ new Map();
            for (const part of floor.parts) {
              if (!byKind.has(part.kind)) byKind.set(part.kind, []);
              byKind.get(part.kind).push(part);
            }
            layout = /* @__PURE__ */ new Map();
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
            cbFloorPlanFloor: true,
            id: floor.id,
            level: floor.level,
            elevationM: floor.elevationM,
            elevationBasis: floor.elevationBasis,
            layoutId: floor.layoutId,
            sourceUrl: floor.sourceUrl,
            apartmentCount: floor.apartmentCount
          };
          for (const [kind, geometry] of layout) {
            const mesh = new THREE.Mesh(geometry, materials.get(kind));
            mesh.name = `FloorPart:${kind}`;
            mesh.userData.floorPartKind = kind;
            floorGroup.add(mesh);
          }
          wrapper.add(floorGroup);
        }
        const bands = api2.uncoveredFloorBands ? api2.uncoveredFloorBands(feature, options.proxyHeightM) : [];
        const polygons = feature.geometry?.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry?.type === "MultiPolygon" ? feature.geometry.coordinates : [];
        if (bands.length && polygons.length && options.proxyMaterial) {
          const material = options.proxyMaterial.clone();
          const declaredLevels = props.floors ?? props.storeys;
          wrapper.userData.proxyStoreyHeightM = Number.isFinite(declaredLevels) && declaredLevels > 0 ? options.proxyHeightM / declaredLevels : 3;
          for (const band of bands) {
            const parts = polygons.map((rings) => ({
              rings: rings.map((ring) => ring.map((p) => project(p[0], p[1]))),
              baseM: 0,
              heightM: band.heightM
            }));
            const mesh = new THREE.Mesh(geometryFor(THREE, parts), material);
            mesh.name = "UnmodeledFloorVolume";
            mesh.position.z = band.baseM;
            mesh.userData = { cbFloorPlanProxy: true, ...band };
            wrapper.add(mesh);
          }
        }
        return rememberOwned(wrapper);
      }
      function setCutaway(group, maxLevel) {
        if (!group?.userData?.cbFloorPlan) return;
        group.children.forEach((floor) => {
          if (floor.userData.cbFloorPlanProxy) {
            const { baseM, heightM } = floor.userData;
            const top = maxLevel === null ? Infinity : maxLevel < 0 ? 0 : (maxLevel + 1) * group.userData.proxyStoreyHeightM;
            const visibleHeight = Math.max(0, Math.min(heightM, top - baseM));
            floor.visible = visibleHeight > 0;
            floor.scale.z = visibleHeight / heightM;
          } else floor.visible = maxLevel === null || floor.userData.level <= maxLevel;
        });
      }
      function disposeGroup(group) {
        if (!group?.userData?.cbFloorPlan) return;
        const owned = ownedGroups.get(group);
        if (!owned) return;
        const { geometries, materials } = owned;
        ownedGroups.delete(group);
        geometries.forEach((geometry) => geometry.dispose());
        materials.forEach((material) => material.dispose());
        while (group.children.length) group.remove(group.children[group.children.length - 1]);
      }
      function summarize(group) {
        if (!group?.userData?.cbFloorPlan || group.visible === false) return { floors: 0, buildings: 0, estimatedFloors: 0, apartments: 0, suggestedBuildings: 0 };
        const visible = group.children.filter((floor) => floor.userData.cbFloorPlanFloor && floor.visible !== false);
        return {
          floors: visible.length,
          buildings: visible.length ? 1 : 0,
          estimatedFloors: visible.filter((floor) => floor.userData.elevationBasis === "estimated").length,
          apartments: visible.reduce((sum, floor) => sum + (floor.userData.apartmentCount || 0), 0),
          suggestedBuildings: visible.length && group.userData.suggested ? 1 : 0
        };
      }
      function renderCutaway(renderer, scene, camera, floorGroup, belowGround) {
        if (!belowGround) {
          renderer.render(scene, camera);
          return;
        }
        const hidden = scene.children.filter((child) => child !== floorGroup && !child.isLight && child.visible);
        try {
          hidden.forEach((child) => {
            child.visible = false;
          });
          renderer.render(scene, camera);
        } finally {
          hidden.forEach((child) => {
            child.visible = true;
          });
        }
      }
      function createLocalUnitGroup(THREE, architecture, geometryApi, options = {}) {
        const parts = (geometryApi || require_geometry()).buildLocalUnitParts(architecture);
        const group = new THREE.Group(), byKind = /* @__PURE__ */ new Map();
        group.userData.cbFloorPlan = true;
        for (const part of parts) {
          if (!byKind.has(part.kind)) byKind.set(part.kind, []);
          byKind.get(part.kind).push(part);
        }
        for (const [kind, values] of byKind) {
          const material = materialFor(THREE, kind);
          if (options.colors?.[kind]) {
            material.color.set(options.colors[kind]);
            material.shininess = 0;
          }
          const mesh = new THREE.Mesh(geometryFor(THREE, values), material);
          mesh.name = `UnitPart:${kind}`;
          group.add(mesh);
        }
        return rememberOwned(group);
      }
      var api = { createLocalUnitGroup, createBuildingGroup, setCutaway, disposeGroup, summarize, renderCutaway };
      module.exports = api;
    }
  });
  return require_meshes();
})();
if (typeof module === "object" && module.exports) module.exports = InteriorMeshes;
