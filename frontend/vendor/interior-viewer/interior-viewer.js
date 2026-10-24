/* InteriorViewer 1.0.0 — generated from packages/interior-viewer; do not edit. */
"use strict";
var InteriorViewer = (() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };

  // packages/interior-viewer/src/geometry.cjs
  var require_geometry = __commonJS({
    "packages/interior-viewer/src/geometry.cjs"(exports, module) {
      "use strict";
      var SCHEMA = "consensus-builder.building-floor-plans.v2";
      var finite = (value) => typeof value === "number" && Number.isFinite(value);
      var error = (path, message) => `${path}: ${message}`;
      function httpUrl(value) {
        if (typeof value !== "string") return false;
        try {
          const url = new URL(value);
          return url.protocol === "http:" || url.protocol === "https:";
        } catch (_) {
          return false;
        }
      }
      var orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      function buildingSourceId(feature) {
        const properties = feature?.properties;
        for (const [field, prefix] of [["sourceFeatureId", ""], ["dguBuildingId", "dgu-building:"], ["sourceLayerId", "source-layer:"]]) {
          const value = properties?.[field];
          if (typeof value === "string" && value.trim() || finite(value) && Number.isInteger(value)) {
            return prefix + String(value);
          }
        }
        return null;
      }
      function uncoveredFloorBands(feature, totalHeight) {
        if (!feature?.properties?.floorPlans || !finite(totalHeight) || totalHeight <= 0) return [];
        const joinToleranceM = 2e-3;
        const plans = feature.properties.floorPlans;
        const layouts = new Map((Array.isArray(plans.layouts) ? plans.layouts : []).map((layout) => [layout.id, layout]));
        const covered = [];
        for (const floor of Array.isArray(plans.floors) ? plans.floors : []) {
          const base = floor?.elevationM;
          const architecture = layouts.get(floor?.layoutId)?.architecture;
          const wallHeight = architecture?.wallHeightM;
          const slabThickness = architecture?.slabThicknessM;
          if (!finite(base) || !finite(wallHeight) || !finite(slabThickness)) continue;
          const height = wallHeight + slabThickness;
          if (height <= 0) continue;
          const top = base + height;
          if (top <= 0 || base >= totalHeight) continue;
          const start = Math.max(0, base), end = Math.min(totalHeight, top);
          if (end > start) covered.push([start, end]);
        }
        if (!covered.length) return [{ baseM: 0, heightM: totalHeight }];
        covered.sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const interval of covered) {
          const previous = merged.at(-1);
          if (previous && interval[0] <= previous[1] + joinToleranceM) previous[1] = Math.max(previous[1], interval[1]);
          else merged.push(interval);
        }
        const gaps = [];
        let cursor = 0;
        for (const [start, end] of merged) {
          if (start - cursor > joinToleranceM) gaps.push({ baseM: cursor, heightM: start - cursor });
          cursor = Math.max(cursor, end);
        }
        if (totalHeight - cursor > joinToleranceM) gaps.push({ baseM: cursor, heightM: totalHeight - cursor });
        return gaps;
      }
      function validateFloorPlans(data) {
        const errors = [];
        if (!data || typeof data !== "object" || Array.isArray(data)) return ["floorPlans: must be an object"];
        if (data.schema !== SCHEMA) errors.push(error("floorPlans.schema", `must equal ${SCHEMA}`));
        const registration = data.registration, corners = registration && registration.corners;
        const validCorners = Array.isArray(corners) && corners.length === 4 && corners.every((c) => Array.isArray(c) && c.length === 2 && finite(c[0]) && finite(c[1]) && c[0] >= -180 && c[0] <= 180 && c[1] >= -90 && c[1] <= 90);
        if (!validCorners) errors.push(error("floorPlans.registration.corners", "must contain four finite [lng,lat] corners within WGS84 ranges"));
        else {
          const span = corners.reduce((max, c) => Math.max(max, ...corners.map((d) => Math.hypot((c[0] - d[0]) * 111320 * Math.cos(c[1] * Math.PI / 180), (c[1] - d[1]) * 111320))), 0);
          const turns = corners.map((c, i) => orient(c, corners[(i + 1) % 4], corners[(i + 2) % 4]));
          if (!(span > 0) || !(turns.every((turn) => turn > 0) || turns.every((turn) => turn < 0))) {
            errors.push(error("floorPlans.registration.corners", "must form a nondegenerate convex quadrilateral"));
          }
          if (span > 1e3) errors.push(error("floorPlans.registration.corners", "must span no more than 1 km"));
        }
        if (typeof registration?.basis !== "string" || !registration.basis.trim()) errors.push(error("floorPlans.registration.basis", "must be a non-empty string"));
        const layouts = data.layouts, layoutIds = /* @__PURE__ */ new Set();
        if (!Array.isArray(layouts) || layouts.length > 100) errors.push(error("floorPlans.layouts", "must be an array of at most 100 layouts"));
        else layouts.forEach((layout, li) => {
          const path = `floorPlans.layouts[${li}]`;
          if (!layout || typeof layout !== "object" || typeof layout.id !== "string" || !layout.id) errors.push(error(`${path}.id`, "must be a non-empty string"));
          else if (layoutIds.has(layout.id)) errors.push(error(`${path}.id`, "must be unique"));
          else layoutIds.add(layout.id);
          errors.push(...validateArchitecture(layout?.architecture, `${path}.architecture`));
          const source = layout?.source;
          if (!source || typeof source !== "object") errors.push(error(`${path}.source`, "is required"));
          else if (source.kind === "generated") {
            if (typeof source.generator !== "string" || !source.generator.trim()) errors.push(error(`${path}.source.generator`, "must name the generator"));
            if (!source.parameters || typeof source.parameters !== "object" || Array.isArray(source.parameters)) errors.push(error(`${path}.source.parameters`, "must be an object"));
            if (data.suggested !== true) errors.push(error(`${path}.source.kind`, "generated layouts require floorPlans.suggested = true"));
          } else {
            if (!httpUrl(source.url)) errors.push(error(`${path}.source.url`, "must be a valid http(s) URL"));
            if (source.page !== void 0 && (!Number.isInteger(source.page) || source.page < 1)) errors.push(error(`${path}.source.page`, "must be a positive integer"));
            if (source.crop !== void 0 && (!Array.isArray(source.crop) || source.crop.length !== 4 || source.crop.some((value) => !finite(value)))) errors.push(error(`${path}.source.crop`, "must contain four finite values"));
            if (typeof source.sha256 !== "string" || !source.sha256) errors.push(error(`${path}.source.sha256`, "must be a non-empty string"));
          }
        });
        const floors = data.floors, floorIds = /* @__PURE__ */ new Set(), levels = /* @__PURE__ */ new Set();
        if (!Array.isArray(floors)) errors.push(error("floorPlans.floors", "must be an array"));
        else if (floors.length > 100) errors.push(error("floorPlans.floors", "must contain at most 100 floors"));
        else floors.forEach((floor, fi) => {
          const path = `floorPlans.floors[${fi}]`;
          if (!floor || typeof floor !== "object" || typeof floor.id !== "string" || !floor.id || floorIds.has(floor.id)) errors.push(error(`${path}.id`, "must be a unique non-empty string"));
          else floorIds.add(floor.id);
          if (!finite(floor?.level) || !Number.isInteger(floor.level) || levels.has(floor.level)) errors.push(error(`${path}.level`, "must be a unique integer"));
          else levels.add(floor.level);
          if (!finite(floor?.elevationM)) errors.push(error(`${path}.elevationM`, "must be finite"));
          if (!["documented", "estimated"].includes(floor?.elevationBasis)) errors.push(error(`${path}.elevationBasis`, "must be documented or estimated"));
          if (typeof floor?.layoutId !== "string" || !layoutIds.has(floor.layoutId)) errors.push(error(`${path}.layoutId`, "must reference a layout"));
          if (floor?.apartments !== void 0 && !Array.isArray(floor.apartments)) errors.push(error(`${path}.apartments`, "must be an array"));
          if (Array.isArray(floor?.apartments)) floor.apartments.forEach((apartment, ai) => {
            const apartmentPath = `${path}.apartments[${ai}]`;
            if (!apartment || typeof apartment.id !== "string" || !apartment.id) {
              errors.push(error(`${apartmentPath}.id`, "must be a non-empty string"));
            }
            if (apartment?.areaM2 !== void 0 && (!finite(apartment.areaM2) || apartment.areaM2 <= 0)) {
              errors.push(error(`${apartmentPath}.areaM2`, "must be a positive finite number"));
            }
            if (apartment?.url !== void 0 && !httpUrl(apartment.url)) {
              errors.push(error(`${apartmentPath}.url`, "must be a valid http(s) URL"));
            }
          });
        });
        if (!errors.length) {
          const layoutSizes = new Map(layouts.map((layout) => [layout.id, estimateArchitectureParts(layout.architecture)]));
          const count = floors.reduce((sum, floor) => sum + layoutSizes.get(floor.layoutId), 0);
          if (count > 5e4) errors.push(error("floorPlans.floors", "expanded model must not exceed 50000 solid parts"));
        }
        return errors;
      }
      var ARCHITECTURE_SCHEMA = "consensus-builder.floor-architecture.v1";
      var uvPoint = (p) => Array.isArray(p) && p.length === 2 && p.every((v) => finite(v) && v >= 0 && v <= 1);
      var bounded = (v, min, max) => finite(v) && v >= min && v <= max;
      var length = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
      var lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      function validateArchitecture(model, path = "architecture") {
        const errors = [];
        const fail = (field, message) => errors.push(error(`${path}.${field}`, message));
        if (!model || model.schema !== ARCHITECTURE_SCHEMA) return [error(path, `must use ${ARCHITECTURE_SCHEMA}`)];
        if (!Array.isArray(model.dimensionsM) || model.dimensionsM.length !== 2 || !model.dimensionsM.every((n) => bounded(n, 1, 1e3))) fail("dimensionsM", "must contain two positive metric dimensions");
        if (!bounded(model.wallHeightM, 1, 12)) fail("wallHeightM", "must be 1..12 metres");
        if (!bounded(model.slabThicknessM, 0.02, 1)) fail("slabThicknessM", "must be .02..1 metres");
        let vertices = 0;
        for (const kind of ["walls", "slabs", "landings", "platforms"]) {
          const polygons = kind === "platforms" ? (model.platforms || []).map((platform) => platform?.rings) : model[kind];
          if (!Array.isArray(polygons)) {
            fail(kind, "must be an array of polygons");
            continue;
          }
          if (["walls", "slabs"].includes(kind) && !polygons.length) fail(kind, "must contain geometry");
          for (const [i, polygon] of polygons.entries()) {
            if (kind === "platforms" && !bounded(model.platforms[i]?.elevationM, -12, 12)) fail(`${kind}[${i}]`, "requires a finite elevation");
            if (!Array.isArray(polygon) || !polygon.length) {
              fail(`${kind}[${i}]`, "must contain an outer ring");
              continue;
            }
            for (const ring of polygon) {
              if (!Array.isArray(ring) || ring.length < 3 || !ring.every(uvPoint)) {
                fail(`${kind}[${i}]`, "rings need at least three normalized points");
                continue;
              }
              vertices += ring.length;
              const area = ring.reduce((sum, p, j) => sum + p[0] * ring[(j + 1) % ring.length][1] - p[1] * ring[(j + 1) % ring.length][0], 0);
              if (Math.abs(area) < 1e-12) fail(`${kind}[${i}]`, "rings must have nonzero area");
            }
          }
        }
        if (vertices > 1e5) fail("walls", "layout must not exceed 100000 polygon vertices");
        for (const kind of ["openings", "stairs", "railings"]) {
          if (!Array.isArray(model[kind]) || model[kind].length > 2e3) {
            fail(kind, "must contain at most 2000 elements");
            continue;
          }
          for (const [i, item] of model[kind].entries()) {
            const key = `${kind}[${i}]`;
            if (!uvPoint(item?.a) || !uvPoint(item?.b) || length(item.a, item.b) < 1e-7) fail(key, "requires distinct normalized endpoints");
            if (kind === "openings") {
              if (!["door", "window", "glazedDoor", "slidingDoor"].includes(item?.kind)) fail(key, "unknown opening kind");
              if (!bounded(item?.depthM, 0.02, 1) || !bounded(item?.sillM, 0, model.wallHeightM) || !bounded(item?.heightM, 0.1, model.wallHeightM) || item.sillM + item.heightM > model.wallHeightM + 1e-3) fail(key, "invalid opening dimensions");
              if (item?.kind === "door" && (!uvPoint(item.hinge) || !uvPoint(item.openTip) || length(item.hinge, item.openTip) < 1e-7)) fail(key, "door requires its hinge and swung leaf endpoint");
            } else if (kind === "stairs") {
              if (!bounded(item?.widthM, 0.3, 5) || !Number.isInteger(item?.steps) || !bounded(item.steps, 1, 64) || !bounded(item?.fromM, -12, 12) || !bounded(item?.toM, -12, 12) || item.toM <= item.fromM) fail(key, "invalid stair dimensions");
            } else if (!bounded(item?.heightM, 0.5, 2)) fail(key, "invalid railing height");
          }
        }
        return errors;
      }
      function estimateArchitectureParts(model) {
        const span = (item) => Math.hypot((item.b[0] - item.a[0]) * model.dimensionsM[0], (item.b[1] - item.a[1]) * model.dimensionsM[1]);
        return model.walls.length + model.slabs.length + model.landings.length + (model.platforms || []).length + model.openings.reduce((n, item) => n + 8 + Math.ceil(span(item) / 1.4), 0) + model.stairs.reduce((n, item) => n + item.steps, 0) + model.railings.reduce((n, item) => n + 3 + Math.ceil(span(item) / 1.15), 0);
      }
      function buildArchitectureParts(model, projectUv) {
        const [width, height] = model.dimensionsM;
        const metric = (p) => [p[0] * width, p[1] * height];
        const projectMetric = (p) => projectUv(p[0] / width, p[1] / height);
        const parts = [];
        function polygon(kind, rings, baseM, heightM) {
          if (heightM <= 1e-3) return;
          parts.push({ kind, rings, baseM, heightM });
        }
        function strip(kind, a, b, depthM, baseM, heightM) {
          const size = length(a, b);
          if (size < 1e-3 || heightM <= 1e-3) return;
          const nx = -(b[1] - a[1]) / size * depthM / 2, ny = (b[0] - a[0]) / size * depthM / 2;
          polygon(kind, [[[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]].map(projectMetric)], baseM, heightM);
        }
        function sourcePolygons(kind, polygons, base, heightM) {
          polygons.forEach((rings) => polygon(kind, rings.map((ring) => ring.map((p) => projectUv(p[0], p[1]))), base, heightM));
        }
        sourcePolygons("wall", model.walls, 0, model.wallHeightM);
        sourcePolygons("slab", model.slabs, -model.slabThicknessM, model.slabThicknessM);
        const halfStorey = (model.wallHeightM + model.slabThicknessM) / 2;
        sourcePolygons("stair", model.landings, halfStorey - model.slabThicknessM, model.slabThicknessM);
        for (const platform of model.platforms || []) {
          if (platform.kind === "landing" && Math.abs(platform.elevationM) < 1e-8) continue;
          sourcePolygons("stair", [platform.rings], platform.elevationM - model.slabThicknessM, model.slabThicknessM);
        }
        for (const opening of model.openings) {
          const a = metric(opening.a), b = metric(opening.b), size = length(a, b);
          const { depthM, sillM, heightM } = opening;
          const frame = Math.min(0.055, size / 4);
          strip("wall", a, b, depthM, 0, sillM);
          strip("wall", a, b, depthM, sillM + heightM, model.wallHeightM - sillM - heightM);
          strip("frame", a, lerp(a, b, frame / size), depthM + 0.015, sillM, heightM);
          strip("frame", lerp(a, b, 1 - frame / size), b, depthM + 0.015, sillM, heightM);
          strip("frame", a, b, depthM + 0.015, sillM + heightM - frame, frame);
          if (opening.kind === "door") {
            strip("door", metric(opening.hinge), metric(opening.openTip), 0.04, 0.015, heightM - 0.07);
          } else if (opening.kind === "slidingDoor") {
            strip("door", lerp(a, b, frame / size), lerp(a, b, 0.497), 0.045, sillM, heightM - frame);
            strip("door", lerp(a, b, 0.503), lerp(a, b, 1 - frame / size), 0.045, sillM, heightM - frame);
          } else {
            strip("frame", a, b, depthM + 0.015, sillM, frame);
            strip("glass", lerp(a, b, frame / size), lerp(a, b, 1 - frame / size), 0.018, sillM + frame, heightM - frame * 2);
            const panes = Math.ceil(size / 1.4);
            for (let pane = 1; pane < panes; pane++) {
              const centre = pane / panes;
              strip("frame", lerp(a, b, centre - frame / (2 * size)), lerp(a, b, centre + frame / (2 * size)), depthM * 0.6, sillM, heightM);
            }
          }
        }
        for (const stair of model.stairs) {
          const a = metric(stair.a), b = metric(stair.b);
          const rise = (stair.toM - stair.fromM) / stair.steps;
          for (let step = 0; step < stair.steps; step++) {
            strip(
              "stair",
              lerp(a, b, step / stair.steps),
              lerp(a, b, (step + 1) / stair.steps),
              stair.widthM,
              stair.fromM + step * rise - 0.15,
              rise + 0.15
            );
          }
        }
        for (const rail of model.railings) {
          const a = metric(rail.a), b = metric(rail.b), size = length(a, b);
          strip("railing", a, b, 0.055, rail.heightM - 0.055, 0.055);
          strip("railing", a, b, 0.035, rail.heightM * 0.5, 0.035);
          const posts = Math.ceil(size / 1.15);
          for (let post = 0; post <= posts; post++) {
            const centre = lerp(a, b, post / posts), direction = [(b[0] - a[0]) / size, (b[1] - a[1]) / size];
            strip("railing", [centre[0] - 0.025 * direction[0], centre[1] - 0.025 * direction[1]], [centre[0] + 0.025 * direction[0], centre[1] + 0.025 * direction[1]], 0.05, 0, rail.heightM);
          }
        }
        return parts;
      }
      function buildFloorPlanGeometry(feature, project) {
        const plans = feature?.properties?.floorPlans;
        if (plans == null) return [];
        const errors = validateFloorPlans(plans);
        if (errors.length) throw new Error(`Invalid floorPlans: ${errors.join("; ")}`);
        if (typeof project !== "function") throw new Error("buildFloorPlanGeometry requires a project(lng, lat) function");
        const c = plans.registration.corners;
        const interpolate = (u, v) => {
          const lng = (1 - u) * (1 - v) * c[0][0] + u * (1 - v) * c[1][0] + u * v * c[2][0] + (1 - u) * v * c[3][0];
          const lat = (1 - u) * (1 - v) * c[0][1] + u * (1 - v) * c[1][1] + u * v * c[2][1] + (1 - u) * v * c[3][1];
          const point = project(lng, lat);
          if (!Array.isArray(point) || point.length !== 2 || !point.every(finite)) throw new Error("Projection must return finite [x,y] coordinates");
          return point;
        };
        const layouts = new Map(plans.layouts.map((layout) => [layout.id, {
          source: layout.source,
          parts: buildArchitectureParts(layout.architecture, interpolate)
        }]));
        return plans.floors.map((floor) => ({
          id: floor.id,
          level: floor.level,
          layoutId: floor.layoutId,
          elevationM: floor.elevationM,
          elevationBasis: floor.elevationBasis,
          parts: layouts.get(floor.layoutId).parts,
          apartmentCount: (floor.apartments || []).length,
          sourceUrl: floor.source?.url || layouts.get(floor.layoutId).source.url
        }));
      }
      function refreshRegisteredFloorPlans(buildings, sources) {
        const byId = /* @__PURE__ */ new Map();
        for (const source of sources || []) {
          const id = buildingSourceId(source);
          if (!id || !source.properties.floorPlans) continue;
          if (byId.has(id)) byId.set(id, null);
          else byId.set(id, source);
        }
        const checked = /* @__PURE__ */ new Set();
        let changed = 0;
        const result = buildings.map((building) => {
          const source = byId.get(buildingSourceId(building));
          if (!source || building.geometry?.type !== source.geometry?.type || JSON.stringify(building.geometry?.coordinates) !== JSON.stringify(source.geometry?.coordinates)) return building;
          const plans = source.properties.floorPlans;
          if (!checked.has(plans)) {
            const errors = validateFloorPlans(plans);
            if (errors.length) throw new Error(`Invalid floor model: ${errors.join("; ")}`);
            checked.add(plans);
          }
          if (JSON.stringify(building.properties.floorPlans) === JSON.stringify(plans)) return building;
          changed++;
          return { ...building, properties: { ...building.properties, floorPlans: structuredClone(plans) } };
        });
        return { buildings: result, changed };
      }
      function buildLocalUnitParts(architecture) {
        const errors = validateArchitecture(architecture);
        if (errors.length) throw new Error(errors.join("; "));
        const [width, depth] = architecture.dimensionsM;
        return buildArchitectureParts(architecture, (u, v) => [u * width, (1 - v) * depth]);
      }
      function registrationToLngLat(plans) {
        const c = plans.registration.corners;
        return (u, v) => [
          (1 - u) * (1 - v) * c[0][0] + u * (1 - v) * c[1][0] + u * v * c[2][0] + (1 - u) * v * c[3][0],
          (1 - u) * (1 - v) * c[0][1] + u * (1 - v) * c[1][1] + u * v * c[2][1] + (1 - u) * v * c[3][1]
        ];
      }
      function floorPlanToGeoJSON(plans, level) {
        const errors = validateFloorPlans(plans);
        if (errors.length) throw new Error(`Invalid floorPlans: ${errors.join("; ")}`);
        const floor = plans.floors.find((entry) => entry.level === level);
        if (!floor) return { type: "FeatureCollection", features: [] };
        const layout = plans.layouts.find((entry) => entry.id === floor.layoutId);
        const toLngLat = registrationToLngLat(plans);
        const ring = (points) => points.map((p) => toLngLat(p[0], p[1])).concat([toLngLat(points[0][0], points[0][1])]);
        const features = [];
        const polygonFeatures = (kind, polygons) => polygons.forEach((rings) => features.push({
          type: "Feature",
          properties: { kind, level, suggested: plans.suggested === true },
          geometry: { type: "Polygon", coordinates: rings.map(ring) }
        }));
        const lineFeatures = (kind, items, extra = () => ({})) => items.forEach((item) => features.push({
          type: "Feature",
          properties: { kind, level, suggested: plans.suggested === true, ...extra(item) },
          geometry: { type: "LineString", coordinates: [toLngLat(item.a[0], item.a[1]), toLngLat(item.b[0], item.b[1])] }
        }));
        const architecture = layout.architecture;
        polygonFeatures("slab", architecture.slabs);
        polygonFeatures("wall", architecture.walls);
        polygonFeatures("landing", architecture.landings);
        lineFeatures("opening", architecture.openings, (item) => ({ opening: item.kind }));
        lineFeatures("stair", architecture.stairs, (item) => ({ steps: item.steps }));
        lineFeatures("railing", architecture.railings);
        return { type: "FeatureCollection", features };
      }
      var api = { buildLocalUnitParts, SCHEMA, ARCHITECTURE_SCHEMA, buildingSourceId, uncoveredFloorBands, validateArchitecture, validateFloorPlans, buildFloorPlanGeometry, refreshRegisteredFloorPlans, registrationToLngLat, floorPlanToGeoJSON };
      module.exports = api;
    }
  });

  // packages/interior-viewer/src/meshes.cjs
  var require_meshes = __commonJS({
    "packages/interior-viewer/src/meshes.cjs"(exports, module) {
      "use strict";
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

  // packages/interior-viewer/src/navigation.cjs
  var require_navigation = __commonJS({
    "packages/interior-viewer/src/navigation.cjs"(exports, module) {
      "use strict";
      var BODY_RADIUS_M = 0.36;
      var MIN_SEPARATION_M = 0.76;
      var distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      var validPoint = (p) => Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite);
      function pointSegmentDistance(p, a, b) {
        const dx = b[0] - a[0], dy = b[1] - a[1], size = dx * dx + dy * dy;
        const t = size ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / size)) : 0;
        return distance(p, [a[0] + t * dx, a[1] + t * dy]);
      }
      function segmentDistance(a, b, c, d) {
        const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
        if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
        return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
      }
      function inRing(p, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i], b = ring[j];
          if (a[1] > p[1] !== b[1] > p[1] && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
        }
        return inside;
      }
      var inPolygon = (p, rings) => inRing(p, rings[0]) && !rings.slice(1).some((r) => inRing(p, r));
      var edges = (rings) => rings.flatMap((ring) => ring.map((a, i) => [a, ring[(i + 1) % ring.length]]));
      function strip(a, b, width) {
        const size = distance(a, b);
        if (size < 1e-6) return null;
        const nx = -(b[1] - a[1]) / size * width / 2, ny = (b[0] - a[0]) / size * width / 2;
        return [[[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]];
      }
      function buildNavigation(architecture) {
        const dimensions = architecture?.dimensionsM;
        if (!Array.isArray(dimensions) || dimensions.length !== 2 || !dimensions.every((v) => Number.isFinite(v) && v > 0 && v <= 80)) return null;
        const [width, depth] = dimensions, metric = (p) => [p[0] * width, (1 - p[1]) * depth];
        const validPolygon = (rings) => Array.isArray(rings) && rings.length && rings.every((r) => Array.isArray(r) && r.length >= 3 && r.every(validPoint));
        for (const polygons of [architecture.slabs, architecture.walls || [], architecture.landings || [], (architecture.platforms || []).map((p) => p.rings)]) if (!Array.isArray(polygons) || !polygons.every(validPolygon)) return null;
        const convert = (polygons) => (polygons || []).map((rings) => rings.map((r) => r.map(metric)));
        const supports = convert(architecture.slabs);
        if (!supports.length) return null;
        const obstacles = convert(architecture.walls).concat(convert(architecture.landings));
        for (const platform of architecture.platforms || []) obstacles.push(...convert([platform.rings]));
        const addStrip = (a, b, size) => {
          if (validPoint(a) && validPoint(b) && Number.isFinite(size) && size > 0) {
            const polygon = strip(metric(a), metric(b), size);
            if (polygon) obstacles.push(polygon);
          }
        };
        for (const stair of architecture.stairs || []) {
          if (!validPoint(stair.a) || !validPoint(stair.b) || !Number.isFinite(stair.widthM) || stair.widthM <= 0) return null;
          addStrip(stair.a, stair.b, stair.widthM);
        }
        for (const rail of architecture.railings || []) addStrip(rail.a, rail.b, 0.06);
        for (const opening of architecture.openings || []) {
          if (!validPoint(opening.a) || !validPoint(opening.b)) return null;
          if (opening.kind !== "door" || !Number.isFinite(opening.sillM) || opening.sillM > 0.03 || !Number.isFinite(opening.heightM) || opening.heightM < 1.9) {
            addStrip(opening.a, opening.b, Math.max(opening.depthM || 0, 0.06));
            continue;
          }
          if (!validPoint(opening.hinge) || !validPoint(opening.openTip)) return null;
          addStrip(opening.hinge, opening.openTip, 0.04);
          const a = metric(opening.a), b = metric(opening.b), size = distance(a, b);
          if (size < 1e-3) continue;
          const t = Math.min(0.055, size / 4) / size, lerp = (f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
          for (const [p, q] of [[a, lerp(t)], [lerp(1 - t), b]]) {
            const polygon = strip(p, q, Math.max(opening.depthM || 0, 0.06) + 0.015);
            if (polygon) obstacles.push(polygon);
          }
        }
        const supportEdges = supports.map(edges), obstacleEdges = obstacles.map(edges), radius = BODY_RADIUS_M;
        function canWalk(a, b = a) {
          if (!validPoint(a) || !validPoint(b)) return false;
          if (!supports.some((rings, i) => inPolygon(a, rings) && inPolygon(b, rings) && supportEdges[i].every(([c, d]) => segmentDistance(a, b, c, d) >= radius))) return false;
          return obstacles.every((rings, i) => !inPolygon(a, rings) && !inPolygon(b, rings) && obstacleEdges[i].every(([c, d]) => segmentDistance(a, b, c, d) >= radius));
        }
        const step = Math.max(0.22, Math.sqrt(width * depth / 14e3)), cols = Math.ceil(width / step), rows = Math.ceil(depth / step);
        const points = [], links = [], grid = new Int32Array(cols * rows).fill(-1);
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
          const p = [(x + 0.5) * step, (y + 0.5) * step];
          if (!canWalk(p)) continue;
          const id = points.length;
          grid[y * cols + x] = id;
          points.push(p);
          links.push([]);
          for (const other of [x ? grid[y * cols + x - 1] : -1, y ? grid[(y - 1) * cols + x] : -1]) if (other >= 0 && canWalk(p, points[other])) {
            links[id].push(other);
            links[other].push(id);
          }
        }
        const components = [], seen = /* @__PURE__ */ new Set();
        for (let id = 0; id < points.length; id++) if (!seen.has(id)) {
          const ids = [id];
          seen.add(id);
          for (let i = 0; i < ids.length; i++) for (const next of links[ids[i]]) if (!seen.has(next)) {
            seen.add(next);
            ids.push(next);
          }
          components.push(ids);
        }
        components.sort((a, b) => b.length - a.length);
        return { points, links, components, step, radius, canWalk };
      }
      function findPath(nav, start, end) {
        if (!nav?.points[start] || !nav.points[end]) return [];
        const queue = [start], parents = /* @__PURE__ */ new Map([[start, null]]);
        for (let i = 0; i < queue.length && !parents.has(end); i++) for (const next of nav.links[queue[i]]) if (!parents.has(next)) {
          parents.set(next, queue[i]);
          queue.push(next);
        }
        if (!parents.has(end)) return [];
        const result = [];
        for (let id = end; id !== null; id = parents.get(id)) result.push(id);
        return result.reverse();
      }
      function createWalkers(nav, random = Math.random) {
        const ids = nav?.components[0];
        if (!ids || ids.length * nav.step * nav.step < 2) return [];
        const centre = ids.reduce((p, id) => [p[0] + nav.points[id][0] / ids.length, p[1] + nav.points[id][1] / ids.length], [0, 0]);
        const first = ids.reduce((best, id) => distance(nav.points[id], centre) < distance(nav.points[best], centre) ? id : best, ids[0]);
        const second = ids.reduce((best, id) => distance(nav.points[id], nav.points[first]) > distance(nav.points[best], nav.points[first]) ? id : best, first);
        if (distance(nav.points[first], nav.points[second]) < 1.2) return [];
        return [first, second].map((id, index) => ({ id, x: nav.points[id][0], y: nav.points[id][1], heading: index ? Math.PI : 0, path: [], pause: 1 + random() * 3, phase: 0, moving: false, blocked: 0 }));
      }
      function advanceWalkers(nav, walkers, delta, random = Math.random) {
        const dt = Math.max(0, Math.min(delta, 0.1));
        let changed = false;
        for (const walker of walkers) {
          if (walker.controlled) continue;
          const wasMoving = walker.moving;
          walker.moving = false;
          if (walker.pause > 0) walker.pause = Math.max(0, walker.pause - dt);
          else {
            if (!walker.path.length) {
              const ids = nav.components[0], candidates = ids.filter((id) => distance(nav.points[id], [walker.x, walker.y]) > 1.2 && walkers.every((other) => other === walker || distance(nav.points[id], [other.x, other.y]) > MIN_SEPARATION_M));
              if (candidates.length) walker.path = findPath(nav, walker.id, candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]).slice(1);
              else walker.pause = 2;
            }
            const next = nav.points[walker.path[0]];
            if (next) {
              const from = [walker.x, walker.y], remaining = distance(from, next), travel = Math.min(0.65 * dt, remaining), t = remaining ? travel / remaining : 1;
              const to = [from[0] + (next[0] - from[0]) * t, from[1] + (next[1] - from[1]) * t];
              if (walkers.every((other) => other === walker || pointSegmentDistance([other.x, other.y], from, to) >= MIN_SEPARATION_M)) {
                walker.heading = Math.atan2(next[1] - walker.y, next[0] - walker.x);
                walker.x = to[0];
                walker.y = to[1];
                walker.phase += travel * 9;
                walker.moving = travel > 0;
                walker.blocked = 0;
                changed = true;
                if (remaining <= travel + 1e-7) {
                  walker.id = walker.path.shift();
                  if (!walker.path.length) walker.pause = 2 + random() * 5;
                }
              } else {
                walker.blocked += dt;
                if (walker.blocked > 2) {
                  walker.path = [walker.id];
                  walker.pause = 1 + random() * 2;
                  walker.blocked = 0;
                }
              }
            }
          }
          if (wasMoving !== walker.moving) changed = true;
        }
        return changed;
      }
      function routeWalkerTo(nav, walker, point) {
        let end = null, start = null, best = Math.max(0.5, nav.step * 1.5), startDistance = nav.step * 1.5;
        const from = [walker.x, walker.y];
        nav.points.forEach((p, id) => {
          const d = distance(p, point);
          if (d < best) {
            end = id;
            best = d;
          }
          const s = distance(p, from);
          if (s < startDistance && nav.canWalk(from, p)) {
            start = id;
            startDistance = s;
          }
        });
        if (end === null || start === null) return false;
        const path = findPath(nav, start, end);
        if (!path.length) return false;
        const route = [];
        let current = from, index = 0;
        while (index < path.length) {
          let farthest = index;
          for (let next = index; next < path.length; next++) if (nav.canWalk(current, nav.points[path[next]])) farthest = next;
          route.push(path[farthest]);
          current = nav.points[path[farthest]];
          index = farthest + 1;
        }
        walker.path = route;
        walker.pause = 0;
        walker.blocked = 0;
        return true;
      }
      function nearestPoint(nav, point) {
        let best = null, bestDistance = Infinity;
        nav.points.forEach((p, id) => {
          const d = distance(p, point);
          if (d < bestDistance) {
            best = id;
            bestDistance = d;
          }
        });
        return best;
      }
      function stepWalker(nav, walker, dx, dy, walkers = []) {
        if (![dx, dy].every(Number.isFinite) || Math.hypot(dx, dy) < 1e-6) return false;
        const from = [walker.x, walker.y];
        const clear = (to) => nav.canWalk(from, to) && walkers.every((other) => other === walker || pointSegmentDistance([other.x, other.y], from, to) >= MIN_SEPARATION_M);
        const moves = [[dx, dy], ...Math.abs(dx) >= Math.abs(dy) ? [[dx, 0], [0, dy]] : [[0, dy], [dx, 0]]];
        for (const [mx, my] of moves) {
          const to = [from[0] + mx, from[1] + my];
          if (Math.hypot(mx, my) < 1e-6 || !clear(to)) continue;
          walker.x = to[0];
          walker.y = to[1];
          walker.phase += Math.hypot(mx, my) * 9;
          walker.moving = true;
          const id = nearestPoint(nav, to);
          if (id !== null) walker.id = id;
          return true;
        }
        walker.moving = false;
        return false;
      }
      module.exports = { BODY_RADIUS_M, MIN_SEPARATION_M, buildNavigation, findPath, createWalkers, advanceWalkers, routeWalkerTo, nearestPoint, stepWalker };
    }
  });

  // packages/interior-viewer/src/walking.cjs
  var require_walking = __commonJS({
    "packages/interior-viewer/src/walking.cjs"(exports, module) {
      "use strict";
      var WALK_M_PER_S = 1.3;
      var TURN_RAD_PER_S = Math.PI * 0.6;
      var STICK_RADIUS_PX = 34;
      var clampPitch = (value) => Math.max(-Math.PI * 0.42, Math.min(Math.PI * 0.42, value));
      function eyePose(walker, height, yaw = 0, pitch = 0) {
        const angle = walker.heading + yaw, tilt = clampPitch(pitch), horizontal = Math.cos(tilt);
        return { eye: [walker.x, walker.y, height + 0.01], target: [walker.x + Math.cos(angle) * horizontal, walker.y + Math.sin(angle) * horizontal, height + 0.01 + Math.sin(tilt)] };
      }
      var KEYS = { ArrowUp: ["forward", 1], KeyW: ["forward", 1], ArrowDown: ["forward", -1], KeyS: ["forward", -1], KeyA: ["strafe", -1], KeyD: ["strafe", 1], ArrowLeft: ["turn", 1], ArrowRight: ["turn", -1], KeyQ: ["turn", 1], KeyE: ["turn", -1] };
      function intent(held, stick = { forward: 0, strafe: 0 }) {
        const sum = (axis) => Math.max(-1, Math.min(1, [...held].reduce((value, code) => value + (KEYS[code]?.[0] === axis ? KEYS[code][1] : 0), 0) + (stick[axis] || 0)));
        return { forward: sum("forward"), strafe: sum("strafe"), turn: sum("turn") };
      }
      function walkStep(angle, { forward, strafe }, distance) {
        return [(Math.cos(angle) * forward + Math.sin(angle) * strafe) * distance, (Math.sin(angle) * forward - Math.cos(angle) * strafe) * distance];
      }
      function mount({ THREE, group, figures, walkers, camera, controls, renderer, render, animate, host, stopAutoRotate, moveTo, step, coarse, labels = {} }, env = globalThis) {
        const doc = env.document, canvas = renderer.domElement, ray = new THREE.Raycaster(), point = new THREE.Vector2();
        const names = labels.people || ["Person 1", "Person 2"], ids = ["male", "female"];
        const ui = doc.createElement("div");
        ui.className = "person-view-controls";
        ui.setAttribute("role", "group");
        ui.setAttribute("aria-label", labels.firstPerson || "First-person view");
        const buttons = figures.map((_, index) => {
          const button = doc.createElement("button");
          button.type = "button";
          button.className = "viewer-chip";
          button.textContent = names[index];
          button.title = labels.personView?.(names[index]) || `View as ${names[index]}`;
          button.setAttribute("aria-label", button.title);
          button.setAttribute("aria-pressed", "false");
          button.addEventListener("click", () => enter(index));
          ui.append(button);
          return button;
        });
        const back = doc.createElement("button");
        back.type = "button";
        back.className = "viewer-chip";
        back.textContent = labels.back || "Back";
        back.setAttribute("aria-label", labels.overview || "Return to overview");
        back.hidden = true;
        back.addEventListener("click", exit);
        ui.append(back);
        const hint = doc.createElement("p");
        hint.className = "person-view-hint";
        hint.setAttribute("aria-live", "polite");
        hint.textContent = labels.choosePerson || "Select a person for first-person view.";
        const stick = doc.createElement("div");
        stick.className = "person-stick";
        stick.hidden = true;
        stick.setAttribute("role", "application");
        stick.setAttribute("aria-label", labels.walkStick || "Walk: drag in the direction of movement");
        const knob = doc.createElement("span");
        knob.className = "person-stick-knob";
        stick.append(knob);
        host.append(ui, hint, stick);
        const oldTabindex = canvas.getAttribute("tabindex");
        let selected = null, saved = null, yaw = 0, pitch = 0, pointer = null, disposed = false, oldVisible = true, stickPointer = null, stickVector = { forward: 0, strafe: 0 };
        const held = /* @__PURE__ */ new Set();
        const walkHint = () => labels.walkHint?.(names[selected], coarse) || `${names[selected]} \xB7 Drag to look \xB7 ${coarse ? "Use the stick" : "Arrows or WASD"} to walk \xB7 Tap the floor to move \xB7 Esc to return`;
        function update() {
          if (selected === null || disposed) return;
          const pose = eyePose(walkers[selected], figures[selected].eyeHeight, yaw, pitch);
          group.updateWorldMatrix(true, false);
          camera.up.set(0, 0, 1).transformDirection(group.matrixWorld);
          camera.position.copy(group.localToWorld(new THREE.Vector3(...pose.eye)));
          camera.lookAt(group.localToWorld(new THREE.Vector3(...pose.target)));
        }
        function enter(index) {
          if (disposed || selected === index) return;
          stopAutoRotate?.();
          if (selected === null) saved = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), up: camera.up.clone(), target: controls.target.clone(), enabled: controls.enabled, fov: camera.fov, near: camera.near, autoRotate: controls.autoRotate };
          else release(walkers[selected]);
          if (selected !== null) figures[selected].group.visible = oldVisible;
          selected = index;
          oldVisible = figures[index].group.visible;
          figures[index].group.visible = false;
          yaw = 0;
          pitch = 0;
          controls.enabled = false;
          controls.autoRotate = false;
          camera.fov = 75;
          camera.near = 0.035;
          camera.updateProjectionMatrix();
          buttons.forEach((button, i) => button.setAttribute("aria-pressed", String(i === index)));
          back.hidden = false;
          stick.hidden = !coarse;
          host.dataset.personView = ids[index];
          hint.textContent = walkHint();
          canvas.tabIndex = 0;
          canvas.focus({ preventScroll: true });
          update();
          render();
        }
        function release(walker) {
          if (walker.controlled) {
            walker.controlled = false;
            walker.path = [];
            walker.pause = 1.5;
            walker.moving = false;
          }
        }
        function exit() {
          if (selected === null) return;
          if (pointer && canvas.hasPointerCapture?.(pointer.id)) canvas.releasePointerCapture(pointer.id);
          pointer = null;
          delete host.dataset.personDragging;
          held.clear();
          resetStick();
          const previous = selected;
          release(walkers[selected]);
          figures[selected].group.visible = oldVisible;
          selected = null;
          camera.position.copy(saved.position);
          camera.quaternion.copy(saved.quaternion);
          camera.up.copy(saved.up);
          camera.fov = saved.fov;
          camera.near = saved.near;
          camera.updateProjectionMatrix();
          controls.target.copy(saved.target);
          controls.enabled = saved.enabled;
          controls.autoRotate = saved.autoRotate;
          if (saved.enabled) controls.update();
          camera.position.copy(saved.position);
          camera.quaternion.copy(saved.quaternion);
          camera.up.copy(saved.up);
          controls.target.copy(saved.target);
          saved = null;
          buttons.forEach((button) => button.setAttribute("aria-pressed", "false"));
          back.hidden = true;
          stick.hidden = true;
          host.dataset.personView = "overview";
          hint.textContent = labels.choosePerson || "Select a person for first-person view.";
          render();
          if (!disposed) buttons[previous].focus({ preventScroll: true });
        }
        const removeWalking = animate({ active: () => selected !== null && (held.size > 0 || stickPointer !== null), update(dt) {
          const want = intent(held, stickVector);
          if (!want.forward && !want.strafe && !want.turn) return false;
          const walker = walkers[selected];
          yaw += want.turn * TURN_RAD_PER_S * dt;
          if (want.forward || want.strafe) {
            if (!walker.controlled) {
              walker.controlled = true;
              walker.path = [];
            }
            const [dx, dy] = walkStep(walker.heading + yaw, want, WALK_M_PER_S * dt * Math.min(1, Math.hypot(want.forward, want.strafe)));
            step(walker, dx, dy);
            figures[selected].pose(walker);
          }
          update();
          return true;
        } });
        function pick(event) {
          const rect = canvas.getBoundingClientRect();
          if (!rect.width || !rect.height) return null;
          point.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
          ray.setFromCamera(point, camera);
          group.updateWorldMatrix(true, true);
          const hit = ray.intersectObjects(figures.map((f) => f.group), true)[0];
          if (!hit) return null;
          const blockers = group.children.filter((child) => child.name?.startsWith("UnitPart:") && child.name !== "UnitPart:glass");
          const obstruction = ray.intersectObjects(blockers, true)[0];
          if (obstruction && obstruction.distance < hit.distance - 0.01) return null;
          let object = hit.object;
          while (object) {
            const index = figures.findIndex((f) => f.group === object);
            if (index !== -1) return index;
            object = object.parent;
          }
          return null;
        }
        function floorPoint(event) {
          const rect = canvas.getBoundingClientRect();
          point.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
          ray.setFromCamera(point, camera);
          group.updateWorldMatrix(true, true);
          const solids = group.children.filter((child) => child.name?.startsWith("UnitPart:") && child.name !== "UnitPart:glass"), hit = ray.intersectObjects(solids, false)[0];
          if (!hit || hit.object.name !== "UnitPart:slab") return null;
          const local = group.worldToLocal(hit.point.clone());
          return [local.x, local.y];
        }
        function down(event) {
          if (event.button !== 0 || pointer) return;
          pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, looking: selected !== null };
          if (pointer.looking) {
            canvas.setPointerCapture(event.pointerId);
            event.preventDefault();
            host.dataset.personDragging = "true";
          }
        }
        function move(event) {
          if (pointer?.id === event.pointerId && pointer.looking && selected !== null) {
            yaw -= (event.clientX - pointer.lastX) * 6e-3;
            pitch = clampPitch(pitch - (event.clientY - pointer.lastY) * 6e-3);
            pointer.lastX = event.clientX;
            pointer.lastY = event.clientY;
            update();
            render();
            event.preventDefault();
          }
        }
        function up(event) {
          if (pointer?.id !== event.pointerId) return;
          const press = pointer;
          pointer = null;
          if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
          if (press.looking) {
            delete host.dataset.personDragging;
            if (event.type === "pointerup" && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 6) {
              const point2 = floorPoint(event);
              if (point2 && !moveTo(walkers[selected], point2)) hint.textContent = labels.noRoute || "No confirmed walkable route to that point.";
            }
            return;
          }
          if (event.type === "pointerup" && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 6) {
            const index = pick(event);
            if (index !== null) enter(index);
          }
        }
        function resetStick() {
          stickPointer = null;
          stickVector = { forward: 0, strafe: 0 };
          knob.style.transform = "";
        }
        function stickAt(event) {
          const box = stick.getBoundingClientRect(), x = event.clientX - box.left - box.width / 2, y = event.clientY - box.top - box.height / 2, length = Math.hypot(x, y), scale = length > STICK_RADIUS_PX ? STICK_RADIUS_PX / length : 1;
          knob.style.transform = `translate(${x * scale}px,${y * scale}px)`;
          stickVector = { forward: -y * scale / STICK_RADIUS_PX, strafe: x * scale / STICK_RADIUS_PX };
        }
        function stickDown(event) {
          if (stickPointer !== null || selected === null) return;
          event.preventDefault();
          stickPointer = event.pointerId;
          stick.setPointerCapture?.(event.pointerId);
          stickAt(event);
          render();
        }
        function stickMove(event) {
          if (event.pointerId === stickPointer) {
            event.preventDefault();
            stickAt(event);
          }
        }
        function stickUp(event) {
          if (event.pointerId !== stickPointer) return;
          if (stick.hasPointerCapture?.(event.pointerId)) stick.releasePointerCapture(event.pointerId);
          resetStick();
        }
        function key(event) {
          if (selected === null) return;
          if (event.key === "Escape") {
            event.preventDefault();
            exit();
            return;
          }
          if (event.target !== canvas || event.altKey || event.ctrlKey || event.metaKey || !KEYS[event.code]) return;
          event.preventDefault();
          held.add(event.code);
          render();
        }
        function keyUp(event) {
          held.delete(event.code);
        }
        const blur = () => held.clear();
        for (const [type, handler] of [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", up]]) canvas.addEventListener(type, handler);
        for (const [type, handler] of [["pointerdown", stickDown], ["pointermove", stickMove], ["pointerup", stickUp], ["pointercancel", stickUp]]) stick.addEventListener(type, handler);
        doc.addEventListener("keydown", key);
        doc.addEventListener("keyup", keyUp);
        canvas.addEventListener("blur", blur);
        host.dataset.personView = "overview";
        return { update, enter, exit, active: () => selected !== null, dispose() {
          if (disposed) return;
          disposed = true;
          exit();
          removeWalking();
          if (pointer && canvas.hasPointerCapture?.(pointer.id)) canvas.releasePointerCapture(pointer.id);
          pointer = null;
          for (const [type, handler] of [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", up]]) canvas.removeEventListener(type, handler);
          doc.removeEventListener("keydown", key);
          doc.removeEventListener("keyup", keyUp);
          canvas.removeEventListener("blur", blur);
          ui.remove();
          hint.remove();
          stick.remove();
          if (oldTabindex === null) canvas.removeAttribute("tabindex");
          else canvas.setAttribute("tabindex", oldTabindex);
          delete host.dataset.personView;
          delete host.dataset.personDragging;
        } };
      }
      module.exports = { mount, eyePose, clampPitch, intent, walkStep };
    }
  });

  // packages/interior-viewer/src/people.cjs
  var require_people = __commonJS({
    "packages/interior-viewer/src/people.cjs"(exports, module) {
      "use strict";
      var OVERVIEW_STEP_S = 1 / 30;
      function createFigure(THREE, female) {
        const group = new THREE.Group(), height = female ? 1.67 : 1.78, g = height / 1.75;
        group.name = female ? "ApartmentPerson:female" : "ApartmentPerson:male";
        const skin = new THREE.MeshPhongMaterial({ color: 14660235, shininess: 8 });
        const shirt = new THREE.MeshPhongMaterial({ color: female ? 11885654 : 4614284, shininess: 8 });
        const trousers = new THREE.MeshPhongMaterial({ color: 3752524, shininess: 8 });
        const hair = new THREE.MeshPhongMaterial({ color: female ? 5848364 : 3944488, shininess: 8 });
        const limbGeometry = new THREE.CylinderGeometry(1, 1, 1, 7).rotateX(Math.PI / 2).translate(0, 0, -0.5);
        const torsoGeometry = new THREE.CylinderGeometry(female ? 0.16 : 0.17, 0.14, 0.62, 9).rotateX(Math.PI / 2).translate(0, 0, 0.31);
        const torso = new THREE.Mesh(torsoGeometry, shirt);
        torso.position.set(0, 0, 0.81 * g);
        torso.scale.set(g, g, g);
        group.add(torso);
        const headGeometry = new THREE.SphereGeometry(0.12, 10, 8), head = new THREE.Mesh(headGeometry, skin);
        head.position.set(0, 0, 1.62 * g);
        head.scale.set(g, g, g);
        group.add(head);
        const hairGeometry = new THREE.SphereGeometry(0.126, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.6).rotateX(Math.PI / 2);
        const cap = new THREE.Mesh(hairGeometry, hair);
        cap.position.copy(head.position);
        cap.scale.set(g, g, g);
        group.add(cap);
        if (female) {
          const back = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), hair);
          back.scale.set(0.8 * g, 1.15 * g, 1.5 * g);
          back.position.set(-0.045 * g, 0, 1.57 * g);
          group.add(back);
        }
        const limbs = [];
        for (const [side, index] of [[1, 0], [-1, 1]]) {
          const leg = new THREE.Mesh(limbGeometry, trousers);
          leg.position.set(0, side * 0.1 * g, 0.81 * g);
          leg.scale.set(0.065 * g, 0.065 * g, 0.8 * g);
          group.add(leg);
          const arm = new THREE.Mesh(limbGeometry, shirt);
          arm.position.set(0, side * 0.235 * g, 1.4 * g);
          arm.scale.set(0.045 * g, 0.045 * g, 0.59 * g);
          group.add(arm);
          limbs.push({ leg, arm, sign: index ? -1 : 1 });
        }
        group.traverse((object) => {
          if (object.isMesh) object.userData.noShadow = true;
        });
        function pose(walker, standing = false) {
          group.position.set(walker.x, walker.y, 0.01);
          group.rotation.z = walker.heading;
          const swing = !standing && walker.moving ? Math.sin(walker.phase) * 0.35 : 0;
          for (const limb of limbs) {
            limb.leg.rotation.y = swing * limb.sign;
            limb.arm.rotation.y = -swing * 0.8 * limb.sign;
          }
        }
        return { group, pose, eyeHeight: 1.62 * g };
      }
      function mount({ THREE, group, render, animate, host, architecture, camera, controls, renderer, stopAutoRotate, quality, labels }, env = globalThis) {
        const navigation = require_navigation();
        const nav = navigation.buildNavigation(architecture), walkers = navigation.createWalkers(nav);
        if (!walkers.length) return () => {
        };
        const people = new THREE.Group();
        people.name = "ApartmentPeople";
        group.add(people);
        const figures = walkers.map((walker, index) => {
          const figure = createFigure(THREE, index === 1);
          people.add(figure.group);
          figure.pose(walker);
          return figure;
        });
        const media = env.matchMedia?.("(prefers-reduced-motion: reduce)");
        let disposed = false, reduced = Boolean(media?.matches), elapsed = 0;
        const poseAll = (standing) => figures.forEach((figure, index) => figure.pose(walkers[index], standing));
        const moveTo = (walker, point) => {
          walker.controlled = false;
          if (!navigation.routeWalkerTo(nav, walker, point)) return false;
          if (reduced) {
            for (let i = 0; walker.path.length && i < 2e4; i++) navigation.advanceWalkers(nav, walkers, 0.1);
            poseAll(true);
            personView?.update();
            render();
          }
          return true;
        };
        const step = (walker, dx, dy) => navigation.stepWalker(nav, walker, dx, dy, walkers);
        const personView = camera ? require_walking().mount({ THREE, group, figures, walkers, camera, controls, renderer, render, animate, host, stopAutoRotate, moveTo, step, labels, coarse: Boolean(quality?.coarse) }, env) : null;
        const removeAnimator = animate({ active: () => !disposed && !reduced, update(dt) {
          elapsed += dt;
          if (!personView?.active() && elapsed < OVERVIEW_STEP_S) return false;
          const changed = navigation.advanceWalkers(nav, walkers, elapsed);
          elapsed = 0;
          if (changed) {
            poseAll(false);
            personView?.update();
          }
          return changed;
        } });
        function motionChanged() {
          reduced = Boolean(media.matches);
          poseAll(true);
          render();
        }
        media?.addEventListener("change", motionChanged);
        render();
        const dispose = function() {
          if (disposed) return;
          disposed = true;
          removeAnimator();
          media?.removeEventListener("change", motionChanged);
          personView?.dispose();
          group.remove(people);
          const geometries = /* @__PURE__ */ new Set(), materials = /* @__PURE__ */ new Set();
          people.traverse((object) => {
            if (object.geometry) geometries.add(object.geometry);
            if (object.material) materials.add(object.material);
          });
          geometries.forEach((geometry) => geometry.dispose());
          materials.forEach((material) => material.dispose());
        };
        dispose.personView = personView;
        dispose.navigation = nav;
        dispose.walkers = walkers;
        return dispose;
      }
      module.exports = { mount, createFigure };
    }
  });

  // packages/interior-viewer/src/presentation.cjs
  var require_presentation = __commonJS({
    "packages/interior-viewer/src/presentation.cjs"(exports, module) {
      "use strict";
      var geometry = require_geometry();
      function mount({ THREE, group, architecture, render = () => {
      } }, { colors = {}, edgeColor = 4609118, personView = () => false } = {}) {
        const edges = [], ceiling = new THREE.Group();
        ceiling.name = "ApartmentVisibleCeiling";
        const roofMaterial = new THREE.MeshStandardMaterial({ color: colors.wall || 15920869, side: THREE.DoubleSide, roughness: 0.95 });
        group.traverse((mesh) => {
          if (!mesh.name?.startsWith("UnitPart:") || mesh.name === "UnitPart:glass") return;
          const line = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 35), new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.22 }));
          mesh.add(line);
          edges.push(line);
        });
        for (const part of geometry.buildLocalUnitParts(architecture).filter((part2) => part2.kind === "slab")) {
          const shape = new THREE.Shape(part.rings[0].map((p) => new THREE.Vector2(...p)));
          part.rings.slice(1).forEach((ring) => shape.holes.push(new THREE.Path(ring.map((p) => new THREE.Vector2(...p)))));
          const buffer = new THREE.ExtrudeGeometry(shape, { depth: architecture.slabThicknessM, bevelEnabled: false });
          buffer.translate(0, 0, architecture.wallHeightM);
          ceiling.add(new THREE.Mesh(buffer, roofMaterial));
        }
        group.add(ceiling);
        let disposed = false;
        function update() {
          const active = Boolean(personView());
          ceiling.visible = active;
          edges.forEach((edge) => {
            edge.visible = !active;
          });
        }
        update();
        render();
        return { update, dispose() {
          if (disposed) return;
          disposed = true;
          ceiling.removeFromParent();
          ceiling.children.forEach((mesh) => mesh.geometry.dispose());
          roofMaterial.dispose();
          edges.forEach((edge) => {
            edge.removeFromParent();
            edge.geometry.dispose();
            edge.material.dispose();
          });
        } };
      }
      module.exports = { mount };
    }
  });

  // packages/interior-viewer/src/scene.cjs
  var require_scene = __commonJS({
    "packages/interior-viewer/src/scene.cjs"(exports, module) {
      "use strict";
      var PLANK_TILE_M = 1.44;
      var SKY_RADIUS_M = 240;
      var mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
      var hex = (value) => [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
      var clamp01 = (value) => Math.max(0, Math.min(1, value));
      function skyPalette(altitude) {
        const day = clamp01((altitude + 0.05) / 0.35), dusk = clamp01(1 - Math.abs(altitude - 0.03) / 0.16);
        const night = { zenith: hex(857638), horizon: hex(2241098), ground: hex(1382685) };
        const noon = { zenith: hex(6198740), horizon: hex(14083826), ground: hex(9411212) };
        const glow = hex(16757611);
        return {
          zenith: mix(night.zenith, noon.zenith, day),
          horizon: mix(mix(night.horizon, noon.horizon, day), glow, dusk * 0.55),
          ground: mix(night.ground, noon.ground, day),
          sun: mix(hex(16751181), hex(16774880), day),
          sunStrength: altitude > -0.04 ? 0.35 + 0.65 * day : 0
        };
      }
      function skyColor(palette, elevation, sunDot) {
        const base = elevation >= 0 ? mix(palette.horizon, palette.zenith, Math.sqrt(clamp01(elevation))) : mix(palette.horizon, palette.ground, clamp01(-elevation * 7));
        const halo = palette.sunStrength * (Math.pow(clamp01(sunDot), 48) * 0.9 + Math.pow(clamp01(sunDot), 6) * 0.18);
        return base.map((v, i) => clamp01(v + (palette.sun[i] - v) * clamp01(halo)));
      }
      function plankLayout(seed = 7, rows = 8) {
        let state = seed >>> 0;
        const random = () => {
          state = state * 1664525 + 1013904223 >>> 0;
          return state / 4294967296;
        };
        const planks = [];
        for (let row = 0; row < rows; row++) {
          const offset = random();
          let x = offset;
          while (x < offset + 1 - 1e-9) {
            let width = 0.5 + random() * 0.5;
            if (x + width > offset + 1 - 0.25) width = offset + 1 - x;
            planks.push({ x, y: row / rows, width, height: 1 / rows, tone: random() * 2 - 1, grain: random() });
            x += width;
          }
        }
        return planks;
      }
      function woodTexture(THREE, doc, base, anisotropy) {
        const size = 512, canvas = doc.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d"), colour = new THREE.Color(base), hsl = {};
        colour.getHSL(hsl, THREE.SRGBColorSpace);
        const shade = (tone, light = 0) => `hsl(${Math.round(hsl.h * 360)} ${Math.round(hsl.s * 100)}% ${Math.round(clamp01(hsl.l + tone * 0.045 + light) * 100)}%)`;
        for (const plank of plankLayout()) {
          for (const dx of [0, -1]) {
            const x = (plank.x + dx) * size, y = plank.y * size, w = plank.width * size, h = plank.height * size;
            ctx.fillStyle = shade(plank.tone);
            ctx.fillRect(x, y, w, h);
            ctx.strokeStyle = shade(plank.tone, -0.05);
            ctx.globalAlpha = 0.35;
            ctx.lineWidth = 1;
            for (let line = 0; line < 5; line++) {
              const gy = y + h * (0.15 + 0.17 * line + plank.grain * 0.08);
              ctx.beginPath();
              ctx.moveTo(x, gy);
              ctx.bezierCurveTo(x + w * 0.3, gy + 2, x + w * 0.6, gy - 2, x + w, gy + 1);
              ctx.stroke();
            }
            ctx.globalAlpha = 1;
            ctx.fillStyle = shade(0, -0.18);
            ctx.fillRect(x, y, w, 1.5);
            ctx.fillRect(x + w - 1.5, y, 1.5, h);
          }
        }
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = anisotropy;
        return texture;
      }
      function planarUv(THREE, geometry, tile) {
        const position = geometry.attributes.position, uv = new Float32Array(position.count * 2);
        for (let i = 0; i < position.count; i++) {
          uv[i * 2] = position.getX(i) / tile;
          uv[i * 2 + 1] = position.getY(i) / tile;
        }
        geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      }
      function buildSky(THREE) {
        const geometry = new THREE.SphereGeometry(SKY_RADIUS_M, 48, 24).rotateX(Math.PI / 2);
        const count = geometry.attributes.position.count, colors = new Float32Array(count * 3), directions = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          const v = new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, i).normalize();
          directions.set([v.x, v.y, v.z], i * 3);
        }
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = "ApartmentSky";
        mesh.renderOrder = -1;
        mesh.frustumCulled = false;
        mesh.visible = false;
        const linear = new THREE.Color();
        function paint(direction, altitude) {
          const palette = skyPalette(altitude);
          for (let i = 0; i < count; i++) {
            const [x, y, z] = [directions[i * 3], directions[i * 3 + 1], directions[i * 3 + 2]];
            const [r, g, b] = skyColor(palette, z, x * direction.x + y * direction.y + z * direction.z);
            linear.setRGB(r, g, b, THREE.SRGBColorSpace);
            colors.set([linear.r, linear.g, linear.b], i * 3);
          }
          geometry.attributes.color.needsUpdate = true;
        }
        return { mesh, paint, dispose() {
          geometry.dispose();
          material.dispose();
        } };
      }
      function mount({ THREE, scene, group, renderer, render, updateShadows }, { host, RoomEnvironment, ownScene = false }, env = globalThis) {
        const old = { toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure, environment: scene.environment, intensity: scene.environmentIntensity };
        let environment = null;
        if (ownScene) {
          renderer.toneMapping = THREE.NeutralToneMapping;
          renderer.toneMappingExposure = 1.2;
        }
        if (ownScene && RoomEnvironment) {
          const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
          environment = pmrem.fromScene(room, 0.04);
          room.dispose?.();
          pmrem.dispose();
          scene.environment = environment.texture;
          scene.environmentIntensity = 0.9;
        }
        const css = env.getComputedStyle(host), read = (name) => css.getPropertyValue(name).trim();
        const wood = woodTexture(THREE, env.document, read("--model-floor") || "#c9a47c", Math.min(8, renderer.capabilities.getMaxAnisotropy()));
        const parts = [], replaced = [];
        group.traverse((mesh) => {
          if (mesh.isMesh && mesh.name?.startsWith("UnitPart:")) parts.push(mesh);
        });
        for (const mesh of parts) {
          const kind = mesh.name.slice("UnitPart:".length), old2 = mesh.material, metal = kind === "frame" || kind === "railing";
          const material = new THREE.MeshStandardMaterial({
            color: old2.color.clone(),
            roughness: kind === "glass" ? 0.05 : metal ? 0.45 : kind === "door" ? 0.6 : 0.9,
            metalness: metal ? 0.3 : 0,
            transparent: old2.transparent,
            opacity: kind === "glass" ? 0.28 : old2.opacity,
            depthWrite: old2.depthWrite,
            side: old2.side,
            envMapIntensity: kind === "glass" ? 1.4 : 1
          });
          if (kind === "slab") {
            planarUv(THREE, mesh.geometry, PLANK_TILE_M);
            material.map = wood;
            material.color.set(16777215);
          }
          mesh.material = material;
          replaced.push({ mesh, old: old2, material });
        }
        const sky = buildSky(THREE);
        group.add(sky.mesh);
        let disposed = false;
        updateShadows?.();
        render();
        return {
          setSun({ direction, altitude, daylight }) {
            sky.paint(direction, altitude);
            if (ownScene) scene.environmentIntensity = 0.15 + 0.75 * daylight;
          },
          setPersonView(active) {
            sky.mesh.visible = active;
          },
          dispose() {
            if (disposed) return;
            disposed = true;
            group.remove(sky.mesh);
            sky.dispose();
            wood.dispose();
            for (const { mesh, old: old2, material } of replaced) {
              if (mesh.material === material) mesh.material = old2;
              material.dispose();
            }
            if (ownScene) {
              scene.environment = old.environment;
              scene.environmentIntensity = old.intensity;
              environment?.dispose();
              renderer.toneMapping = old.toneMapping;
              renderer.toneMappingExposure = old.exposure;
            }
          }
        };
      }
      module.exports = { mount, skyPalette, skyColor, plankLayout, PLANK_TILE_M };
    }
  });

  // packages/interior-viewer/src/standalone.cjs
  var require_standalone = __commonJS({
    "packages/interior-viewer/src/standalone.cjs"(exports, module) {
      "use strict";
      async function mountStandalone(host, architecture, options = {}) {
        const { THREE, OrbitControls } = options, env = options.env || globalThis;
        if (!host?.append || !THREE?.WebGLRenderer || !OrbitControls) throw new TypeError("host, THREE and OrbitControls are required");
        if (options.signal?.aborted) throw new Error("Interior mount aborted");
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(options.background || 15857142);
        const camera = new THREE.PerspectiveCamera(40, 1, 0.035, 1e3);
        camera.up.set(0, 0, 1);
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(env.devicePixelRatio || 1, options.maxPixelRatio || 2));
        const canvas = renderer.domElement;
        canvas.tabIndex = 0;
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", options.labels?.view || "3D interior");
        host.append(canvas);
        const controls = new OrbitControls(camera, canvas);
        controls.enableDamping = false;
        const animators = /* @__PURE__ */ new Set();
        let frame = null, disposed = false, dirty = true, previous = null, onscreen = true, attachment = null, localPresentation = null;
        const visible = () => onscreen && !env.document?.hidden;
        const active = () => controls.autoRotate || [...animators].some((a) => a.active());
        function schedule() {
          if (!disposed && visible() && frame === null && (dirty || active())) frame = env.requestAnimationFrame(tick);
        }
        function render() {
          dirty = true;
          schedule();
        }
        function animate(animator) {
          animators.add(animator);
          schedule();
          return () => animators.delete(animator);
        }
        function tick(time) {
          frame = null;
          if (disposed || !visible()) {
            previous = null;
            return;
          }
          const dt = previous === null ? 0 : Math.max(0, Math.min(0.1, (time - previous) / 1e3));
          previous = time;
          for (const animator of animators) if (animator.active()) dirty = animator.update(dt) || dirty;
          if (controls.enabled && controls.autoRotate) {
            controls.update(dt);
            dirty = true;
          }
          if (dirty) {
            localPresentation?.update();
            renderer.render(scene, camera);
            dirty = false;
          }
          if (!active()) previous = null;
          schedule();
        }
        const resize = () => {
          const w = host.clientWidth, h = host.clientHeight;
          if (w > 0 && h > 0) {
            renderer.setSize(w, h, false);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            render();
          }
        };
        const visibility = () => {
          if (!visible() && frame !== null) {
            env.cancelAnimationFrame(frame);
            frame = null;
            previous = null;
          }
          render();
        };
        const stopAutoRotate = () => {
          controls.autoRotate = false;
          render();
        };
        let resizeObserver = null, intersectionObserver = null;
        function dispose() {
          if (disposed) return;
          disposed = true;
          if (frame !== null) env.cancelAnimationFrame(frame);
          frame = null;
          animators.clear();
          options.signal?.removeEventListener("abort", dispose);
          env.document?.removeEventListener("visibilitychange", visibility);
          resizeObserver?.disconnect();
          intersectionObserver?.disconnect();
          env.removeEventListener?.("resize", resize);
          canvas.removeEventListener("pointerdown", stopAutoRotate);
          controls.removeEventListener("change", render);
          localPresentation?.dispose();
          attachment?.dispose();
          controls.dispose();
          renderer.dispose();
          renderer.forceContextLoss?.();
          canvas.remove();
        }
        try {
          const api = require_index();
          attachment = api.attach({ ...options, THREE, scene, camera, renderer, controls, host, architecture, render, animate, stopAutoRotate, env });
          const box = new THREE.Box3().setFromObject(attachment.root);
          if (box.isEmpty()) throw new Error("Empty interior geometry");
          const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
          const extent = Math.max(size.x, size.y, size.z, 1), aspect = host.clientWidth / Math.max(host.clientHeight, 1);
          const distance = extent / Math.tan(camera.fov * Math.PI / 360) / Math.min(1, Math.max(0.1, aspect));
          camera.far = Math.max(1e3, distance * 10);
          camera.position.copy(centre).addScaledVector(new THREE.Vector3(0.85, -1.3, 1.05).normalize(), distance);
          controls.target.copy(centre);
          controls.update();
          scene.add(new THREE.HemisphereLight(16777215, 7701387, 2.4));
          const light = new THREE.DirectionalLight(16777215, 2);
          light.position.set(-extent, -extent, extent * 2);
          scene.add(light);
          if (options.presentation) localPresentation = api.presentation.mount(attachment, { colors: options.colors, personView: () => attachment.personView?.active() });
          controls.addEventListener("change", render);
          canvas.addEventListener("pointerdown", stopAutoRotate);
          if (env.ResizeObserver) {
            resizeObserver = new env.ResizeObserver(resize);
            resizeObserver.observe(host);
          } else env.addEventListener?.("resize", resize);
          if (env.IntersectionObserver) {
            intersectionObserver = new env.IntersectionObserver((entries) => {
              onscreen = entries.some((e) => e.isIntersecting);
              visibility();
            });
            intersectionObserver.observe(host);
          }
          env.document?.addEventListener("visibilitychange", visibility);
          options.signal?.addEventListener("abort", dispose, { once: true });
          resize();
          render();
          return { ...attachment, render, animate, dispose };
        } catch (error) {
          dispose();
          throw error;
        }
      }
      module.exports = { mountStandalone };
    }
  });

  // packages/interior-viewer/src/index.cjs
  var require_index = __commonJS({
    "packages/interior-viewer/src/index.cjs"(exports, module) {
      var geometry = require_geometry();
      var meshes = require_meshes();
      var navigation = require_navigation();
      var walking = require_walking();
      var people = require_people();
      var presentation = require_presentation();
      var look = require_scene();
      function normalizeArchitecture(value) {
        const architecture = value?.architecture || value;
        const errors = geometry.validateArchitecture(architecture);
        if (errors.length) throw new TypeError(errors.join("; "));
        return architecture;
      }
      function applyPlacement(THREE, root, placement) {
        if (!placement) return;
        if (placement.matrix) {
          const matrix = placement.matrix.isMatrix4 ? placement.matrix : new THREE.Matrix4().fromArray(placement.matrix);
          if (!matrix.elements.every(Number.isFinite) || Math.abs(matrix.determinant()) < 1e-12) throw new TypeError("Placement matrix must be finite and invertible");
          root.matrix.copy(matrix);
          root.matrixAutoUpdate = false;
        } else {
          for (const key of ["position", "quaternion", "scale"]) if (placement[key]) {
            const values = placement[key];
            if (!Array.isArray(values) || values.length !== (key === "quaternion" ? 4 : 3) || !values.every(Number.isFinite)) throw new TypeError(`Invalid placement ${key}`);
            root[key].fromArray(values);
          }
          if (root.scale.x === 0 || root.scale.y === 0 || root.scale.z === 0 || root.quaternion.lengthSq() < 1e-12) throw new TypeError("Placement must be invertible");
          root.quaternion.normalize();
          root.updateMatrix();
        }
      }
      function attach(options) {
        const { THREE, scene, camera, renderer, controls, host, animate, render = () => {
        } } = options;
        if (!THREE?.Group || !scene?.add) throw new TypeError("THREE and a host scene are required");
        const architecture = normalizeArchitecture(options.architecture);
        if (options.walking && (!camera || !renderer || !controls || !host || !animate)) throw new TypeError("Walking requires camera, renderer, controls, host and host animate hook");
        const root = new THREE.Group();
        root.name = "InteriorViewer";
        applyPlacement(THREE, root, options.placement);
        const group = meshes.createLocalUnitGroup(THREE, architecture, geometry, { colors: options.colors });
        root.add(group);
        let disposed = false, removePeople = null;
        const context = {
          THREE,
          scene,
          root,
          group,
          camera,
          renderer,
          controls,
          host,
          architecture,
          animate,
          render,
          quality: options.quality,
          labels: options.labels,
          stopAutoRotate: options.stopAutoRotate
        };
        scene.add(root);
        try {
          if (options.walking) removePeople = people.mount(context, options.env || globalThis);
        } catch (error) {
          scene.remove(root);
          meshes.disposeGroup(group);
          throw error;
        }
        render();
        return Object.assign(context, {
          navigation: removePeople?.navigation || null,
          walkers: removePeople?.walkers || [],
          personView: removePeople?.personView || null,
          dispose() {
            if (disposed) return;
            disposed = true;
            removePeople?.();
            root.remove(group);
            meshes.disposeGroup(group);
            root.removeFromParent();
            render();
          }
        });
      }
      module.exports = {
        version: "1.0.0",
        geometry,
        meshes,
        navigation,
        walking,
        personView: walking,
        people,
        presentation,
        look,
        normalizeArchitecture,
        attach,
        mountStandalone: (host, architecture, options) => require_standalone().mountStandalone(host, architecture, options)
      };
    }
  });
  return require_index();
})();
if (typeof module === "object" && module.exports) module.exports = InteriorViewer;
