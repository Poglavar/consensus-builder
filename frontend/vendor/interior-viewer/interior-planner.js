/* InteriorPlanner 1.13.0 — generated from the interior-viewer repository; do not edit. */
var InteriorGeometryDependency = typeof module === "object" && module.exports ? require("./interior-geometry.js") : globalThis.InteriorGeometry;
"use strict";
var InteriorPlanner = (() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __commonJS = (cb, mod) => function __require2() {
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

  // src/planner/building-use.js
  var require_building_use = __commonJS({
    "src/planner/building-use.js"(exports, module) {
      (function(root, factory) {
        const api = factory();
        if (typeof module === "object" && module.exports) module.exports = api;
        if (root) root.BuildingUse = api;
      })(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : null, function() {
        "use strict";
        const USES = Object.freeze(["residential", "residential-shops", "mixed", "office", "public", "industrial"]);
        const SYNONYMS = Object.freeze({
          residential: ["housing", "apartments", "apartment", "flats", "homes", "dwelling", "dwellings", "house", "houses"],
          "residential-shops": ["residential with shops", "shops below", "retail ground floor"],
          mixed: ["mixed-use", "mixed use"],
          office: ["offices", "commercial", "business"],
          public: ["civic", "school", "education", "health", "clinic", "hospital", "community", "library"],
          industrial: ["industry", "warehouse", "workshop", "logistics", "factory"]
        });
        const lookup = /* @__PURE__ */ new Map();
        USES.forEach((use) => {
          lookup.set(use, use);
          SYNONYMS[use].forEach((word) => lookup.set(word, use));
        });
        function normalize(value) {
          if (typeof value !== "string") return null;
          return lookup.get(value.trim().toLowerCase().replace(/_/g, "-")) || null;
        }
        function storeyUses(use, floors) {
          const key = normalize(use);
          const n = Number.isInteger(floors) && floors > 0 ? floors : 0;
          if (!key || !n) return [];
          const lower = { residential: [], "residential-shops": ["shop"], mixed: ["shop", "office"] }[key];
          if (!lower) return new Array(n).fill(key);
          return Array.from({ length: n }, (_, level) => lower[level] || "residential");
        }
        function housingShare(use, floors) {
          const storeys = storeyUses(use, floors);
          if (!storeys.length) return null;
          return storeys.filter((storey) => storey === "residential").length / storeys.length;
        }
        const housesPeople = (use) => ["residential", "residential-shops", "mixed"].includes(normalize(use));
        const hasSuggestedLayout = (use) => housesPeople(use) || normalize(use) === "office";
        function layoutRules(use) {
          const key = normalize(use);
          if (!housesPeople(key)) return null;
          return { groundFloorUse: key === "residential" ? "residential" : "commercial" };
        }
        const HOUSING_TYPOLOGIES = Object.freeze(["block", "row", "parcelBased"]);
        const autoGroundFloorUse = (typology, floors) => typology === "block" && floors >= 5 ? "commercial" : "residential";
        function statedUse(properties) {
          const props = properties || {};
          if (props.urbanRule) return normalize(props.urbanRule.use);
          return normalize(props.use);
        }
        function effectiveUse(properties, floors) {
          const props = properties || {};
          const stated = statedUse(props);
          if (stated) return stated;
          const typology = props.urbanRule && props.urbanRule.typology;
          if (!HOUSING_TYPOLOGIES.includes(typology)) return null;
          return autoGroundFloorUse(typology, floors) === "commercial" ? "residential-shops" : "residential";
        }
        function storeyUsesOf(properties, floors) {
          const use = effectiveUse(properties, floors);
          return use ? storeyUses(use, floors) : [];
        }
        const ALKIS_USES = Object.freeze([
          [1e3, 1099, "residential"],
          [1100, 1100, "mixed"],
          [1110, 1110, "residential"],
          [1120, 1120, "residential-shops"],
          [1121, 1122, "mixed"],
          [1123, 1123, "residential-shops"],
          [1130, 1131, "residential-shops"],
          [1200, 1299, "residential"],
          [2e3, 2099, "office"],
          [2100, 2299, "industrial"],
          [2310, 2320, "mixed"],
          [2400, 2799, "industrial"],
          [3e3, 3099, "public"],
          [3100, 3100, "public"],
          [3200, 3299, "public"]
        ]);
        function alkisUse(code) {
          const match = /^(?:31001_)?(\d{4})$/.exec(String(code).trim());
          if (!match) return null;
          const number = Number(match[1]);
          const range = ALKIS_USES.find(([from, to]) => number >= from && number <= to);
          return range ? range[2] : null;
        }
        function fromCityModel(functionCode, usageCode) {
          for (const value of [functionCode, usageCode]) {
            if (value === null || value === void 0 || value === "") continue;
            const use = alkisUse(value) || normalize(String(value));
            if (use) return use;
          }
          return null;
        }
        const OSM_USES = Object.freeze({
          residential: [
            "apartments",
            "house",
            "residential",
            "detached",
            "semidetached_house",
            "semi",
            "terrace",
            "dwelling_house",
            "bungalow",
            "dormitory",
            "farm",
            "cabin",
            "houseboat",
            "static_caravan",
            "stilt_house"
          ],
          office: ["office", "commercial", "retail", "supermarket", "kiosk", "hotel"],
          industrial: ["industrial", "warehouse", "factory", "manufacture", "hangar"],
          public: [
            "public",
            "civic",
            "government",
            "school",
            "kindergarten",
            "college",
            "university",
            "education",
            "hospital",
            "medical",
            "library",
            "fire_station",
            "post_office",
            "train_station",
            "transportation",
            "church",
            "cathedral",
            "chapel",
            "mosque",
            "synagogue",
            "temple",
            "religious",
            "monastery",
            "sports_hall",
            "sports_centre",
            "stadium"
          ]
        });
        const osmLookup = /* @__PURE__ */ new Map();
        Object.entries(OSM_USES).forEach(([use, words]) => words.forEach((word) => osmLookup.set(word, use)));
        function fromOsmBuilding(value) {
          if (typeof value !== "string") return null;
          return osmLookup.get(value.trim().toLowerCase()) || null;
        }
        const ACCESS = Object.freeze(["auto", "point", "corridor"]);
        const normalizeAccess = (value) => typeof value === "string" && ACCESS.includes(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null;
        function statedAccess(properties) {
          const props = properties || {};
          const access = normalizeAccess(props.urbanRule ? props.urbanRule.access : props.access);
          return access === "auto" ? null : access;
        }
        function layoutAccess(viewOverride, properties) {
          const view = normalizeAccess(viewOverride);
          if (view && view !== "auto") return { access: view, basis: "view" };
          const stated = statedAccess(properties);
          return stated ? { access: stated, basis: "design" } : { access: "auto", basis: "depth" };
        }
        return {
          USES,
          HOUSING_TYPOLOGIES,
          ACCESS,
          normalize,
          normalizeAccess,
          statedAccess,
          layoutAccess,
          statedUse,
          effectiveUse,
          storeyUses,
          storeyUsesOf,
          autoGroundFloorUse,
          housingShare,
          housesPeople,
          hasSuggestedLayout,
          layoutRules,
          fromCityModel,
          fromOsmBuilding
        };
      });
    }
  });

  // src/planner/clip-report.js
  var require_clip_report = __commonJS({
    "src/planner/clip-report.js"(exports, module) {
      (function(global) {
        "use strict";
        const counts = /* @__PURE__ */ new Map();
        function reportClipFailure(operation, error, context) {
          const site = context && context.site || "unknown";
          counts.set(site, (counts.get(site) || 0) + 1);
          console.warn(`[${(/* @__PURE__ */ new Date()).toISOString()}] [interior-planner] polygon ${operation} failed at ${site}: ${error && error.message} \u2014 degraded`);
          return error;
        }
        function clipHealth() {
          const sites = Object.fromEntries(counts);
          return { total: Object.values(sites).reduce((sum, n) => sum + n, 0), sites };
        }
        const api = { reportClipFailure, clipHealth };
        if (typeof module !== "undefined" && module.exports) module.exports = api;
      })(typeof window !== "undefined" ? window : globalThis);
    }
  });

  // src/planner/default-floor-plan-rooms.js
  var require_default_floor_plan_rooms = __commonJS({
    "src/planner/default-floor-plan-rooms.js"(exports, module) {
      (function(global) {
        "use strict";
        function reportClip(operation, error, site, operands) {
          const api2 = global && global.__parcelArrangement || (typeof __require === "function" ? require_clip_report() : null);
          if (api2) return api2.reportClipFailure(operation, error, { site }, operands);
          console.error(`[${(/* @__PURE__ */ new Date()).toISOString()}] [clip] Polygon ${operation} failed at ${site}: ${error && error.message} \u2014 degraded`);
          return error;
        }
        const PARTITION_M = 0.12;
        const HALL_WIDTH_M = 1.25;
        const BACK_HALL_M = 1.3;
        const INTERIOR_DOOR_M = 0.8;
        const INTERIOR_DOOR_HEIGHT_M = 2.05;
        const MIN_ROOM_WIDTH_M = 2.9;
        const MIN_WET_WIDTH_M = 2;
        const BEDROOM_WIDTH_M = 3.4;
        const LIVING_MIN_WIDTH_M = 4.2;
        const KITCHEN_WIDTH_M = 2.6;
        const BALCONY_DEPTH_M = 1.5;
        const BALCONY_MAX_WIDTH_M = 4.5;
        const PARTY_CLEARANCE_M = 0.3;
        const WINDOW_SPECS = Object.freeze({
          bedroom: { widthM: 1.4, sillM: 0.9, heightM: 1.4 },
          living: { widthM: 2.4, sillM: 0.9, heightM: 1.4 },
          kitchen: { widthM: 1.2, sillM: 0.9, heightM: 1.4 },
          bathroom: { widthM: 0.6, sillM: 1.6, heightM: 0.6 },
          room: { widthM: 1.4, sillM: 0.9, heightM: 1.4 },
          office: { widthM: 2.4, sillM: 0.9, heightM: 1.4 },
          shop: { widthM: 2.4, sillM: 0.4, heightM: 2.2 },
          storage: null,
          hall: null,
          lobby: null
        });
        const rect = (t, u0, u1, v0, v1) => u1 - u0 > 1e-6 && v1 - v0 > 1e-6 ? t.polygon([[[u0, v0], [u1, v0], [u1, v1], [u0, v1], [u0, v0]]]) : null;
        const ordered = (a, b) => a <= b ? [a, b] : [b, a];
        const vec = (a, b) => [b[0] - a[0], b[1] - a[1]];
        const add = (p, d, k = 1) => [p[0] + d[0] * k, p[1] + d[1] * k];
        const len = (d) => Math.hypot(d[0], d[1]);
        const unit = (d) => {
          const l = len(d);
          return [d[0] / l, d[1] / l];
        };
        const leftNormal = (d) => [-d[1], d[0]];
        function strip(t, a, b, width) {
          const n = leftNormal(unit(vec(a, b)));
          return t.polygon([[add(a, n, width / 2), add(b, n, width / 2), add(b, n, -width / 2), add(a, n, -width / 2), add(a, n, width / 2)]]);
        }
        function polygonsOf(feature) {
          const g = feature && feature.type === "Feature" ? feature.geometry : feature;
          if (!g) return [];
          return g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
        }
        function ringArea(ring) {
          let twice = 0;
          for (let i = 0; i < ring.length; i++) {
            const p = ring[i], q = ring[(i + 1) % ring.length];
            twice += p[0] * q[1] - q[0] * p[1];
          }
          return twice / 2;
        }
        function area(feature) {
          let total = 0;
          for (const rings of polygonsOf(feature)) rings.forEach((ring, index) => {
            total += (index === 0 ? 1 : -1) * Math.abs(ringArea(ring));
          });
          return total;
        }
        function snapped(feature) {
          const round = (value) => Array.isArray(value) ? value.map(round) : Math.round(value * 1e9) / 1e9;
          const geometry = feature.type === "Feature" ? feature.geometry : feature;
          return { type: "Feature", properties: {}, geometry: { type: geometry.type, coordinates: round(geometry.coordinates) } };
        }
        function clipOrRetry(op, a, b) {
          try {
            return op(a, b);
          } catch (first) {
            try {
              return op(snapped(a), snapped(b));
            } catch (_) {
              throw first;
            }
          }
        }
        function intersect(t, a, b) {
          if (!a || !b) return null;
          try {
            const r = clipOrRetry((x, y) => t.intersect(x, y), a, b);
            return r && r.geometry ? r : null;
          } catch (error) {
            reportClip("intersect", error, "default-floor-plan-rooms.intersect", [a, b]);
            return null;
          }
        }
        function difference(t, a, b) {
          if (!a) return null;
          if (!b) return a;
          try {
            const r = clipOrRetry((x, y) => t.difference(x, y), a, b);
            return r && r.geometry ? r : null;
          } catch (error) {
            reportClip("difference", error, "default-floor-plan-rooms.difference", [a, b]);
            return null;
          }
        }
        function unionAll(t, features) {
          let acc = null;
          for (const f of features) {
            if (!f) continue;
            if (!acc) {
              acc = f;
              continue;
            }
            try {
              const m = clipOrRetry((x, y) => t.union(x, y), acc, f);
              if (m && m.geometry) acc = m;
            } catch (error) {
              reportClip("union", error, "default-floor-plan-rooms.unionAll", [acc, f]);
            }
          }
          return acc;
        }
        function bbox(feature) {
          let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
          for (const rings of polygonsOf(feature)) for (const p of rings[0]) {
            u0 = Math.min(u0, p[0]);
            u1 = Math.max(u1, p[0]);
            v0 = Math.min(v0, p[1]);
            v1 = Math.max(v1, p[1]);
          }
          return [u0, v0, u1, v1];
        }
        function facadeRun(t, room, facade, wallM) {
          const inner0 = add(facade.a, facade.inward, wallM), inner1 = add(facade.b, facade.inward, wallM);
          const band = strip(t, add(inner0, facade.inward, 0.15), add(inner1, facade.inward, 0.15), 0.3);
          const clip = intersect(t, room, band);
          if (!clip || area(clip) < 0.05) return null;
          let t0 = Infinity, t1 = -Infinity;
          for (const rings of polygonsOf(clip)) for (const p of rings[0]) {
            const along = (p[0] - facade.a[0]) * facade.d[0] + (p[1] - facade.a[1]) * facade.d[1];
            t0 = Math.min(t0, along);
            t1 = Math.max(t1, along);
          }
          return t1 - t0 > 0.5 ? [t0, t1] : null;
        }
        function freeRuns(facade, run, minM = 0.5) {
          let pieces = [run.slice()];
          for (const [s0, s1] of facade.partyRuns || []) {
            const lo = s0 - PARTY_CLEARANCE_M, hi = s1 + PARTY_CLEARANCE_M;
            pieces = pieces.flatMap(([p0, p1]) => [[p0, Math.min(p1, lo)], [Math.max(p0, hi), p1]]).filter(([p0, p1]) => p1 > p0);
          }
          return pieces.filter(([p0, p1]) => p1 - p0 > minM);
        }
        function openingOn(facade, t0, t1, widthM, spec, wallM, kind = "window") {
          const centre = (t0 + t1) / 2;
          const half = Math.min(widthM, Math.max(0.5, t1 - t0 - 0.5)) / 2;
          const line = (s) => add(add(facade.a, facade.d, s), facade.inward, wallM / 2);
          return { kind, a: line(centre - half), b: line(centre + half), depthM: wallM, sillM: spec.sillM, heightM: spec.heightM };
        }
        function doorOn(a, b, depthM, into, widthM = INTERIOR_DOOR_M) {
          const d = unit(vec(a, b)), mid = add(a, vec(a, b), 0.5);
          const p = add(mid, d, -widthM / 2), q = add(mid, d, widthM / 2);
          return { kind: "door", a: p, b: q, depthM, sillM: 0, heightM: INTERIOR_DOOR_HEIGHT_M, hinge: q, openTip: add(q, into, widthM) };
        }
        function furnishApartment(apartment, env) {
          const { t } = env;
          const out = { rooms: [], partitions: [], openings: [], cuts: [], balconySlabs: [], railings: [] };
          if (!apartment) return out;
          const [au0, , au1] = bbox(apartment);
          const whole = env.side === "whole";
          const dir = env.side === "right" ? 1 : -1;
          const coreU = env.coreSideU;
          const farU = whole ? au0 : env.farU;
          const u = (from, width) => ordered(from, from + dir * width);
          const cell = (uRange, v0, v1) => intersect(t, apartment, rect(t, uRange[0], uRange[1], v0, v1));
          const partition = (uRange, v0, v1) => {
            const p = intersect(t, apartment, rect(t, uRange[0], uRange[1], v0, v1));
            if (p && area(p) > 5e-3) out.partitions.push(p);
          };
          const room = (kind, polygon) => {
            if (polygon && area(polygon) >= 1.5) {
              out.rooms.push({ kind, polygon, areaM2: Math.round(area(polygon) * 10) / 10 });
              return true;
            }
            return false;
          };
          const cutFor = (opening) => out.cuts.push(strip(t, opening.a, opening.b, opening.depthM + 0.06));
          const stripW = Math.abs(farU - coreU);
          const hallW = stripW - HALL_WIDTH_M - PARTITION_M >= MIN_WET_WIDTH_M ? HALL_WIDTH_M : stripW;
          const hallColumn = u(coreU, hallW);
          const backHallV1 = Math.min(env.backY + BACK_HALL_M, env.vb - 2.5);
          const backU = whole ? ordered(au0, au1) : ordered(env.dividerU, farU);
          const hallPieces = [cell(hallColumn, env.vFront, backHallV1), cell(backU, env.backY, backHallV1)].filter(Boolean);
          const hall = unionAll(t, hallPieces);
          if (!hall) {
            room("room", apartment);
            return out;
          }
          const sideW = stripW - hallW - PARTITION_M;
          if (sideW >= MIN_WET_WIDTH_M) {
            const sideU = u(coreU + dir * (hallW + PARTITION_M), sideW);
            const stripDepth = env.backY - env.vFront;
            partition(u(coreU + dir * hallW, PARTITION_M), env.vFront, env.backY);
            const cells = [];
            if (sideW >= MIN_ROOM_WIDTH_M && stripDepth >= 5.5 && env.bedrooms !== 0) {
              const bedDepth = Math.min(4.8, Math.max(3.6, stripDepth * 0.6));
              cells.push(["bedroom", env.vFront, env.vFront + bedDepth]);
              cells.push(["bathroom", env.vFront + bedDepth + PARTITION_M, env.backY]);
            } else if (stripDepth >= 3.6) {
              cells.push(["bathroom", env.vFront, env.vFront + 2.4]);
              cells.push(["storage", env.vFront + 2.4 + PARTITION_M, env.backY]);
            } else {
              cells.push(["bathroom", env.vFront, env.backY]);
            }
            cells.forEach(([kind, v0, v1], index) => {
              if (v1 - v0 < 1) return;
              const polygon = cell(sideU, v0, v1);
              if (!room(kind, polygon)) return;
              if (index > 0) partition(sideU, v0 - PARTITION_M, v0);
              const doorU = coreU + dir * (hallW + PARTITION_M / 2), run = runInside(apartment, [doorU, v0], [doorU, v1]);
              let doorA = [doorU, v0 + 0.1], doorB = [doorU, Math.min(v1 - 0.1, v0 + 0.1 + 1.4)];
              if (!holds(run, doorA[1] - v0, doorB[1] - v0)) {
                if (!run) return;
                doorA = [doorU, v0 + run[0] + 0.1];
                doorB = [doorU, Math.min(v0 + run[1] - 0.1, v0 + run[0] + 0.1 + 1.4)];
              }
              if (doorB[1] - doorA[1] >= INTERIOR_DOOR_M + 0.1) {
                const door = doorOn(doorA, doorB, PARTITION_M, [dir, 0]);
                out.openings.push({ ...door, room: kind });
                cutFor(door);
              }
            });
          }
          const bedroomW = env.bayWidthM >= 2.8 && env.bayWidthM <= 4.5 ? env.bayWidthM : BEDROOM_WIDTH_M;
          const roomsV0 = backHallV1 + PARTITION_M;
          if (env.vb - roomsV0 >= 2.6) {
            partition(backU, backHallV1, roomsV0);
            const Wb = backU[1] - backU[0];
            const columns = [];
            const start = whole ? au1 : env.dividerU;
            let cursor = start;
            const push = (kind, width) => {
              const r = ordered(cursor, cursor + dir * width);
              columns.push([kind, r[0], r[1]]);
              cursor += dir * (width + PARTITION_M);
            };
            if (Wb >= LIVING_MIN_WIDTH_M + KITCHEN_WIDTH_M + PARTITION_M + 1) {
              let bedrooms = Math.max(0, Math.floor((Wb - KITCHEN_WIDTH_M - LIVING_MIN_WIDTH_M - PARTITION_M) / (bedroomW + PARTITION_M)));
              let bedW = bedroomW;
              const known = typeof env.bedrooms === "number" && Number.isFinite(env.bedrooms) ? env.bedrooms : null;
              if (known !== null) {
                const want = Math.max(0, known - out.rooms.filter((r) => r.kind === "bedroom").length);
                const room2 = Wb - KITCHEN_WIDTH_M - LIVING_MIN_WIDTH_M - PARTITION_M;
                bedrooms = Math.min(want, Math.max(0, Math.floor(room2 / (BEDROOM_MIN_M + PARTITION_M))));
                if (bedrooms > 0) bedW = Math.min(bedroomW, room2 / bedrooms - PARTITION_M);
              }
              const livingW = Wb - KITCHEN_WIDTH_M - PARTITION_M - bedrooms * (bedW + PARTITION_M);
              push("kitchen", KITCHEN_WIDTH_M);
              push("living", livingW);
              for (let i = 0; i < bedrooms; i++) push("bedroom", bedW);
            } else {
              push("living", Wb);
            }
            columns.forEach(([kind, u0, u1], index) => {
              const polygon = cell([u0, u1], roomsV0, env.vb);
              if (!room(kind, polygon)) return;
              if (index > 0) partition(dir > 0 ? [u0 - PARTITION_M, u0] : [u1, u1 + PARTITION_M], roomsV0, env.vb);
              const doorV = roomsV0 - PARTITION_M / 2, run = runInside(apartment, [u0, doorV], [u1, doorV]);
              let doorU0 = Math.max(u0 + 0.15, Math.min(u1 - 0.15 - INTERIOR_DOOR_M - 0.2, (u0 + u1) / 2 - 0.6));
              if (!holds(run, doorU0 - u0, doorU0 - u0 + INTERIOR_DOOR_M + 0.2)) {
                if (!run || run[1] - run[0] < INTERIOR_DOOR_M + 0.3) return;
                const r0 = u0 + run[0], r1 = u0 + run[1];
                doorU0 = Math.max(r0 + 0.15, Math.min(r1 - 0.15 - INTERIOR_DOOR_M - 0.2, (r0 + r1) / 2 - 0.6));
              }
              const door = doorOn([doorU0, roomsV0 - PARTITION_M / 2], [doorU0 + INTERIOR_DOOR_M + 0.2, roomsV0 - PARTITION_M / 2], PARTITION_M, [0, 1]);
              out.openings.push({ ...door, room: kind });
              cutFor(door);
            });
          } else {
            room("living", difference(t, cell(backU, env.backY, env.vb), hall));
          }
          out.rooms.push({ kind: "hall", polygon: hall, areaM2: Math.round(area(hall) * 10) / 10 });
          glaze(out, env);
          return out;
        }
        function glaze(out, env) {
          const { t } = env;
          const cutFor = (opening) => out.cuts.push(strip(t, opening.a, opening.b, opening.depthM + 0.06));
          const facades = env.facades.filter((f) => !f.blind);
          let balconyDone = false;
          for (const entry of out.rooms) {
            const spec = WINDOW_SPECS[entry.kind];
            if (!spec) continue;
            const runs = facades.flatMap((f) => {
              const run = facadeRun(t, entry.polygon, f, env.wallM);
              return run ? freeRuns(f, run).map((free) => ({ f, run: free })) : [];
            });
            for (const { f, run } of runs) {
              const [t0, t1] = run;
              const wantsBalcony = env.balconies && !env.isGround && entry.kind === "living" && !balconyDone && (!f.isFront || env.balconyOnFront) && runs.every((other) => other.f === f || (other.f.sun || 0) <= (f.sun || 0));
              if (wantsBalcony && t1 - t0 >= 2.6) {
                const half = Math.min(BALCONY_MAX_WIDTH_M, t1 - t0 - 0.6) / 2, centre = (t0 + t1) / 2;
                const door = openingOn(f, centre - 0.7, centre + 0.7, 1.4, { sillM: 0, heightM: Math.min(2.3, env.wallHeightM - 0.3) }, env.wallM, "glazedDoor");
                out.openings.push({ ...door, room: entry.kind });
                cutFor(door);
                if (t1 - t0 >= 4.6) {
                  const side = openingOn(f, centre + 0.9, Math.min(t1, centre + 0.9 + 1.6), 1.2, spec, env.wallM);
                  out.openings.push({ ...side, room: entry.kind });
                  cutFor(side);
                }
                const o0 = add(f.a, f.d, centre - half), o1 = add(f.a, f.d, centre + half);
                const outward = [-f.inward[0], -f.inward[1]];
                const slab = t.polygon([[o0, o1, add(o1, outward, BALCONY_DEPTH_M), add(o0, outward, BALCONY_DEPTH_M), o0]]);
                out.balconySlabs.push(slab);
                const r0 = add(o0, outward, BALCONY_DEPTH_M - 0.05), r1 = add(o1, outward, BALCONY_DEPTH_M - 0.05);
                out.railings.push({ a: add(o0, outward, 0.05), b: r0, heightM: 1.05 }, { a: r0, b: r1, heightM: 1.05 }, { a: r1, b: add(o1, outward, 0.05), heightM: 1.05 });
                balconyDone = true;
                continue;
              }
              const count = entry.kind === "living" && t1 - t0 >= 6.5 ? 2 : 1;
              for (let i = 0; i < count; i++) {
                const segment = [t0 + (t1 - t0) * i / count, t0 + (t1 - t0) * (i + 1) / count];
                const window2 = openingOn(f, segment[0], segment[1], spec.widthM, spec, env.wallM);
                out.openings.push({ ...window2, room: entry.kind });
                cutFor(window2);
              }
            }
          }
          return out;
        }
        const CORRIDOR_HALL_M = 1.1;
        const GABLE_HALL_M = 1.2;
        const LIVING_MIN_M = 3.2;
        const BEDROOM_MIN_M = 2.6;
        const BATH_WIDTH_M = 2;
        function furnishCorridorFlat(flat, env) {
          const { t } = env;
          const out = { rooms: [], partitions: [], openings: [], cuts: [], balconySlabs: [], railings: [] };
          if (!flat) return out;
          const Wx = env.widthM, Dy = env.depthM, P = PARTITION_M;
          const at = (x, y) => [env.origin[0] + env.ex[0] * x + env.ey[0] * y, env.origin[1] + env.ex[1] * x + env.ey[1] * y];
          const dirOf = (x, y) => [env.ex[0] * x + env.ey[0] * y, env.ex[1] * x + env.ey[1] * y];
          const box = (x0, x1, y0, y1) => {
            if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) return null;
            const a = at(x0, y0), b = at(x1, y1);
            return rect(t, Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1]));
          };
          const cell = (x0, x1, y0, y1) => intersect(t, flat, box(x0, x1, y0, y1));
          const partition = (x0, x1, y0, y1) => {
            const p = cell(x0, x1, y0, y1);
            if (p && area(p) > 5e-3) out.partitions.push(p);
          };
          const room = (kind, polygon) => {
            if (polygon && area(polygon) >= 1.5) {
              out.rooms.push({ kind, polygon, areaM2: Math.round(area(polygon) * 10) / 10 });
              return true;
            }
            return false;
          };
          const cutFor = (opening) => out.cuts.push(strip(t, opening.a, opening.b, opening.depthM + 0.06));
          const doorAlongX = (x0, x1, y, swing, kind) => {
            if (x1 - x0 < INTERIOR_DOOR_M + 0.3) return;
            const run = runInside(flat, at(x0, y), at(x1, y));
            let mid = (x0 + x1) / 2;
            if (!holds(run, mid - x0 - 0.5, mid - x0 + 0.5)) {
              if (!run || run[1] - run[0] < INTERIOR_DOOR_M + 0.3) return;
              mid = x0 + (run[0] + run[1]) / 2;
            }
            const door = doorOn(at(mid - 0.5, y), at(mid + 0.5, y), P, dirOf(0, swing));
            out.openings.push({ ...door, room: kind });
            cutFor(door);
          };
          const doorAlongY = (x, y0, y1, swing, kind) => {
            if (y1 - y0 < INTERIOR_DOOR_M + 0.3) return;
            const run = runInside(flat, at(x, y0), at(x, y1));
            let from = y0;
            if (!holds(run, 0.1, 0.1 + INTERIOR_DOOR_M + 0.2)) {
              if (!run || run[1] - run[0] < INTERIOR_DOOR_M + 0.3) return;
              from = y0 + run[0];
            }
            const door = doorOn(at(x, from + 0.1), at(x, from + 0.1 + INTERIOR_DOOR_M + 0.2), P, dirOf(swing, 0));
            out.openings.push({ ...door, room: kind });
            cutFor(door);
          };
          const bayW = env.bayWidthM >= 2.8 && env.bayWidthM <= 4.5 ? env.bayWidthM : BEDROOM_WIDTH_M;
          const facadeRow = (kinds2, x0, x1, y0, y1, doorY, swing) => {
            let cursor2 = x0;
            kinds2.forEach(([kind, width], index) => {
              const right = index === kinds2.length - 1 ? x1 : cursor2 + width;
              if (index > 0) partition(cursor2 - P, cursor2, y0, y1);
              if (room(kind, cell(cursor2, right, y0, y1)) && doorY !== null) doorAlongX(cursor2, right, doorY, swing, kind);
              cursor2 = right + P;
            });
          };
          if (env.layout === "gable") {
            const hallY02 = Dy - GABLE_HALL_M, roomsY12 = hallY02 - P;
            const hall2 = cell(0, Wx, hallY02, Dy);
            if (!hall2 || roomsY12 < 2.4) {
              room("room", flat);
              glaze(out, env);
              return out;
            }
            partition(0, Wx, roomsY12, hallY02);
            const usable = Wx - LIVING_MIN_M - 2 * P - KITCHEN_WIDTH_M - BATH_WIDTH_M;
            const beds2 = Math.max(0, Math.min(env.bedrooms || 0, Math.floor((usable + 0.4) / (BEDROOM_MIN_M + P))));
            const bedW2 = beds2 ? Math.min(bayW, (usable - beds2 * P) / beds2) : 0;
            const livingW = Wx - KITCHEN_WIDTH_M - BATH_WIDTH_M - beds2 * bedW2 - (beds2 + 2) * P;
            const kinds2 = [["living", livingW], ["kitchen", KITCHEN_WIDTH_M], ["bathroom", BATH_WIDTH_M], ...Array.from({ length: beds2 }, () => ["bedroom", bedW2])];
            facadeRow(env.livingAtEnd ? kinds2.slice().reverse() : kinds2, 0, Wx, 0, roomsY12, roomsY12 + P / 2, -1);
            out.rooms.push({ kind: "hall", polygon: hall2, areaM2: Math.round(area(hall2) * 10) / 10 });
            glaze(out, env);
            return out;
          }
          const innerD = Math.min(2.6, Math.max(2, Dy * 0.3));
          const zoneY0 = Dy - innerD;
          const hallW = Math.min(Wx - BATH_WIDTH_M - P, Math.max(1.3, (env.doorX ? env.doorX[1] : 1.4) + 0.2));
          const wanted = Math.max(0, env.bedrooms || 0);
          const fitBeds = Math.max(0, Math.floor((Wx - LIVING_MIN_M) / (BEDROOM_MIN_M + P)));
          const backHall = wanted > 0 && fitBeds > 0 && zoneY0 - P - CORRIDOR_HALL_M - P >= 2.8;
          const beds = backHall ? Math.min(wanted, fitBeds) : 0;
          const hallY0 = backHall ? zoneY0 - P - CORRIDOR_HALL_M : zoneY0;
          const hall = unionAll(t, [cell(0, hallW, hallY0, Dy), backHall ? cell(0, Wx, hallY0, zoneY0 - P) : null].filter(Boolean));
          if (!hall) {
            room("room", flat);
            glaze(out, env);
            return out;
          }
          const service = [["bathroom", BATH_WIDTH_M]];
          const restW = Wx - hallW - P - BATH_WIDTH_M - P;
          if (restW >= KITCHEN_WIDTH_M - 0.4 && beds > 0) service.push(["kitchen", restW]);
          else if (restW >= 1) service.push(["storage", restW]);
          let cursor = hallW + P;
          partition(hallW, hallW + P, zoneY0, Dy);
          service.forEach(([kind, width], index) => {
            const right = index === service.length - 1 ? Wx : cursor + width;
            if (index > 0) partition(cursor - P, cursor, zoneY0, Dy);
            if (room(kind, cell(cursor, right, zoneY0, Dy))) {
              if (backHall) doorAlongX(cursor, right, zoneY0 - P / 2, 1, kind);
              else if (index === 0) doorAlongY(hallW + P / 2, zoneY0, Dy, 1, kind);
              else doorAlongX(cursor, right, zoneY0 - P / 2, 1, kind);
            }
            cursor = right + P;
          });
          if (backHall) partition(hallW, Wx, zoneY0 - P, zoneY0);
          const roomsY1 = hallY0 - P;
          partition(backHall ? 0 : hallW, backHall ? Wx : hallW, roomsY1, hallY0);
          if (!backHall) partition(hallW, Wx, roomsY1, zoneY0);
          const bedW = beds ? Math.min(bayW, (Wx - LIVING_MIN_M - beds * P) / beds) : 0;
          const kinds = [["living", Wx - beds * (bedW + P)], ...Array.from({ length: beds }, () => ["bedroom", bedW])];
          if (backHall) facadeRow(kinds, 0, Wx, 0, roomsY1, roomsY1 + P / 2, -1);
          else {
            room("living", cell(0, Wx, 0, roomsY1));
            doorAlongX(0, hallW, roomsY1 + P / 2, -1, "living");
          }
          out.rooms.push({ kind: "hall", polygon: hall, areaM2: Math.round(area(hall) * 10) / 10 });
          glaze(out, env);
          return out;
        }
        const ROOM_DEPTH_M = 5;
        const SERVICE_MIN_M = 2.4;
        const LONG_RUN_M = 12, HALL_ONLY_M = 1.6;
        const LIVING_NOM_M = 4.2, LIVING_MAX_M = 7, BEDROOM_MAX_M = 4.6, KITCHEN_MAX_M = 3.4;
        const BATH_M2 = 4.5, STORE_M2 = 2.4, STORE_MAX_M2 = 9;
        const MIN_ROOM_M2 = Object.freeze({ living: 12, bedroom: 8, kitchen: 5, room: 8, bathroom: 3.2, wc: 1.5, storage: 1.5, hall: 2 });
        const MIN_SIDE_M = Object.freeze({ bathroom: 1.4, kitchen: 1.8, wc: 1, storage: 1 });
        const LEFTOVER_M2 = 2.5;
        function inside(feature, p) {
          let hit = false;
          for (const rings of polygonsOf(feature)) for (const ring of rings) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
              const a = ring[i], b = ring[j];
              if (a[1] > p[1] !== b[1] > p[1] && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
            }
          }
          return hit;
        }
        function runInside(feature, a, b) {
          const d = vec(a, b), L = len(d);
          if (!feature || L < 1e-9) return null;
          const cuts = [0, L];
          for (const rings of polygonsOf(feature)) for (const ring of rings) for (let i = 0; i + 1 < ring.length; i++) {
            const p = ring[i], e = vec(p, ring[i + 1]), den = d[0] * e[1] - d[1] * e[0];
            if (Math.abs(den) < 1e-12) continue;
            const w = vec(a, p), s = (w[0] * e[1] - w[1] * e[0]) / den, r = (w[0] * d[1] - w[1] * d[0]) / den;
            if (s > 0 && s < 1 && r >= 0 && r <= 1) cuts.push(s * L);
          }
          cuts.sort((x, y) => x - y);
          let best = null, run = null;
          for (let i = 0; i + 1 < cuts.length; i++) {
            const s0 = cuts[i], s1 = cuts[i + 1];
            if (s1 - s0 < 1e-9) continue;
            if (inside(feature, add(a, d, (s0 + s1) / 2 / L))) {
              run = run ? [run[0], s1] : [s0, s1];
              if (!best || run[1] - run[0] > best[1] - best[0]) best = run.slice();
            } else run = null;
          }
          return best;
        }
        const holds = (run, s0, s1) => !!run && run[0] <= s0 + 0.01 && run[1] >= s1 - 0.01;
        const partsOf = (t, feature) => polygonsOf(feature).map((rings) => t.polygon(rings)).filter((part) => area(part) > 0.5);
        function tidy(t, feature) {
          const polygons = polygonsOf(feature).map((rings) => rings.map((ring) => {
            let pts = ring.slice(0, ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? -1 : ring.length);
            for (let changed = true; changed && pts.length > 3; ) {
              changed = false;
              for (let i = 0; i < pts.length && pts.length > 3; i++) {
                const p = pts[(i + pts.length - 1) % pts.length], q = pts[i], r = pts[(i + 1) % pts.length];
                const twice = Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]));
                if (len(vec(p, q)) < 0.02 || twice < 4e-3) {
                  pts.splice(i, 1);
                  changed = true;
                  i--;
                }
              }
            }
            return [...pts, pts[0]];
          }));
          const kept = polygons.filter((rings) => rings[0].length >= 4 && Math.abs(ringArea(rings[0])) >= 0.05).map((rings) => [rings[0], ...rings.slice(1).filter((ring) => ring.length >= 4 && Math.abs(ringArea(ring)) >= 0.05)]);
          if (!kept.length) return null;
          try {
            return kept.length === 1 ? t.polygon(kept[0]) : t.multiPolygon(kept);
          } catch (_) {
            return feature;
          }
        }
        function furnishByDaylight(outline, env) {
          const { t } = env;
          const out = { rooms: [], partitions: [], openings: [], cuts: [], balconySlabs: [], railings: [] };
          const flat = outline && tidy(t, outline);
          if (!flat) return out;
          const P = PARTITION_M, wallM = env.wallM, flatM2 = area(flat);
          const cutFor = (opening) => out.cuts.push(strip(t, opening.a, opening.b, opening.depthM + 0.06));
          const at = (f, s, depth) => add(add(f.a, f.d, s), f.inward, wallM + depth);
          const runs = [];
          for (const f of env.facades) {
            if (f.blind || f.party) continue;
            const run = facadeRun(t, flat, f, wallM);
            if (!run) continue;
            for (const [t0, t1] of freeRuns(f, run, 1.2)) {
              const depths = [0.15, 0.35, 0.5, 0.65, 0.85].map((k) => {
                const s = t0 + (t1 - t0) * k;
                let d = 0;
                while (d < 40 && inside(flat, at(f, s, d + 0.1))) d += 0.2;
                return d;
              }).sort((a, b) => a - b);
              const avail = depths[2];
              if (avail < 1.5) continue;
              const service = t1 - t0 >= LONG_RUN_M ? HALL_ONLY_M : SERVICE_MIN_M;
              const depthM = avail < 2.7 + 1.1 + P ? avail : avail <= ROOM_DEPTH_M + service ? Math.max(2.7, avail - service) : ROOM_DEPTH_M;
              runs.push({ f, t0, t1, depthM, distance: env.door ? len(vec(at(f, (t0 + t1) / 2, 0), env.door)) : 0 });
            }
          }
          runs.sort((a, b) => a.distance - b.distance);
          if (!runs.length) {
            out.rooms.push({ kind: "room", polygon: flat, areaM2: Math.round(flatM2 * 10) / 10 });
            return out;
          }
          const ends = runs.map((run) => [at(run.f, run.t0, 0), at(run.f, run.t1, 0)]);
          let frontage = runs.reduce((sum, run) => sum + run.t1 - run.t0, 0);
          runs.forEach((run, i) => runs.forEach((other, j) => {
            if (j <= i || run.f === other.f) return;
            if (ends[i].some((p) => ends[j].some((q) => len(vec(p, q)) < 0.8))) frontage -= Math.min(run.depthM, other.depthM) + P;
          }));
          const known = typeof env.bedrooms === "number" && Number.isFinite(env.bedrooms);
          let beds = known ? Math.max(0, env.bedrooms) : flatM2 < 40 ? 0 : flatM2 < 60 ? 1 : flatM2 < 80 ? 2 : 3;
          while (beds > 0 && LIVING_MIN_M + beds * (BEDROOM_MIN_M + P) > frontage) beds--;
          const bayW = env.bayWidthM >= 2.8 && env.bayWidthM <= 4.5 ? env.bayWidthM : BEDROOM_WIDTH_M;
          const queue = [
            { kind: "living", w: LIVING_NOM_M, min: LIVING_MIN_M, max: LIVING_MAX_M },
            ...Array.from({ length: beds }, () => ({ kind: "bedroom", w: bayW, min: BEDROOM_MIN_M, max: BEDROOM_MAX_M })),
            // (a studio cooks in its living room)
            ...flatM2 >= 40 ? [{ kind: "kitchen", w: KITCHEN_WIDTH_M, min: 2.2, max: KITCHEN_MAX_M }] : []
          ];
          const needed = queue.filter((room) => room.kind !== "kitchen");
          const nominal = needed.reduce((sum, room) => sum + room.w + P, 0);
          if (frontage < nominal) needed.forEach((room) => {
            room.w = Math.max(room.min, room.w * frontage / nominal);
          });
          let rooms = null, all = null;
          const facadeRooms = [];
          const build = (r) => {
            const { f, s0, s1, d } = r;
            const edges = [
              { a: at(f, s0, d), b: at(f, s1, d), away: f.inward },
              { a: at(f, s0, -wallM), b: at(f, s0, d), away: [-f.d[0], -f.d[1]] },
              { a: at(f, s1, -wallM), b: at(f, s1, d), away: f.d }
            ].filter((edge) => inside(flat, add(add(edge.a, vec(edge.a, edge.b), 0.5), edge.away, 0.3)));
            const walls = unionAll(t, edges.map((edge) => {
              const dir = unit(vec(edge.a, edge.b));
              return intersect(t, flat, strip(t, add(edge.a, dir, -P / 2), add(edge.b, dir, P / 2), P));
            }).filter(Boolean));
            const own = walls && rooms ? difference(t, walls, rooms) : walls;
            const quad = t.polygon([[at(f, s0, -wallM), at(f, s1, -wallM), at(f, s1, d), at(f, s0, d), at(f, s0, -wallM)]]);
            let polygon = intersect(t, flat, quad);
            if (polygon && all) polygon = difference(t, polygon, all);
            if (polygon && own) polygon = difference(t, polygon, own);
            if (!polygon || area(polygon) < (r.kind === "room" ? MIN_ROOM_M2.room : 3)) return false;
            if (own) out.partitions.push(own);
            out.rooms.push({ kind: r.kind, polygon, areaM2: Math.round(area(polygon) * 10) / 10 });
            facadeRooms.push({ ...r, polygon, edges });
            rooms = rooms ? unionAll(t, [rooms, polygon]) : polygon;
            all = tidy(t, unionAll(t, [all, polygon, own].filter(Boolean)));
            return true;
          };
          for (const run of runs) {
            const free = (s2) => !all || !inside(all, at(run.f, s2, Math.min(1, run.depthM / 2)));
            let t0 = run.t0, t1 = run.t1;
            while (t0 < t1 && !free(t0 + 0.05)) t0 += 0.1;
            while (t1 > t0 && !free(t1 - 0.05)) t1 -= 0.1;
            if (t0 > run.t0) t0 += P;
            if (t1 < run.t1) t1 -= P;
            const length = t1 - t0, here = [];
            const [g0, g1] = [run.t0, run.t1];
            let x = 0;
            const headroom = (r) => r.max - r.w;
            while (length - x >= 1.5) {
              if (!queue.length && flatM2 < 40) break;
              const room = queue.length ? queue[0] : { kind: "room", w: bayW, min: BEDROOM_MIN_M, max: BEDROOM_MAX_M };
              const rest2 = length - x;
              if (rest2 < Math.max(room.min, (MIN_ROOM_M2[room.kind] || 0) / Math.max(1, run.depthM))) {
                if (here.length || room.kind !== "kitchen") break;
                queue.shift();
                continue;
              }
              if (!queue.length && here.length && (flatM2 < 40 || here.reduce((sum, r) => sum + headroom(r), 0) >= rest2)) break;
              const w = Math.min(room.w, rest2);
              here.push({ kind: room.kind, w, max: room.max });
              queue.shift();
              x += w + P;
            }
            if (!here.length) continue;
            let spare = length - here.reduce((sum, r) => sum + r.w, 0) - P * (here.length - 1);
            for (const r of here.slice().sort((a, b) => (b.kind === "living") - (a.kind === "living") || headroom(b) - headroom(a))) {
              const add2 = Math.min(spare, Math.max(0, headroom(r)));
              r.w += add2;
              spare -= add2;
            }
            if (spare > 0) here[0].w += spare;
            const forward = !env.door || len(vec(at(run.f, t0, 0), env.door)) <= len(vec(at(run.f, t1, 0), env.door));
            let s = 0;
            for (const r of here) {
              const a = s, b = s + r.w;
              const first = r === here[0], last = r === here[here.length - 1];
              const s0 = forward ? first ? g0 - 0.3 : t0 + a : last ? g0 - 0.3 : t1 - b, s1 = forward ? last ? g1 + 0.3 : t0 + b : first ? g1 + 0.3 : t1 - a;
              build({ kind: r.kind, f: run.f, s0, s1, d: run.depthM });
              s = b;
            }
          }
          const kitchenInside = !out.rooms.some((room) => room.kind === "kitchen");
          const rest = all ? difference(t, flat, all) : flat;
          const pieces = rest ? partsOf(t, rest) : [];
          const door = env.door || null;
          let hallIndex = door ? pieces.findIndex((piece) => inside(piece, door)) : -1;
          if (hallIndex < 0 && pieces.length) hallIndex = pieces.reduce((best, piece, i) => area(piece) > area(pieces[best]) ? i : best, 0);
          let hall = hallIndex >= 0 ? pieces[hallIndex] : null;
          const others = pieces.filter((_, i) => i !== hallIndex);
          const carved = [];
          const carve = (piece, wantM2, from, kind, minLeftM2 = 1.5) => {
            const [x0, y0, x1, y1] = bbox(piece);
            const tries = [];
            for (const alongU of [x1 - x0 >= y1 - y0, x1 - x0 < y1 - y0]) {
              const a0 = alongU ? x0 : y0, a1 = alongU ? x1 : y1, c0 = alongU ? y0 : x0, c1 = alongU ? y1 : x1;
              const fa = from ? alongU ? from[0] : from[1] : a0, fc = from ? alongU ? from[1] : from[0] : c0;
              const farA = Math.abs(fa - a0) <= Math.abs(fa - a1), farC = Math.abs(fc - c0) <= Math.abs(fc - c1);
              tries.push([alongU, farA, farC], [alongU, farA, !farC], [alongU, !farA, farC], [alongU, !farA, !farC]);
            }
            for (const [alongU, highA, highC] of tries) {
              const a0 = alongU ? x0 : y0, a1 = alongU ? x1 : y1, c0 = alongU ? y0 : x0, c1 = alongU ? y1 : x1;
              const box = (p0, p1, q0, q1) => alongU ? rect(t, Math.min(p0, p1), Math.max(p0, p1), Math.min(q0, q1), Math.max(q0, q1)) : rect(t, Math.min(q0, q1), Math.max(q0, q1), Math.min(p0, p1), Math.max(p0, p1));
              const pt = (p, q) => alongU ? [p, q] : [q, p];
              const cross = c1 - c0, whole = cross <= 3 || cross - 2.4 < 1.2;
              const h = whole ? cross : 2.4;
              const minSide = MIN_SIDE_M[kind] || 1.2;
              const deep = Math.min(4, Math.max(minSide, wantM2 / h));
              if (a1 - a0 - deep - P < 1.3) continue;
              const cut = highA ? a1 - deep : a0 + deep, far = highA ? a1 + 1 : a0 - 1, wall = highA ? [cut - P, cut] : [cut, cut + P];
              const side = highC ? c1 - h : c0 + h, edgeC = highC ? c1 + 1 : c0 - 1, sideWall = highC ? [side - P, side] : [side, side + P];
              const roomBox = whole ? box(cut, far, c0 - 1, c1 + 1) : box(cut, far, side, edgeC);
              const room = intersect(t, piece, roomBox);
              if (!room) continue;
              const [r0, s0, r1, s1] = bbox(room);
              if (Math.min(r1 - r0, s1 - s0) < 0.9 * minSide || area(room) < 0.6 * (r1 - r0) * (s1 - s0) || area(room) < 0.85 * Math.max(0.6 * wantM2, MIN_ROOM_M2[kind] || 0)) continue;
              const walls = unionAll(t, [
                intersect(t, piece, whole ? box(wall[0], wall[1], c0 - 1, c1 + 1) : box(wall[0], wall[1], side, edgeC)),
                whole ? null : intersect(t, piece, box(cut, far, sideWall[0], sideWall[1]))
              ].filter(Boolean));
              const left = difference(t, difference(t, piece, roomBox), walls);
              if (!left || area(left) < minLeftM2) continue;
              if (walls) out.partitions.push(walls);
              const across = { a: pt((wall[0] + wall[1]) / 2, whole ? c0 : side), b: pt((wall[0] + wall[1]) / 2, whole ? c1 : highC ? c1 : c0), away: alongU ? [highA ? -1 : 1, 0] : [0, highA ? -1 : 1] };
              const beside = whole ? null : { a: pt(cut, (sideWall[0] + sideWall[1]) / 2), b: pt(highA ? a1 : a0, (sideWall[0] + sideWall[1]) / 2), away: alongU ? [0, highC ? -1 : 1] : [highC ? -1 : 1, 0] };
              carved.push({ kind, polygon: room, edges: [across, beside].filter(Boolean) });
              return left;
            }
            return null;
          };
          if (hall) {
            const afterBath = carve(hall, flatM2 < 40 ? 3.2 : BATH_M2, door, "bathroom", flatM2 < 40 ? 1 : 1.5);
            if (afterBath) {
              hall = afterBath;
              if (kitchenInside && area(hall) > 14) hall = carve(hall, 7, door, "kitchen") || hall;
              const hallMaxM2 = Math.max(8, 0.12 * flatM2);
              for (const [kind, wantM2] of [...flatM2 >= 70 ? [["wc", 1.8]] : [], ["storage", STORE_M2]]) {
                if (area(hall) <= hallMaxM2 + wantM2) continue;
                hall = carve(hall, wantM2, door, kind) || hall;
              }
            } else {
              const spare = others.findIndex((piece) => area(piece) >= 2.5 && area(piece) <= 8);
              if (spare >= 0) carved.push({ kind: "bathroom", polygon: others.splice(spare, 1)[0], edges: [] });
            }
          }
          if (!carved.some((room) => room.kind === "bathroom")) {
            const hosts = [...facadeRooms.filter((room) => room.kind === "living"), ...facadeRooms.filter((room) => room.kind !== "living").sort((a, b) => area(b.polygon) - area(a.polygon))];
            for (const host of hosts) {
              const left = carve(host.polygon, flatM2 < 40 ? 3.4 : BATH_M2, at(host.f, (host.s0 + host.s1) / 2, 0), "bathroom", flatM2 < 40 ? 9 : MIN_ROOM_M2[host.kind] || 8);
              if (!left) continue;
              const entry = out.rooms.find((room) => room.polygon === host.polygon);
              host.polygon = left;
              if (entry) {
                entry.polygon = left;
                entry.areaM2 = Math.round(area(left) * 10) / 10;
              }
              break;
            }
          }
          const pieceKind = (piece) => area(piece) <= STORE_MAX_M2 ? "storage" : "hall";
          const absorb = (piece) => {
            const [a0, b0, a1, b1] = bbox(piece), gap = P + 0.06;
            const holders = [...hall ? [{ kind: "hall", polygon: hall }] : [], ...facadeRooms, ...carved];
            let best = null;
            for (const holder2 of holders) {
              const [c0, d0, c1, d1] = bbox(holder2.polygon);
              const joint2 = rect(t, Math.max(a0, c0) - gap, Math.min(a1, c1) + gap, Math.max(b0, d0) - gap, Math.min(b1, d1) + gap);
              const shared = joint2 && intersect(t, holder2.polygon, joint2);
              const reach = shared && intersect(t, piece, joint2);
              if (!shared || !reach) continue;
              const score = area(joint2) + (holder2.kind === "hall" ? 100 : 0);
              if (!best || score > best.score) best = { holder: holder2, joint: joint2, score };
            }
            if (!best) return false;
            const { holder, joint } = best;
            const others2 = holders.filter((h) => h !== holder).map((h) => h.polygon);
            const seam = difference(t, intersect(t, flat, joint), others2.length ? unionAll(t, others2) : null);
            const merged = tidy(t, unionAll(t, [holder.polygon, piece, seam].filter(Boolean)));
            if (!merged) return false;
            out.partitions = out.partitions.map((p) => difference(t, p, joint)).filter(Boolean);
            const old = holder.polygon;
            if (holder.kind === "hall" && old === hall) hall = merged;
            for (const list of [out.rooms, facadeRooms, carved]) for (const entry of list) if (entry.polygon === old) {
              entry.polygon = merged;
              if ("areaM2" in entry) entry.areaM2 = Math.round(area(merged) * 10) / 10;
            }
            return true;
          };
          const maxStores = flatM2 >= 90 ? 2 : 1;
          let stores = carved.filter((room) => room.kind === "storage").length;
          for (const piece of others.slice().sort((a, b) => area(a) - area(b))) {
            const kind = pieceKind(piece);
            const [p0, q0, p1, q1] = bbox(piece);
            const sliver = Math.min(p1 - p0, q1 - q0) < 1 || env.facades.some((f) => !f.blind && !f.party && facadeRun(t, piece, f, wallM));
            if ((area(piece) < LEFTOVER_M2 || sliver || kind === "storage" && stores >= maxStores) && absorb(piece)) {
              others.splice(others.indexOf(piece), 1);
              continue;
            }
            if (kind === "storage") stores++;
          }
          for (const piece of others) out.rooms.push({ kind: pieceKind(piece), polygon: piece, areaM2: Math.round(area(piece) * 10) / 10 });
          for (const room of carved) out.rooms.push({ kind: room.kind, polygon: room.polygon, areaM2: Math.round(area(room.polygon) * 10) / 10 });
          if (hall) out.rooms.push({ kind: "hall", polygon: hall, areaM2: Math.round(area(hall) * 10) / 10 });
          const doorFrom = (room, target, label) => {
            let best = null;
            for (const edge of room.edges) {
              const L = len(vec(edge.a, edge.b)), dir = unit(vec(edge.a, edge.b));
              let start2 = null;
              for (let s = 0.05; s <= L + 1e-9; s += 0.1) {
                const p = add(edge.a, dir, s);
                const ok = inside(target, add(p, edge.away, P / 2 + 0.08)) && inside(room.polygon, add(p, edge.away, -(P / 2 + 0.08)));
                if (ok && start2 === null) start2 = s;
                if ((!ok || s + 0.1 > L) && start2 !== null) {
                  const end = ok ? s : s - 0.1;
                  if (!best || end - start2 > best.end - best.start) best = { edge, dir, start: start2, end };
                  start2 = null;
                }
              }
            }
            if (!best || best.end - best.start < INTERIOR_DOOR_M + 0.2) return false;
            const mid = add(best.edge.a, best.dir, (best.start + best.end) / 2);
            const opening = doorOn(add(mid, best.dir, -0.5), add(mid, best.dir, 0.5), P, [-best.edge.away[0], -best.edge.away[1]]);
            out.openings.push({ ...opening, room: label });
            cutFor(opening);
            return true;
          };
          const nodes = [...facadeRooms, ...carved, ...others.map((piece) => ({ kind: pieceKind(piece), polygon: piece, edges: [] }))];
          const start = hall ? { kind: "hall", polygon: hall, edges: [] } : nodes.find((node) => door && inside(node.polygon, door)) || nodes.find((node) => node.kind === "living");
          const reached = start ? [start] : [];
          const rank = (node) => node.kind === "hall" ? 0 : node.kind === "living" ? 1 : 2;
          for (let progress = true; progress; ) {
            progress = false;
            for (const node of nodes) {
              if (reached.includes(node)) continue;
              for (const from of reached.slice().sort((a, b) => rank(a) - rank(b))) {
                if (node.edges.length && doorFrom(node, from.polygon, node.kind) || from.edges.length && doorFrom(from, node.polygon, node.kind)) {
                  reached.push(node);
                  progress = true;
                  break;
                }
              }
            }
          }
          glaze(out, { ...env, balconies: false });
          return out;
        }
        function furnishOffice(unit2, env) {
          const out = { rooms: [], partitions: [], openings: [], cuts: [], balconySlabs: [], railings: [] };
          if (!unit2) return out;
          out.rooms.push({ kind: "office", polygon: unit2, areaM2: Math.round(area(unit2) * 10) / 10 });
          glaze(out, { ...env, balconies: false });
          return out;
        }
        function furnishShop(apartment, env) {
          const { t } = env;
          const out = { rooms: [], partitions: [], openings: [], cuts: [], balconySlabs: [], railings: [] };
          if (!apartment) return out;
          const [, av0, , av1] = bbox(apartment);
          const storeDepth = av1 - av0 >= 7 ? 3 : 0;
          const band = (from, to) => env.streetAtHighV ? rect(t, -1e4, 1e4, av0 + av1 - to, av0 + av1 - from) : rect(t, -1e4, 1e4, from, to);
          const sales = storeDepth ? intersect(t, apartment, band(av0, av1 - storeDepth - PARTITION_M)) : apartment;
          const stock = storeDepth ? intersect(t, apartment, band(av1 - storeDepth, av1)) : null;
          if (storeDepth) {
            const p = intersect(t, apartment, band(av1 - storeDepth - PARTITION_M, av1 - storeDepth));
            if (p) out.partitions.push(p);
          }
          if (sales && area(sales) >= 1.5) out.rooms.push({ kind: "shop", polygon: sales, areaM2: Math.round(area(sales) * 10) / 10 });
          if (stock && area(stock) >= 1.5) out.rooms.push({ kind: "storage", polygon: stock, areaM2: Math.round(area(stock) * 10) / 10 });
          const cutFor = (opening) => out.cuts.push(strip(t, opening.a, opening.b, opening.depthM + 0.06));
          let doorDone = false;
          for (const f of env.facades.filter((f2) => !f2.blind)) {
            const run = sales ? facadeRun(t, sales, f, env.wallM) : null;
            if (!run) continue;
            for (const [t0, t1] of freeRuns(f, run)) {
              if (f.isFront && !doorDone && t1 - t0 >= 2.2) {
                doorDone = true;
                const doorT = env.doorNearU !== void 0 && Math.abs(f.d[0]) > 0.5 && (env.doorNearU - f.a[0]) / f.d[0] > (t0 + t1) / 2 ? t1 - 0.8 : t0 + 0.8;
                const door = openingOn(f, doorT - 0.6, doorT + 0.6, 1.1, { sillM: 0, heightM: Math.min(2.4, env.wallHeightM - 0.3) }, env.wallM, "glazedDoor");
                out.openings.push({ ...door, room: "shop" });
                cutFor(door);
                const glazing = doorT > (t0 + t1) / 2 ? [t0 + 0.3, doorT - 0.9] : [doorT + 0.9, t1 - 0.3];
                const panes = Math.max(0, Math.floor((glazing[1] - glazing[0] + 0.6) / 3));
                for (let i = 0; i < panes; i++) {
                  const seg = [glazing[0] + (glazing[1] - glazing[0]) * i / panes, glazing[0] + (glazing[1] - glazing[0]) * (i + 1) / panes];
                  const window2 = openingOn(f, seg[0], seg[1], WINDOW_SPECS.shop.widthM, WINDOW_SPECS.shop, env.wallM);
                  out.openings.push({ ...window2, room: "shop" });
                  cutFor(window2);
                }
              } else if (t1 - t0 >= 2) {
                const window2 = openingOn(f, t0, t1, Math.min(WINDOW_SPECS.shop.widthM, t1 - t0 - 0.6), WINDOW_SPECS.shop, env.wallM);
                out.openings.push({ ...window2, room: "shop" });
                cutFor(window2);
              }
            }
          }
          return out;
        }
        function garageLayout(env) {
          const { t } = env;
          const out = { columns: [], ramp: null, notices: [] };
          const [u0, u1] = env.uRange, [v0, v1] = env.vRange;
          const blocked = unionAll(t, env.cores);
          const du = 7.5, dv = 5.5;
          for (let x = u0 + du / 2; x < u1 - 1; x += du) {
            for (let y = v0 + dv / 2; y < v1 - 1; y += dv) {
              const column = rect(t, x - 0.2, x + 0.2, y - 0.2, y + 0.2);
              if (!column) continue;
              const inside2 = intersect(t, env.inner, column);
              if (!inside2 || area(inside2) < 0.15) continue;
              if (blocked && intersect(t, blocked, column)) continue;
              out.columns.push(column);
            }
          }
          const rampW = 3.5, slope = 0.15, maxSlope = 0.2, needed = env.storeyHeightM / slope;
          const available = v1 - v0 - 1.5;
          if (available < env.storeyHeightM / maxSlope) {
            out.notices.push("garage-ramp-omitted");
            return out;
          }
          const rampL = Math.min(needed, available);
          const uRamp = env.farEnd.dir > 0 ? [env.farEnd.u - 0.3 - rampW, env.farEnd.u - 0.3] : [env.farEnd.u + 0.3, env.farEnd.u + 0.3 + rampW];
          const vRamp = [v0 + 0.8, v0 + 0.8 + rampL];
          const rampRect = rect(t, uRamp[0], uRamp[1], vRamp[0], vRamp[1]);
          const rampInside = intersect(t, env.inner, rampRect);
          if (!rampInside || area(rampInside) < area(rampRect) * 0.95 || blocked && intersect(t, blocked, rampRect)) {
            out.notices.push("garage-ramp-omitted");
            return out;
          }
          if (rampL < needed - 1e-6) out.notices.push("garage-ramp-steep");
          const steps = 10, platforms = [];
          for (let i = 0; i < steps; i++) {
            const a = vRamp[1] - (vRamp[1] - vRamp[0]) * i / steps, b = vRamp[1] - (vRamp[1] - vRamp[0]) * (i + 1) / steps;
            platforms.push({ polygon: rect(t, uRamp[0], uRamp[1], b, a), elevationM: Math.max(0.2, env.storeyHeightM * (1 - (i + 0.5) / steps)) });
          }
          out.ramp = { polygon: rampRect, platforms, railings: [
            { a: [uRamp[0], vRamp[0]], b: [uRamp[0], vRamp[1]], heightM: 1 },
            { a: [uRamp[1], vRamp[0]], b: [uRamp[1], vRamp[1]], heightM: 1 }
          ], slope: Math.round(env.storeyHeightM / rampL * 100) };
          return out;
        }
        const api = {
          furnishApartment,
          furnishCorridorFlat,
          furnishByDaylight,
          furnishShop,
          furnishOffice,
          garageLayout,
          facadeRun,
          freeRuns,
          runInside,
          WINDOW_SPECS,
          PARTITION_M,
          // The clip helpers, exported so their failure reporting is tested directly.
          _clip: { intersect, difference, unionAll }
        };
        global.__defaultFloorPlanRooms = api;
        if (typeof module !== "undefined" && module.exports) module.exports = api;
      })(typeof window !== "undefined" ? window : globalThis);
    }
  });

  // src/planner/default-floor-plan-core.js
  var require_default_floor_plan_core = __commonJS({
    "src/planner/default-floor-plan-core.js"(exports, module) {
      (function(global) {
        "use strict";
        const base = () => global && global.__defaultFloorPlans || require_default_floor_plans();
        const roomsApi = () => global && global.__defaultFloorPlanRooms || require_default_floor_plan_rooms();
        const CORE_RULES = Object.freeze({
          liftM2: 3500,
          // gross floor area one passenger lift serves
          maxLifts: 8,
          splitCoreFromLifts: 4,
          // from four lifts they stand in two rows across a lift hall
          liftHallM: 3,
          // between two rows of lifts
          liftLobbyM: 2.4,
          // in front of a single row of lifts
          receptionScreenM: 0.12,
          // the glass screen round a reception
          receptionDoorM: 1.8,
          corridorM: 1.8,
          // the residential corridor along the lift face
          wcWidthM: 2.4,
          // toilets beside the stair when the core has no lift
          minLeaseDepthM: 3,
          // floor kept between the core (and its lobby) and every facade
          twoStairsAboveM2: 900,
          // a floor plate this large has two stairs below the high-rise limit too
          officeBayM: 1.5,
          officeWindowM: 1.2,
          residentialBayM: 3,
          residentialWindowM: 1.6,
          targetFlatM2: 70,
          entranceHallM: 2.4,
          // the residential ground floor's hall from the street door to the lobby
          towerFromFloors: 10,
          // a compact building this tall is a tower ...
          towerMaxAspect: 1.5
          // ... when its plate is no more than this long for its width
        });
        const TARGET_KINDS = ["apartment", "shop", "office", "void"];
        function coreTargets(list) {
          if (!Array.isArray(list) || !list.length) return null;
          const finiteArea = (target) => target && typeof target.areaM2 === "number" && Number.isFinite(target.areaM2) && target.areaM2 > 0 ? target.areaM2 : null;
          const out = list.map((target, index) => ({
            id: target && target.id !== void 0 && target.id !== null ? String(target.id) : `t${index + 1}`,
            kind: target && TARGET_KINDS.includes(target.kind) ? target.kind : "apartment",
            areaM2: finiteArea(target),
            bedrooms: target && typeof target.bedrooms === "number" && Number.isFinite(target.bedrooms) && target.bedrooms >= 0 ? Math.floor(target.bedrooms) : null
          }));
          const known = out.filter((target) => target.areaM2 !== null);
          const fill = known.length ? known.reduce((sum, target) => sum + target.areaM2, 0) / known.length : 1;
          out.forEach((target) => {
            target.weight = target.areaM2 !== null ? target.areaM2 : fill;
          });
          return out;
        }
        function wantsCentralCore(input, rules) {
          if (Array.isArray(input.plates) && input.plates.length > 1) return true;
          const uses = Array.isArray(input.storeyUses) ? input.storeyUses : [];
          if (uses.length && uses.filter((use) => use === "office").length * 2 >= uses.length) return true;
          if (rules.access === "point" || rules.access === "corridor") return false;
          if (!(Number.isInteger(input.floors) && input.floors >= (rules.towerFromFloors || CORE_RULES.towerFromFloors))) return false;
          const g = base()._geometry;
          const polygons = g.polygonsOf(input.footprint);
          if (polygons.length !== 1) return false;
          const ring = polygons[0][0];
          const anchor = ring[0];
          const frame = g.makeFrame(anchor[0], anchor[1]);
          const box2 = orientedBox(g.cleanRing(ring.map(frame.toMeters), 0.02));
          return !!box2 && box2.long / Math.max(1e-6, box2.short) <= (rules.towerMaxAspect || CORE_RULES.towerMaxAspect);
        }
        function orientedBox(ring) {
          let best = null;
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
            if (!(l > 1e-6)) continue;
            const d = [dx / l, dy / l], n = [-d[1], d[0]];
            const us = ring.map((p) => p[0] * d[0] + p[1] * d[1]), vs = ring.map((p) => p[0] * n[0] + p[1] * n[1]);
            const w = Math.max(...us) - Math.min(...us), h = Math.max(...vs) - Math.min(...vs);
            if (!best || w * h < best.area) best = { d, n, w, h, area: w * h };
          }
          if (!best) return null;
          const u = best.h > best.w ? best.n : best.d;
          return { u, v: [-u[1], u[0]], long: Math.max(best.w, best.h), short: Math.min(best.w, best.h) };
        }
        function planCoreFloorPlans(input, options = {}) {
          const B = base(), g = B._geometry;
          const t = g.T(options);
          if (!t) throw new Error("default-floor-plan-core: turf is not available");
          const rooms = roomsApi();
          const rules = { ...CORE_RULES, ...B.rulesFor(options), ...options && options.rules || {} };
          const warnings = [];
          const targets = coreTargets(input.unitTargets);
          const summary = {
            scheme: "core",
            cores: 0,
            apartmentsPerFloor: 0,
            apartmentAreasM2: [],
            lift: false,
            highRise: false,
            coreM: null,
            frontBasis: null,
            frontEdge: null,
            region: rules.region,
            groundFloorUse: null,
            garageLevels: 0,
            rooms: 0,
            flats: [],
            access: "core"
          };
          const fail = () => ({ floorPlans: null, warnings, summary });
          const floors = Number.isInteger(input.floors) ? input.floors : null;
          if (!floors || floors < 1) {
            g.warn(warnings, "floors-unknown", "error", "The number of storeys is unknown.");
            return fail();
          }
          if (floors > rules.maxFloors) {
            g.warn(warnings, "too-many-floors", "error", `More than ${rules.maxFloors} storeys are not modelled.`);
            return fail();
          }
          const storeyHeightM = g.finite(input.storeyHeightM) && input.storeyHeightM > 0 ? input.storeyHeightM : 3;
          if (storeyHeightM < 2.5 || storeyHeightM > 6) {
            g.warn(warnings, "storey-height-implausible", "error", `A storey height of ${storeyHeightM.toFixed(2)} m is outside 2.5\u20136 m.`);
            return fail();
          }
          const topFloorM = (floors - 1) * storeyHeightM;
          const highRise = topFloorM > rules.highRiseAboveM;
          summary.highRise = highRise;
          const plateInputs = (Array.isArray(input.plates) && input.plates.length ? input.plates : [{ footprint: input.footprint, floors }]).map((plate) => ({ footprint: plate.footprint, floors: Math.min(floors, Number.isInteger(plate.floors) && plate.floors > 0 ? plate.floors : floors) })).filter((plate) => g.polygonsOf(plate.footprint).length);
          if (!plateInputs.length) {
            g.warn(warnings, "invalid-footprint", "error", "The footprint is not a polygon.");
            return fail();
          }
          const uses = Array.from({ length: floors }, (_, level) => {
            const use = Array.isArray(input.storeyUses) ? input.storeyUses[level] : null;
            return use === "office" || use === "shop" ? use : "residential";
          });
          const allRings = plateInputs.flatMap((plate) => g.polygonsOf(plate.footprint).map((rings) => rings[0]));
          const anchorRing = allRings[0];
          const anchor = anchorRing.reduce((s, p) => [s[0] + p[0] / anchorRing.length, s[1] + p[1] / anchorRing.length], [0, 0]);
          const frame = g.makeFrame(anchor[0], anchor[1]);
          const plateKeyAt = (level) => plateInputs.map((plate, index) => plate.floors > level ? index : -1).filter((index) => index >= 0).join(",");
          const plateLngLat = /* @__PURE__ */ new Map();
          const plateOf = (key) => {
            if (!plateLngLat.has(key)) {
              const parts = key.split(",").map(Number).map((index) => plateInputs[index].footprint);
              plateLngLat.set(key, parts.length === 1 ? asFeature(t, parts[0]) : closeSeams(t, g, g.unionAll(t, parts.map((part) => asFeature(t, part)))));
            }
            return plateLngLat.get(key);
          };
          const topKey = plateKeyAt(floors - 1);
          const topLL = plateOf(topKey);
          const topRing = largestRing(g, topLL);
          const topM = topRing ? g.cleanRing(topRing.map(frame.toMeters), 0.02) : null;
          let box2 = topM ? orientedBox(topM) : null;
          if (box2) {
            const axis = g.finite(input.axisDeg) ? [Math.cos(input.axisDeg * Math.PI / 180), Math.sin(input.axisDeg * Math.PI / 180)] : g.mainAxis(topM);
            const u = g.squareTo(axis, box2.u);
            if (u !== box2.u) box2 = { ...box2, u, v: [-u[1], u[0]] };
          }
          if (!box2) {
            g.warn(warnings, "invalid-footprint", "error", "The footprint is too small or degenerate.");
            return fail();
          }
          const toUV = (p) => {
            const m = frame.toMeters(p);
            return [m[0] * box2.u[0] + m[1] * box2.u[1], m[0] * box2.v[0] + m[1] * box2.v[1]];
          };
          const fromUV = ([a, b]) => frame.toDegrees([a * box2.u[0] + b * box2.v[0], a * box2.u[1] + b * box2.v[1]]);
          const uvFrame = { toMeters: toUV, toDegrees: fromUV };
          const toUVFeature = (feature) => mapFeature(t, g, feature, toUV);
          const insetUV = (featureLL, metres) => {
            let inset = null;
            try {
              inset = t.buffer(featureLL, -metres, { units: "meters" });
            } catch (_) {
              inset = null;
            }
            return inset && g.polygonsOf(inset).length ? toUVFeature(inset) : null;
          };
          const groundKey = plateKeyAt(0);
          const groundUV = toUVFeature(plateOf(groundKey));
          const groundInner = insetUV(plateOf(groundKey), rules.exteriorWallM);
          const topInner = insetUV(topLL, rules.exteriorWallM);
          if (!groundUV || !topInner) {
            g.warn(warnings, "too-small-for-walls", "error", "Too small to hold exterior walls.");
            return fail();
          }
          const gfaM2 = Array.from({ length: floors }, (_, level) => g.polygonsArea(toUVFeature(plateOf(plateKeyAt(level))))).reduce((a, b) => a + b, 0);
          const stairCore = B.coreDimensions(storeyHeightM, rules, false, false);
          const sw = stairCore.widthM, sd = stairCore.depthM, cw = rules.coreWallM;
          const [shaftW, shaftD] = rules.liftShaftOuterM;
          const minLifts = highRise ? 2 : rules.liftPolicy === "never" ? 0 : rules.liftPolicy === "always" || floors >= rules.liftFromFloors ? 1 : 0;
          const wantedLifts = Math.min(rules.maxLifts, Math.max(minLifts, Math.ceil(gfaM2 / rules.liftM2) * (minLifts > 0 ? 1 : 0)));
          const stairs = highRise || g.polygonsArea(groundUV) > rules.twoStairsAboveM2 ? 2 : 1;
          const anyWork = uses.some((use) => use !== "residential");
          const attempts = [];
          const shapes = [{ orientation: "deep", toilets: true }, { orientation: "long", toilets: true }, { orientation: "long", toilets: false }];
          if (wantedLifts >= rules.splitCoreFromLifts && stairs === 2) shapes.forEach((shape) => attempts.push({ split: true, lifts: wantedLifts + wantedLifts % 2, ...shape }));
          for (let lifts = Math.min(wantedLifts, rules.splitCoreFromLifts - 1); lifts >= minLifts; lifts--) shapes.forEach((shape) => attempts.push({ split: false, lifts, ...shape }));
          const leaseInner = insetUV(topLL, rules.exteriorWallM + rules.minLeaseDepthM);
          const centroid = leaseInner ? centreOf(t, leaseInner) : centreOf(t, topInner);
          let core = null;
          for (const attempt of attempts) {
            core = placeCore({ t, g, rules, attempt, stairs, sw, sd, cw, shaftW, shaftD, leaseInner, centroid });
            if (core) break;
          }
          summary.coreM = core ? [g.round2(core.widthM), g.round2(core.depthM)] : null;
          if (highRise) g.warn(warnings, "high-rise", "notice", `The top floor lies ${Math.round(topFloorM)} m up, above ${rules.highRiseAboveM} m: two protected stairs and a firefighting lift are assumed.`);
          if (!core) {
            g.warn(
              warnings,
              "core-does-not-fit",
              "error",
              `Too small to fit a central core of ${stairs} stair(s) and ${Math.max(minLifts, 1)} lift(s) with ${rules.minLeaseDepthM} m of floor round it on the top storey.`,
              { stairs, lifts: minLifts }
            );
            return fail();
          }
          if (core.lifts < wantedLifts) g.warn(warnings, "lifts-limited-by-plate", "notice", `The top floor plate holds a core of ${core.lifts} lift(s); the building's floor area asks for ${wantedLifts}.`);
          summary.cores = 1;
          summary.lift = core.lifts > 0;
          const neighboursUV = (input.neighbours || []).map((n) => toUVFeature(asFeature(t, n))).filter(Boolean);
          const facadesOf = (plateUV) => {
            const edges = [];
            g.polygonsOf(plateUV).forEach((rings) => rings.forEach((ring, ringIndex) => {
              let points = g.cleanRing(ring, 0.02);
              const ccw = g.ringArea(points) > 0;
              if (ringIndex === 0 !== ccw) points = points.slice().reverse();
              points.forEach((a, i) => {
                const b = points[(i + 1) % points.length];
                const lengthM = g.len(g.vec(a, b));
                if (!(lengthM > 0.05)) return;
                const d = g.unit(g.vec(a, b)), inward = g.leftNormal(d);
                edges.push({ a, b, d, inward, lengthM, partyRuns: g.partyRunsOf(t, a, b, d, inward, lengthM, neighboursUV), blind: false, isFront: false });
              });
            }));
            for (const edge of edges) edge.party = edge.partyRuns.reduce((sum, run) => sum + run[1] - run[0], 0) >= edge.lengthM / 2;
            for (const hint of input.blindEdges || []) {
              const edge = g.matchEdge(edges, hint, uvFrame);
              if (edge) edge.blind = true;
            }
            return edges;
          };
          const groundFacades = facadesOf(groundUV);
          let front = null, frontBasis = "longest";
          if (input.front && Array.isArray(input.front.a) && Array.isArray(input.front.b)) {
            const match = g.matchEdge(groundFacades, input.front, uvFrame);
            if (match && !match.party) {
              front = match;
              frontBasis = input.front.basis || "user";
            }
          }
          if (!front) {
            const open = groundFacades.filter((edge) => !edge.party && !edge.blind);
            const pool = open.length ? open : groundFacades.filter((edge) => !edge.party);
            front = pool.reduce((best, edge) => !best || edge.lengthM > best.lengthM ? edge : best, null);
            if (!input.front) g.warn(warnings, "front-assumed-longest", "notice", "No street data: the entrance faces the longest facade.");
          }
          if (!front) {
            g.warn(warnings, "no-exterior-edge", "error", "Every edge is a party wall; there is no facade for an entrance.");
            return fail();
          }
          front.blind = false;
          summary.frontBasis = frontBasis;
          summary.frontEdge = { a: fromUV(front.a), b: fromUV(front.b), lengthM: front.lengthM };
          const along = Math.min(front.lengthM - 1.2, Math.max(1.2, (core.centre[0] - front.a[0]) * front.d[0] + (core.centre[1] - front.a[1]) * front.d[1]));
          const doorCentre = g.add(front.a, front.d, along);
          const doorLine = g.add(doorCentre, front.inward, rules.exteriorWallM / 2);
          const entrance = {
            kind: "glazedDoor",
            a: g.add(doorLine, front.d, -rules.entranceDoorM / 2),
            b: g.add(doorLine, front.d, rules.entranceDoorM / 2),
            depthM: rules.exteriorWallM,
            sillM: 0,
            heightM: Math.min(rules.entranceHeightM, storeyHeightM - rules.slabThicknessM - 0.3),
            room: "entrance"
          };
          front.isFront = true;
          const wallHeightM = storeyHeightM - rules.slabThicknessM;
          const allUV = g.polygonsOf(groundUV).flatMap((rings) => rings[0]);
          const umin = Math.min(...allUV.map((p) => p[0])), umax = Math.max(...allUV.map((p) => p[0]));
          const vmin = Math.min(...allUV.map((p) => p[1])), vmax = Math.max(...allUV.map((p) => p[1]));
          const W = umax - umin, H = vmax - vmin;
          const uv = ([u, v]) => [g.round6(Math.min(1, Math.max(0, (u - umin) / W))), g.round6(Math.min(1, Math.max(0, (v - vmin) / H)))];
          const polygonData = (feature) => g.polygonsOf(feature).filter((rings) => Math.abs(g.ringArea(rings[0])) >= 0.01).map((rings) => rings.filter((ring, index) => index === 0 || Math.abs(g.ringArea(ring)) >= 0.01).map((ring) => g.cleanRing(ring, 4e-3).map(uv)).filter((ring) => ring.length >= 3));
          const openingData = (o) => ({
            kind: o.kind,
            a: uv(o.a),
            b: uv(o.b),
            depthM: o.depthM,
            sillM: o.sillM,
            heightM: Math.min(o.heightM, wallHeightM - o.sillM),
            ...o.hinge ? { hinge: uv(o.hinge), openTip: uv(o.openTip) } : {},
            ...o.room ? { room: o.room } : {}
          });
          const GENERATOR_ID = B.GENERATOR_ID;
          const parameters = {
            scheme: "core",
            storeyHeightM,
            floors,
            coreType: core.split ? "split" : "single",
            lifts: core.lifts,
            stairs,
            highRise,
            frontBasis,
            region: rules.region,
            plates: plateInputs.map((plate) => plate.floors),
            storeyUses: uses,
            rules: {
              maxRiserM: rules.maxRiserM,
              minTreadM: rules.minTreadM,
              flightWidthM: rules.flightWidthM,
              liftShaftOuterM: rules.liftShaftOuterM,
              exteriorWallM: rules.exteriorWallM,
              coreWallM: rules.coreWallM,
              liftM2: rules.liftM2,
              minLeaseDepthM: rules.minLeaseDepthM,
              corridorM: rules.corridorM
            }
          };
          const source = { kind: "generated", generator: GENERATOR_ID, parameters };
          const buildingId = typeof input.buildingId === "string" && input.buildingId ? input.buildingId : "building";
          const layouts = [], layoutIds = /* @__PURE__ */ new Map(), unitsByLayout = /* @__PURE__ */ new Map(), regionsByLayout = /* @__PURE__ */ new Map();
          const layoutFor = (level) => {
            const plateKey = plateKeyAt(level), slabKey = level > 0 ? plateKeyAt(level - 1) : plateKey;
            const use = uses[level], ground = level === 0;
            const key = `${plateKey}|${slabKey}|${use}|${ground ? "g" : "t"}`;
            if (layoutIds.has(key)) return layoutIds.get(key);
            const id = `${buildingId}:core-${layouts.length + 1}`;
            const built = buildLayout({
              t,
              g,
              rules,
              rooms,
              core,
              use,
              ground,
              storeyHeightM,
              wallHeightM,
              plateUV: toUVFeature(plateOf(plateKey)),
              innerUV: withoutSlivers(t, g, insetUV(plateOf(plateKey), rules.exteriorWallM)),
              slabUV: toUVFeature(plateOf(slabKey)),
              facades: facadesOf(toUVFeature(plateOf(plateKey))).map((edge) => ({ ...edge, isFront: ground && near(g, edge, front) })),
              entrance: ground ? entrance : null,
              doorCentre,
              frontInward: front.inward,
              warnings,
              targets
            });
            layouts.push({ id, source, architecture: {
              schema: B.ARCHITECTURE_SCHEMA,
              dimensionsM: [Math.round(W * 1e4) / 1e4, Math.round(H * 1e4) / 1e4],
              wallHeightM: Math.round(wallHeightM * 1e3) / 1e3,
              slabThicknessM: rules.slabThicknessM,
              walls: polygonData(built.walls),
              slabs: built.slabs.flatMap(polygonData),
              landings: built.landings.flatMap(polygonData),
              openings: built.openings.map(openingData),
              stairs: built.stairs.map((s) => ({ ...s, a: uv(s.a), b: uv(s.b) })),
              railings: built.railings.map((r) => ({ ...r, a: uv(r.a), b: uv(r.b) })),
              // Flats as regions, as the point-core generator gives them (with emitRooms also shops and offices: their kind
              // and rooms).
              apartmentRegions: built.regions.filter((region) => region.polygon && (region.kind === "apartment" || region.targetId || options.emitRooms === true)).map((region) => ({
                id: region.id,
                polygons: polygonData(region.polygon),
                flag: null,
                basis: "Generated apartment partition",
                ...region.targetId ? { targetId: region.targetId, kind: region.kind } : {},
                ...options.emitRooms === true ? { kind: region.kind, rooms: (region.rooms || []).map((room) => ({ kind: room.kind, areaM2: room.areaM2, polygons: polygonData(room.polygon) })) } : {}
              })).filter((region) => region.polygons.length),
              inference: {
                wallFootprints: "generated default",
                openings: "generated default",
                verticalDimensions: "estimated",
                glazingTypes: "assumed",
                stairRise: `${stairCore.stair.risers} risers of ${Math.round(stairCore.stair.riserM * 1e3)} mm, treads ${Math.round(rules.minTreadM * 1e3)} mm`
              },
              quality: { floorAreaM2: g.round2(g.polygonsArea(built.plate)), usableAreaM2: g.round2(built.usableM2), cores: 1, lift: core.lifts > 0, highRise }
            } });
            layoutIds.set(key, id);
            unitsByLayout.set(id, built.units);
            regionsByLayout.set(id, built.regions);
            return id;
          };
          const storeys = [];
          for (let level = 0; level < floors; level++) {
            const layoutId = layoutFor(level);
            storeys.push({
              id: `${buildingId}:core-storey-${level}`,
              level,
              elevationM: Math.round(level * storeyHeightM * 1e3) / 1e3,
              elevationBasis: "estimated",
              layoutId,
              units: unitsByLayout.get(layoutId).map((unit) => ({ ...unit, id: `${unit.id}-${level}` }))
            });
          }
          const officeStoreys = uses.filter((use) => use === "office").length, shopStoreys = uses.filter((use) => use === "shop").length;
          const flatsPerStorey = storeys.map((storey) => storey.units.filter((unit) => unit.kind === "apartment").length);
          const corners = [[umin, vmin], [umax, vmin], [umax, vmax], [umin, vmax]].map((p) => fromUV(p).map((value) => Math.round(value * 1e9) / 1e9));
          const floorPlans = {
            schema: B.PLANS_SCHEMA,
            suggested: true,
            generator: { id: GENERATOR_ID, parameters, warnings: warnings.slice() },
            registration: {
              corners,
              basis: "Generated default layout on the bounding rectangle of the proposed footprint; the u axis follows the long side of the top floor plate.",
              accuracy: "generated",
              frontBasis,
              frontEdge: summary.frontEdge
            },
            layouts,
            storeys,
            notes: [
              `A suggested default layout, not part of the proposal: a central ${core.split ? "split core (two rows of lifts across a lift hall)" : "core"} with ${stairs} stair(s), ${core.lifts} lift(s) and toilets, through all ${floors} storeys.`,
              officeStoreys ? `${officeStoreys} office storey(s): open plan round the core, a reception at the lift lobby.` : null,
              shopStoreys ? `${shopStoreys} shop storey(s), open plan.` : null,
              flatsPerStorey.some(Boolean) ? `Flats off a ${rules.corridorM} m corridor along the lifts: ${Math.min(...flatsPerStorey.filter(Boolean))}\u2013${Math.max(...flatsPerStorey)} per residential storey, the corridor no longer than its doors need; every living room, kitchen and bedroom on a facade, the hall and wet rooms further in.` : null,
              plateInputs.length > 1 ? `Stepped parts: each storey's floor plate is the parts that reach it, so the floor over a lower part's roof is a terrace.` : null,
              `Stair: ${stairCore.stair.risers} risers of ${Math.round(stairCore.stair.riserM * 1e3)} mm with ${Math.round(rules.minTreadM * 1e3)} mm treads and ${Math.round(rules.flightWidthM * 100)} cm flights (${rules.regulationBasis}).`,
              core.lifts ? `Lift shafts ${rules.liftShaftOuterM[0]} \xD7 ${rules.liftShaftOuterM[1]} m, one per ${rules.liftM2} m\xB2 of floor area.` : "No lift: below the storey threshold for one.",
              highRise ? `High-rise above ${rules.highRiseAboveM} m: two protected stairs and a firefighting lift assumed.` : null
            ].filter(Boolean)
          };
          const validate = typeof options.validate === "function" ? options.validate : global.__buildingFloorPlans && global.__buildingFloorPlans.validateFloorPlans;
          if (validate) {
            const errors = validate(floorPlans);
            if (errors.length) throw new Error(`default-floor-plan-core produced an invalid model: ${errors.join("; ")}`);
          }
          summary.heightM = floors * storeyHeightM;
          summary.apartmentsPerFloor = Math.max(0, ...flatsPerStorey);
          summary.apartmentAreasM2 = (storeys.find((storey) => storey.units.some((unit) => unit.kind === "apartment"))?.units || []).filter((unit) => unit.kind === "apartment").map((unit) => unit.areaM2);
          summary.officeStoreys = officeStoreys;
          summary.lifts = core.lifts;
          summary.stairs = stairs;
          summary.coreType = core.split ? "split" : "single";
          summary.groundFloorUse = uses[0] === "residential" ? "residential" : "commercial";
          const typical = storeys.find((storey) => storey.level >= 1 && storey.units.some((unit) => unit.kind === "apartment")) || storeys.find((storey) => storey.units.some((unit) => unit.kind === "apartment"));
          if (typical) {
            const toLngLat = (p) => fromUV(p).map((value) => Math.round(value * 1e9) / 1e9);
            summary.flats = regionsByLayout.get(typical.layoutId).filter((region) => region.polygon && region.kind !== "void" && (region.kind === "apartment" || region.targetId)).map((region) => ({
              id: region.id,
              type: null,
              areaM2: g.round2(g.polygonsArea(region.polygon)),
              flag: null,
              rings: g.polygonsOf(region.polygon).map((rings) => rings[0].map(toLngLat)),
              ...region.targetId ? { targetId: region.targetId } : {}
            }));
          }
          if (targets) {
            const placed = new Set(summary.flats.map((flat) => flat.targetId).filter(Boolean));
            if (typical) regionsByLayout.get(typical.layoutId).forEach((region) => {
              if (region.targetId) placed.add(region.targetId);
            });
            summary.unplacedTargets = targets.filter((target) => !placed.has(target.id)).map((target) => target.id);
            if (summary.unplacedTargets.length) g.warn(warnings, "unit-targets-not-placed", "notice", `${summary.unplacedTargets.length} of ${targets.length} known units did not fit this layout.`, { ids: summary.unplacedTargets });
          }
          return { floorPlans, warnings, summary };
        }
        function asFeature(t, value) {
          if (!value) return null;
          if (value.type === "Feature") return value;
          if (value.type === "Polygon") return t.polygon(value.coordinates);
          if (value.type === "MultiPolygon") return t.multiPolygon(value.coordinates);
          return null;
        }
        function closeSeams(t, g, feature) {
          try {
            const closed = t.buffer(t.buffer(feature, SEAM_M, { units: "meters" }), -SEAM_M, { units: "meters" });
            return closed && g.polygonsOf(closed).length ? closed : feature;
          } catch (_) {
            return feature;
          }
        }
        const SEAM_M = 0.05;
        function mapFeature(t, g, feature, map) {
          const polygons = g.polygonsOf(feature).map((rings) => rings.map((ring) => ring.map(map)));
          if (!polygons.length) return null;
          return polygons.length === 1 ? t.polygon(polygons[0]) : t.multiPolygon(polygons);
        }
        function largestRing(g, feature) {
          return g.polygonsOf(feature).map((rings) => rings[0]).reduce((best, ring) => {
            const area = Math.abs(g.ringArea(ring.map((p) => [p[0] * 1e5, p[1] * 1e5])));
            return !best || area > best.area ? { ring, area } : best;
          }, null)?.ring || null;
        }
        function centreOf(t, feature) {
          try {
            return t.centroid(t.centerOfMass(feature)).geometry.coordinates;
          } catch (_) {
            return t.centroid(feature).geometry.coordinates;
          }
        }
        const near = (g, edge, other) => g.len(g.vec(edge.a, other.a)) < 0.3 && g.len(g.vec(edge.b, other.b)) < 0.3;
        const box = (t, u0, u1, v0, v1) => t.polygon([[[u0, v0], [u1, v0], [u1, v1], [u0, v1], [u0, v0]]]);
        function placeCore({ t, g, rules, attempt, stairs, sw, sd, cw, shaftW, shaftD, leaseInner, centroid }) {
          const { split, lifts, orientation, toilets } = attempt;
          const perRow = split ? lifts / 2 : lifts;
          const stairAlongM = orientation === "long" ? cw + sd : sw;
          const halfDepthM = orientation === "long" ? sw : cw + sd;
          const liftsM = perRow * shaftW;
          const toiletM = orientation === "long" ? toilets ? rules.wcWidthM : 0 : perRow > 0 ? 0 : rules.wcWidthM;
          const widthM = (split ? 1 : stairs) * stairAlongM + liftsM + toiletM;
          const depthM = split ? 2 * halfDepthM + rules.liftHallM : halfDepthM;
          const lobbyM = split ? 0 : rules.liftLobbyM;
          const needs = (uc2, vc2) => box(t, uc2 - widthM / 2, uc2 + widthM / 2, vc2 - depthM / 2 - lobbyM, vc2 + depthM / 2);
          if (!leaseInner) return null;
          const fits = (feature) => {
            const clip = g.intersectOrNull(t, leaseInner, feature);
            return clip && g.polygonsArea(clip) >= 0.995 * g.polygonsArea(feature);
          };
          const candidates = [[0, 0]];
          for (let r = 0.5; r <= 8 + 1e-9; r += 0.5) for (const [du, dv] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]]) candidates.push([du, dv]);
          let found = null;
          for (const [du, dv] of candidates) {
            const uc2 = centroid[0] + du, vc2 = centroid[1] + dv;
            if (fits(needs(uc2, vc2))) {
              found = [uc2, vc2];
              break;
            }
          }
          if (!found) return null;
          const [uc, vc] = found;
          const front = vc - depthM / 2;
          const outline = box(t, uc - widthM / 2, uc + widthM / 2, vc - depthM / 2, vc + depthM / 2);
          return {
            split,
            lifts,
            perRow,
            orientation,
            toilets: toiletM > 0 || orientation === "deep" && perRow > 0 && halfDepthM - shaftD > 1.6,
            widthM,
            depthM,
            halfDepthM,
            stairAlongM,
            liftsM,
            toiletM,
            centre: [uc, vc],
            front,
            outline,
            lobby: split ? box(t, uc - widthM / 2, uc + widthM / 2, vc - rules.liftHallM / 2, vc + rules.liftHallM / 2) : box(t, uc - widthM / 2, uc + widthM / 2, front - lobbyM, front),
            stairs,
            sw,
            sd,
            cw,
            shaftW,
            shaftD
          };
        }
        function coreElements({ t, g, rules, core, storeyHeightM, work }) {
          const B = base();
          const out = { walls: [], openings: [], cuts: [], voids: [], landings: [], stairs: [], railings: [], wcRooms: [] };
          const stairCore = B.coreDimensions(storeyHeightM, rules, false, false);
          const { cw, sw, shaftW, shaftD } = core;
          const [uc, vc] = core.centre;
          const strip = B._geometry.strip;
          const doorOn = (pt, x, y, widthM, room, swingY) => {
            const door = {
              kind: "door",
              a: pt(x - widthM / 2, y),
              b: pt(x + widthM / 2, y),
              depthM: cw,
              sillM: 0,
              heightM: rules.doorHeightM,
              hinge: pt(x + widthM / 2, y),
              openTip: pt(x + widthM / 2, y + swingY),
              room
            };
            out.openings.push(door);
            out.cuts.push(strip(t, door.a, door.b, cw + 0.06));
          };
          const half = (faceV, dir, mirror, withSecondStair) => {
            const pt = (x2, y) => [uc + (mirror ? -x2 : x2), faceV + dir * y];
            const bx = (x0, x1, y0, y1) => {
              const a = pt(x0, y0), b = pt(x1, y1);
              return box(t, Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1]));
            };
            const keep = (built) => {
              out.walls.push(...built.walls);
              out.voids.push(...built.voids);
              out.landings.push(...built.landings);
              out.stairs.push(...built.stairs);
              out.railings.push(...built.railings);
            };
            const stairAt = (x0, towards) => {
              if (core.orientation === "long") {
                const xAt = (py) => towards > 0 ? x0 + cw + py : x0 + core.stairAlongM - cw - py;
                const map = (px, py) => pt(xAt(py), px);
                keep(B._geometry.coreParts(t, rules, stairCore, storeyHeightM, false, sw / 2, map, (a0, a1, b0, b1) => {
                  const p = map(a0, b0), q = map(a1, b1);
                  return box(t, Math.min(p[0], q[0]), Math.max(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[1], q[1]));
                }));
                out.walls.push(towards > 0 ? bx(x0, x0 + cw, 0, sw) : bx(x0 + core.stairAlongM - cw, x0 + core.stairAlongM, 0, sw));
                doorOn(pt, xAt(stairCore.landingM / 2), cw / 2, 1, "stair", -1);
              } else {
                keep(B._geometry.coreParts(t, rules, stairCore, storeyHeightM, false, x0 + sw / 2, (px, py) => pt(px, py + cw), (a0, a1, b0, b1) => bx(a0, a1, b0 + cw, b1 + cw)));
                out.walls.push(bx(x0, x0 + sw, 0, cw));
                doorOn(pt, x0 + sw / 2, cw / 2, 1, "stair", -1);
              }
            };
            let x = -core.widthM / 2;
            stairAt(x, 1);
            x += core.stairAlongM;
            const lifts0 = x;
            for (let k = 0; k < core.perRow; k++) {
              const s0 = lifts0 + k * shaftW, s1 = s0 + shaftW;
              const shaft = g.differenceOrNull(t, bx(s0, s1, 0, shaftD), bx(s0 + cw, s1 - cw, cw, shaftD - cw));
              if (shaft) out.walls.push(shaft);
              out.voids.push(bx(s0 + cw, s1 - cw, cw, shaftD - cw));
              const door = {
                kind: "slidingDoor",
                a: pt((s0 + s1) / 2 - rules.liftDoorM / 2, cw / 2),
                b: pt((s0 + s1) / 2 + rules.liftDoorM / 2, cw / 2),
                depthM: cw,
                sillM: 0,
                heightM: rules.doorHeightM,
                room: "lift"
              };
              out.openings.push(door);
              out.cuts.push(strip(t, door.a, door.b, cw + 0.06));
            }
            x += core.liftsM;
            if (core.orientation === "long" && core.perRow > 0 && core.halfDepthM - shaftD > 0.05) out.walls.push(bx(lifts0, x, shaftD, core.halfDepthM));
            const toiletBlock = core.orientation === "deep" && core.perRow > 0 ? [lifts0, x, shaftD] : core.toiletM > 0 ? [x, x + core.toiletM, 0] : null;
            if (toiletBlock && core.halfDepthM - toiletBlock[2] > 1.6) {
              const [m0, m1, y0] = toiletBlock, y1 = core.halfDepthM;
              if (y0 === 0) out.walls.push(bx(m0, m1, 0, cw));
              out.walls.push(bx(m0, m1, y1 - cw, y1));
              if (core.orientation === "long") out.walls.push(bx(m1 - cw, m1, 0, y1));
              const rooms = m1 - m0 >= 3.6 ? [[m0, (m0 + m1) / 2 - 0.06], [(m0 + m1) / 2 + 0.06, m1]] : [[m0, m1]];
              if (rooms.length === 2) out.walls.push(bx((m0 + m1) / 2 - 0.06, (m0 + m1) / 2 + 0.06, y0, y1 - cw));
              rooms.forEach(([r0, r1]) => {
                out.wcRooms.push(bx(r0, r1, y0, y1 - cw));
                if (work) doorOn(pt, (r0 + r1) / 2, y1 - cw / 2, 0.9, "wc", -0.9);
              });
            }
            x += core.toiletM;
            if (withSecondStair) stairAt(x, -1);
          };
          if (core.split) {
            half(vc - rules.liftHallM / 2, -1, false, false);
            half(vc + rules.liftHallM / 2, 1, true, false);
          } else {
            half(core.front, 1, false, core.stairs === 2);
          }
          return out;
        }
        function facadeWindows({ t, g, rules, rooms, facades, work, wallHeightM, furnished = [] }) {
          const openings = [], cuts = [];
          const bay = work ? rules.officeBayM : g.finite(rules.facadeBayWidthM) ? rules.facadeBayWidthM : rules.residentialBayM;
          const width = Math.min(bay - 0.3, work ? rules.officeWindowM : rules.residentialWindowM);
          const sillM = work ? 0.3 : 0.9, heightM = work ? Math.max(1.4, wallHeightM - 0.6) : 1.4;
          for (const facade of facades) {
            if (facade.blind || facade.party) continue;
            const taken = furnished.map((polygon) => rooms.facadeRun(t, polygon, facade, rules.exteriorWallM)).filter(Boolean);
            const free = rooms.freeRuns({ ...facade, partyRuns: [...facade.partyRuns || [], ...taken] }, [0.5, facade.lengthM - 0.5], width + 0.2);
            for (const [s0, s1] of free) {
              const count = Math.max(1, Math.floor((s1 - s0) / bay));
              for (let k = 0; k < count; k++) {
                const c = s0 + (s1 - s0) * (k + 0.5) / count;
                if (facade.isFront && facade.entranceAt !== void 0 && Math.abs(c - facade.entranceAt) < rules.entranceDoorM / 2 + width / 2 + 0.2) continue;
                const line = g.add(facade.a, facade.inward, rules.exteriorWallM / 2);
                const opening = { kind: "window", a: g.add(line, facade.d, c - width / 2), b: g.add(line, facade.d, c + width / 2), depthM: rules.exteriorWallM, sillM, heightM };
                openings.push(opening);
                cuts.push(g.strip(t, opening.a, opening.b, rules.exteriorWallM + 0.06));
              }
            }
          }
          return { openings, cuts };
        }
        function buildLayout(c) {
          const { t, g, rules, rooms, core, use, ground, storeyHeightM, wallHeightM, plateUV, slabUV, facades, entrance, warnings } = c;
          const work = use !== "residential";
          const innerUV = c.innerUV || plateUV;
          const exteriorWalls = g.differenceOrNull(t, plateUV, innerUV);
          const coreParts = coreElements({ t, g, rules, core, storeyHeightM, work });
          if (entrance) {
            const front = facades.find((f) => f.isFront);
            if (front) front.entranceAt = (g.midpoint(entrance.a, entrance.b)[0] - front.a[0]) * front.d[0] + (g.midpoint(entrance.a, entrance.b)[1] - front.a[1]) * front.d[1];
          }
          const walls = [exteriorWalls, ...coreParts.walls];
          const openings = [...coreParts.openings];
          const cuts = [...coreParts.cuts];
          const furnishedFlats = [];
          const railings = [...coreParts.railings];
          const units = [], regions = [];
          let usableM2 = g.polygonsArea(innerUV) - g.polygonsArea(core.outline);
          if (entrance) {
            openings.push(entrance);
            cuts.push(g.strip(t, entrance.a, entrance.b, rules.exteriorWallM + 0.06));
          }
          if (work) {
            const screen = rules.receptionScreenM;
            const [l0, lv0, l1, lv1] = bboxOf(g, core.lobby);
            const sides = core.split ? [[[l0, lv0], [l0, lv1]], [[l1, lv0], [l1, lv1]]] : [[[l0, lv0], [l1, lv0]], [[l0, lv0], [l0, lv1]], [[l1, lv0], [l1, lv1]]];
            sides.forEach(([a, b], index) => {
              walls.push(g.strip(t, a, b, screen));
              const lengthM = g.len(g.vec(a, b)), d = g.unit(g.vec(a, b));
              const doorAt = index === 0 || core.split ? lengthM / 2 : null;
              if (doorAt !== null && lengthM > rules.receptionDoorM + 0.6) {
                const door = {
                  kind: "glazedDoor",
                  a: g.add(a, d, doorAt - rules.receptionDoorM / 2),
                  b: g.add(a, d, doorAt + rules.receptionDoorM / 2),
                  depthM: screen,
                  sillM: 0,
                  heightM: Math.min(2.4, wallHeightM - 0.2),
                  room: "reception"
                };
                openings.push(door);
                cuts.push(g.strip(t, door.a, door.b, screen + 0.06));
              }
              const glassRuns = doorAt !== null && lengthM > rules.receptionDoorM + 0.6 ? [[0.15, doorAt - rules.receptionDoorM / 2 - 0.15], [doorAt + rules.receptionDoorM / 2 + 0.15, lengthM - 0.15]] : [[0.15, lengthM - 0.15]];
              for (const [s0, s1] of glassRuns) {
                if (s1 - s0 < 0.6) continue;
                const pane = { kind: "window", a: g.add(a, d, s0), b: g.add(a, d, s1), depthM: screen, sillM: 0.1, heightM: wallHeightM - 0.3, room: "reception" };
                openings.push(pane);
                cuts.push(g.strip(t, pane.a, pane.b, screen + 0.06));
              }
            });
            regions.push({ id: use === "shop" ? "shop" : "office", kind: use === "shop" ? "shop" : "office", polygon: g.differenceOrNull(t, innerUV, core.outline) });
            units.push({
              id: use === "shop" ? "shop" : "office",
              kind: use === "shop" ? "shop" : "office",
              areaM2: Math.round(usableM2 * 10) / 10,
              rooms: [
                { kind: "reception", areaM2: g.round2(g.polygonsArea(core.lobby)) },
                { kind: use === "shop" ? "shop" : "office", areaM2: Math.round((usableM2 - g.polygonsArea(core.lobby)) * 10) / 10 },
                ...coreParts.wcRooms.map((room) => ({ kind: "wc", areaM2: g.round2(g.polygonsArea(room)) }))
              ]
            });
          } else {
            const flats = residentialFlats({ ...c, innerUV, entrance, warnings });
            walls.push(...flats.walls);
            openings.push(...flats.openings);
            cuts.push(...flats.cuts);
            flats.flats.forEach((flat, index) => {
              const kind = flat.target ? flat.target.kind : flat.void ? "void" : "apartment";
              const targetId = flat.target ? { targetId: flat.target.id } : {};
              const env = {
                t,
                facades,
                wallM: rules.exteriorWallM,
                wallHeightM,
                isGround: ground,
                balconies: false,
                bayWidthM: rules.facadeBayWidthM,
                door: flat.doorU !== void 0 ? [flat.doorU, flat.doorV + flat.side * 0.3] : null,
                bedrooms: flat.target ? flat.target.bedrooms : null
              };
              const furnished = kind === "void" ? null : kind === "apartment" ? rooms.furnishByDaylight(flat.polygon, env) : rooms.furnishOffice(flat.polygon, env);
              if (furnished) {
                walls.push(...furnished.partitions);
                openings.push(...furnished.openings);
                cuts.push(...furnished.cuts);
                furnishedFlats.push(flat.polygon);
              }
              const roomList = furnished ? furnished.rooms : [];
              if (kind !== "void") units.push({ id: `flat-${index + 1}`, kind, areaM2: Math.round(flat.areaM2 * 10) / 10, ...targetId, rooms: roomList.map((room) => ({ kind: room.kind, areaM2: room.areaM2 })) });
              regions.push({ id: kind === "void" ? `void-${index + 1}` : `flat-${index + 1}`, kind, polygon: flat.polygon, ...targetId, rooms: roomList });
            });
            usableM2 = flats.flats.reduce((sum, flat) => sum + flat.areaM2, 0);
          }
          const windows = facadeWindows({ t, g, rules, rooms, facades, work, wallHeightM, furnished: furnishedFlats });
          openings.push(...windows.openings);
          cuts.push(...windows.cuts);
          const wallUnion = wallsLessCuts(t, g, walls, cuts);
          const slab = g.differenceOrNull(t, slabUV || plateUV, g.unionAll(t, coreParts.voids.filter(Boolean)));
          return { plate: plateUV, walls: wallUnion, slabs: [slab].filter(Boolean), landings: coreParts.landings.filter(Boolean), openings, stairs: coreParts.stairs, railings, units, regions, usableM2 };
        }
        function wallsLessCuts(t, g, walls, cuts) {
          const all = g.unionAll(t, walls.filter(Boolean)), list = cuts.filter(Boolean);
          if (!all || !list.length) return all;
          const whole = g.differenceOrNull(t, all, g.unionAll(t, list));
          if (whole) return whole;
          const grown = (cut) => {
            const ring = g.polygonsOf(cut)[0][0], c = ring.reduce((s, p) => [s[0] + p[0] / ring.length, s[1] + p[1] / ring.length], [0, 0]);
            return t.polygon([ring.map((p) => [c[0] + (p[0] - c[0]) * 1.01, c[1] + (p[1] - c[1]) * 1.01])]);
          };
          let rest = all;
          for (const cut of list) rest = g.differenceOrNull(t, rest, cut) || g.differenceOrNull(t, rest, grown(cut)) || rest;
          return rest;
        }
        function bboxOf(g, feature) {
          let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
          for (const rings of g.polygonsOf(feature)) for (const p of rings[0]) {
            u0 = Math.min(u0, p[0]);
            v0 = Math.min(v0, p[1]);
            u1 = Math.max(u1, p[0]);
            v1 = Math.max(v1, p[1]);
          }
          return [u0, v0, u1, v1];
        }
        function residentialFlats({ t, g, rules, core, innerUV, entrance, doorCentre, targets: knownUnits, facades, rooms }) {
          const out = { walls: [], openings: [], cuts: [], flats: [] };
          const wallM = rules.apartmentWallM, doorM = rules.apartmentDoorM;
          const [c0, cv0, c1, cv1] = bboxOf(g, core.outline);
          const [iu0, iv0, iu1, iv1] = bboxOf(g, innerUV);
          const band = core.split ? [core.centre[1] - rules.liftHallM / 2, core.centre[1] + rules.liftHallM / 2] : [core.front - rules.corridorM, core.front];
          const across = (v0, v1) => box(t, iu0 - 1, iu1 + 1, v0, v1);
          const sides = [
            { sign: -1, face: band[0] - wallM, region: g.intersectOrNull(t, innerUV, across(iv0 - 1, band[0] - wallM)), core: core.split || cv0 < band[0] },
            { sign: 1, face: band[1] + wallM, region: g.intersectOrNull(t, innerUV, across(band[1] + wallM, iv1 + 1)), core: true }
          ].map((side) => ({ ...side, region: side.region && g.differenceOrNull(t, side.region, core.outline) }));
          let hallU = null;
          if (entrance) {
            const target = [Math.min(iu1 - 1, Math.max(iu0 + 1, doorCentre[0])), Math.min(band[1], Math.max(band[0], doorCentre[1]))];
            if (g.len(g.vec(doorCentre, target)) > 0.5) {
              const hall = g.strip(t, doorCentre, target, rules.entranceHallM), walled = g.strip(t, doorCentre, target, rules.entranceHallM + 2 * wallM);
              for (const side of sides) {
                if (!side.region) continue;
                const walls = g.differenceOrNull(t, g.intersectOrNull(t, walled, side.region), hall);
                if (walls && g.polygonsArea(walls) > 0.05) out.walls.push(walls);
                side.region = g.differenceOrNull(t, side.region, walled);
              }
              const d = g.unit(g.vec(doorCentre, target));
              out.cuts.push(g.strip(t, g.add(target, d, -1), g.add(target, d, 0.3), rules.entranceHallM));
              hallU = target[0];
            }
          }
          const areaOf = (polygon) => polygon ? g.polygonsArea(polygon) : 0;
          const slice = (region, u0, u1) => g.intersectOrNull(t, region, box(t, u0, u1, iv0 - 1, iv1 + 1));
          const cornersU = (region) => [...new Set(g.polygonsOf(region).flatMap((rings) => rings.flatMap((ring) => ring.map((p) => Math.round(p[0] * 1e3) / 1e3))))];
          const unslivered = (region, bounds, lo, hi) => {
            const xs = cornersU(region);
            for (let k = 1; k < bounds.length - 1; k++) {
              const cost = (u) => narrowM2(g, slice(region, bounds[k - 1], u), MIN_PART_M) + narrowM2(g, slice(region, u, bounds[k + 1]), MIN_PART_M);
              let best = bounds[k], bestCost = cost(best);
              if (bestCost < SLIVER_M2) continue;
              for (const x of xs.flatMap((u) => [u - 0.02, u + 0.02])) {
                if (Math.abs(x - bounds[k]) > SNAP_M || x <= bounds[k - 1] + 0.5 || x >= bounds[k + 1] - 0.5 || x < lo || x > hi) continue;
                const c = cost(x);
                if (c < bestCost - 0.5) {
                  best = x;
                  bestCost = c;
                }
              }
              bounds[k] = best;
            }
            return bounds;
          };
          const cutAcross = (region, u0, u1) => {
            if (!region || areaOf(region) < 1) return [];
            const n = Math.max(1, Math.round(areaOf(region) / rules.targetFlatM2));
            const bounds = unslivered(region, Array.from({ length: n + 1 }, (_, k) => u0 + (u1 - u0) * k / n), u0, u1);
            return bounds.slice(1).map((b, k) => ({ u0: bounds[k], u1: b, polygon: slice(region, bounds[k], b) }));
          };
          const targets = knownUnits && knownUnits.length ? knownUnits : null;
          const minFlatM2 = targets ? 8 : rules.minApartmentM2;
          const voidTarget = targets ? targets.find((target) => target.kind === "void") || null : null;
          const absolute = !!voidTarget && targets.filter((target) => target.kind !== "void").every((target) => target.areaM2 !== null);
          const units = absolute ? targets.filter((target) => target.kind !== "void") : targets;
          const BEHIND_M = 1;
          const leftShare = (side) => [c0 + BEHIND_M, c1 - BEHIND_M].map((u) => areaLeftOf(g, side.region, u) / areaOf(side.region));
          const runRange = (side, list) => {
            if (!absolute) return leftShare(side);
            const sum = list.reduce((acc, target) => acc + target.weight, 0), A = areaOf(side.region);
            const leftCap = areaLeftOf(g, side.region, c1 - BEHIND_M), rightCap = A - areaLeftOf(g, side.region, c0 + BEHIND_M);
            const lo = 1 - rightCap / sum, hi = leftCap / sum;
            return lo <= hi ? [Math.max(0, lo), Math.min(1, hi)] : (lo + hi) / 2;
          };
          const assign = (mode) => {
            const assigned = /* @__PURE__ */ new Map();
            if (!targets) return assigned;
            const open = sides.filter((side) => side.region && areaOf(side.region) >= minFlatM2);
            const total = units.reduce((sum, target) => sum + target.weight, 0);
            if (open.length === 1 || units.length === 1) {
              const biggest = open.reduce((best, side) => !best || areaOf(side.region) > areaOf(best.region) ? side : best, null);
              if (biggest) assigned.set(biggest, units);
            } else if (open.length === 2) {
              const areas = open.map((side) => areaOf(side.region));
              const share = areas[0] / (areas[0] + areas[1]);
              const depths = open.map((side, i) => {
                const [u0, , u1] = bboxOf(g, side.region);
                return areas[i] / Math.max(1, u1 - u0);
              });
              const sumOf = (list) => list.reduce((acc, target) => acc + target.weight, 0);
              const narrowness = (list, i) => list.filter((target) => target.kind !== "void").reduce((acc, target) => acc + Math.max(0, MIN_FLAT_WIDTH_M - target.weight * (absolute ? 1 : areas[i] / sumOf(list)) / depths[i]) ** 2, 0);
              const runError = (list, i) => open[i].core && list.length > 1 ? bestSplit(list, runRange(open[i], list)).err * sumOf(list) / total : 0;
              const overflow = (list, i) => Math.max(0, sumOf(list) / areas[i] - 0.97);
              let best = null;
              const n = units.length, masks = mode === "fit" && n <= 8 ? Array.from({ length: (1 << n) - 2 }, (_, k) => k + 1) : [];
              for (const mask of masks) {
                const first = units.filter((_, k) => mask & 1 << k), second = units.filter((_, k) => !(mask & 1 << k));
                const fit = absolute ? (10 * overflow(first, 0)) ** 2 + (10 * overflow(second, 1)) ** 2 : (10 * (sumOf(first) / total - share)) ** 2;
                const cost = fit + (10 * runError(first, 0)) ** 2 + (10 * runError(second, 1)) ** 2 + narrowness(first, 0) + narrowness(second, 1);
                if (!best || cost < best.cost - 1e-9) best = { cost, first, second };
              }
              if (!best) {
                let split = 1, acc = 0, bestCost = Infinity;
                for (let k = 1; k < units.length; k++) {
                  acc += units[k - 1].weight;
                  const cost = Math.abs(acc / total - share);
                  if (cost < bestCost) {
                    bestCost = cost;
                    split = k;
                  }
                }
                best = { first: units.slice(0, split), second: units.slice(split) };
              }
              assigned.set(open[0], best.first).set(open[1], best.second);
            }
            return assigned;
          };
          const uAtArea = (region, area) => {
            let lo = iu0 - 1, hi = iu1 + 1;
            for (let i = 0; i < 30; i++) {
              const mid = (lo + hi) / 2;
              if (areaLeftOf(g, region, mid) < area) lo = mid;
              else hi = mid;
            }
            return (lo + hi) / 2;
          };
          const cutRun = (region, list, u0, u1, lo, hi) => {
            const base2 = areaLeftOf(g, region, u0), A = areaLeftOf(g, region, u1) - base2, W = list.reduce((sum, target) => sum + target.weight, 0);
            const bounds = [u0];
            let acc = 0;
            for (let k = 0; k < list.length - 1; k++) {
              acc += list[k].weight;
              bounds.push(Math.max(bounds[bounds.length - 1], Math.min(hi, Math.max(lo, uAtArea(region, base2 + A * acc / W)))));
            }
            bounds.push(u1);
            unslivered(region, bounds, lo, hi);
            return list.map((target, k) => ({ u0: bounds[k], u1: bounds[k + 1], target, polygon: slice(region, bounds[k], bounds[k + 1]) }));
          };
          const packRun = (region, list, u0, u1, lo, hi, voidAt) => {
            const A = areaLeftOf(g, region, u1) - areaLeftOf(g, region, u0);
            const need = list.reduce((sum, target) => sum + target.weight, 0);
            if (!list.length) return A >= minFlatM2 ? [{ u0, u1, target: voidTarget, void: true, polygon: slice(region, u0, u1) }] : [];
            if (need >= A * 0.97) return cutRun(region, list, u0, u1, lo, hi);
            const xs = cornersU(region), forward = voidAt !== "start";
            const pieces = [];
            let prev = forward ? u0 : u1;
            (forward ? list : list.slice().reverse()).forEach((target, k, order) => {
              const last = k === order.length - 1;
              let cut = uAtArea(region, areaLeftOf(g, region, prev) + (forward ? target.weight : -target.weight));
              if (!last) cut = Math.min(hi, Math.max(lo, cut));
              const span = (u) => forward ? [prev, u] : [u, prev];
              const cost = (u) => narrowM2(g, slice(region, ...span(u)), MIN_PART_M);
              let best = cut, bestCost = cost(cut);
              if (bestCost >= SLIVER_M2) {
                const options = [{ x: cut, c: bestCost }];
                for (const x of xs.flatMap((u) => [u - 0.02, u + 0.02])) {
                  if (Math.abs(x - cut) > SNAP_M || (forward ? x <= prev + 0.5 || x >= u1 - 0.5 : x >= prev - 0.5 || x <= u0 + 0.5) || !last && (x < lo || x > hi)) continue;
                  options.push({ x, c: cost(x) });
                }
                const floor = Math.max(SLIVER_M2, Math.min(...options.map((o) => o.c)) + 0.5);
                const miss = (x) => Math.abs(areaOf(slice(region, ...span(x))) - target.weight);
                best = options.filter((o) => o.c < floor).reduce((b2, o) => miss(o.x) < miss(b2.x) ? o : b2).x;
                bestCost = cost(best);
              }
              const [a, b] = span(best);
              pieces.push({ u0: a, u1: b, target });
              prev = best;
            });
            if (!forward) pieces.reverse();
            const [r0, r1] = forward ? [prev, u1] : [u0, prev];
            const restPolygon = slice(region, r0, r1);
            if (!restPolygon || areaOf(restPolygon) < 1) {
              if (forward) pieces[pieces.length - 1].u1 = u1;
              else pieces[0].u0 = u0;
              return pieces.map((piece) => ({ ...piece, polygon: slice(region, piece.u0, piece.u1) }));
            }
            const flats = pieces.map((piece) => ({ ...piece, polygon: slice(region, piece.u0, piece.u1) }));
            const rest = { u0: r0, u1: r1, target: voidTarget, void: true, polygon: restPolygon };
            return forward ? [...flats, rest] : [rest, ...flats];
          };
          const reachM = doorM + 0.5;
          const cutByTargets = (side, list, mode, voidMode) => {
            const uc = (c0 + c1) / 2;
            const twoRuns = side.core || absolute && voidMode === "core";
            if (!twoRuns) return absolute ? packRun(side.region, list, iu0 - 1, iu1 + 1, iu0 - 1, iu1 + 1, "end") : cutRun(side.region, list, iu0 - 1, iu1 + 1, iu0 - 1, iu1 + 1);
            if (list.length === 1 && !absolute) return [{ u0: iu0 - 1, u1: iu1 + 1, target: list[0], polygon: side.region }];
            const split = list.length === 1 ? { first: list, second: [] } : mode === "fit" ? bestSplit(list, side.core ? runRange(side, list) : 0.5) : bestSplit(list, areaLeftOf(g, side.region, uc) / areaOf(side.region), true);
            const largestLast = (run) => {
              if (!run.length) return run;
              const i = run.reduce((best, target, k) => target.weight > run[best].weight ? k : best, 0);
              return [...run.slice(0, i), ...run.slice(i + 1), run[i]];
            };
            const left = largestLast(split.first), right = largestLast(split.second).reverse();
            const weightOf = (run) => run.reduce((sum, target) => sum + target.weight, 0);
            const ub = !side.core ? uc : mode === "fit" && !absolute ? Math.min(c1 - BEHIND_M, Math.max(c0 + BEHIND_M, uAtArea(side.region, areaOf(side.region) * weightOf(left) / weightOf(list)))) : uc;
            const [leftHi, rightLo] = side.core ? [c0 - reachM, c1 + reachM] : [ub, ub];
            if (absolute) return [
              ...packRun(side.region, left, iu0 - 1, ub, iu0 - 1, leftHi, voidMode === "core" ? "end" : "start"),
              ...packRun(side.region, right, ub, iu1 + 1, rightLo, iu1 + 1, voidMode === "core" ? "start" : "end")
            ];
            return [
              ...cutRun(side.region, left, iu0 - 1, ub, iu0 - 1, leftHi),
              ...cutRun(side.region, right, ub, iu1 + 1, rightLo, iu1 + 1)
            ];
          };
          const candidate = (sideMode, runMode, voidMode) => {
            const assigned = assign(sideMode), walls = [];
            const placed2 = [];
            for (const side of sides) {
              if (!side.region || areaOf(side.region) < minFlatM2) continue;
              let flats;
              if (targets && !assigned.has(side)) {
                placed2.push({ side, u0: iu0 - 1, u1: iu1 + 1, polygon: side.region, target: null, void: true, span: null });
                continue;
              } else if (targets) {
                flats = cutByTargets(side, assigned.get(side), runMode, voidMode);
              } else if (side.core) {
                const uc = (c0 + c1) / 2;
                const left = cutAcross(slice(side.region, iu0 - 1, c0), iu0 - 1, c0);
                const right = cutAcross(slice(side.region, c1, iu1 + 1), c1, iu1 + 1);
                const behindL = slice(side.region, c0, uc - wallM / 2), behindR = slice(side.region, uc + wallM / 2, c1);
                if (left.length) {
                  const last = left[left.length - 1];
                  last.polygon = g.unionAll(t, [last.polygon, behindL].filter(Boolean));
                  last.u1 = uc;
                }
                if (right.length) {
                  right[0].polygon = g.unionAll(t, [behindR, right[0].polygon].filter(Boolean));
                  right[0].u0 = uc;
                }
                const between = g.intersectOrNull(t, box(t, uc - wallM / 2, uc + wallM / 2, iv0 - 1, iv1 + 1), side.region);
                if (between && left.length && right.length) walls.push(between);
                flats = [...left, ...right];
              } else {
                flats = cutAcross(side.region, iu0 - 1, iu1 + 1);
              }
              const reachesCorridor = (flat) => {
                const contact = g.intersectOrNull(t, flat.polygon, across(side.face - (side.sign < 0 ? 0.1 : 0), side.face + (side.sign > 0 ? 0.1 : 0)));
                if (!contact || areaOf(contact) < 0.01) return null;
                const [a0, , a1] = bboxOf(g, contact);
                return a1 - a0 >= doorM + 0.4 ? [a0, a1] : null;
              };
              flats = flats.filter((flat) => flat.polygon && areaOf(flat.polygon) > 0.5);
              for (let i = 0; i < flats.length && flats.length > 1; i++) {
                if (flats[i].void || areaOf(flats[i].polygon) >= minFlatM2 && reachesCorridor(flats[i])) continue;
                const j = [i + 1, i - 1].find((k) => flats[k] && !flats[k].void);
                if (j === void 0) continue;
                flats[j] = {
                  u0: Math.min(flats[i].u0, flats[j].u0),
                  u1: Math.max(flats[i].u1, flats[j].u1),
                  polygon: g.unionAll(t, [flats[i].polygon, flats[j].polygon]),
                  ...targets ? { target: flats[j].target || flats[i].target } : {}
                };
                flats.splice(i, 1);
                i = -1;
              }
              for (const flat of flats) {
                if (areaOf(flat.polygon) < (flat.void ? 1 : minFlatM2)) continue;
                const before = placed2[placed2.length - 1];
                if (flat.void && before && before.void && before.side === side && Math.abs(before.u1 - flat.u0) < 0.01) {
                  before.polygon = g.unionAll(t, [before.polygon, flat.polygon]);
                  before.u1 = flat.u1;
                  continue;
                }
                placed2.push({ side, u0: flat.u0, u1: flat.u1, polygon: flat.polygon, target: flat.target || null, void: !!flat.void, span: flat.void ? null : reachesCorridor(flat) });
              }
            }
            const ucMid = (c0 + c1) / 2;
            let uL = c0, uR = c1;
            for (const flat of placed2) {
              if (!flat.span) continue;
              const [s0, s1] = flat.span, pad = Math.min(0.3, (s1 - s0 - doorM) / 2);
              flat.doorU = Math.min(s1 - pad - doorM / 2, Math.max(s0 + pad + doorM / 2, ucMid));
              uL = Math.min(uL, flat.doorU - doorM / 2 - CORRIDOR_END_M);
              uR = Math.max(uR, flat.doorU + doorM / 2 + CORRIDOR_END_M);
            }
            if (hallU !== null) {
              uL = Math.min(uL, hallU - rules.entranceHallM / 2 - wallM);
              uR = Math.max(uR, hallU + rules.entranceHallM / 2 + wallM);
            }
            const trimmed = { [-1]: [], [1]: [] }, endWalls = [];
            const [bandV0, bandV1] = band;
            for (const [end, lo, hi] of [[-1, iu0 - 1, uL], [1, uR, iu1 + 1]]) {
              if (end < 0 ? uL <= iu0 + 0.3 : uR >= iu1 - 0.3) continue;
              const spans = placed2.filter((flat) => end < 0 ? flat.u0 <= iu0 && flat.u1 >= uL - 0.01 : flat.u1 >= iu1 && flat.u0 <= uR + 0.01);
              if (!spans.length) continue;
              const deficit = (flat) => flat.void || flat.target && flat.target.kind === "void" ? -Infinity : targets && flat.target ? areaOf(flat.polygon) / flat.target.weight : areaOf(flat.polygon);
              const taker = spans.reduce((best, flat) => deficit(flat) < deficit(best) ? flat : best);
              const v0 = taker.side.sign < 0 ? bandV0 - wallM : bandV0, v1 = taker.side.sign < 0 ? bandV1 : bandV1 + wallM;
              const piece = g.differenceOrNull(t, g.intersectOrNull(t, innerUV, box(t, lo, hi, v0, v1)), core.outline);
              if (!piece || areaOf(piece) < 0.3) continue;
              taker.polygon = g.unionAll(t, [taker.polygon, piece]);
              trimmed[taker.side.sign].push(box(t, lo, hi, v0, v1));
              const wu = end < 0 ? [uL - wallM, uL] : [uR, uR + wallM];
              endWalls.push(g.intersectOrNull(t, innerUV, box(t, wu[0], wu[1], v0, v1)));
            }
            [[-1, across(bandV0 - wallM, bandV0)], [1, across(bandV1, bandV1 + wallM)]].forEach(([sign, wall]) => {
              const piece = g.differenceOrNull(t, g.differenceOrNull(t, g.intersectOrNull(t, wall, innerUV), core.outline), g.unionAll(t, trimmed[sign]));
              if (piece) walls.push(piece);
            });
            walls.push(...endWalls.filter(Boolean));
            const touching = (a, b) => g.polygonsOf(g.unionAll(t, [a, b])).length < g.polygonsOf(a).length + g.polygonsOf(b).length;
            for (const flat of placed2) {
              if (flat.void || flat.doorU === void 0 || g.polygonsOf(flat.polygon).length < 2) continue;
              const door = [flat.doorU, flat.side.face + flat.side.sign * 0.3];
              for (const rings of g.polygonsOf(flat.polygon)) {
                if (insideRing(rings, door)) continue;
                const piece = t.polygon(rings);
                const taker = placed2.find((other) => other !== flat && other.void && touching(other.polygon, piece)) || placed2.filter((other) => other !== flat && touching(other.polygon, piece)).sort((a, b) => areaOf(b.polygon) - areaOf(a.polygon))[0];
                if (!taker) continue;
                flat.polygon = g.differenceOrNull(t, flat.polygon, piece) || flat.polygon;
                taker.polygon = g.unionAll(t, [taker.polygon, piece]);
              }
            }
            return { placed: placed2, walls };
          };
          const darkM2 = (flat) => {
            if (!facades || !rooms) return 0;
            const lit = [];
            for (const f of facades) {
              if (f.blind || f.party) continue;
              const run = rooms.facadeRun(t, flat.polygon, f, rules.exteriorWallM);
              if (!run) continue;
              const at = (along, depth) => g.add(g.add(f.a, f.d, along), f.inward, rules.exteriorWallM + depth);
              lit.push(t.polygon([[at(run[0] - 0.5, -1), at(run[1] + 0.5, -1), at(run[1] + 0.5, LIT_DEPTH_M), at(run[0] - 0.5, LIT_DEPTH_M), at(run[0] - 0.5, -1)]]));
            }
            const sign = flat.side.sign, face = flat.side.face;
            lit.push(box(t, iu0 - 1, iu1 + 1, Math.min(face, face + sign * ACCESS_DEPTH_M), Math.max(face, face + sign * ACCESS_DEPTH_M)));
            return areaOf(g.differenceOrNull(t, flat.polygon, g.unionAll(t, lit)));
          };
          const frontageOf = (flat) => facades && rooms ? facades.filter((f) => !f.blind && !f.party).map((f) => rooms.facadeRun(t, flat.polygon, f, rules.exteriorWallM)).filter(Boolean).reduce((sum, run) => sum + run[1] - run[0], 0) : 0;
          const score = ({ placed: placed2 }) => {
            const flats = placed2.filter((flat) => !flat.void && flat.target && flat.target.kind !== "void");
            const drawn = flats.reduce((sum, flat) => sum + areaOf(flat.polygon), 0), wanted = flats.reduce((sum, flat) => sum + flat.target.weight, 0);
            let cost = 2 * Math.max(0, targets.filter((target) => target.kind !== "void").length - flats.length);
            for (const flat of flats) {
              const area = areaOf(flat.polygon), err = absolute ? area / flat.target.weight - 1 : area / drawn / (flat.target.weight / wanted) - 1;
              cost += 10 * err * err + 3 * darkM2(flat) / area;
              if (flat.doorU === void 0) cost += 3;
              const frontage = frontageOf(flat);
              if (frontage < Math.max(3.5, area / 12)) cost += 2 * (1 - frontage / Math.max(3.5, area / 12));
              cost += narrowM2(g, flat.polygon, NARROW_FLAT_M) / 4;
              const [x0, y0, x1, y1] = bboxOf(g, flat.polygon), long = Math.max(x1 - x0, y1 - y0), short = Math.max(0.5, Math.min(x1 - x0, y1 - y0));
              cost += Math.max(0, long / short - 2.5);
            }
            return cost;
          };
          const groupingKey = (assigned) => [...assigned.entries()].map(([side, list]) => `${side.sign}:${list.map((target) => target.id).join(",")}`).join("|");
          const sideModes = targets ? ["order", "fit"].filter((mode, i, all) => i === 0 || groupingKey(assign(mode)) !== groupingKey(assign(all[0]))) : ["order"];
          const modes = sideModes.flatMap((sideMode) => {
            const splitsRound = targets && [...assign(sideMode).entries()].some(([side, list]) => (side.core || absolute) && list.length > 1);
            return splitsRound ? [[sideMode, "order"], [sideMode, "fit"]] : [[sideMode, "order"]];
          }).flatMap((mode) => absolute ? [[...mode, "core"], [...mode, "far"]] : [[...mode, null]]);
          const chosen = modes.map(([sideMode, runMode, voidMode]) => candidate(sideMode, runMode, voidMode)).reduce((best, layout) => {
            if (!targets) return layout;
            layout.cost = score(layout);
            return !best || layout.cost < best.cost - 1e-9 ? layout : best;
          }, null);
          const placed = chosen.placed;
          out.walls.push(...chosen.walls);
          const within = (point, except) => placed.some((other) => other !== except && g.polygonsOf(other.polygon).some((rings) => insideRing(rings, point)));
          for (const flat of placed) {
            for (const rings of g.polygonsOf(flat.polygon)) for (const ring of rings) {
              const solid = g.ringArea(ring) > 0 ? 1 : -1;
              for (let i = 0; i + 1 < ring.length; i++) {
                const a = ring[i], b = ring[i + 1], L = g.len(g.vec(a, b));
                if (L < 0.3) continue;
                const d = g.unit(g.vec(a, b)), outward = [d[1] * solid, -d[0] * solid];
                if (!within(g.add(g.midpoint(a, b), outward, 0.15), flat)) continue;
                const wall = g.intersectOrNull(t, g.strip(t, g.add(a, d, -wallM / 2), g.add(b, d, wallM / 2), wallM), innerUV);
                if (wall) out.walls.push(wall);
              }
            }
          }
          for (const flat of placed) {
            out.flats.push({
              polygon: flat.polygon,
              areaM2: areaOf(flat.polygon),
              ...targets ? { target: flat.target } : {},
              ...flat.void ? { void: true } : {},
              side: flat.side.sign,
              ...flat.doorU !== void 0 ? { doorU: flat.doorU, doorV: flat.side.face } : {}
            });
            if (flat.doorU === void 0) continue;
            const v = flat.side.face - flat.side.sign * wallM / 2, sign = flat.side.sign;
            const a = [flat.doorU - doorM / 2, v], b = [flat.doorU + doorM / 2, v];
            const door = { kind: "door", a, b, depthM: wallM, sillM: 0, heightM: rules.doorHeightM, hinge: b, openTip: [b[0], v + sign * doorM], room: "apartment" };
            out.openings.push(door);
            out.cuts.push(g.strip(t, door.a, door.b, wallM + 0.06));
          }
          return out;
        }
        function withoutSlivers(t, g, feature, minM = 1, stepM = 0.2) {
          if (!feature) return feature;
          const rings = g.polygonsOf(feature).flatMap((r) => r);
          const strips = [];
          for (const axis of [0, 1]) {
            const o = 1 - axis;
            let lo = Infinity, hi = -Infinity;
            for (const ring of rings) for (const p of ring) {
              lo = Math.min(lo, p[o]);
              hi = Math.max(hi, p[o]);
            }
            for (let sv = lo + stepM / 2; sv < hi; sv += stepM) {
              const xs = [];
              for (const ring of rings) for (let i = 0; i < ring.length; i++) {
                const p = ring[i], q = ring[(i + 1) % ring.length];
                if (p[o] <= sv !== q[o] <= sv) xs.push(p[axis] + (sv - p[o]) * (q[axis] - p[axis]) / (q[o] - p[o]));
              }
              xs.sort((a, b) => a - b);
              for (let k = 0; k + 1 < xs.length; k += 2) {
                if (xs[k + 1] - xs[k] >= minM) continue;
                const [a0, a1, b0, b1] = [xs[k] - 0.01, xs[k + 1] + 0.01, sv - stepM / 2 - 0.01, sv + stepM / 2 + 0.01];
                strips.push(axis === 0 ? box(t, a0, a1, b0, b1) : box(t, b0, b1, a0, a1));
              }
            }
          }
          if (!strips.length) return feature;
          const zones = g.polygonsOf(g.unionAll(t, strips)).map((r) => t.polygon(r)).filter((zone) => g.polygonsArea(g.intersectOrNull(t, zone, feature)) >= 0.8);
          if (!zones.length) return feature;
          return g.differenceOrNull(t, feature, g.unionAll(t, zones)) || feature;
        }
        function areaLeftOf(g, feature, x) {
          let total = 0;
          for (const rings of feature ? g.polygonsOf(feature) : []) rings.forEach((ring, index) => {
            const out = [];
            for (let i = 0; i < ring.length; i++) {
              const p = ring[i], q = ring[(i + 1) % ring.length];
              if (p[0] <= x) out.push(p);
              if (p[0] <= x !== q[0] <= x) out.push([x, p[1] + (x - p[0]) * (q[1] - p[1]) / (q[0] - p[0])]);
            }
            let twice = 0;
            for (let i = 0; i < out.length; i++) {
              const a = out[i], b = out[(i + 1) % out.length];
              twice += a[0] * b[1] - b[0] * a[1];
            }
            total += (index === 0 ? 1 : -1) * Math.abs(twice / 2);
          });
          return total;
        }
        function narrowM2(g, feature, minM, stepM = 0.25) {
          const rings = feature ? g.polygonsOf(feature).flatMap((rings2) => rings2) : [];
          if (!rings.length) return 0;
          let total = 0;
          for (const axis of [0, 1]) {
            const o = 1 - axis;
            let lo = Infinity, hi = -Infinity;
            for (const ring of rings) for (const p of ring) {
              lo = Math.min(lo, p[o]);
              hi = Math.max(hi, p[o]);
            }
            for (let s = lo + stepM / 2; s < hi; s += stepM) {
              const xs = [];
              for (const ring of rings) for (let i = 0; i < ring.length; i++) {
                const p = ring[i], q = ring[(i + 1) % ring.length];
                if (p[o] <= s !== q[o] <= s) xs.push(p[axis] + (s - p[o]) * (q[axis] - p[axis]) / (q[o] - p[o]));
              }
              xs.sort((a, b) => a - b);
              for (let k = 0; k + 1 < xs.length; k += 2) {
                const w = xs[k + 1] - xs[k];
                if (w < minM) total += w * stepM;
              }
            }
          }
          return total;
        }
        const MIN_PART_M = 2, SLIVER_M2 = 1, SNAP_M = 3, CORRIDOR_END_M = 0.4;
        const MIN_FLAT_WIDTH_M = 4.5;
        const NARROW_FLAT_M = 3.2;
        function bestSplit(list, wanted, inOrder = false) {
          const [lo, hi] = Array.isArray(wanted) ? [Math.min(...wanted), Math.max(...wanted)] : [wanted, wanted];
          const miss = (value) => Math.max(0, lo - value, value - hi);
          const total = list.reduce((sum, target) => sum + target.weight, 0);
          let best = null;
          if (list.length <= 12 && !inOrder) {
            for (let mask = 1; mask < (1 << list.length) - 1; mask++) {
              let acc2 = 0;
              list.forEach((target, k) => {
                if (mask & 1 << k) acc2 += target.weight;
              });
              const err = miss(acc2 / total);
              if (!best || err < best.err - 1e-9) best = { err, mask };
            }
            return best ? { err: best.err, first: list.filter((_, k) => best.mask & 1 << k), second: list.filter((_, k) => !(best.mask & 1 << k)) } : { err: miss(1), first: list.slice(), second: [] };
          }
          let acc = 0;
          for (let k = 1; k < list.length; k++) {
            acc += list[k - 1].weight;
            const err = miss(acc / total);
            if (!best || err < best.err) best = { err, k };
          }
          return { err: best.err, first: list.slice(0, best.k), second: list.slice(best.k) };
        }
        const LIT_DEPTH_M = 6.4;
        const ACCESS_DEPTH_M = 4;
        function insideRing(rings, p) {
          let hit = false;
          for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i], b = ring[j];
            if (a[1] > p[1] !== b[1] > p[1] && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
          }
          return hit;
        }
        const api = { CORE_RULES, wantsCentralCore, planCoreFloorPlans, orientedBox, closeSeams };
        global.__defaultFloorPlanCore = api;
        if (typeof module !== "undefined" && module.exports) module.exports = api;
      })(typeof window !== "undefined" ? window : globalThis);
    }
  });

  // src/planner/default-floor-plans.js
  var require_default_floor_plans = __commonJS({
    "src/planner/default-floor-plans.js"(exports, module) {
      (function(global) {
        "use strict";
        function reportClip(operation, error, site, operands) {
          const api2 = global && global.__parcelArrangement || (typeof __require === "function" ? require_clip_report() : null);
          if (api2) return api2.reportClipFailure(operation, error, { site }, operands);
          console.error(`[${(/* @__PURE__ */ new Date()).toISOString()}] [clip] Polygon ${operation} failed at ${site}: ${error && error.message} \u2014 degraded`);
          return error;
        }
        const buildingUse = () => global && global.BuildingUse || require_building_use();
        const GENERATOR_ID = "consensus-builder.default-floor-plan.v1";
        const PLANS_SCHEMA = "consensus-builder.building-floor-plans.v3";
        const ARCHITECTURE_SCHEMA = "consensus-builder.floor-architecture.v1";
        const REGULATION_PRESETS = Object.freeze({
          HR: Object.freeze({
            region: "HR",
            regulationBasis: "NN 12/2023 \u010Dl. 13, 14, 19, 24; NN 29/2013 \u010Dl. 4, 44",
            maxRiserM: 0.15,
            minTreadM: 0.33,
            flightWidthM: 1.1,
            landingDepthM: 1.5,
            apartmentDoorM: 1.1,
            liftDoorM: 0.9,
            liftCabinM: [1.1, 1.4],
            highRiseAboveM: 22,
            corridorWidthM: 1.5,
            maxDeadEndM: 15,
            maxStairSpacingM: 40
          }),
          generic: Object.freeze({
            region: "generic",
            regulationBasis: "generic practice (no local regulation configured)",
            maxRiserM: 0.17,
            minTreadM: 0.29,
            flightWidthM: 1.2,
            landingDepthM: 1.5,
            apartmentDoorM: 1,
            liftDoorM: 0.9,
            liftCabinM: [1.1, 1.4],
            highRiseAboveM: 22,
            corridorWidthM: 1.5,
            maxDeadEndM: 15,
            maxStairSpacingM: 40
          })
        });
        const CORRIDOR_MIX = Object.freeze([
          Object.freeze({ type: "studio", share: 0.25, widthM: 4.8, areaM2: Object.freeze([30, 38]), bedrooms: 0, north: true }),
          Object.freeze({ type: "one-bed", share: 0.4, widthM: 7, areaM2: Object.freeze([50, 58]), bedrooms: 1 }),
          Object.freeze({ type: "two-bed", share: 0.3, widthM: 9, areaM2: Object.freeze([65, 75]), bedrooms: 2 }),
          Object.freeze({ type: "three-bed", share: 0.05, areaM2: Object.freeze([85, 90]), bedrooms: 3, gable: true })
        ]);
        const COMMON_RULES = Object.freeze({
          halfLandingDepthM: 1.2,
          // the turn between the two flights
          liftShaftOuterM: [2, 2.2],
          // a 110 × 140 cm cabin with its shaft walls
          stairEyeM: 0.25,
          // open well between flights when there is no lift
          fireLobbyDepthM: 1.5,
          // extra landing depth that stands in for a high-rise fire lobby
          entranceDoorM: 1.4,
          doorHeightM: 2.1,
          entranceHeightM: 2.3,
          exteriorWallM: 0.3,
          coreWallM: 0.2,
          apartmentWallM: 0.2,
          // between the two apartments behind the core
          dilatationWallM: 0.25,
          // between two cores' segments of one building
          slabThicknessM: 0.2,
          blindFacadeSetbackM: 3,
          // facades closer than this to the parcel boundary stay blind
          minApartmentM2: 30,
          maxApartmentM2: 120,
          // above this per apartment the floor gets another core
          minApartmentWidthM: 3,
          // a strip beside the core narrower than this is not a room
          deepFloorPlateM: 16,
          // facade-to-facade depth above which rooms lose daylight
          liftPolicy: "auto",
          // 'auto' | 'always' | 'never'
          liftFromFloors: 4,
          // auto: a lift from P+3 upwards ...
          liftFromApartments: 10,
          // ... or once the building reaches ten apartments
          balconies: true,
          groundFloorUse: "auto",
          // 'auto' | 'residential' | 'commercial'
          garage: "auto",
          // 'auto' | 'always' | 'never'
          garageLevels: 1,
          garageFromFloors: 4,
          garageFromUsableM2: 300,
          maxCores: 8,
          maxFloors: 60,
          minFootprintM2: 4,
          access: "auto",
          // 'auto' | 'point' | 'corridor' (building-use.js layoutAccess)
          coreSide: "auto",
          // point access: 'auto' (by the street's orientation) | 'street' | 'yard'
          corridorFromDepthM: 15,
          // auto: a plate this deep inside its walls (two ~6.5 m rows + corridor) gets a corridor
          minCorridorRowDepthM: 5,
          // a corridor row shallower than this holds no flat
          deepCorridorRowM: 10,
          // a corridor row deeper than this leaves rooms far from the facade
          gableFlatDepthM: 4.8,
          // the gable flat's depth from the end facade: hall 1.2 + rooms 3.4
          lobbyWidthM: 1.9,
          // the stair lobby beside each corridor core, facade to corridor
          northFacingWithinDeg: 45,
          // a facade facing within this of the pole is north-facing
          corridorMix: CORRIDOR_MIX
        });
        function rulesFor(options = {}) {
          const overrides = options.rules || {};
          const region = String(overrides.region || options.region || "generic").toUpperCase();
          const preset = REGULATION_PRESETS[region] || REGULATION_PRESETS.generic;
          return Object.freeze({ ...COMMON_RULES, ...preset, ...overrides, region: preset.region });
        }
        const DEFAULT_RULES = rulesFor();
        const finite = (value) => typeof value === "number" && Number.isFinite(value);
        const round6 = (value) => Math.round(value * 1e6) / 1e6;
        const round2 = (value) => Math.round(value * 100) / 100;
        const EARTH_RADIUS_M = 6378137;
        const M_PER_DEG = Math.PI * EARTH_RADIUS_M / 180;
        function T(options) {
          if (options && options.turf) return options.turf;
          if (typeof turf !== "undefined" && turf) return turf;
          if (global && global.turf) return global.turf;
          try {
            return typeof __require === "function" ? __require("@turf/turf") : null;
          } catch (_) {
            return null;
          }
        }
        function coreModule(options) {
          if (options && options.core) return options.core;
          if (global && global.__defaultFloorPlanCore) return global.__defaultFloorPlanCore;
          return typeof __require === "function" ? require_default_floor_plan_core() : null;
        }
        function roomsModule(options) {
          if (options && options.rooms) return options.rooms;
          if (global && global.__defaultFloorPlanRooms) return global.__defaultFloorPlanRooms;
          try {
            return typeof __require === "function" ? require_default_floor_plan_rooms() : null;
          } catch (_) {
            return null;
          }
        }
        function makeFrame(anchorLng, anchorLat) {
          const mx = M_PER_DEG * Math.cos(anchorLat * Math.PI / 180);
          return {
            toMeters: ([lng, lat]) => [(lng - anchorLng) * mx, (lat - anchorLat) * M_PER_DEG],
            toDegrees: ([x, y]) => [anchorLng + x / mx, anchorLat + y / M_PER_DEG]
          };
        }
        function geometryOf(value) {
          const g = value && value.type === "Feature" ? value.geometry : value;
          return g && (g.type === "Polygon" || g.type === "MultiPolygon") ? g : null;
        }
        function polygonsOf(value) {
          const g = geometryOf(value);
          if (!g) return [];
          return g.type === "Polygon" ? [g.coordinates] : g.coordinates;
        }
        function ringArea(ring) {
          let twice = 0;
          const n = ring.length;
          for (let i = 0; i < n; i++) {
            const p = ring[i], q = ring[(i + 1) % n];
            twice += p[0] * q[1] - q[0] * p[1];
          }
          return twice / 2;
        }
        const AXIS_SNAP_DEG = 3;
        function mainAxis(ring) {
          const edges = [];
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (l > 1e-6) edges.push({ deg: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI % 90 + 90) % 90, l });
          }
          if (!edges.length) return null;
          const signed = (x, from) => {
            const d = ((x - from) % 90 + 135) % 90 - 45;
            return d;
          };
          let best = null;
          for (const candidate of edges) {
            const near = edges.filter((e) => Math.abs(signed(e.deg, candidate.deg)) <= AXIS_SNAP_DEG);
            const weight = near.reduce((sum, e) => sum + e.l, 0);
            if (!best || weight > best.weight + 1e-9) best = { weight, near, from: candidate.deg };
          }
          const deg = best.from + best.near.reduce((sum, e) => sum + signed(e.deg, best.from) * e.l, 0) / best.weight;
          return [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180)];
        }
        function squareTo(axis, d) {
          if (!axis) return d;
          const dot = (c) => c[0] * d[0] + c[1] * d[1];
          const nearest = [axis, [-axis[1], axis[0]], [-axis[0], -axis[1]], [axis[1], -axis[0]]].reduce((best, c) => dot(c) > dot(best) ? c : best);
          return dot(nearest) > Math.cos(0.5 * Math.PI / 180) ? d : nearest;
        }
        function polygonsArea(value) {
          let area = 0;
          for (const rings of polygonsOf(value)) {
            rings.forEach((ring, index) => {
              area += (index === 0 ? 1 : -1) * Math.abs(ringArea(ring));
            });
          }
          return area;
        }
        function cleanRing(ring, eps) {
          const out = [];
          for (const p of ring) {
            const prev = out[out.length - 1];
            if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < eps) continue;
            out.push([p[0], p[1]]);
          }
          while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < eps) out.pop();
          return out;
        }
        const closed = (ring) => [...ring, ring[0]];
        const rect = (t, u0, u1, v0, v1) => t.polygon([[[u0, v0], [u1, v0], [u1, v1], [u0, v1], [u0, v0]]]);
        const vec = (a, b) => [b[0] - a[0], b[1] - a[1]];
        const add = (p, d, k = 1) => [p[0] + d[0] * k, p[1] + d[1] * k];
        const len = (d) => Math.hypot(d[0], d[1]);
        const unit = (d) => {
          const l = len(d);
          return [d[0] / l, d[1] / l];
        };
        const leftNormal = (d) => [-d[1], d[0]];
        function strip(t, a, b, width) {
          const n = leftNormal(unit(vec(a, b)));
          return t.polygon([[add(a, n, width / 2), add(b, n, width / 2), add(b, n, -width / 2), add(a, n, -width / 2), add(a, n, width / 2)]]);
        }
        function swingInto(t, polygon, hinge, into, widthM) {
          let holds = false;
          try {
            holds = !!polygon && t.booleanPointInPolygon(t.point(add(hinge, into, 0.95 * widthM)), polygon);
          } catch (_) {
            holds = false;
          }
          return holds ? into : [-into[0], -into[1]];
        }
        function unionAll(t, features) {
          let acc = null;
          for (const feature of features) {
            if (!feature || !feature.geometry) continue;
            if (!acc) {
              acc = feature;
              continue;
            }
            try {
              const merged = clipOrRetry((x, y) => t.union(x, y), acc, feature);
              if (merged && merged.geometry) acc = merged;
            } catch (error) {
              reportClip("union", error, "default-floor-plans.unionAll", [acc, feature]);
            }
          }
          return acc;
        }
        function snapped(feature) {
          const round = (value) => Array.isArray(value) ? value.map(round) : Math.round(value * 1e9) / 1e9;
          return { type: "Feature", properties: {}, geometry: { type: feature.geometry.type, coordinates: round(feature.geometry.coordinates) } };
        }
        function clipOrRetry(op, a, b) {
          try {
            return op(a, b);
          } catch (first) {
            try {
              return op(snapped(a), snapped(b));
            } catch (_) {
              throw first;
            }
          }
        }
        function differenceOrNull(t, a, b) {
          if (!a || !a.geometry) return null;
          if (!b || !b.geometry) return a;
          try {
            return clipOrRetry((x, y) => t.difference(x, y), a, b);
          } catch (error) {
            reportClip("difference", error, "default-floor-plans.difference", [a, b]);
            return null;
          }
        }
        function intersectOrNull(t, a, b) {
          if (!a || !a.geometry || !b || !b.geometry) return null;
          try {
            return clipOrRetry((x, y) => t.intersect(x, y), a, b);
          } catch (error) {
            reportClip("intersect", error, "default-floor-plans.intersect", [a, b]);
            return null;
          }
        }
        function uExtent(feature) {
          let lo = Infinity, hi = -Infinity;
          for (const rings of polygonsOf(feature)) for (const p of rings[0]) {
            lo = Math.min(lo, p[0]);
            hi = Math.max(hi, p[0]);
          }
          return hi - lo;
        }
        const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        function partyRunsOf(t, a, b, d, inward, lengthM, neighboursM) {
          const out = [-inward[0], -inward[1]];
          const band = t.polygon([[add(a, out, 0.05), add(b, out, 0.05), add(b, out, 0.7), add(a, out, 0.7), add(a, out, 0.05)]]);
          const runs = [];
          for (const neighbour of neighboursM) {
            for (const rings of polygonsOf(intersectOrNull(t, band, neighbour))) {
              let s0 = Infinity, s1 = -Infinity;
              for (const p of rings[0]) {
                const s = (p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1];
                s0 = Math.min(s0, s);
                s1 = Math.max(s1, s);
              }
              s0 = Math.max(0, s0);
              s1 = Math.min(lengthM, s1);
              if (s1 - s0 > 0.05) runs.push([s0, s1]);
            }
          }
          runs.sort((x, y) => x[0] - y[0]);
          const merged = [];
          for (const run of runs) {
            const last = merged[merged.length - 1];
            if (last && run[0] <= last[1] + 0.3) last[1] = Math.max(last[1], run[1]);
            else merged.push(run.slice());
          }
          return merged;
        }
        function stairRun(storeyHeightM, rules) {
          const risers = Math.max(2, Math.ceil(storeyHeightM / rules.maxRiserM - 1e-9));
          const riserM = storeyHeightM / risers;
          const first = Math.ceil(risers / 2), second = risers - first;
          return {
            risers,
            riserM,
            flights: [first, second],
            // The last riser of a flight steps onto its landing: a flight of R risers has R-1 treads.
            runM: (first - 1) * rules.minTreadM
          };
        }
        function wantsLift(rules, floors, cores, highRise = false, perFloor = 2 * cores) {
          if (highRise) return true;
          if (rules.liftPolicy === "always") return true;
          if (rules.liftPolicy === "never") return false;
          return floors >= rules.liftFromFloors || floors * perFloor >= rules.liftFromApartments;
        }
        function coreDimensions(storeyHeightM, rules, lift, highRise = false) {
          const stair = stairRun(storeyHeightM, rules);
          const eyeM = lift ? rules.liftShaftOuterM[0] : rules.stairEyeM;
          const flightZoneM = Math.max(stair.runM, lift ? rules.liftShaftOuterM[1] : 0);
          const landingM = rules.landingDepthM + (highRise ? rules.fireLobbyDepthM : 0);
          const innerWidthM = 2 * rules.flightWidthM + eyeM;
          const innerDepthM = landingM + flightZoneM + rules.halfLandingDepthM;
          return {
            stair,
            lift,
            highRise,
            eyeM,
            flightZoneM,
            landingM,
            innerWidthM,
            innerDepthM,
            widthM: innerWidthM + 2 * rules.coreWallM,
            depthM: innerDepthM + rules.coreWallM
            // the front wall of the core is the facade itself
          };
        }
        function warn(list, code, severity, message, data) {
          list.push({ code, severity, message, ...data ? { data } : {} });
        }
        const TARGET_KINDS = ["apartment", "shop", "office", "void"];
        const COMPASS = {
          north: [0, 1],
          south: [0, -1],
          east: [1, 0],
          west: [-1, 0],
          northeast: [Math.SQRT1_2, Math.SQRT1_2],
          northwest: [-Math.SQRT1_2, Math.SQRT1_2],
          southeast: [Math.SQRT1_2, -Math.SQRT1_2],
          southwest: [-Math.SQRT1_2, -Math.SQRT1_2]
        };
        function normaliseTargets(list) {
          if (!Array.isArray(list) || !list.length) return null;
          const out = list.map((target, index) => {
            const area = target && finite(target.areaM2) && target.areaM2 > 0 ? target.areaM2 : null;
            const beds = target && finite(target.bedrooms) && target.bedrooms >= 0 ? Math.floor(target.bedrooms) : null;
            return {
              id: target && target.id !== void 0 && target.id !== null ? String(target.id) : `t${index + 1}`,
              index,
              areaM2: area,
              bedrooms: beds,
              side: target && typeof target.side === "string" && target.side ? target.side.toLowerCase() : null,
              kind: target && TARGET_KINDS.includes(target.kind) ? target.kind : "apartment"
            };
          });
          const known = out.filter((target) => target.areaM2 !== null);
          const fill = known.length ? known.reduce((sum, target) => sum + target.areaM2, 0) / known.length : 1;
          out.forEach((target) => {
            target.weight = target.areaM2 !== null ? target.areaM2 : fill;
          });
          return out;
        }
        function sideVector(side, front) {
          if (!side) return null;
          if (COMPASS[side]) return COMPASS[side];
          if (side === "street" || side === "front") return [-front.inward[0], -front.inward[1]];
          if (side === "courtyard" || side === "back" || side === "yard") return front.inward.slice();
          return null;
        }
        const typeForBedrooms = (beds) => beds === 0 ? "studio" : beds === 1 ? "one-bed" : beds === 2 ? "two-bed" : "three-bed";
        const bedroomsForArea = (area) => area < 40 ? 0 : area < 60 ? 1 : area < 80 ? 2 : 3;
        function describe(result) {
          if (result.floorPlans && result.summary.scheme === "core") {
            return `a central core with ${result.summary.lifts} lift(s)${result.summary.officeStoreys ? `, ${result.summary.officeStoreys} office storeys` : ""}, up to ${result.summary.apartmentsPerFloor} apartments per storey`;
          }
          if (result.floorPlans) return `${result.summary.cores} core(s), ${result.summary.apartmentsPerFloor} apartments per storey`;
          return result.warnings.filter((w) => w.severity === "error").map((w) => w.message).join(" ") || "No layout generated.";
        }
        function matchEdge(edges, hint, frame) {
          if (!hint || !Array.isArray(hint.a) || !Array.isArray(hint.b)) return null;
          const a = frame.toMeters(hint.a), b = frame.toMeters(hint.b), hintMid = midpoint(a, b);
          const exact = edges.reduce((best2, edge) => {
            const distance = len(vec(midpoint(edge.a, edge.b), hintMid));
            return distance < 0.5 && (!best2 || distance < best2.distance) ? { edge, distance } : best2;
          }, null)?.edge;
          if (exact) return exact;
          const L = len(vec(a, b));
          if (L < 1e-6) return null;
          const d = unit(vec(a, b)), along = (p) => (p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1], off = (p) => Math.abs((p[0] - a[0]) * d[1] - (p[1] - a[1]) * d[0]);
          let best = null;
          for (const edge of edges) {
            const l = len(vec(edge.a, edge.b));
            if (l < 1e-6) continue;
            const e = unit(vec(edge.a, edge.b));
            if (Math.abs(e[0] * d[0] + e[1] * d[1]) < Math.cos(5 * Math.PI / 180) || off(edge.a) > 0.5 || off(edge.b) > 0.5) continue;
            const overlap = Math.min(L, Math.max(along(edge.a), along(edge.b))) - Math.max(0, Math.min(along(edge.a), along(edge.b)));
            if (overlap > 0.5 && (!best || overlap > best.overlap)) best = { edge, overlap };
          }
          return best ? best.edge : null;
        }
        function coreParts(t, rules, core, storeyHeightM, lift, uc, pt, bx) {
          const out = { walls: [], openings: [], cuts: [], voids: [], landings: [], stairs: [], railings: [] };
          const x0 = uc - core.innerWidthM / 2, x1 = uc + core.innerWidthM / 2;
          const y0 = core.landingM;
          const y1 = y0 + core.flightZoneM;
          const y2 = y1 + rules.halfLandingDepthM;
          out.walls.push(bx(x0 - rules.coreWallM, x0, 0, y2 + rules.coreWallM));
          out.walls.push(bx(x1, x1 + rules.coreWallM, 0, y2 + rules.coreWallM));
          out.walls.push(bx(x0, x1, y2, y2 + rules.coreWallM));
          out.rect = bx(x0 - rules.coreWallM, x1 + rules.coreWallM, 0, y2 + rules.coreWallM);
          const run = core.stair.runM;
          const leftX = x0 + rules.flightWidthM / 2, rightX = x1 - rules.flightWidthM / 2;
          const half = core.stair.flights[0] * core.stair.riserM;
          out.stairs.push({ a: pt(leftX, y0), b: pt(leftX, y0 + run), widthM: rules.flightWidthM, steps: core.stair.flights[0], fromM: 0, toM: half });
          if (core.stair.flights[1] > 0) {
            const run2 = (core.stair.flights[1] - 1) * rules.minTreadM;
            out.stairs.push({
              a: pt(rightX, y1),
              b: pt(rightX, Math.max(y0 + 0.05, y1 - run2)),
              widthM: rules.flightWidthM,
              steps: core.stair.flights[1],
              fromM: half,
              toM: storeyHeightM
            });
          }
          out.landings.push(bx(x0, x1, y1, y2));
          out.voids.push(bx(x0, x1, y0, y2));
          if (lift) {
            const [shaftW, shaftD] = rules.liftShaftOuterM;
            const sx0 = uc - shaftW / 2, sx1 = uc + shaftW / 2, sy0 = y0, sy1 = y0 + shaftD;
            const shaft = differenceOrNull(
              t,
              bx(sx0, sx1, sy0, sy1),
              bx(sx0 + rules.coreWallM, sx1 - rules.coreWallM, sy0 + rules.coreWallM, sy1 - rules.coreWallM)
            );
            if (shaft) out.walls.push(shaft);
            const doorY = sy0 + rules.coreWallM / 2;
            const liftDoor = {
              kind: "slidingDoor",
              a: pt(uc - rules.liftDoorM / 2, doorY),
              b: pt(uc + rules.liftDoorM / 2, doorY),
              depthM: rules.coreWallM,
              sillM: 0,
              heightM: rules.doorHeightM,
              room: "lift"
            };
            out.openings.push(liftDoor);
            out.cuts.push(strip(t, liftDoor.a, liftDoor.b, rules.coreWallM + 0.06));
          } else {
            out.railings.push({ a: pt(x0 + rules.flightWidthM, y0), b: pt(x0 + rules.flightWidthM, y1), heightM: 1 });
            out.railings.push({ a: pt(x1 - rules.flightWidthM, y0), b: pt(x1 - rules.flightWidthM, y1), heightM: 1 });
            out.railings.push({ a: pt(x0 + rules.flightWidthM, y0), b: pt(x1 - rules.flightWidthM, y0), heightM: 1 });
          }
          return { ...out, x0, x1, y0, y2 };
        }
        function decideCoreSide(rules, outward, sunSign, frontBasis) {
          const streetBearing = Math.round((Math.atan2(outward[0], outward[1]) * 180 / Math.PI + 360) % 360) % 360;
          if (rules.coreSide === "street" || rules.coreSide === "yard") return { side: rules.coreSide, basis: "rule", streetBearing };
          if (frontBasis === "longest") return { side: "street", basis: "no-street", streetBearing };
          const sunnyBearing = sunSign >= 0 ? 225 : 315;
          const sunny = Math.cos((streetBearing - sunnyBearing) * Math.PI / 180) > 1e-9;
          return { side: sunny ? "yard" : "street", basis: "orientation", streetBearing };
        }
        function decideAccess(rules, plateDepthM) {
          const requested = rules.access === "point" || rules.access === "corridor" ? rules.access : null;
          if (requested) return { access: requested, basis: rules.accessBasis === "view" ? "view" : "design", plateDepthM: round2(plateDepthM) };
          return { access: plateDepthM >= rules.corridorFromDepthM - 1e-9 ? "corridor" : "point", basis: "depth", plateDepthM: round2(plateDepthM) };
        }
        function fillRows(segments, mix, wallM) {
          const shares = mix.reduce((sum, m) => sum + m.share, 0);
          const meanW = mix.reduce((sum, m) => sum + m.share * m.widthM, 0) / shares;
          const minW = Math.min(...mix.map((m) => m.widthM));
          const lengthOf = (seg) => seg.to - seg.from;
          const guess = segments.map((seg) => lengthOf(seg) < 0.5 * minW ? 0 : Math.max(1, Math.round((lengthOf(seg) + wallM) / (meanW + wallM))));
          const total = guess.reduce((sum, k) => sum + k, 0);
          const quotas = mix.map((m) => m.share / shares * total);
          const pool = quotas.map(Math.floor);
          quotas.map((q, j) => [q - Math.floor(q), j]).sort((a, b) => b[0] - a[0]).slice(0, total - pool.reduce((s, n) => s + n, 0)).forEach(([, j]) => {
            pool[j]++;
          });
          const compositions = (k, parts) => parts === 1 ? [[k]] : Array.from({ length: k + 1 }, (_, a) => compositions(k - a, parts - 1).map((rest) => [a, ...rest])).flat();
          const results = new Array(segments.length);
          const order = segments.map((_, i) => i).sort((a, b) => (segments[b].prefer ? 1 : 0) - (segments[a].prefer ? 1 : 0) || a - b);
          for (const i of order) {
            const seg = segments[i];
            if (!guess[i]) {
              results[i] = { flats: [], walls: [] };
              continue;
            }
            let best = null;
            for (const k of [guess[i] - 1, guess[i], guess[i] + 1]) {
              const net = lengthOf(seg) - (k - 1) * wallM;
              if (k < 1 || net <= 0) continue;
              for (const counts of compositions(k, mix.length)) {
                const sumW = counts.reduce((sum, n, j) => sum + n * mix[j].widthM, 0);
                const over = counts.reduce((sum, n, j) => sum + Math.max(0, n - pool[j]), 0);
                const preferred = counts.reduce((sum, n, j) => sum + (mix[j].type === seg.prefer ? Math.min(n, pool[j]) : 0), 0);
                const cost = Math.abs(Math.log(net / sumW)) + 0.6 * over - 0.02 * preferred;
                if (!best || cost < best.cost - 1e-12) best = { cost, counts, scale: net / sumW };
              }
            }
            best.counts.forEach((n, j) => {
              pool[j] = Math.max(0, pool[j] - n);
            });
            const left = best.counts.slice(), picks = [];
            while (left.some((n) => n > 0)) mix.map((m, j) => j).sort((a, b) => left[b] - left[a] || a - b).forEach((j) => {
              if (left[j] > 0) {
                picks.push(mix[j]);
                left[j]--;
              }
            });
            const flats = [], walls = [];
            let cursor = seg.from;
            picks.forEach((entry, index) => {
              const s1 = index === picks.length - 1 ? seg.to : cursor + entry.widthM * best.scale;
              flats.push({ entry, s0: cursor, s1 });
              if (index < picks.length - 1) walls.push([s1, s1 + wallM]);
              cursor = s1 + wallM;
            });
            results[i] = { flats, walls };
          }
          return results;
        }
        function fillRowsWithTargets(rows, sideTargets, wallM, entryFor) {
          const results = rows.map(() => ({ flats: [], walls: [] }));
          for (const [key, targets] of Object.entries(sideTargets)) {
            const indices = rows.map((row, i) => i).filter((i) => rows[i].rowSide.key === key).sort((a, b) => rows[a].from - rows[b].from);
            if (!indices.length) continue;
            if (!targets.length) {
              indices.forEach((i, j) => {
                if (rows[i].to - rows[i].from > 1.5) results[i].flats.push({ entry: entryFor({ id: `void-${key}-${j}`, index: Infinity, kind: "void", areaM2: null, bedrooms: null, side: null, weight: 0 }), s0: rows[i].from, s1: rows[i].to });
              });
              continue;
            }
            const lengths = indices.map((i) => rows[i].to - rows[i].from);
            const total = lengths.reduce((sum, l) => sum + l, 0);
            const weights = targets.reduce((sum, target) => sum + target.weight, 0);
            const ideal = targets.map((target) => total * target.weight / weights);
            const meanW = total / targets.length;
            const n = targets.length, m = indices.length;
            const runCost = (j, a, b) => {
              if (b === a) return 2 * (lengths[j] / meanW) ** 2;
              const want = ideal.slice(a, b).reduce((s, w) => s + w, 0), room = lengths[j] - (b - a - 1) * wallM;
              if (room <= 0) return Infinity;
              return (b - a) * Math.log(room / want) ** 2;
            };
            const best = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(Infinity));
            const from = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
            best[0][0] = 0;
            for (let j = 1; j <= m; j++) for (let i = 0; i <= n; i++) for (let a = 0; a <= i; a++) {
              const cost = best[j - 1][a] + runCost(j - 1, a, i);
              if (cost < best[j][i]) {
                best[j][i] = cost;
                from[j][i] = a;
              }
            }
            const bySegment = indices.map(() => []);
            for (let j = m, i = n; j > 0; j--) {
              const a = from[j][i];
              bySegment[j - 1] = targets.slice(a, i);
              i = a;
            }
            indices.forEach((i, j) => {
              const seg = rows[i], list = bySegment[j];
              if (!list.length) {
                if (seg.to - seg.from > 1.5) results[i].flats.push({ entry: entryFor({ id: `void-${key}-${j}`, index: Infinity, kind: "void", areaM2: null, bedrooms: null, side: null, weight: 0 }), s0: seg.from, s1: seg.to });
                return;
              }
              const sum = list.reduce((s2, target) => s2 + target.weight, 0);
              const want = sum / weights * total;
              const room = Math.min(seg.to - seg.from - (list.length - 1) * wallM, 1.15 * want);
              const lobbyFirst = j > 0 && j === indices.length - 1;
              let spare = seg.to - seg.from - (list.length - 1) * wallM - room;
              if (spare < 0.6) spare = 0;
              const lo = seg.from + (spare && lobbyFirst ? spare : 0), hi = seg.to - (spare && !lobbyFirst ? spare : 0);
              if (spare) results[i].walls.push(lobbyFirst ? [lo - wallM, lo] : [hi, hi + wallM]);
              const net = hi - lo - (list.length - 1) * wallM;
              let s = lo;
              list.forEach((target, index) => {
                const s1 = index === list.length - 1 ? hi : s + net * target.weight / sum;
                results[i].flats.push({ entry: entryFor(target), s0: s, s1 });
                if (index < list.length - 1) results[i].walls.push([s1, s1 + wallM]);
                s = s1 + wallM;
              });
            });
          }
          return results;
        }
        function planCorridorParts(c) {
          const { t, rules, inner, edgesUV, front, frameUV, sunSign, ext, storeyHeightM, floors, highRise, facadeRun, runInside } = c;
          const failWith = (code, message) => ({ error: { code, message } });
          const spineD = c.fixed ? vec(c.fixed.spine[0], c.fixed.spine[1]) : null;
          const alongU = spineD ? Math.abs(spineD[0]) >= Math.abs(spineD[1]) : ext.u1 - ext.u0 >= ext.v1 - ext.v0;
          const P = (s, r) => alongU ? [s, r] : [r, s];
          const sAxis = alongU ? [1, 0] : [0, 1], rAxis = alongU ? [0, 1] : [1, 0];
          const box = (s0, s1, r0, r1) => {
            const a = P(Math.min(s0, s1), Math.min(r0, r1)), b = P(Math.max(s0, s1), Math.max(r0, r1));
            return rect(t, Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1]));
          };
          const clip = (feature) => intersectOrNull(t, inner, feature);
          const wall = rules.exteriorWallM, wc = rules.apartmentWallM, cw = rules.corridorWidthM, doorM = rules.apartmentDoorM;
          const [sLo, sHi] = alongU ? [ext.u0, ext.u1] : [ext.v0, ext.v1];
          const [rLo, rHi] = alongU ? [ext.v0, ext.v1] : [ext.u0, ext.u1];
          const S0 = sLo + wall, S1 = sHi - wall, R0 = rLo + wall, R1 = rHi - wall;
          const fixed = c.fixed && (() => {
            const [a, b] = c.fixed.spine, sOf = (p) => alongU ? p[0] : p[1], rOf = (p) => alongU ? p[1] : p[0];
            return { rMid: (rOf(a) + rOf(b)) / 2, centres: c.fixed.centres.map(sOf).sort((x, y) => x - y) };
          })();
          const offCentre = finite(c.loDepthM) || !!fixed;
          const c0 = fixed ? fixed.rMid - cw / 2 : offCentre ? R0 + wc + c.loDepthM : (R0 + R1) / 2 - cw / 2, c1 = c0 + cw, rMid = (c0 + c1) / 2;
          const rowDepthM = c0 - wc - R0;
          const depthOfSide = (side2) => offCentre ? side2.rowR[1] - side2.rowR[0] : rowDepthM;
          if ((offCentre ? Math.min(rowDepthM, R1 - c1 - wc) : rowDepthM) < rules.minCorridorRowDepthM) {
            return failWith("corridor-too-shallow", `The floor plate is too shallow for a corridor: each side keeps ${rowDepthM.toFixed(1)} m, under ${rules.minCorridorRowDepthM} m.`);
          }
          const cos30 = Math.cos(30 * Math.PI / 180);
          const facing = (axis, sign) => edgesUV.filter((edge) => sign * (edge.inward[0] * axis[0] + edge.inward[1] * axis[1]) >= cos30);
          const mostly = (list, key) => {
            const total = list.reduce((sum, e) => sum + e.lengthM, 0);
            return total > 0 && list.reduce((sum, e) => sum + (e[key] ? e.lengthM : 0), 0) >= total / 2;
          };
          const rWorld = alongU ? frameUV.v : frameUV.u;
          const northCos = Math.cos(rules.northFacingWithinDeg * Math.PI / 180);
          const sides = [-1, 1].map((sign) => {
            const edges = facing(rAxis, -sign);
            return {
              sign,
              key: sign < 0 ? "lo" : "hi",
              party: !edges.length || mostly(edges, "party"),
              front: edges.some((e) => e.isFront),
              pole: sunSign * sign * rWorld[1],
              facadeR: sign < 0 ? R0 : R1,
              edgeR: sign < 0 ? c0 : c1,
              rowR: sign < 0 ? [R0, c0 - wc] : [c1 + wc, R1],
              ey: [-sign * rAxis[0], -sign * rAxis[1]]
            };
          });
          const open = sides.filter((side2) => !side2.party);
          if (!open.length) return failWith("corridor-no-facade", "Neighbours stand against both long sides; a corridor building needs a free facade.");
          let coreSide = open.find((side2) => side2.pole >= northCos) || null, coreBasis = "north";
          if (!coreSide) {
            const [a, b] = open;
            if (b && Math.abs(a.pole - b.pole) > 0.2) {
              coreSide = a.pole > b.pole ? a : b;
              coreBasis = "less-sunny";
            } else {
              coreSide = open.find((side2) => side2.front) || a;
              coreBasis = "street";
            }
          }
          const otherSide = sides.find((side2) => side2 !== coreSide);
          const targets = c.targets || null;
          const sWorld = alongU ? frameUV.u : frameUV.v;
          const slotDirs = [["lo", [-rWorld[0], -rWorld[1]]], ["hi", rWorld], ["g0", [-sWorld[0], -sWorld[1]]], ["g1", sWorld]];
          const slots = targets ? targets.map((target) => {
            const dir = sideVector(target.side, front);
            if (!dir) return null;
            const best = slotDirs.reduce((b, [slot, v]) => {
              const dot = v[0] * dir[0] + v[1] * dir[1];
              return !b || dot > b.dot ? { slot, dot } : b;
            }, null);
            return best.dot >= Math.cos(50 * Math.PI / 180) ? best.slot : null;
          }) : null;
          const rowMix = (rules.corridorMix || CORRIDOR_MIX).filter((m) => !m.gable && m.share > 0).map((m) => ({ ...m, widthM: Math.min(m.widthM * 1.3, Math.max(m.widthM, (m.areaM2[0] + m.areaM2[1]) / 2 / rowDepthM)) }));
          const gableEntry = (rules.corridorMix || CORRIDOR_MIX).find((m) => m.gable) || null;
          if (!rowMix.length) return failWith("corridor-no-mix", "The corridor flat mix names no row flats.");
          const minW = Math.min(...rowMix.map((m) => m.widthM));
          const perFloorGuess = targets ? targets.length : Math.max(2, Math.round(2 * (S1 - S0) / 7));
          const lift = c.fixedLift !== null && c.fixedLift !== void 0 ? c.fixedLift : wantsLift(rules, floors, 1, highRise, perFloorGuess);
          const core = coreDimensions(storeyHeightM, rules, lift, highRise);
          if (core.depthM > depthOfSide(coreSide) + wc + 1e-9) {
            return failWith("corridor-core-too-deep", `A ${core.widthM.toFixed(1)} \xD7 ${core.depthM.toFixed(1)} m stair core does not fit a ${rowDepthM.toFixed(1)} m corridor row.`);
          }
          const bayW = core.widthM + rules.lobbyWidthM;
          const ends = [-1, 1].map((sign) => {
            const edges = facing(sAxis, -sign);
            return edges.length > 0 && !mostly(edges, "party") && !mostly(edges, "blind");
          });
          const gW = rules.gableFlatDepthM;
          const roomForGables = (count) => S1 - S0 - count * (gW + wc) >= bayW + 2 * minW;
          let gables = gableEntry ? [ends[0] && roomForGables(ends[1] ? 2 : 1), ends[1] && roomForGables(ends[0] ? 2 : 1)] : [false, false];
          const gableTargets = targets ? [0, 1].map((i) => targets.filter((_, j) => slots[j] === `g${i}`).sort((a, b) => b.weight - a.weight)[0] || null) : [null, null];
          const gWs = gableTargets.map((target) => target ? Math.min(8, Math.max(3.6, target.weight / (R1 - R0))) : gW);
          if (targets) {
            const room = S1 - S0 - gableTargets.reduce((sum, target, i) => sum + (target && ends[i] ? gWs[i] + wc : 0), 0) >= bayW + 2 * minW;
            gables = [!!(gableTargets[0] && ends[0] && room), !!(gableTargets[1] && ends[1] && room)];
          }
          if (fixed) gables = [false, false];
          const Sa = S0 + (gables[0] ? gWs[0] + wc : 0), Sb = S1 - (gables[1] ? gWs[1] + wc : 0), Lc = Sb - Sa;
          if (Lc < bayW + minW) return failWith("corridor-too-short", `A ${Lc.toFixed(1)} m corridor holds no stair core and flat.`);
          const D = rules.maxDeadEndM, Smax = rules.maxStairSpacingM;
          let stairs = Lc <= 2 * D ? 1 : 1 + Math.ceil((Lc - 2 * D) / Smax - 1e-9);
          if (highRise || Lc > Smax) stairs = Math.max(2, stairs);
          stairs = Math.min(stairs, rules.maxCores);
          if (c.stairCount) stairs = c.stairCount;
          if (fixed) stairs = fixed.centres.length;
          const endGap = stairs === 1 ? Lc / 2 : Math.min(D, Lc / (2 * stairs));
          const centres = fixed ? fixed.centres : stairs === 1 ? [Sa + Lc / 2] : Array.from({ length: stairs }, (_, i) => Sa + endGap + i * (Lc - 2 * endGap) / (stairs - 1));
          const bays = centres.map((p) => {
            const lobbyHigh = p <= Sa + Lc / 2;
            let q0 = lobbyHigh ? p - core.widthM / 2 : p - core.widthM / 2 - rules.lobbyWidthM;
            let q1 = q0 + bayW;
            if (q0 < Sa) {
              q1 += Sa - q0;
              q0 = Sa;
            }
            if (q1 > Sb) {
              q0 -= q1 - Sb;
              q1 = Sb;
            }
            const cs0 = lobbyHigh ? q0 : q1 - core.widthM;
            return { q0, q1, cs0, cs1: cs0 + core.widthM, uc: cs0 + core.widthM / 2, lobbyHigh };
          });
          for (let i = 1; i < bays.length; i++) {
            if (bays[i].q0 < bays[i - 1].q1 + minW) return failWith("corridor-cores-crowded", "The stair cores the corridor needs leave no room for flats between them.");
          }
          const gapLimit = 0.6 * minW;
          if (bays[0].q0 - Sa > 1e-6 && bays[0].q0 - Sa < gapLimit) bays[0].q0 = Sa;
          if (Sb - bays[bays.length - 1].q1 > 1e-6 && Sb - bays[bays.length - 1].q1 < gapLimit) bays[bays.length - 1].q1 = Sb;
          for (let i = 1; i < bays.length; i++) if (bays[i].q0 - bays[i - 1].q1 < gapLimit) bays[i - 1].q1 = bays[i].q0;
          const entranceAt = (doorS, side2) => {
            const half = rules.entranceDoorM / 2, rFace = side2.facadeR, rOut = side2.facadeR + side2.sign * wall;
            const reaches = (s) => {
              const run2 = runInside(inner, P(s, rMid), P(s, rFace));
              return run2 && run2[0] <= 0.01 && run2[1] >= Math.abs(rFace - rMid) - 0.01;
            };
            if (!runInside || reaches(doorS - half) && reaches(doorS + half)) {
              const r = side2.facadeR + side2.sign * wall / 2;
              return [P(doorS - half, r), P(doorS + half, r)];
            }
            const run = runInside(inner, P(doorS, rMid), P(doorS, rOut));
            if (!run || run[0] > 1e-6) return null;
            const exit = P(doorS, rMid + side2.sign * run[1]);
            let best = null;
            for (const edge2 of edgesUV) {
              if (edge2.party || edge2.lengthM < 2 * half + 0.2) continue;
              const face = add(edge2.a, edge2.inward, wall), w = vec(face, exit);
              const along = w[0] * edge2.d[0] + w[1] * edge2.d[1], off = Math.abs(w[0] * edge2.inward[0] + w[1] * edge2.inward[1]);
              if (along < -0.05 || along > edge2.lengthM + 0.05 || off > 0.05) continue;
              if (!best || off < best.off) best = { edge: edge2, along, off };
            }
            if (!best) return null;
            const { edge } = best, at = Math.min(edge.lengthM - half - 0.1, Math.max(half + 0.1, best.along)), line = add(edge.a, edge.inward, wall / 2);
            return [add(line, edge.d, at - half), add(line, edge.d, at + half)];
          };
          const parts = {
            coreWalls: [],
            coreOpenings: [],
            coreCuts: [],
            entranceOpenings: [],
            entranceCuts: [],
            voids: [],
            landings: [],
            stairs: [],
            coreRailings: [],
            coreRects: [],
            dividerWalls: [],
            apartmentDoors: [],
            apartmentDoorCuts: []
          };
          const side = coreSide;
          const pt = (x, y) => P(x, side.edgeR + side.sign * y);
          const bx = (x0, x1, y0, y1) => box(x0, x1, side.edgeR + side.sign * y0, side.edgeR + side.sign * y1);
          const rowBox = (rowSide, s0, s1) => box(s0, s1, rowSide.rowR[0], rowSide.rowR[1]);
          for (const bay of bays) {
            const built = coreParts(t, rules, core, storeyHeightM, lift, bay.uc, pt, bx);
            parts.coreWalls.push(...built.walls);
            parts.coreOpenings.push(...built.openings);
            parts.coreCuts.push(...built.cuts);
            parts.voids.push(...built.voids);
            parts.landings.push(...built.landings);
            parts.stairs.push(...built.stairs);
            parts.coreRailings.push(...built.railings);
            parts.coreRects.push(built.rect);
            const fullRow = [side.rowR[0], side.rowR[1]];
            if (bay.q0 > Sa + 1e-6) parts.dividerWalls.push(differenceOrNull(t, clip(box(bay.q0, bay.q0 + wc, fullRow[0], fullRow[1])), built.rect));
            if (bay.q1 < Sb - 1e-6) parts.dividerWalls.push(differenceOrNull(t, clip(box(bay.q1 - wc, bay.q1, fullRow[0], fullRow[1])), built.rect));
            const lobby = bay.lobbyHigh ? [bay.cs1, bay.q1 - wc] : [bay.q0 + wc, bay.cs0];
            const ends2 = entranceAt((lobby[0] + lobby[1]) / 2, side);
            if (!ends2) continue;
            const entrance = {
              kind: "glazedDoor",
              a: ends2[0],
              b: ends2[1],
              depthM: wall,
              sillM: 0,
              heightM: Math.min(rules.entranceHeightM, storeyHeightM - rules.slabThicknessM - 0.3),
              room: "entrance"
            };
            parts.entranceOpenings.push(entrance);
            parts.entranceCuts.push(strip(t, entrance.a, entrance.b, wall + 0.06));
          }
          const coreSegments = [];
          let cursor = Sa;
          for (const bay of bays) {
            if (bay.q0 - cursor > 1e-6) coreSegments.push({ from: cursor, to: bay.q0 });
            cursor = bay.q1;
          }
          if (Sb - cursor > 1e-6) coreSegments.push({ from: cursor, to: Sb });
          const corridorWall = (rowSide, s0, s1) => clip(box(s0, s1, rowSide.sign < 0 ? c0 - wc : c1, rowSide.sign < 0 ? c0 : c1 + wc));
          coreSegments.forEach((seg) => parts.dividerWalls.push(corridorWall(coreSide, seg.from, seg.to)));
          parts.dividerWalls.push(corridorWall(otherSide, Sa, Sb));
          if (gables[0]) parts.dividerWalls.push(clip(box(Sa - wc, Sa, R0, R1)));
          if (gables[1]) parts.dividerWalls.push(clip(box(Sb, Sb + wc, R0, R1)));
          const studio = rowMix.find((m) => m.north) || null;
          const northCore = coreBasis === "north";
          const rows = [
            ...coreSegments.map((seg) => ({ ...seg, rowSide: coreSide, prefer: northCore && studio ? studio.type : null })),
            { from: Sa, to: Sb, rowSide: otherSide, prefer: null }
          ];
          let filled, balance = null;
          if (targets) {
            const sideTargets = { lo: [], hi: [] };
            const capacity = { lo: 0, hi: 0 }, load = { lo: 0, hi: 0 };
            rows.forEach((row) => {
              capacity[row.rowSide.key] += row.to - row.from;
            });
            const taken = new Set(gableTargets.filter((target, i) => target && gables[i]).map((target) => target.id));
            targets.forEach((target, j) => {
              if (taken.has(target.id)) return;
              let key = slots[j] === "lo" || slots[j] === "hi" ? slots[j] : null;
              if (key && !sides.find((side2) => side2.key === key).party && capacity[key] > 0) {
                sideTargets[key].push(target);
                load[key] += target.weight;
              }
            });
            targets.forEach((target, j) => {
              if (taken.has(target.id) || sideTargets.lo.includes(target) || sideTargets.hi.includes(target)) return;
              const key = (load.lo + target.weight) / Math.max(1e-9, capacity.lo) <= (load.hi + target.weight) / Math.max(1e-9, capacity.hi) ? "lo" : "hi";
              sideTargets[key].push(target);
              load[key] += target.weight;
            });
            const fixed2 = new Set(targets.filter((target, j) => (slots[j] === "lo" || slots[j] === "hi") && sideTargets[slots[j]].includes(target)).map((target) => target.id));
            const imbalance = () => Math.abs(load.lo / Math.max(1e-9, capacity.lo) - load.hi / Math.max(1e-9, capacity.hi));
            for (let pass = 0, improved = true; improved && pass < 50; pass++) {
              improved = false;
              for (const [a, b] of [["lo", "hi"], ["hi", "lo"]]) {
                for (const x of sideTargets[a].filter((target) => !fixed2.has(target.id))) {
                  const before = imbalance();
                  load[a] -= x.weight;
                  load[b] += x.weight;
                  if (sideTargets[a].length > 1 && imbalance() < before - 1e-9) {
                    sideTargets[a].splice(sideTargets[a].indexOf(x), 1);
                    sideTargets[b].push(x);
                    improved = true;
                    continue;
                  }
                  let swapped = false;
                  for (const y of sideTargets[b].filter((target) => !fixed2.has(target.id) && target !== x)) {
                    load[b] -= y.weight;
                    load[a] += y.weight;
                    if (imbalance() < before - 1e-9) {
                      sideTargets[a].splice(sideTargets[a].indexOf(x), 1, y);
                      sideTargets[b].splice(sideTargets[b].indexOf(y), 1, x);
                      swapped = improved = true;
                      break;
                    }
                    load[b] += y.weight;
                    load[a] -= y.weight;
                  }
                  if (!swapped) {
                    load[a] += x.weight;
                    load[b] -= x.weight;
                  }
                }
              }
            }
            for (const key of ["lo", "hi"]) sideTargets[key].sort((a, b) => a.index - b.index);
            balance = {
              lo: load.lo / Math.max(1e-9, capacity.lo),
              hi: load.hi / Math.max(1e-9, capacity.hi),
              spanM: R1 - R0 - cw - 2 * wc,
              minLoM: Math.max(rules.minCorridorRowDepthM, coreSide.key === "lo" ? core.depthM - wc : 0),
              minHiM: Math.max(rules.minCorridorRowDepthM, coreSide.key === "hi" ? core.depthM - wc : 0)
            };
            filled = fillRowsWithTargets(rows, sideTargets, wc, (target) => {
              const beds = target.bedrooms !== null ? target.bedrooms : bedroomsForArea(target.weight);
              return { type: typeForBedrooms(beds), bedrooms: beds, target };
            });
          } else filled = fillRows(rows, rowMix, wc);
          const apartments = [];
          const facadeFlag = (polygon) => {
            if (!facadeRun) return null;
            const touched = c.facades.filter((f) => !f.party && !f.blind && facadeRun(t, polygon, f, wall));
            return touched.length && touched.every((f) => -f.sun >= northCos) ? "north-single-aspect" : null;
          };
          const addFlat = (entry, polygon, env, door, into) => {
            if (!polygon || polygonsArea(polygon) < (entry.target ? 4 : rules.minApartmentM2 * 0.5)) return;
            apartments.push({
              unitId: `flat-${apartments.length + 1}`,
              type: entry.type,
              polygon,
              areaM2: polygonsArea(polygon),
              env,
              flag: facadeFlag(polygon),
              ...entry.target ? { target: entry.target } : {}
            });
            if (!door) return;
            const opening = {
              kind: "door",
              ...door,
              depthM: wc,
              sillM: 0,
              heightM: rules.doorHeightM,
              hinge: door.b,
              openTip: add(door.b, swingInto(t, polygon, door.b, into, doorM), doorM),
              room: "apartment"
            };
            parts.apartmentDoors.push(opening);
            parts.apartmentDoorCuts.push(strip(t, opening.a, opening.b, wc + 0.06));
          };
          const corridorReach = (rowSide, polygon, s0, s1) => {
            if (!runInside) return [0, s1 - s0];
            const rEdge = rowSide.edgeR + rowSide.sign * (wc + 0.05), rDoor = rowSide.edgeR + rowSide.sign * wc / 2;
            const a = runInside(polygon, P(s0, rEdge), P(s1, rEdge)), b = runInside(inner, P(s0, rDoor), P(s1, rDoor));
            if (!a || !b) return null;
            const from = Math.max(a[0], b[0]), to = Math.min(a[1], b[1]);
            return to > from ? [from, to] : null;
          };
          rows.forEach((row, index) => {
            const rowSide = row.rowSide, rDoor = rowSide.edgeR + rowSide.sign * wc / 2;
            filled[index].walls.forEach(([s0, s1]) => parts.dividerWalls.push(clip(rowBox(rowSide, s0, s1))));
            for (const flat of filled[index].flats) {
              const polygon = clip(rowBox(rowSide, flat.s0, flat.s1));
              const reach = polygon ? corridorReach(rowSide, polygon, flat.s0, flat.s1) : null;
              const doorX = reach && reach[0] <= 0.36 && reach[1] >= 0.35 + doorM - 0.01 ? 0.35 : !reach || reach[1] - reach[0] < doorM + 0.1 ? null : reach[1] - reach[0] >= 0.35 + doorM + 0.1 ? reach[0] + 0.35 : (reach[0] + reach[1] - doorM) / 2;
              const env = {
                layout: "row",
                origin: P(flat.s0, rowSide.facadeR),
                ex: sAxis,
                ey: rowSide.ey,
                widthM: flat.s1 - flat.s0,
                depthM: depthOfSide(rowSide),
                doorX: doorX === null ? null : [doorX, doorX + doorM],
                bedrooms: flat.entry.bedrooms,
                balconyOnFront: true
              };
              addFlat(flat.entry, polygon, env, doorX === null ? null : { a: P(flat.s0 + doorX, rDoor), b: P(flat.s0 + doorX + doorM, rDoor) }, [-rowSide.ey[0], -rowSide.ey[1]]);
            }
          });
          const livingAtEnd = sides[1].pole < sides[0].pole;
          [[gables[0], S0, Sa - wc, Sa - wc / 2, sAxis], [gables[1], S1, Sb + wc, Sb + wc / 2, [-sAxis[0], -sAxis[1]]]].forEach(([present, facadeS, wallS, doorS, ey], end) => {
            if (!present) return;
            const gt = gableTargets[end];
            const entry = gt ? { type: typeForBedrooms(gt.bedrooms !== null ? gt.bedrooms : bedroomsForArea(gt.weight)), bedrooms: gt.bedrooms !== null ? gt.bedrooms : bedroomsForArea(gt.weight), target: gt } : gableEntry;
            const env = {
              layout: "gable",
              origin: P(facadeS, R0),
              ex: rAxis,
              ey,
              widthM: R1 - R0,
              depthM: Math.abs(wallS - facadeS),
              doorX: [rMid - R0 - doorM / 2, rMid - R0 + doorM / 2],
              bedrooms: entry.bedrooms,
              livingAtEnd,
              balconyOnFront: true
            };
            addFlat(
              entry,
              clip(box(facadeS, wallS, R0, R1)),
              env,
              { a: P(doorS, rMid - doorM / 2), b: P(doorS, rMid + doorM / 2) },
              [-ey[0], -ey[1]]
            );
          });
          if (!apartments.length) return failWith("corridor-no-flats", "No corridor flat fits this floor plate.");
          const deadEndM = Math.max(bays[0].uc - Sa, Sb - bays[bays.length - 1].uc);
          const maxStairGapM = bays.slice(1).reduce((max, bay, i) => Math.max(max, bay.uc - bays[i].uc), 0);
          const mix = {};
          apartments.forEach((apartment) => {
            mix[apartment.type] = (mix[apartment.type] || 0) + 1;
          });
          return {
            ...parts,
            dividerWalls: parts.dividerWalls.filter(Boolean),
            access: "corridor",
            ...balance ? { balance } : {},
            cores: bays.length,
            lift,
            core,
            dilatations: [],
            apartments,
            corridor: {
              lengthM: round2(Lc),
              widthM: cw,
              stairs: bays.length,
              deadEndM: round2(deadEndM),
              maxStairGapM: round2(maxStairGapM),
              rowDepthM: round2(rowDepthM),
              coreSide: coreBasis,
              gables: gables.filter(Boolean).length,
              mix,
              spine: [P(Sa, rMid), P(Sb, rMid)],
              stairCentres: bays.map((bay) => P(bay.uc, rMid))
            },
            garageVRange: [ext.v0 + wall, ext.v1 - wall]
          };
        }
        const KNOWN_DOOR_WITHIN_M = 3;
        function planDefaultFloorPlans(input, options = {}) {
          const t = T(options);
          if (!t) throw new Error("default-floor-plans: turf is not available");
          const rooms = roomsModule(options);
          const rules = rulesFor(options);
          const yardCore = input._yardCore || null;
          let targets = normaliseTargets(input.unitTargets);
          if (targets && yardCore) targets = targets.slice().reverse();
          const emitRooms = options.emitRooms === true;
          const central = coreModule(options);
          if (central && central.wantsCentralCore(input, rules)) return central.planCoreFloorPlans(input, options);
          const warnings = yardCore ? yardCore.warnings.slice() : [];
          const summary = {
            cores: 0,
            apartmentsPerFloor: 0,
            apartmentAreasM2: [],
            lift: false,
            highRise: false,
            coreM: null,
            frontBasis: null,
            frontEdge: null,
            region: rules.region,
            groundFloorUse: "residential",
            garageLevels: 0,
            rooms: 0
          };
          const fail = () => ({ floorPlans: null, warnings, summary });
          const floors = Number.isInteger(input.floors) ? input.floors : null;
          if (!floors || floors < 1) {
            warn(warnings, "floors-unknown", "error", "The number of storeys is unknown.");
            return fail();
          }
          if (floors > rules.maxFloors) {
            warn(warnings, "too-many-floors", "error", `More than ${rules.maxFloors} storeys are not modelled.`);
            return fail();
          }
          const storeyHeightM = finite(input.storeyHeightM) && input.storeyHeightM > 0 ? input.storeyHeightM : 3;
          if (storeyHeightM < 2.5 || storeyHeightM > 6) {
            warn(warnings, "storey-height-implausible", "error", `A storey height of ${storeyHeightM.toFixed(2)} m is outside 2.5\u20136 m.`);
            return fail();
          }
          const topFloorM = (floors - 1) * storeyHeightM;
          const highRise = topFloorM > rules.highRiseAboveM;
          summary.highRise = highRise;
          const polygons = polygonsOf(input.footprint);
          if (!polygons.length) {
            warn(warnings, "invalid-footprint", "error", "The footprint is not a polygon.");
            return fail();
          }
          if (polygons.length > 1 && !yardCore) warn(warnings, "multipolygon-largest-part", "notice", "Only the largest part of a multi-part footprint is laid out.");
          const outerLngLat = polygons.map((rings) => rings[0]).reduce((best, ring) => {
            const area = Math.abs(ringArea(ring.map((p) => [p[0] * 1e5, p[1] * 1e5])));
            return !best || area > best.area ? { ring, area } : best;
          }, null).ring;
          const anchor = outerLngLat.reduce((s, p) => [s[0] + p[0] / outerLngLat.length, s[1] + p[1] / outerLngLat.length], [0, 0]);
          const frame = makeFrame(anchor[0], anchor[1]);
          const sunSign = anchor[1] >= 0 ? 1 : -1;
          let ringM = cleanRing(outerLngLat.map(frame.toMeters), 0.02);
          if (ringM.length < 3 || Math.abs(ringArea(ringM)) < rules.minFootprintM2) {
            warn(warnings, "invalid-footprint", "error", "The footprint is too small or degenerate.");
            return fail();
          }
          if (ringArea(ringM) < 0) ringM = ringM.slice().reverse();
          const bufferedLngLat = t.buffer(t.polygon([closed(ringM.map(frame.toDegrees))]), -rules.exteriorWallM, { units: "meters" });
          const innerPolygons = polygonsOf(bufferedLngLat).map((rings) => rings.map((ring) => ring.map(frame.toMeters)));
          if (!innerPolygons.length) {
            warn(warnings, "too-small-for-walls", "error", "Too small to hold exterior walls.");
            return fail();
          }
          const neighboursM = (input.neighbours || []).flatMap(polygonsOf).map((rings) => t.polygon(rings.map((ring) => ring.map(frame.toMeters))));
          const edges = ringM.map((a, index) => {
            const b = ringM[(index + 1) % ringM.length];
            const d = unit(vec(a, b));
            const inward = leftNormal(d);
            const lengthM = len(vec(a, b));
            const partyRuns = partyRunsOf(t, a, b, d, inward, lengthM, neighboursM);
            const party = partyRuns.reduce((sum, run) => sum + run[1] - run[0], 0) >= lengthM / 2;
            return { index, a, b, d, inward, lengthM, party, partyRuns, blind: false, sun: sunSign * inward[1] };
          });
          for (const hint of input.blindEdges || []) {
            const edge = matchEdge(edges, hint, frame);
            if (edge) edge.blind = true;
          }
          const exterior = edges.filter((edge) => !edge.party);
          if (!exterior.length) {
            warn(warnings, "no-exterior-edge", "error", "Every edge is a party wall; there is no facade for an entrance.");
            return fail();
          }
          let front = null, frontBasis = "longest";
          if (input.front && Array.isArray(input.front.a) && Array.isArray(input.front.b)) {
            const match = matchEdge(edges, input.front, frame);
            if (match && !match.party) {
              front = match;
              frontBasis = input.front.basis || "user";
              match.blind = false;
            } else if (match) warn(warnings, "front-is-party-wall", "notice", "The chosen front is a party wall; the longest facade is used instead.");
            else warn(warnings, "front-not-found", "notice", "The chosen front does not match an edge of this building; the longest facade is used instead.");
          }
          if (!front) {
            const open = exterior.filter((edge) => !edge.blind);
            front = (open.length ? open : exterior).reduce((best, edge) => edge.lengthM > best.lengthM ? edge : best, (open.length ? open : exterior)[0]);
            front.blind = false;
            if (!input.front) warn(warnings, "front-assumed-longest", "notice", "No street data: the entrance faces the longest facade.");
          }
          let street = front;
          if (yardCore) {
            const match = matchEdge(edges, yardCore.street, frame);
            if (match) street = match;
            frontBasis = yardCore.street.basis || frontBasis;
          }
          summary.frontBasis = frontBasis;
          summary.frontEdge = { a: frame.toDegrees(street.a), b: frame.toDegrees(street.b), lengthM: street.lengthM };
          const axis = finite(input.axisDeg) ? [Math.cos(input.axisDeg * Math.PI / 180), Math.sin(input.axisDeg * Math.PI / 180)] : mainAxis(ringM);
          const frameU = squareTo(axis, front.d), frameV = leftNormal(frameU);
          const toUV = (p) => {
            const r = vec(front.a, p);
            return [r[0] * frameU[0] + r[1] * frameU[1], r[0] * frameV[0] + r[1] * frameV[1]];
          };
          const fromUV = ([u, v]) => add(add(front.a, frameU, u), frameV, v);
          const knownStairs = input.stairs && finite(input.stairs.count) && input.stairs.count >= 1 ? Math.round(input.stairs.count) : null;
          const fixedLift = knownStairs && input.stairs.fixed && typeof input.stairs.lift === "boolean" ? input.stairs.lift : null;
          const knownDoorsUV = knownStairs && Array.isArray(input.stairs.at) ? input.stairs.at.filter((p) => Array.isArray(p)).map((p) => toUV(frame.toMeters(p))) : [];
          if (knownStairs) summary.stairsBasis = knownDoorsUV.length ? "entrances-seen" : "house-numbers";
          const ringUV = ringM.map(toUV);
          const us = ringUV.map((p) => p[0]), vs = ringUV.map((p) => p[1]);
          const margin = rules.balconies ? 1.7 : 0;
          const umin = Math.min(...us) - margin, umax = Math.max(...us) + margin, vmin = Math.min(...vs) - margin, vmax = Math.max(...vs) + margin;
          const W = umax - umin, H = vmax - vmin;
          if (W - 2 * margin < 1 || H - 2 * margin < 1) {
            warn(warnings, "invalid-footprint", "error", "The footprint is narrower than one metre.");
            return fail();
          }
          const fp = t.polygon([closed(ringUV)]);
          const inner = innerPolygons.length === 1 ? t.polygon(innerPolygons[0].map((ring) => ring.map(toUV))) : t.multiPolygon(innerPolygons.map((rings) => rings.map((ring) => ring.map(toUV))));
          const edgesUV = edges.map((edge) => {
            const a = toUV(edge.a), b = toUV(edge.b), d = unit(vec(a, b));
            return { ...edge, a, b, d, inward: leftNormal(d), isFront: edge.index === street.index };
          });
          const footprintUmin = Math.min(...us), footprintUmax = Math.max(...us), footprintVmin = Math.min(...vs), footprintVmax = Math.max(...vs);
          const usableM2 = polygonsArea(inner);
          const exteriorWalls = differenceOrNull(t, fp, inner);
          const facades = edgesUV.map((edge) => ({
            index: edge.index,
            a: edge.a,
            b: edge.b,
            d: edge.d,
            inward: edge.inward,
            lengthM: edge.lengthM,
            party: edge.party,
            partyRuns: edge.partyRuns,
            blind: edge.blind,
            isFront: edge.isFront,
            sun: edge.sun
          }));
          const decision = yardCore ? { ...yardCore.decision } : decideAccess(rules, Math.min(footprintUmax - footprintUmin, footprintVmax - footprintVmin) - 2 * rules.exteriorWallM);
          let coreSide = null, yardMode = false;
          if (decision.access === "corridor" && !yardCore) {
            const corridorInput = {
              t,
              rules,
              inner,
              edgesUV,
              facades,
              front,
              frameUV: { u: frameU, v: frameV },
              stairCount: knownStairs,
              sunSign,
              storeyHeightM,
              floors,
              highRise,
              targets,
              // targets
              ext: { u0: footprintUmin, u1: footprintUmax, v0: footprintVmin, v1: footprintVmax },
              facadeRun: rooms ? rooms.facadeRun : null,
              runInside: rooms ? rooms.runInside : null,
              fixedLift,
              // The building's corridor and stairs as laid out on another storey: kept where they are.
              fixed: knownStairs && input.stairs.fixed && input.stairs.corridor ? {
                spine: input.stairs.corridor.spine.map((p) => toUV(frame.toMeters(p))),
                centres: input.stairs.corridor.centres.map((p) => toUV(frame.toMeters(p)))
              } : null
            };
            let corridorParts = planCorridorParts(corridorInput);
            const b = corridorParts.balance;
            if (!corridorInput.fixed && b && b.lo > 0 && b.hi > 0 && Math.abs(b.lo / b.hi - 1) > 0.05) {
              const loDepthM = Math.min(b.spanM - b.minHiM, Math.max(b.minLoM, b.spanM * b.lo / (b.lo + b.hi)));
              const shifted = planCorridorParts({ ...corridorInput, loDepthM });
              if (!shifted.error) corridorParts = shifted;
            }
            if (!corridorParts.error) {
              const rowM = corridorParts.corridor.rowDepthM;
              if (rowM > rules.deepCorridorRowM) warn(warnings, "deep-corridor-rows", "notice", `Each corridor row is ${Math.round(rowM)} m deep; rooms far from the facade get little daylight.`);
              return finish(corridorParts);
            }
            warn(warnings, corridorParts.error.code, "notice", `${corridorParts.error.message} The layout uses point access instead.`);
            decision.fallback = corridorParts.error.code;
          }
          if (yardCore) coreSide = { ...yardCore.coreSide };
          else {
            coreSide = decideCoreSide(rules, [-front.inward[0], -front.inward[1]], sunSign, frontBasis);
            if (coreSide.side === "yard") {
              const yard = exterior.filter((edge) => !edge.blind && edge.lengthM >= 3 && edge.inward[0] * front.inward[0] + edge.inward[1] * front.inward[1] < -Math.cos(30 * Math.PI / 180)).reduce((best, edge) => !best || edge.lengthM > best.lengthM ? edge : best, null);
              if (yard) {
                const degrees = (edge) => ({ a: frame.toDegrees(edge.a), b: frame.toDegrees(edge.b) });
                const yardPass = planDefaultFloorPlans({
                  ...input,
                  front: { ...degrees(yard), basis: "yard" },
                  _yardCore: { street: { ...degrees(front), basis: frontBasis }, coreSide, decision, warnings }
                }, options);
                if (yardPass.floorPlans) return yardPass;
                coreSide = { ...coreSide, side: "street", basis: "yard-core-does-not-fit" };
                warn(warnings, "yard-core-does-not-fit", "notice", "The street is sunny, but no stair core fits on the yard facade; it stands on the street facade.");
              } else {
                coreSide = { ...coreSide, side: "street", basis: "no-yard-facade" };
                warn(warnings, "no-yard-facade", "notice", "The street is sunny, but no open facade faces the yard; the stair core stands on the street facade.");
              }
            }
          }
          yardMode = coreSide.side === "yard";
          summary.coreSide = coreSide.side;
          summary.coreSideBasis = coreSide.basis;
          let cores = Math.max(1, Math.min(rules.maxCores, Math.ceil(usableM2 / (2 * rules.maxApartmentM2))));
          if (targets) cores = Math.ceil(targets.length / 2);
          if (knownStairs) cores = knownStairs;
          const lift = fixedLift !== null ? fixedLift : wantsLift(rules, floors, cores, highRise, targets ? targets.length : 2 * cores);
          const core = coreDimensions(storeyHeightM, rules, lift, highRise);
          summary.lift = lift;
          summary.coreM = [round2(core.widthM), round2(core.depthM)];
          if (highRise) warn(warnings, "high-rise", "notice", `The top floor lies ${Math.round(topFloorM)} m up, above ${rules.highRiseAboveM} m: a protected stair with a fire lobby and a firefighting lift are assumed.`);
          const noCoreFits = (detail) => {
            warn(
              warnings,
              "core-does-not-fit",
              "error",
              `Too small to fit a minimum ${lift ? "stair and lift" : "stair"} core of ${summary.coreM[0]} \xD7 ${summary.coreM[1]} m behind the front facade.`,
              { coreM: summary.coreM, cores, ...detail }
            );
            return fail();
          };
          const spans = edgesUV.filter((edge) => !edge.blind && edge.inward[1] > Math.cos(30 * Math.PI / 180)).flatMap((edge) => rooms.freeRuns(edge, [0, edge.lengthM], core.widthM).map(([s0, s1]) => {
            const ends = [add(edge.a, edge.d, s0), add(edge.a, edge.d, s1)];
            const [p, q] = ends[0][0] <= ends[1][0] ? ends : [ends[1], ends[0]];
            return {
              index: edge.index,
              from: p[0],
              to: q[0],
              length: q[0] - p[0],
              vAt: (u) => p[1] + (u - p[0]) * (q[1] - p[1]) / Math.max(1e-9, q[0] - p[0])
            };
          })).sort((a, b) => a.from - b.from);
          const frontLengthM = spans.reduce((sum, span) => sum + span.length, 0);
          if (!spans.length) return noCoreFits({ frontLengthM });
          const byFrontage = Math.max(1, Math.floor(frontLengthM / (core.widthM + 2 * rules.minApartmentWidthM)));
          if (cores > byFrontage && !knownStairs) {
            cores = byFrontage;
            if (targets) warn(warnings, "unit-targets-limited-by-frontage", "notice", `The street facade takes ${cores} core(s): ${Math.min(targets.length, 2 * cores)} of ${targets.length} known flats fit.`);
            else warn(warnings, "cores-limited-by-frontage", "notice", `The street facade takes ${cores} core(s); apartments run larger than ${rules.maxApartmentM2} m\xB2.`);
          }
          let groups = null, bounds = null, desiredU = null;
          if (targets) {
            groups = [];
            if (Math.ceil(targets.length / 2) >= cores) for (let i = 0; i < targets.length && groups.length < cores; i += 2) groups.push(targets.slice(i, i + 2));
            else for (let k = 0; k < cores; k++) groups.push(targets.slice(Math.floor(targets.length * k / cores), Math.floor(targets.length * (k + 1) / cores)));
            const coreA = core.widthM * core.depthM;
            const areaLeftOf = (u) => polygonsArea(intersectOrNull(t, inner, rect(t, umin - 1, u, vmin - 1, vmax + 1)));
            const uAtArea = (area) => {
              let lo = footprintUmin, hi = footprintUmax;
              for (let i = 0; i < 40; i++) {
                const mid = (lo + hi) / 2;
                if (areaLeftOf(mid) < area) lo = mid;
                else hi = mid;
              }
              return (lo + hi) / 2;
            };
            const weights = groups.map((group) => group.reduce((sum, target) => sum + target.weight, 0) + coreA);
            const total = weights.reduce((sum, w) => sum + w, 0);
            const cum = [0];
            weights.forEach((w) => cum.push(cum[cum.length - 1] + w / total * usableM2));
            bounds = cum.map((area, i) => i === 0 ? footprintUmin : i === groups.length ? footprintUmax : uAtArea(area));
            desiredU = groups.map((group, k) => {
              const segA = cum[k + 1] - cum[k];
              const share = group.length === 2 ? group[0].weight / (group[0].weight + group[1].weight) : 0.5;
              return uAtArea(cum[k] + share * Math.max(0, segA - coreA) + coreA / 2);
            });
          }
          if (knownStairs && knownDoorsUV.length === cores) {
            const cos30 = Math.cos(30 * Math.PI / 180);
            const nearLongFacade = (p) => edgesUV.some((edge) => Math.abs(edge.d[0]) > cos30 && (() => {
              const ab = vec(edge.a, edge.b), l2 = ab[0] * ab[0] + ab[1] * ab[1];
              const s = Math.max(0, Math.min(1, ((p[0] - edge.a[0]) * ab[0] + (p[1] - edge.a[1]) * ab[1]) / l2));
              return Math.hypot(p[0] - edge.a[0] - s * ab[0], p[1] - edge.a[1] - s * ab[1]) < 3;
            })());
            const along = input.stairs.fixed ? knownDoorsUV : knownDoorsUV.filter(nearLongFacade);
            if (along.length === cores) {
              const doorsU = along.map((p) => p[0]).sort((a, b) => a - b);
              desiredU = doorsU.map((u, k) => desiredU && !input.stairs.fixed ? Math.min(u + KNOWN_DOOR_WITHIN_M, Math.max(u - KNOWN_DOOR_WITHIN_M, desiredU[k])) : u);
            } else summary.stairsBasis = "house-numbers";
          }
          const coreDepthM = core.depthM + (yardMode ? rules.coreWallM : 0);
          const coreOuter = (uc, vFront) => rect(t, uc - core.widthM / 2, uc + core.widthM / 2, vFront, vFront + coreDepthM);
          const fits = (feature) => {
            const clip = intersectOrNull(t, inner, feature);
            return clip && polygonsArea(clip) >= 0.995 * polygonsArea(feature);
          };
          const placed = [];
          const fixedCoresUV = knownStairs && input.stairs.fixed && knownDoorsUV.length === cores ? knownDoorsUV.slice().sort((a, b) => a[0] - b[0]) : null;
          for (let k = 0; k < cores; k++) {
            const target = frontLengthM * (k + 0.5) / cores;
            let offset = 0, home = spans[spans.length - 1], local = home.length / 2;
            for (const span of spans) {
              if (target <= offset + span.length) {
                home = span;
                local = target - offset;
                break;
              }
              offset += span.length;
            }
            if (desiredU) {
              const u = desiredU[k];
              home = spans.reduce((best, span) => {
                const d = u < span.from ? span.from - u : u > span.to ? u - span.to : 0;
                return !best || d < best.d ? { span, d } : best;
              }, null).span;
              local = Math.min(home.length, Math.max(0, u - home.from));
            }
            const minU = placed.length ? placed[placed.length - 1].uc + core.widthM + 1 : -Infinity;
            let found = null;
            if (fixedCoresUV && fixedCoresUV[k] && fixedCoresUV[k][0] >= minU - 1e-9) {
              const [u, v] = fixedCoresUV[k];
              for (let step = 0; step <= 20 && !found; step++) {
                const vFront = v + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 0.1;
                if (fits(coreOuter(u, vFront))) found = { k, uc: u, vFront, edgeIndex: home.index };
              }
            }
            const stepM = desiredU ? 0.1 : 0.5;
            for (const span of found ? [] : [home, ...spans.filter((span2) => span2 !== home)]) {
              const lo = span.from + core.widthM / 2, hi = span.to - core.widthM / 2;
              if (hi < lo - 1e-9 || hi < minU - 1e-9) continue;
              const centre = Math.min(hi, Math.max(lo, minU, span === home ? span.from + local : lo));
              const candidates = [centre];
              for (let step = stepM; step <= hi - lo + 1e-9; step += stepM) candidates.push(centre + step, centre - step);
              for (const u of candidates) {
                if (u < lo - 1e-9 || u > hi + 1e-9 || u < minU - 1e-9) continue;
                const vFront = Math.max(span.vAt(u - core.widthM / 2), span.vAt(u + core.widthM / 2)) + rules.exteriorWallM;
                if (fits(coreOuter(u, vFront))) {
                  found = { k, uc: u, vFront, edgeIndex: span.index };
                  break;
                }
              }
              if (found) break;
            }
            if (!found) return noCoreFits({ segment: k, frontLengthM });
            placed.push(found);
          }
          placed.forEach((block, i) => {
            block.s0 = i === 0 ? footprintUmin : (placed[i - 1].uc + block.uc) / 2;
            block.s1 = i === placed.length - 1 ? footprintUmax : (block.uc + placed[i + 1].uc) / 2;
          });
          if (bounds) {
            const cut = (i) => Math.min(placed[i].uc - core.widthM / 2 - 0.5, Math.max(placed[i - 1].uc + core.widthM / 2 + 0.5, bounds[i]));
            placed.forEach((block, i) => {
              if (i > 0) block.s0 = cut(i);
              if (i < placed.length - 1) block.s1 = cut(i + 1);
            });
          }
          summary.coreCentres = placed.map((block) => frame.toDegrees(fromUV([block.uc, block.vFront])));
          const coreWalls = [], coreOpenings = [], coreCuts = [], entranceOpenings = [], entranceCuts = [];
          const voids = [], landings = [], stairs = [], coreRailings = [], blocks = [], coreRects = [];
          const entranceHeightM = Math.min(rules.entranceHeightM, storeyHeightM - rules.slabThicknessM - 0.3);
          const streetUV = edgesUV.find((edge) => edge.isFront);
          for (const { k, uc, vFront, edgeIndex, s0, s1 } of placed) {
            const D = core.depthM;
            const built = yardMode ? coreParts(t, rules, core, storeyHeightM, lift, uc, (x, y) => [x, vFront + D - y], (x02, x12, y0, y1) => rect(t, x02, x12, vFront + D - y1, vFront + D - y0)) : coreParts(t, rules, core, storeyHeightM, lift, uc, (x, y) => [x, vFront + y], (x02, x12, y0, y1) => rect(t, x02, x12, vFront + y0, vFront + y1));
            coreWalls.push(...built.walls);
            coreOpenings.push(...built.openings);
            coreCuts.push(...built.cuts);
            voids.push(...built.voids);
            landings.push(...built.landings);
            stairs.push(...built.stairs);
            coreRailings.push(...built.railings);
            coreRects.push(yardMode ? coreOuter(uc, vFront) : built.rect);
            const { x0, x1 } = built;
            const glazedDoor = (a, b, depthM2) => ({ kind: "glazedDoor", a, b, depthM: depthM2, sillM: 0, heightM: entranceHeightM, room: "entrance" });
            const enter = (opening) => {
              entranceOpenings.push(opening);
              entranceCuts.push(strip(t, opening.a, opening.b, opening.depthM + 0.06));
            };
            if (yardMode) {
              coreWalls.push(rect(t, x0 - rules.coreWallM, x1 + rules.coreWallM, vFront + D, vFront + D + rules.coreWallM));
              const doorV = vFront + D + rules.coreWallM / 2;
              enter(glazedDoor([uc - rules.entranceDoorM / 2, doorV], [uc + rules.entranceDoorM / 2, doorV], rules.coreWallM));
              const half = rules.entranceDoorM / 2;
              const along = Math.abs(streetUV.d[0]) > 0.3 ? (uc - streetUV.a[0]) / streetUV.d[0] : streetUV.lengthM / 2;
              const centre = add(add(streetUV.a, streetUV.d, Math.min(streetUV.lengthM - half - 0.1, Math.max(half + 0.1, along))), streetUV.inward, rules.exteriorWallM / 2);
              enter(glazedDoor(add(centre, streetUV.d, -half), add(centre, streetUV.d, half), rules.exteriorWallM));
            } else {
              const doorV = vFront - rules.exteriorWallM / 2;
              enter(glazedDoor([uc - rules.entranceDoorM / 2, doorV], [uc + rules.entranceDoorM / 2, doorV], rules.exteriorWallM));
            }
            blocks.push({
              k,
              uc,
              s0,
              s1,
              x0,
              x1,
              edgeIndex,
              backY: vFront + coreDepthM,
              hallY0: vFront,
              doorY0: yardMode ? vFront + D - core.landingM : vFront,
              doorY1: yardMode ? vFront + D : vFront + core.landingM
            });
          }
          const dilatations = placed.slice(1).map(({ s0 }) => intersectOrNull(t, inner, rect(t, s0 - rules.dilatationWallM / 2, s0 + rules.dilatationWallM / 2, vmin - 1, vmax + 1))).filter(Boolean);
          let remaining = inner;
          for (const block of blocks) remaining = differenceOrNull(t, remaining, rect(t, block.x0 - rules.coreWallM, block.x1 + rules.coreWallM, block.hallY0, block.backY));
          for (const wall of dilatations) remaining = differenceOrNull(t, remaining, wall);
          const apartments = [], dividerWalls = [], apartmentDoors = [], apartmentDoorCuts = [];
          for (const block of blocks) {
            const divider = intersectOrNull(t, inner, rect(t, block.uc - rules.apartmentWallM / 2, block.uc + rules.apartmentWallM / 2, block.backY, vmax + 1));
            const segment = rect(t, block.s0, block.s1, vmin - 1, vmax + 1);
            const inSegment = intersectOrNull(t, remaining, segment);
            const left = intersectOrNull(t, inSegment, rect(t, block.s0, block.uc - rules.apartmentWallM / 2, vmin - 1, vmax + 1));
            const right = intersectOrNull(t, inSegment, rect(t, block.uc + rules.apartmentWallM / 2, block.s1, vmin - 1, vmax + 1));
            const areaL = left ? polygonsArea(left) : 0, areaR = right ? polygonsArea(right) : 0;
            const besideCore = (side) => {
              const clip = intersectOrNull(t, side, rect(t, block.s0, block.s1, block.hallY0, block.backY));
              return clip ? uExtent(clip) : 0;
            };
            const wideEnough = (side) => {
              const w = besideCore(side);
              return w === 0 || w >= rules.minApartmentWidthM;
            };
            const group = groups ? groups[block.k] : null;
            const minA = group ? 8 : rules.minApartmentM2;
            const two = (!group || group.length === 2) && left && right && areaL >= minA && areaR >= minA && wideEnough(left) && wideEnough(right);
            const withTarget = (apartment, target) => target ? { ...apartment, target } : apartment;
            if (two) {
              if (divider) {
                dividerWalls.push(divider);
                remaining = differenceOrNull(t, remaining, divider);
              }
              apartments.push(withTarget({ block, side: "left", polygon: left, areaM2: areaL }, group && group[0]), withTarget({ block, side: "right", polygon: right, areaM2: areaR }, group && group[1]));
            } else if (inSegment && polygonsArea(inSegment) >= minA) {
              apartments.push(withTarget({ block, side: "whole", polygon: inSegment, areaM2: polygonsArea(inSegment) }, group && group[0]));
              if (!group) warn(warnings, "single-apartment-per-core", "notice", "Too narrow for two apartments beside the core; one apartment per floor.");
            } else {
              warn(
                warnings,
                "no-room-for-apartments",
                "error",
                `Only ${Math.round(inSegment ? polygonsArea(inSegment) : 0)} m\xB2 remain beside the core; no apartment of ${rules.minApartmentM2} m\xB2 fits.`
              );
              return fail();
            }
            for (const apartment of apartments.filter((apartment2) => apartment2.block === block)) {
              const onLeft = apartment.side !== "right";
              const wallX = onLeft ? block.x0 - rules.coreWallM / 2 : block.x1 + rules.coreWallM / 2;
              let y0 = block.doorY0 + 0.35, y1 = y0 + rules.apartmentDoorM;
              if (y1 > block.doorY1 - 0.05) continue;
              const besideX = wallX + (onLeft ? -1 : 1) * (rules.coreWallM / 2 + 0.05);
              const run = rooms ? rooms.runInside(apartment.polygon, [besideX, block.doorY0], [besideX, block.doorY1]) : [0, block.doorY1 - block.doorY0];
              if (!run) continue;
              if (run[0] > y0 - block.doorY0 + 0.01 || run[1] < y1 - block.doorY0 - 0.01) {
                y0 = block.doorY0 + run[0] + 0.1;
                y1 = y0 + rules.apartmentDoorM;
                if (y1 > block.doorY0 + run[1] + 0.01) continue;
              }
              const into = swingInto(t, apartment.polygon, [wallX, y1], [onLeft ? -1 : 1, 0], rules.apartmentDoorM);
              const door = {
                kind: "door",
                a: [wallX, y0],
                b: [wallX, y1],
                depthM: rules.coreWallM,
                sillM: 0,
                heightM: rules.doorHeightM,
                hinge: [wallX, y1],
                openTip: add([wallX, y1], into, rules.apartmentDoorM),
                room: "apartment"
              };
              apartmentDoors.push(door);
              apartmentDoorCuts.push(strip(t, door.a, door.b, rules.coreWallM + 0.06));
            }
          }
          const depthM = footprintVmax - blocks[0].hallY0;
          if (depthM > rules.deepFloorPlateM) warn(warnings, "deep-floor-plate", "notice", `The floor plate is ${Math.round(depthM)} m deep; rooms in the middle get little daylight.`);
          for (const apartment of apartments) {
            const block = apartment.block, right = apartment.side === "right";
            apartment.unitId = `core-${block.k + 1}-${apartment.side}`;
            apartment.env = {
              side: apartment.side,
              coreSideU: right ? block.x1 + rules.coreWallM : block.x0 - rules.coreWallM,
              dividerU: right ? block.uc + rules.apartmentWallM / 2 : block.uc - rules.apartmentWallM / 2,
              farU: right ? block.s1 : block.s0,
              vFront: block.hallY0,
              backY: block.backY,
              vb: footprintVmax - rules.exteriorWallM,
              doorNearU: block.uc,
              ...apartment.target ? { bedrooms: apartment.target.bedrooms } : {}
              // the register's bedrooms, or null
            };
          }
          let ground = null;
          if (yardMode) {
            const passages = [], passageWalls = [];
            for (const block of blocks) {
              const outer = [block.x0 - rules.coreWallM - rules.apartmentWallM, block.x1 + rules.coreWallM + rules.apartmentWallM];
              const passage = intersectOrNull(t, inner, rect(t, block.x0 - rules.coreWallM, block.x1 + rules.coreWallM, block.backY, vmax + 1));
              const walled = intersectOrNull(t, inner, rect(t, outer[0], outer[1], block.backY, vmax + 1));
              if (!passage || !walled) continue;
              passages.push(walled);
              for (const [w0, w1] of [[outer[0], block.x0 - rules.coreWallM], [block.x1 + rules.coreWallM, outer[1]]]) {
                const wall = intersectOrNull(t, fp, rect(t, w0, w1, block.backY - 0.05, vmax + 1));
                if (wall) passageWalls.push(wall);
              }
              for (const apartment of apartments.filter((apartment2) => apartment2.block === block && apartment2.side !== "whole")) {
                apartment.envGround = { dividerU: apartment.side === "right" ? outer[1] : outer[0] };
              }
            }
            const cut = unionAll(t, passages);
            ground = {
              cut,
              walls: passageWalls,
              dividerWalls: dividerWalls.map((wall) => cut ? differenceOrNull(t, wall, cut) : wall).filter(Boolean)
            };
          }
          return finish({
            access: "point",
            cores,
            lift,
            core,
            coreWalls,
            coreOpenings,
            coreCuts,
            entranceOpenings,
            entranceCuts,
            voids,
            landings,
            stairs,
            coreRailings,
            coreRects,
            dividerWalls,
            dilatations,
            apartments,
            apartmentDoors,
            apartmentDoorCuts,
            ground,
            garageVRange: [blocks[0].hallY0, footprintVmax - rules.exteriorWallM]
          });
          function finish(parts) {
            const {
              cores: cores2,
              lift: lift2,
              core: core2,
              coreWalls: coreWalls2,
              coreOpenings: coreOpenings2,
              coreCuts: coreCuts2,
              entranceOpenings: entranceOpenings2,
              entranceCuts: entranceCuts2,
              voids: voids2,
              landings: landings2,
              stairs: stairs2,
              coreRailings: coreRailings2,
              coreRects: coreRects2,
              dividerWalls: dividerWalls2,
              dilatations: dilatations2,
              apartments: apartments2,
              apartmentDoors: apartmentDoors2,
              apartmentDoorCuts: apartmentDoorCuts2
            } = parts;
            const corridor = parts.access === "corridor" ? parts.corridor : null;
            summary.lift = lift2;
            summary.coreM = [round2(core2.widthM), round2(core2.depthM)];
            summary.access = parts.access;
            summary.accessBasis = decision.basis;
            summary.plateDepthM = decision.plateDepthM;
            if (decision.fallback) summary.accessFallback = decision.fallback;
            summary.flaggedFlats = apartments2.filter((apartment) => apartment.flag).length;
            if (targets) {
              const placedIds = new Set(apartments2.filter((apartment) => apartment.target).map((apartment) => apartment.target.id));
              summary.unplacedTargets = targets.filter((target) => !placedIds.has(target.id)).map((target) => target.id);
              if (summary.unplacedTargets.length) warn(warnings, "unit-targets-not-placed", "notice", `${summary.unplacedTargets.length} of ${targets.length} known units did not fit this layout.`, { ids: summary.unplacedTargets });
            }
            function accessReason() {
              const mode = parts.access === "corridor" ? "Corridor access" : "Point access";
              if (decision.fallback) return `Point access: a corridor does not fit this floor plate (${decision.fallback}).`;
              if (decision.basis === "view") return `${mode}, as chosen in the view.`;
              if (decision.basis === "design") return `${mode}, as the design states.`;
              return `${mode}: the floor plate is ${decision.plateDepthM} m deep inside its walls (${parts.access === "corridor" ? "at least" : "under"} ${rules.corridorFromDepthM} m).`;
            }
            const groundFloorUse = rules.groundFloorUse === "auto" ? buildingUse().autoGroundFloorUse(input.typology, floors) : rules.groundFloorUse;
            summary.groundFloorUse = groundFloorUse;
            const garageLevels = rules.garage === "never" ? 0 : rules.garage === "always" ? Math.max(1, rules.garageLevels) : floors >= rules.garageFromFloors && usableM2 >= rules.garageFromUsableM2 ? Math.max(1, rules.garageLevels) : 0;
            let garage = null;
            if (garageLevels && rooms) {
              const endEdge = edgesUV.find((edge) => !edge.party && Math.abs(edge.inward[0]) > Math.cos(35 * Math.PI / 180));
              const farEnd = endEdge ? { u: endEdge.inward[0] > 0 ? footprintUmin + rules.exteriorWallM : footprintUmax - rules.exteriorWallM, dir: endEdge.inward[0] > 0 ? -1 : 1 } : null;
              if (farEnd) {
                garage = rooms.garageLayout({
                  t,
                  inner,
                  cores: coreRects2,
                  uRange: [footprintUmin + rules.exteriorWallM, footprintUmax - rules.exteriorWallM],
                  vRange: parts.garageVRange,
                  storeyHeightM,
                  farEnd
                });
                garage.notices.forEach((code) => warn(warnings, code, "notice", code === "garage-ramp-steep" ? `The garage ramp is steeper than 15 % (${garage.ramp?.slope ?? "?"} %).` : "No room for a garage ramp inside the building; the garage level has no ramp."));
              } else {
                garage = { columns: [], ramp: null, notices: [] };
              }
            }
            summary.garageLevels = garage ? garageLevels : 0;
            const wallHeightM = storeyHeightM - rules.slabThicknessM;
            function furnish(isGround) {
              const result = { partitions: [], openings: [], cuts: [], balconySlabs: [], railings: [], units: [], rooms: 0 };
              if (!rooms) return result;
              for (const apartment of apartments2) {
                let polygon = apartment.polygon;
                if (isGround && garage && garage.ramp) polygon = differenceOrNull(t, polygon, garage.ramp.polygon) || polygon;
                const passageCut = isGround && parts.ground && parts.ground.cut ? differenceOrNull(t, polygon, parts.ground.cut) : null;
                if (passageCut) polygon = passageCut;
                const env = {
                  ...apartment.env,
                  ...isGround && apartment.envGround ? apartment.envGround : {},
                  t,
                  facades,
                  wallM: rules.exteriorWallM,
                  wallHeightM,
                  isGround,
                  balconies: rules.balconies,
                  bayWidthM: finite(rules.facadeBayWidthM) ? rules.facadeBayWidthM : null,
                  ...yardMode ? { streetAtHighV: true } : {}
                  // the street facade lies at the far side of the frame
                };
                const targetKind = apartment.target ? apartment.target.kind : null;
                const kind = targetKind && targetKind !== "apartment" ? targetKind : isGround && groundFloorUse === "commercial" ? "shop" : "apartment";
                const furnished = kind === "void" ? { rooms: [], partitions: [], openings: [], cuts: [], balconySlabs: [], railings: [] } : kind === "shop" ? rooms.furnishShop(polygon, env) : kind === "office" ? rooms.furnishOffice(polygon, env) : apartment.env.layout ? rooms.furnishCorridorFlat(polygon, env) : rooms.furnishApartment(polygon, env);
                result.partitions.push(...furnished.partitions);
                result.openings.push(...furnished.openings);
                result.cuts.push(...furnished.cuts);
                result.balconySlabs.push(...furnished.balconySlabs);
                result.railings.push(...furnished.railings);
                result.rooms += furnished.rooms.length;
                result.units.push({
                  apartment,
                  kind,
                  // kind above (upstream: shop on a commercial ground floor, else apartment)
                  rooms: furnished.rooms.map((room) => ({ kind: room.kind, areaM2: room.areaM2 })),
                  roomFeatures: furnished.rooms,
                  ...passageCut ? { polygon, areaM2: polygonsArea(polygon) } : {}
                });
              }
              return result;
            }
            const typical = furnish(false);
            const ground2 = furnish(true);
            if (!rooms) warn(warnings, "rooms-unavailable", "notice", "Room layouts are unavailable; apartments stay undivided.");
            const uv = ([u, v]) => [round6(Math.min(1, Math.max(0, (u - umin) / W))), round6(Math.min(1, Math.max(0, (v - vmin) / H)))];
            const polygonData = (feature) => polygonsOf(feature).filter((rings) => Math.abs(ringArea(rings[0])) >= 0.01).map((rings) => rings.filter((ring, index) => index === 0 || Math.abs(ringArea(ring)) >= 0.01).map((ring) => cleanRing(ring, 4e-3).map(uv)).filter((ring) => ring.length >= 3));
            const polygonsData = (features) => features.flatMap(polygonData);
            const openingData = (o) => ({
              kind: o.kind,
              a: uv(o.a),
              b: uv(o.b),
              depthM: o.depthM,
              sillM: o.sillM,
              heightM: Math.min(o.heightM, wallHeightM - o.sillM),
              ...o.hinge ? { hinge: uv(o.hinge), openTip: uv(o.openTip) } : {},
              ...o.room ? { room: o.room } : {}
            });
            const stairData = stairs2.map((s) => ({ ...s, a: uv(s.a), b: uv(s.b) }));
            const railData = (list) => list.map((r) => ({ ...r, a: uv(r.a), b: uv(r.b) }));
            const structural = [exteriorWalls, ...coreWalls2, ...dilatations2];
            const wallsOf = (extraWalls, cuts) => differenceOrNull(t, unionAll(t, [...structural, ...extraWalls]), unionAll(t, cuts));
            const typicalWalls = wallsOf([...dividerWalls2, ...typical.partitions], [...coreCuts2, ...apartmentDoorCuts2, ...typical.cuts]);
            const groundWalls = wallsOf(
              [...parts.ground ? [...parts.ground.dividerWalls, ...parts.ground.walls] : dividerWalls2, ...ground2.partitions],
              [...coreCuts2, ...apartmentDoorCuts2, ...ground2.cuts, ...entranceCuts2]
            );
            const slabTypical = differenceOrNull(t, fp, unionAll(t, voids2));
            const slabGround = garage && garage.ramp ? differenceOrNull(t, fp, garage.ramp.polygon) : fp;
            const parameters = {
              storeyHeightM,
              floors,
              cores: cores2,
              lift: lift2,
              highRise,
              frontBasis,
              region: rules.region,
              groundFloorUse,
              garageLevels: summary.garageLevels,
              access: parts.access,
              accessBasis: decision.basis,
              plateDepthM: decision.plateDepthM,
              ...decision.fallback ? { accessFallback: decision.fallback } : {},
              ...coreSide ? { coreSide: coreSide.side, coreSideBasis: coreSide.basis, streetBearingDeg: coreSide.streetBearing } : {},
              ...corridor ? { corridor: {
                lengthM: corridor.lengthM,
                widthM: corridor.widthM,
                stairs: corridor.stairs,
                deadEndM: corridor.deadEndM,
                maxStairGapM: corridor.maxStairGapM,
                coreSide: corridor.coreSide,
                mix: corridor.mix
              } } : {},
              rules: {
                maxRiserM: rules.maxRiserM,
                minTreadM: rules.minTreadM,
                flightWidthM: rules.flightWidthM,
                landingDepthM: rules.landingDepthM,
                liftShaftOuterM: rules.liftShaftOuterM,
                exteriorWallM: rules.exteriorWallM,
                coreWallM: rules.coreWallM,
                maxApartmentM2: rules.maxApartmentM2,
                minApartmentM2: rules.minApartmentM2,
                blindFacadeSetbackM: rules.blindFacadeSetbackM,
                balconies: rules.balconies
              }
            };
            const architecture = (walls, slabs, openingList, railings, extra = {}) => ({
              schema: ARCHITECTURE_SCHEMA,
              dimensionsM: [Math.round(W * 1e4) / 1e4, Math.round(H * 1e4) / 1e4],
              wallHeightM: Math.round(wallHeightM * 1e3) / 1e3,
              slabThicknessM: rules.slabThicknessM,
              walls: polygonData(walls),
              slabs: polygonsData(slabs),
              landings: polygonsData(landings2),
              openings: openingList.map(openingData),
              stairs: stairData,
              railings: railData(railings),
              ...extra,
              inference: {
                wallFootprints: "generated default",
                openings: "generated default",
                verticalDimensions: "estimated",
                glazingTypes: "assumed",
                stairRise: `${core2.stair.risers} risers of ${Math.round(core2.stair.riserM * 1e3)} mm, treads ${Math.round(rules.minTreadM * 1e3)} mm`
              },
              quality: { floorAreaM2: round2(polygonsArea(fp)), usableAreaM2: round2(usableM2), cores: cores2, lift: lift2, highRise }
            });
            const apartmentRegions = (furnished) => furnished.units.filter((unit2) => unit2.kind === "apartment" || unit2.apartment.target || emitRooms && unit2.kind !== "void").map((unit2) => ({
              id: unit2.apartment.unitId,
              polygons: polygonData(unit2.polygon || unit2.apartment.polygon),
              flag: unit2.apartment.flag || null,
              basis: "Generated apartment partition",
              ...unit2.apartment.target ? { targetId: unit2.apartment.target.id, kind: unit2.kind } : {},
              ...emitRooms ? { kind: unit2.kind, rooms: unit2.roomFeatures.map((room) => ({ kind: room.kind, areaM2: room.areaM2, polygons: polygonData(room.polygon) })) } : {}
            }));
            const source = { kind: "generated", generator: GENERATOR_ID, parameters };
            const buildingId = typeof input.buildingId === "string" && input.buildingId ? input.buildingId : "building";
            const layouts = [{
              id: `${buildingId}:default-ground`,
              source,
              architecture: architecture(
                groundWalls,
                [slabGround, ...ground2.balconySlabs],
                [...coreOpenings2, ...apartmentDoors2, ...ground2.openings, ...entranceOpenings2],
                [...coreRailings2, ...ground2.railings, ...garage && garage.ramp ? garage.ramp.railings : []],
                { apartmentRegions: apartmentRegions(ground2) }
              )
            }];
            if (floors > 1) layouts.push({
              id: `${buildingId}:default-typical`,
              source,
              architecture: architecture(typicalWalls, [slabTypical, ...typical.balconySlabs], [...coreOpenings2, ...apartmentDoors2, ...typical.openings], [...coreRailings2, ...typical.railings], { apartmentRegions: apartmentRegions(typical) })
            });
            if (garage) {
              const garageWalls = differenceOrNull(t, unionAll(t, [...structural, ...garage.columns]), unionAll(t, coreCuts2));
              layouts.push({
                id: `${buildingId}:default-garage`,
                source,
                architecture: architecture(
                  garageWalls,
                  [fp],
                  coreOpenings2,
                  [...coreRailings2, ...garage.ramp ? garage.ramp.railings : []],
                  garage.ramp ? { platforms: garage.ramp.platforms.map((p) => ({ rings: polygonData(p.polygon)[0], elevationM: Math.round(p.elevationM * 1e3) / 1e3 })).filter((p) => p.rings) } : {}
                )
              });
            }
            const unitList = (furnished, level) => furnished.units.filter(
              (unit2) => unit2.kind !== "void"
              /* a void is not a unit */
            ).map((unit2) => ({
              id: `${unit2.apartment.unitId}-${level}`,
              areaM2: Math.round((unit2.areaM2 || unit2.apartment.areaM2) * 10) / 10,
              kind: unit2.kind,
              rooms: unit2.rooms,
              ...unit2.kind === "apartment" && unit2.apartment.type ? { type: unit2.apartment.type } : {},
              ...unit2.kind === "apartment" && unit2.apartment.flag ? { flag: unit2.apartment.flag } : {},
              ...unit2.apartment.target ? { targetId: unit2.apartment.target.id } : {}
            }));
            const storeyList = [];
            for (let level = 0 - summary.garageLevels; level < floors; level++) {
              const isGarage = level < 0, isGround = level === 0;
              const layout = isGarage ? layouts[layouts.length - 1] : layouts[isGround ? 0 : Math.min(1, layouts.length - 1)];
              const units = isGarage ? [] : unitList(isGround ? ground2 : typical, level);
              storeyList.push({
                id: `${buildingId}:default-storey-${level}`,
                level,
                elevationM: Math.round(level * storeyHeightM * 1e3) / 1e3,
                elevationBasis: "estimated",
                layoutId: layout.id,
                units: isGarage ? [{ id: `garage-${level}`, kind: "garage", areaM2: round2(usableM2) }] : units
              });
            }
            const corners = [[umin, vmin], [umax, vmin], [umax, vmax], [umin, vmax]].map((p) => frame.toDegrees(fromUV(p)).map((value) => Math.round(value * 1e9) / 1e9));
            const floorPlans = {
              schema: PLANS_SCHEMA,
              suggested: true,
              generator: { id: GENERATOR_ID, parameters, warnings: warnings.slice() },
              registration: {
                corners,
                basis: `Generated default layout on the oriented bounding rectangle of the proposed footprint (plus a balcony margin); the u axis follows the ${yardMode ? "yard facade the stair core stands on" : "entrance facade"}.`,
                accuracy: "generated",
                frontBasis,
                frontEdge: summary.frontEdge
              },
              layouts,
              storeys: storeyList,
              notes: [
                corridor ? `A suggested default layout, not part of the proposal: a double-loaded corridor ${corridor.lengthM} m long with ${cores2} stair core(s) and ${apartments2.length} flats per storey (${Object.entries(corridor.mix).map(([type, n]) => `${n} ${type}`).join(", ")}).` : yardMode ? "A suggested default layout, not part of the proposal: a point-access core on the yard facade, reached from the street door by a ground-floor passage, with two apartments per core." : "A suggested default layout, not part of the proposal: a point-access core entered from the long side with two apartments per core.",
                accessReason(),
                coreSide && coreSide.basis === "orientation" ? `The street facade faces ${coreSide.streetBearing}\xB0 (0\xB0 north): ${yardMode ? "sunny, so it is left to the rooms and the stair stands on the yard" : "north or east, so the stair stands on it"}.` : null,
                corridor ? `Egress: the corridor's dead end runs ${corridor.deadEndM} m to a stair (at most ${rules.maxDeadEndM} m)${cores2 > 1 ? `, stairs stand at most ${corridor.maxStairGapM} m apart (at most ${rules.maxStairSpacingM} m)` : ""}.` : null,
                summary.flaggedFlats ? `${summary.flaggedFlats} flat(s) per storey face only north (single aspect), shown in red.` : null,
                `Stair: ${core2.stair.risers} risers of ${Math.round(core2.stair.riserM * 1e3)} mm with ${Math.round(rules.minTreadM * 1e3)} mm treads and ${Math.round(rules.flightWidthM * 100)} cm flights (${rules.regulationBasis}).`,
                lift2 ? `Lift shaft ${rules.liftShaftOuterM[0]} \xD7 ${rules.liftShaftOuterM[1]} m for a ${Math.round(rules.liftCabinM[0] * 100)} \xD7 ${Math.round(rules.liftCabinM[1] * 100)} cm cabin.` : "No lift: an open stairwell, below the storey and apartment thresholds for one.",
                highRise ? `High-rise above ${rules.highRiseAboveM} m: protected stair with a fire lobby and a firefighting lift assumed.` : null,
                "Rooms, windows and balconies are placed by rule; party walls and facades within the boundary setback stay blind.",
                groundFloorUse === "commercial" ? "Ground floor shown as shops with storefront glazing." : null,
                summary.garageLevels ? `${summary.garageLevels} garage level(s) with a ramp inside the building.` : null
              ].filter(Boolean)
            };
            const validate = typeof options.validate === "function" ? options.validate : global.__buildingFloorPlans && global.__buildingFloorPlans.validateFloorPlans;
            if (validate) {
              const errors = validate(floorPlans);
              if (errors.length) throw new Error(`default-floor-plans produced an invalid model: ${errors.join("; ")}`);
            }
            summary.cores = cores2;
            summary.heightM = floors * storeyHeightM;
            summary.apartmentsPerFloor = typical.units.filter((unit2) => unit2.kind === "apartment").length;
            summary.apartmentAreasM2 = typical.units.filter((unit2) => unit2.kind === "apartment").map((unit2) => Math.round(unit2.apartment.areaM2 * 10) / 10);
            summary.rooms = typical.rooms;
            summary.shopsOnGround = ground2.units.filter((unit2) => unit2.kind === "shop").length;
            const toLngLat = (p) => frame.toDegrees(fromUV(p)).map((value) => Math.round(value * 1e9) / 1e9);
            summary.flats = apartments2.map((apartment) => ({
              id: apartment.unitId,
              type: apartment.type || null,
              areaM2: round2(apartment.areaM2),
              flag: apartment.flag || null,
              rings: polygonsOf(apartment.polygon).map((rings) => rings[0].map(toLngLat)),
              ...apartment.target ? { targetId: apartment.target.id } : {}
            }));
            if (corridor) summary.corridor = { ...corridor, spine: corridor.spine.map(toLngLat), stairCentres: corridor.stairCentres.map(toLngLat) };
            return { floorPlans, warnings, summary };
          }
        }
        const api = {
          GENERATOR_ID,
          DEFAULT_RULES,
          COMMON_RULES,
          REGULATION_PRESETS,
          CORRIDOR_MIX,
          rulesFor,
          planDefaultFloorPlans,
          stairRun,
          coreDimensions,
          wantsLift,
          decideAccess,
          decideCoreSide,
          fillRows,
          describe,
          PLANS_SCHEMA,
          ARCHITECTURE_SCHEMA,
          // The clip helpers, exported so their failure reporting is tested directly.
          _clip: { unionAll, differenceOrNull, intersectOrNull },
          // Shared with the central-core scheme (default-floor-plan-core.js).
          _geometry: {
            T,
            finite,
            warn,
            round2,
            round6,
            makeFrame,
            polygonsOf,
            ringArea,
            mainAxis,
            squareTo,
            polygonsArea,
            cleanRing,
            rect,
            strip,
            vec,
            add,
            len,
            unit,
            leftNormal,
            midpoint,
            unionAll,
            differenceOrNull,
            intersectOrNull,
            partyRunsOf,
            matchEdge,
            coreParts
          }
        };
        global.__defaultFloorPlans = api;
        if (typeof module !== "undefined" && module.exports) module.exports = api;
      })(typeof window !== "undefined" ? window : globalThis);
    }
  });

  // src/planner/default-floor-plan-context.js
  var require_default_floor_plan_context = __commonJS({
    "src/planner/default-floor-plan-context.js"(exports, module) {
      (function(global) {
        "use strict";
        function reportClip(operation, error, site, operands) {
          const api2 = global && global.__parcelArrangement || (typeof __require === "function" ? require_clip_report() : null);
          if (api2) return api2.reportClipFailure(operation, error, { site }, operands);
          console.error(`[${(/* @__PURE__ */ new Date()).toISOString()}] [clip] Polygon ${operation} failed at ${site}: ${error && error.message} \u2014 degraded`);
          return error;
        }
        const buildingUse = () => global && global.BuildingUse || require_building_use();
        const generatorGeometry = () => (global && global.__defaultFloorPlans || require_default_floor_plans())._geometry;
        const STREET_CELL_DEG = 5e-3;
        const STREET_CELL_MARGIN_DEG = 1e-3;
        const COVERAGE_MIN = 0.95;
        const NEIGHBOUR_PAD_DEG = 2e-5;
        const WING_FILL_MAX = 0.8;
        const WING_MIN_M2 = 25;
        const WING_CORNER_MIN_EDGE_M = 4;
        const WING_MIN_DEPTH_M = 5;
        const CACHE_MAX = 64, CACHE_BYTES = 16 * 1024 * 1024, CACHE_ENTRY_BYTES = 4 * 1024 * 1024;
        const cachedSizes = /* @__PURE__ */ new WeakMap();
        function resultBytes(result) {
          if (!cachedSizes.has(result)) cachedSizes.set(result, JSON.stringify(result).length * 2);
          return cachedSizes.get(result);
        }
        function cacheResult(cache, key, result) {
          const size = resultBytes(result);
          if (size > CACHE_ENTRY_BYTES) return;
          let bytes = [...cache.values()].reduce((sum, value) => sum + resultBytes(value), 0);
          while (cache.size && (cache.size >= CACHE_MAX || bytes + size > CACHE_BYTES)) {
            const oldest = cache.keys().next().value;
            bytes -= resultBytes(cache.get(oldest));
            cache.delete(oldest);
          }
          cache.set(key, result);
        }
        function hashText(text) {
          let h = 2166136261;
          for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619);
          }
          return (h >>> 0).toString(16);
        }
        const geometryHash = (feature) => hashText(JSON.stringify(feature && feature.geometry ? feature.geometry.coordinates : null));
        function bboxOf(feature, turf2) {
          try {
            return turf2.bbox(feature);
          } catch (_) {
            return null;
          }
        }
        function areaOf(feature, turf2) {
          try {
            return turf2.area(feature);
          } catch (_) {
            return 0;
          }
        }
        const bboxesOverlap = (a, b, pad = 0) => !(b[2] < a[0] - pad || b[0] > a[2] + pad || b[3] < a[1] - pad || b[1] > a[3] + pad);
        const asFeature = (geometry) => ({ type: "Feature", properties: {}, geometry });
        const polygonsOf = (feature) => {
          const g = feature && feature.type === "Feature" ? feature.geometry : feature;
          if (!g) return [];
          return g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
        };
        const M_PER_DEG = Math.PI * 6378137 / 180;
        function makeFrame(anchorLng, anchorLat) {
          const mx = M_PER_DEG * Math.cos(anchorLat * Math.PI / 180);
          return {
            toMeters: ([lng, lat]) => [(lng - anchorLng) * mx, (lat - anchorLat) * M_PER_DEG],
            toDegrees: ([x, y]) => [anchorLng + x / mx, anchorLat + y / M_PER_DEG]
          };
        }
        const vec = (a, b) => [b[0] - a[0], b[1] - a[1]];
        const add = (p, d, k = 1) => [p[0] + d[0] * k, p[1] + d[1] * k];
        const len = (d) => Math.hypot(d[0], d[1]);
        const unit = (d) => {
          const l = len(d);
          return [d[0] / l, d[1] / l];
        };
        const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
        function ringArea(ring) {
          let twice = 0;
          for (let i = 0; i < ring.length; i++) {
            const p = ring[i], q = ring[(i + 1) % ring.length];
            twice += p[0] * q[1] - q[0] * p[1];
          }
          return twice / 2;
        }
        function cleanRing(ring, eps) {
          const out = [];
          for (const p of ring) {
            const prev = out[out.length - 1];
            if (prev && len(vec(prev, p)) < eps) continue;
            out.push([p[0], p[1]]);
          }
          while (out.length > 1 && len(vec(out[0], out[out.length - 1])) < eps) out.pop();
          return out;
        }
        function parcelIdOf(parcel) {
          const p = parcel && parcel.properties || {};
          const id = p.parcelId ?? p.parcel_id ?? p.id ?? parcel.id;
          return id === void 0 || id === null || id === "" ? null : String(id);
        }
        function outerRing(feature, turf2) {
          const g = feature && feature.geometry;
          if (!g) return null;
          let best = null, bestArea = -Infinity;
          for (const rings of polygonsOf(g)) {
            const area = areaOf(turf2.polygon([rings[0]]), turf2);
            if (area > bestArea) {
              bestArea = area;
              best = rings[0];
            }
          }
          return best;
        }
        function sliceBuildingByParcels(building, parcels, turf2) {
          const bbox = bboxOf(building, turf2);
          if (!bbox) return [];
          const whole = [{ footprint: asFeature(building.geometry), parcelFeature: null, parcelId: null, unsliced: true }];
          const total = areaOf(building, turf2);
          const slices = [];
          let covered = 0;
          for (const parcel of parcels || []) {
            if (!parcel || !parcel.geometry) continue;
            const parcelBbox = bboxOf(parcel, turf2);
            if (!parcelBbox || !bboxesOverlap(bbox, parcelBbox)) continue;
            let piece = null;
            try {
              piece = turf2.intersect(building, parcel);
            } catch (error) {
              reportClip("intersect", error, "default-floor-plan-context.sliceBuildingByParcels", [building, parcel]);
              piece = null;
            }
            if (!piece || !piece.geometry) continue;
            const area = areaOf(piece, turf2);
            if (area < 1) continue;
            covered += area;
            let centre = [0, 0];
            try {
              centre = turf2.centroid(piece).geometry.coordinates;
            } catch (_) {
            }
            slices.push({ footprint: asFeature(piece.geometry), parcelFeature: parcel, parcelId: parcelIdOf(parcel), centre });
          }
          if (!slices.length || !(total > 0) || covered / total < COVERAGE_MIN) return whole;
          slices.sort((a, b) => a.centre[0] - b.centre[0] || a.centre[1] - b.centre[1]);
          return slices.map(({ centre, ...slice }) => slice);
        }
        function longAxisOf(points) {
          let best = null;
          for (let i = 0; i < points.length; i++) {
            const a = points[i], b = points[(i + 1) % points.length];
            const length = len(vec(a, b));
            if (length < 1e-6) continue;
            const d = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
            let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
            for (const p of points) {
              const u = p[0] * d[0] + p[1] * d[1], v = -p[0] * d[1] + p[1] * d[0];
              u0 = Math.min(u0, u);
              u1 = Math.max(u1, u);
              v0 = Math.min(v0, v);
              v1 = Math.max(v1, v);
            }
            const w = u1 - u0, h = v1 - v0;
            if (!best || w * h < best.area - 1e-9) best = { area: w * h, axis: w >= h ? d : [-d[1], d[0]], aspect: Math.max(w, h) / Math.max(1e-9, Math.min(w, h)) };
          }
          return best;
        }
        function decomposeIntoWings(footprint, turf2) {
          const polygons = polygonsOf(footprint);
          if (polygons.length !== 1) return { wings: [asFeature(footprint.geometry)], dropped: 0 };
          const ringLngLat = polygons[0][0];
          const frame = makeFrame(ringLngLat[0][0], ringLngLat[0][1]);
          let outer = cleanRing(ringLngLat.map(frame.toMeters), 0.02);
          if (outer.length < 4) return { wings: [asFeature(footprint.geometry)], dropped: 0 };
          if (ringArea(outer) < 0) outer = outer.slice().reverse();
          const holes = polygons[0].slice(1).map((ring) => cleanRing(ring.map(frame.toMeters), 0.02)).filter((ring) => ring.length >= 3);
          const area = Math.abs(ringArea(outer)) - holes.reduce((sum, ring) => sum + Math.abs(ringArea(ring)), 0);
          const box = longAxisOf(outer);
          if (!box || !holes.length && area / box.area >= WING_FILL_MAX) return { wings: [asFeature(footprint.geometry)], dropped: 0 };
          const metricPolygon = turf2.polygon([[...outer, outer[0]], ...holes.map((ring) => [...ring, ring[0]])]);
          const reach = 2 * Math.sqrt(box.area);
          const { mainAxis, squareTo } = generatorGeometry();
          const axis = mainAxis(outer);
          const cuts = [], segments = [];
          const nearestHit = (p, d) => {
            const ray = turf2.lineString([add(p, d, 0.05), add(p, d, reach)]);
            let nearest = null;
            const consider = (hits) => {
              for (const hit of hits.features) {
                const distance = len(vec(p, hit.geometry.coordinates));
                if (distance > 0.1 && (!nearest || distance < nearest.distance)) nearest = { distance, point: hit.geometry.coordinates };
              }
            };
            try {
              consider(turf2.lineIntersect(ray, metricPolygon));
              for (const [a, b] of segments) consider(turf2.lineIntersect(ray, turf2.lineString([a, b])));
            } catch (_) {
              return null;
            }
            return nearest;
          };
          const candidates = [];
          const corners = (ring, minEdgeM, reflexOnly) => {
            for (let i = 0; i < ring.length; i++) {
              const prev = ring[(i + ring.length - 1) % ring.length], p = ring[i], next = ring[(i + 1) % ring.length];
              if (len(vec(prev, p)) < minEdgeM || len(vec(p, next)) < minEdgeM) continue;
              const d1 = unit(vec(prev, p)), d2 = unit(vec(p, next));
              if (reflexOnly && cross(d1, d2) >= -1e-9) continue;
              const options = [d1, [-d2[0], -d2[1]]].map((extension) => squareTo(axis, extension)).filter((d) => turf2.booleanPointInPolygon(add(p, d, 0.05), metricPolygon));
              if (options.length) candidates.push({ p, options });
            }
          };
          corners(outer, WING_CORNER_MIN_EDGE_M, true);
          holes.forEach((ring) => corners(ring, 2, false));
          const along = (ring, d) => {
            const t = ring.map((q) => q[0] * d[0] + q[1] * d[1]);
            return Math.max(...t) - Math.min(...t);
          };
          const wingLike = (rings) => Math.abs(ringArea(rings[0])) >= WING_MIN_M2 && Math.min(along(rings[0], axis), along(rings[0], [-axis[1], axis[0]])) >= WING_MIN_DEPTH_M;
          let remainder = metricPolygon;
          const sized = candidates.map((c) => ({ ...c, length: Math.min(...c.options.map((d) => (nearestHit(c.p, d) || { distance: Infinity }).distance)) })).sort((a, b) => a.length - b.length);
          for (const { p, options } of sized) {
            const tries = options.map((d) => ({ d, hit: nearestHit(p, d) })).filter((o) => o.hit).sort((a, b) => a.hit.distance - b.hit.distance);
            for (const { d, hit } of tries) {
              const q = hit.point, n = [-d[1], d[0]];
              const a = add(p, d, -0.05), b = add(q, d, 0.05);
              const cut = turf2.polygon([[add(a, n, 0.02), add(b, n, 0.02), add(b, n, -0.02), add(a, n, -0.02), add(a, n, 0.02)]]);
              let next = null;
              try {
                next = turf2.difference(remainder, cut);
              } catch (error) {
                reportClip("difference", error, "default-floor-plan-context.decomposeIntoWings", [remainder, cut]);
                break;
              }
              if (!next || !next.geometry || !polygonsOf(next).every(wingLike)) continue;
              remainder = next;
              segments.push([p, q]);
              cuts.push(cut);
              break;
            }
          }
          if (!cuts.length) return { wings: [asFeature(footprint.geometry)], dropped: 0 };
          const pieces = polygonsOf(remainder).map((rings) => turf2.polygon(rings));
          const wings = [], sizes = pieces.map((piece) => Math.abs(ringArea(piece.geometry.coordinates[0])));
          let dropped = 0;
          pieces.forEach((piece, index) => {
            if (sizes[index] < WING_MIN_M2) {
              dropped++;
              return;
            }
            wings.push(asFeature({ type: "Polygon", coordinates: piece.geometry.coordinates.map((ring) => ring.map(frame.toDegrees)) }));
          });
          return wings.length ? { wings, dropped } : { wings: [asFeature(footprint.geometry)], dropped: 0 };
        }
        function outlineFront(unit2, turf2) {
          const block = polygonsOf(unit2.footprint === unit2.sliceFootprint ? null : unit2.sliceFootprint)[0];
          if (unit2.wing === null || !block || block.length < 2) return null;
          const outline = turf2.lineString(block[0]);
          const ring = polygonsOf(unit2.footprint)[0][0];
          let best = null;
          for (let i = 0; i + 1 < ring.length; i++) {
            const a = ring[i], b = ring[i + 1], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            const length = turf2.distance(a, b, { units: "meters" });
            if (turf2.pointToLineDistance(mid, outline, { units: "meters" }) < 0.05 && (!best || length > best.length)) best = { a, b, length };
          }
          return best ? { a: best.a, b: best.b, basis: "longest" } : null;
        }
        function storeysOf(featureOrProps, heightM, fallbackStoreyM) {
          const p = featureOrProps && featureOrProps.properties ? featureOrProps.properties : featureOrProps || {};
          const declared = [p.storeys, p.floors, p.levels, p.stories, p["building:levels"]].map(Number).find((n) => Number.isFinite(n) && n > 0);
          const ruleStorey = Number(p.urbanRule && p.urbanRule.floorHeightM);
          const unitM = Number.isFinite(ruleStorey) && ruleStorey > 0 ? ruleStorey : Number.isFinite(fallbackStoreyM) && fallbackStoreyM > 0 ? fallbackStoreyM : 3.3;
          const height = Number.isFinite(heightM) && heightM > 0 ? heightM : null;
          const floors = declared ? Math.max(1, Math.round(declared)) : height ? Math.max(1, Math.round(height / unitM)) : null;
          if (!floors) return { floors: null, storeyHeightM: unitM };
          return { floors, storeyHeightM: height ? height / floors : unitM };
        }
        function roadRunsOf(feature, frame) {
          const g = feature && feature.type === "Feature" ? feature.geometry : feature;
          if (!g) return [];
          const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
          return lines.filter(Array.isArray).map((line) => line.map((p) => frame.toMeters(p)));
        }
        function nearestRoadPoint(point, roads, frame) {
          let nearest = null;
          for (const road of roads) {
            for (const run of roadRunsOf(road, frame)) {
              for (let i = 0; i < run.length - 1; i++) {
                const p = run[i], q = run[i + 1], dx = q[0] - p[0], dy = q[1] - p[1], len2 = dx * dx + dy * dy;
                if (!(len2 > 0)) continue;
                const k = Math.max(0, Math.min(1, ((point[0] - p[0]) * dx + (point[1] - p[1]) * dy) / len2));
                const c = [p[0] + k * dx, p[1] + k * dy];
                const distance = Math.hypot(c[0] - point[0], c[1] - point[1]);
                if (!nearest || distance < nearest.distance) nearest = { distance, point: c, road };
              }
            }
          }
          return nearest;
        }
        function edgesOf(ring, frame, neighbours, turf2) {
          const points = ring.slice(0, -1).map(frame.toMeters);
          const signedArea = ringArea(points);
          const outwardSign = signedArea >= 0 ? 1 : -1;
          return points.map((a, i) => {
            const b = points[(i + 1) % points.length];
            const lengthM = len(vec(a, b));
            if (lengthM < 0.5) return null;
            const d = unit(vec(a, b));
            const outward = [d[1] * outwardSign, -d[0] * outwardSign];
            const mid = add(a, vec(a, b), 0.5);
            const probe = turf2.point(frame.toDegrees(add(mid, outward, 0.35)));
            const party = (neighbours || []).some((neighbour) => {
              try {
                return turf2.booleanPointInPolygon(probe, neighbour);
              } catch (_) {
                return false;
              }
            });
            return { index: i, a: ring[i].slice(0, 2), b: ring[i + 1].slice(0, 2), aM: a, bM: b, d, outward, mid, lengthM, party };
          }).filter(Boolean);
        }
        function resolveFront(slice, roads, deps) {
          const turf2 = deps && deps.turf, neighbours = deps && deps.neighbours || [];
          if (!turf2) return null;
          const ring = outerRing(slice, turf2);
          if (!ring || ring.length < 4) return null;
          const frame = makeFrame(ring[0][0], ring[0][1]);
          const edges = edgesOf(ring, frame, neighbours, turf2);
          const exterior = edges.filter((edge) => !edge.party && edge.lengthM >= 2);
          if (!exterior.length) return null;
          const box = longAxisOf(edges.map((edge) => edge.aM));
          const alongAxis = box && box.aspect >= 1.15 ? exterior.filter((edge) => Math.abs(edge.d[0] * box.axis[0] + edge.d[1] * box.axis[1]) >= Math.cos(30 * Math.PI / 180)) : [];
          const candidates = alongAxis.length ? alongAxis : exterior;
          const longest = candidates.reduce((best2, edge) => edge.lengthM > best2.lengthM ? edge : best2, candidates[0]);
          const fallback = { a: longest.a, b: longest.b, basis: "longest", street: null, distanceM: null };
          const roadList = Array.isArray(roads) ? roads.filter(Boolean) : [];
          if (!roadList.length) return fallback;
          let best = null;
          for (const edge of candidates) {
            const nearest = nearestRoadPoint(edge.mid, roadList, frame);
            if (!nearest) continue;
            const facing = (nearest.point[0] - edge.mid[0]) * edge.outward[0] + (nearest.point[1] - edge.mid[1]) * edge.outward[1] > 0;
            const score = (facing ? nearest.distance : 1e4 + nearest.distance) - edge.lengthM * 1e-3;
            if (!best || score < best.score) best = { edge, score, nearest, facing };
          }
          if (!best || !best.facing) return fallback;
          const props = best.nearest.road && best.nearest.road.properties || {};
          return {
            a: best.edge.a,
            b: best.edge.b,
            basis: "street",
            distanceM: Math.round(best.nearest.distance * 10) / 10,
            street: { name: props.name || props.street_name || props.title || null, highway: props.highway_type || props.highway || null, id: props.osm_id ?? props.street_id ?? props.proposalId ?? null }
          };
        }
        function blindEdgesFor(slice, parcel, roads, front, deps) {
          const turf2 = deps && deps.turf, setbackM = deps && deps.setbackM || 3;
          if (!turf2 || !parcel || !parcel.geometry) return [];
          const ring = outerRing(slice, turf2);
          if (!ring || ring.length < 4) return [];
          const frame = makeFrame(ring[0][0], ring[0][1]);
          const frontMid = front ? add(frame.toMeters(front.a), vec(frame.toMeters(front.a), frame.toMeters(front.b)), 0.5) : null;
          const roadList = Array.isArray(roads) ? roads.filter(Boolean) : [];
          return edgesOf(ring, frame, [], turf2).filter((edge) => {
            if (frontMid && len(vec(edge.mid, frontMid)) < 0.5) return false;
            const outside = add(edge.mid, edge.outward, setbackM);
            let insideParcel = false;
            try {
              insideParcel = turf2.booleanPointInPolygon(turf2.point(frame.toDegrees(outside)), parcel);
            } catch (_) {
              insideParcel = true;
            }
            if (insideParcel) return false;
            const nearRoad = nearestRoadPoint(add(edge.mid, edge.outward, 1), roadList, frame);
            if (nearRoad && nearRoad.distance <= setbackM) return false;
            for (const road of roadList) {
              if (polygonsOf(road).length) {
                try {
                  if (turf2.booleanPointInPolygon(turf2.point(frame.toDegrees(outside)), road)) return false;
                } catch (_) {
                }
              }
            }
            return true;
          }).map((edge) => ({ a: edge.a, b: edge.b }));
        }
        const sameBuilding = (a, b) => {
          const pa = a && a.properties || {}, pb = b && b.properties || {};
          if (pa.proposalId === void 0 || pa.proposalId === null || String(pa.proposalId) !== String(pb.proposalId)) return false;
          if (pa.buildingId && pa.buildingId === pb.buildingId) return true;
          return pa.buildingIndex !== void 0 && pa.buildingIndex === pb.buildingIndex;
        };
        function neighbourPool(owner, proposed, existing, turf2) {
          const bbox = bboxOf(owner, turf2);
          if (!bbox) return [];
          const out = [];
          for (const feature of Array.isArray(proposed) ? proposed : []) {
            if (!feature || feature === owner || !feature.geometry || sameBuilding(feature, owner)) continue;
            const b = bboxOf(feature, turf2);
            if (b && bboxesOverlap(bbox, b, NEIGHBOUR_PAD_DEG)) out.push(feature);
          }
          for (const feature of Array.isArray(existing) ? existing : []) {
            if (!feature || feature === owner || !feature.geometry) continue;
            const b = bboxOf(feature, turf2);
            if (!b || !bboxesOverlap(bbox, b, NEIGHBOUR_PAD_DEG)) continue;
            let overlap = null;
            try {
              overlap = turf2.intersect(owner, feature);
            } catch (error) {
              reportClip("intersect", error, "default-floor-plan-context.neighbourPool", [owner, feature]);
              overlap = null;
            }
            if (overlap && areaOf(overlap, turf2) > 1) continue;
            out.push(feature);
          }
          return out;
        }
        function streetCellKey(feature, turf2) {
          const b = bboxOf(feature, turf2);
          if (!b) return null;
          return `${Math.floor((b[0] + b[2]) / 2 / STREET_CELL_DEG)}:${Math.floor((b[1] + b[3]) / 2 / STREET_CELL_DEG)}`;
        }
        function streetCellBbox(key) {
          const [i, j] = String(key).split(":").map(Number);
          const r = (value) => Math.round(value * 1e6) / 1e6;
          return [
            r(i * STREET_CELL_DEG - STREET_CELL_MARGIN_DEG),
            r(j * STREET_CELL_DEG - STREET_CELL_MARGIN_DEG),
            r((i + 1) * STREET_CELL_DEG + STREET_CELL_MARGIN_DEG),
            r((j + 1) * STREET_CELL_DEG + STREET_CELL_MARGIN_DEG)
          ];
        }
        function regionOf(cityConfig) {
          const locale = cityConfig && cityConfig.currency && cityConfig.currency.locale;
          const match = typeof locale === "string" && locale.match(/[-_]([A-Za-z]{2})$/);
          return match ? match[1].toUpperCase() : null;
        }
        function eraRulesFor(featureOrProps, storeyHeightM, floors) {
          const p = featureOrProps && featureOrProps.properties ? featureOrProps.properties : featureOrProps || {};
          const year = [p.year, p.yearBuilt, p.year_built, p.start_date, p.built, p.construction_year].map((value) => parseInt(String(value || "").slice(0, 4), 10)).find((n) => Number.isFinite(n) && n > 1500);
          const era = year ? year < 1945 ? "prewar" : year < 1990 ? "postwar" : "contemporary" : storeyHeightM >= 3.4 ? "prewar" : storeyHeightM <= 3.05 && floors >= 4 ? "postwar" : "contemporary";
          const byEra = {
            prewar: { era, liftPolicy: "never", maxApartmentM2: 160, balconies: false, garage: "never", groundFloorUse: floors >= 3 ? "commercial" : "residential" },
            postwar: { era, liftFromFloors: 6, garage: "never", groundFloorUse: "residential" },
            contemporary: { era }
          };
          return byEra[era];
        }
        function steppedBuilding(parts, turf2, storeyFallbackM) {
          const plates = parts.map(({ feature, heightM }) => ({ feature, ...storeysOf(feature, heightM, storeyFallbackM) })).filter((plate) => plate.floors && polygonsOf(plate.feature.geometry).length);
          if (plates.length < 2) return null;
          const tallest = plates.reduce((top, plate) => plate.floors > top.floors ? plate : top, plates[0]);
          let footprint = asFeature(plates[0].feature.geometry);
          for (const plate of plates.slice(1)) {
            try {
              footprint = turf2.union(footprint, asFeature(plate.feature.geometry)) || footprint;
            } catch (error) {
              reportClip("union", error, "default-floor-plan-context.steppedBuilding", [footprint, plate.feature]);
            }
          }
          try {
            const closed = turf2.buffer(turf2.buffer(footprint, 0.05, { units: "meters" }), -0.05, { units: "meters" });
            if (closed && polygonsOf(closed.geometry).length) footprint = closed;
          } catch (error) {
            reportClip("buffer", error, "default-floor-plan-context.steppedBuilding.close", [footprint]);
          }
          const byHeight = plates.slice().sort((a, b) => a.floors - b.floors);
          const storeyUses = Array.from({ length: tallest.floors }, (_, level) => {
            const part = byHeight.find((plate) => plate.floors > level);
            const uses = buildingUse().storeyUsesOf(part.feature.properties, part.floors);
            return uses[level] || "residential";
          });
          return {
            footprint: asFeature(footprint.geometry),
            floors: tallest.floors,
            storeyHeightM: tallest.storeyHeightM,
            plates: plates.map((plate) => ({ footprint: asFeature(plate.feature.geometry), floors: plate.floors })),
            storeyUses
          };
        }
        function planBuilding(subject, context) {
          const { turf: turf2, generator, parcels, neighbours, roads, heightM, storeyFallbackM, cache, owner } = context;
          if (!turf2 || !generator) throw new Error("default-floor-plan-context: turf and the generator are required");
          const ownerProps = (owner || subject).properties || {};
          const stepped = Array.isArray(context.parts) && context.parts.length > 1 ? steppedBuilding(context.parts, turf2, storeyFallbackM) : null;
          const whole = { footprint: stepped ? stepped.footprint : asFeature(subject.geometry), parcelFeature: null, parcelId: null, unsliced: true };
          const slices = context.existing || stepped || !ownerProps.urbanRule ? [whole] : sliceBuildingByParcels(subject, parcels, turf2);
          const { floors, storeyHeightM } = stepped || storeysOf(subject, heightM, storeyFallbackM);
          const storeyUses = stepped ? stepped.storeyUses : floors ? buildingUse().storeyUsesOf(ownerProps, floors) : [];
          const baseId = context.existing ? `existing/${ownerProps.object_id ?? ownerProps.id ?? ownerProps.osm_id ?? geometryHash(subject)}` : `${ownerProps.proposalId ?? "local"}/${ownerProps.buildingIndex ?? 0}`;
          const typology = ownerProps.urbanRule && ownerProps.urbanRule.typology ? String(ownerProps.urbanRule.typology) : ownerProps.typology || void 0;
          const around = Array.isArray(neighbours) ? neighbours : [];
          const aroundHash = hashText(around.map(geometryHash).join(","));
          const access = buildingUse().layoutAccess(context.accessOverride, ownerProps);
          const rules = {
            ...context.region ? { region: context.region } : {},
            ...context.existing && floors ? eraRulesFor(subject, storeyHeightM, floors) : {},
            ...context.rules || {},
            ...access.access !== "auto" ? { access: access.access, accessBasis: access.basis } : {}
          };
          const rulesHash = hashText(JSON.stringify(rules));
          const units = [];
          let droppedWings = 0;
          slices.forEach((slice, index) => {
            const { wings, dropped } = stepped ? { wings: [slice.footprint], dropped: 0 } : decomposeIntoWings(slice.footprint, turf2);
            droppedWings += dropped;
            wings.forEach((wing, wingIndex) => units.push({ ...slice, footprint: wing, sliceFootprint: slice.footprint, sliceIndex: index, wing: wings.length > 1 ? wingIndex : null }));
          });
          const footprints = units.map((unit2) => unit2.footprint);
          const results = units.map((unit2, index) => {
            const siblings = footprints.filter((_, i) => i !== index);
            const nearby = [...siblings, ...around];
            const front = context.front && Array.isArray(context.front.a) && Array.isArray(context.front.b) ? { basis: "known", ...context.front } : roads ? resolveFront(unit2.footprint, roads, { turf: turf2, neighbours: nearby }) : outlineFront(unit2, turf2);
            const setbackM = rules.blindFacadeSetbackM || generator.DEFAULT_RULES && generator.DEFAULT_RULES.blindFacadeSetbackM || 3;
            const blindEdges = blindEdgesFor(unit2.footprint, unit2.parcelFeature, roads, front, { turf: turf2, setbackM });
            const key = [
              baseId,
              unit2.sliceIndex,
              unit2.wing ?? "-",
              geometryHash(unit2.footprint),
              floors,
              Math.round(storeyHeightM * 1e3),
              front ? `${front.basis}:${front.a.join(",")}:${front.b.join(",")}` : "nofront",
              blindEdges.length,
              aroundHash,
              rulesHash,
              typology || "",
              storeyUses.join(","),
              stepped ? hashText(stepped.plates.map((plate) => `${plate.floors}:${geometryHash(plate.footprint)}`).join(";")) : "-",
              context.emitRooms ? "rooms" : ""
            ].join("|");
            let result = cache ? cache.get(key) : null;
            if (result && cache) {
              cache.delete(key);
              cache.set(key, result);
            }
            if (!result) {
              result = generator.planDefaultFloorPlans({
                footprint: unit2.footprint,
                floors,
                storeyHeightM,
                neighbours: nearby,
                front,
                blindEdges,
                typology,
                storeyUses,
                ...stepped ? { plates: stepped.plates } : {},
                buildingId: `${baseId}/${unit2.sliceIndex}${unit2.wing !== null && unit2.wing !== void 0 ? `/w${unit2.wing}` : ""}`
              }, { turf: turf2, rules, ...context.emitRooms ? { emitRooms: true } : {} });
              if (cache) cacheResult(cache, key, result);
            }
            return { ...unit2, key, result };
          });
          return { floors, storeyHeightM, slices: results, droppedWings };
        }
        function createStreetLoader({ read, onIdle = () => {
        }, onError = () => {
        }, maxConcurrent = 2, maxEntries = 64 }) {
          const entries = /* @__PURE__ */ new Map(), active = /* @__PURE__ */ new Map(), queue = [], waiters = [];
          function idle() {
            if (!active.size && !queue.length) {
              waiters.splice(0).forEach((resolve) => resolve());
              onIdle();
            }
          }
          function pump() {
            while (active.size < maxConcurrent && queue.length) {
              const [key, entry] = queue.shift(), controller = new AbortController();
              active.set(key, controller);
              Promise.resolve().then(() => read(key, controller.signal)).then((features) => {
                if (entries.get(key) === entry && !controller.signal.aborted) {
                  entry.features = features;
                  entry.pending = false;
                }
              }).catch((error) => {
                if (entries.get(key) !== entry || controller.signal.aborted) return;
                entry.features = [];
                entry.pending = false;
                onError(error, key);
              }).finally(() => {
                if (active.get(key) !== controller) return;
                active.delete(key);
                pump();
                idle();
              });
            }
          }
          function get(key) {
            const existing = entries.get(key);
            if (existing) {
              entries.delete(key);
              entries.set(key, existing);
              return existing.features;
            }
            if (entries.size >= maxEntries) {
              const oldest = [...entries].find(([, entry2]) => !entry2.pending)?.[0];
              if (oldest === void 0) return null;
              entries.delete(oldest);
            }
            const entry = { features: null, pending: true };
            entries.set(key, entry);
            queue.push([key, entry]);
            pump();
            return null;
          }
          function cancel(clear = false) {
            active.forEach((controller) => controller.abort());
            active.clear();
            queue.length = 0;
            for (const [key, entry] of entries) if (clear || entry.pending) entries.delete(key);
            waiters.splice(0).forEach((resolve) => resolve());
          }
          return {
            get,
            cancel,
            get pending() {
              return active.size + queue.length;
            },
            get size() {
              return entries.size;
            },
            whenIdle: () => !active.size && !queue.length ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve))
          };
        }
        const api = {
          STREET_CELL_DEG,
          hashText,
          sliceBuildingByParcels,
          decomposeIntoWings,
          storeysOf,
          steppedBuilding,
          resolveFront,
          blindEdgesFor,
          neighbourPool,
          streetCellKey,
          streetCellBbox,
          regionOf,
          eraRulesFor,
          planBuilding,
          createStreetLoader
        };
        global.__defaultFloorPlanContext = api;
        if (typeof module !== "undefined" && module.exports) module.exports = api;
      })(typeof window !== "undefined" ? window : globalThis);
    }
  });

  // src/planner/default-floor-plan-worker-client.js
  var require_default_floor_plan_worker_client = __commonJS({
    "src/planner/default-floor-plan-worker-client.js"(exports, module) {
      (function(global) {
        "use strict";
        function create({ spawn, timeoutMs = 1e4, setTimer = setTimeout, clearTimer = clearTimeout }) {
          let worker = null, pending = null, sequence = 0;
          function stop(error) {
            worker?.terminate();
            worker = null;
            if (pending) {
              const request = pending;
              pending = null;
              clearTimer(request.timer);
              request.reject(error);
            }
          }
          function dispose() {
            stop(Object.assign(new Error("Layout calculation cancelled."), { name: "AbortError" }));
          }
          function plan(feature, context) {
            if (pending) return Promise.reject(new Error("A layout calculation is already in progress."));
            return new Promise((resolve, reject) => {
              if (!worker) {
                try {
                  worker = spawn();
                } catch (error) {
                  reject(error);
                  return;
                }
                const active = worker;
                worker.onmessage = ({ data }) => {
                  if (!pending || data?.id !== pending.id) return;
                  const request = pending;
                  pending = null;
                  clearTimer(request.timer);
                  if (data.error) request.reject(Object.assign(new Error(data.error.message), { name: data.error.name || "Error" }));
                  else request.resolve(data.result);
                };
                worker.onerror = (event) => {
                  if (worker !== active) return;
                  event.preventDefault?.();
                  stop(new Error(event.message || "Layout worker failed."));
                };
              }
              const id = ++sequence;
              pending = { id, resolve, reject, timer: setTimer(() => stop(new Error("Layout calculation exceeded its time limit.")), timeoutMs) };
              const { turf: turf2, generator, cache, ...input } = context;
              try {
                worker.postMessage({ id, feature, context: input });
              } catch (error) {
                stop(error);
              }
            });
          }
          return { plan, dispose, get pending() {
            return !!pending;
          } };
        }
        const api = { create };
        global.__defaultFloorPlanWorker = api;
        if (typeof module !== "undefined" && module.exports) module.exports = api;
      })(typeof window !== "undefined" ? window : globalThis);
    }
  });

  // interior-version:package-version
  var require_package_version = __commonJS({
    "interior-version:package-version"(exports, module) {
      module.exports = { version: "1.13.0" };
    }
  });

  // src/planner.cjs
  var require_planner = __commonJS({
    "src/planner.cjs"(exports, module) {
      var geometry = require_geometry();
      var root = typeof window !== "undefined" ? window : globalThis;
      if (!root.__buildingFloorPlans) root.__buildingFloorPlans = geometry;
      var buildingUse = require_building_use();
      var rooms = require_default_floor_plan_rooms();
      var generator = require_default_floor_plans();
      var core = require_default_floor_plan_core();
      var context = require_default_floor_plan_context();
      var workerClient = require_default_floor_plan_worker_client();
      var clipReport = require_clip_report();
      module.exports = { version: require_package_version().version, generator, rooms, core, context, buildingUse, workerClient, clipReport };
    }
  });
  return require_planner();
})();
if (typeof module === "object" && module.exports) module.exports = InteriorPlanner;
