// Authoritative in-memory parcel fabric. Cadastral facts stay immutable; authored materialization
// exists only in a private mutation draft and is published as one revision.
(function attachLiveParcelFabric(root, factory) {
    const api = factory(root || globalThis);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.createLiveParcelFabric = api.createLiveParcelFabric;
        root.LiveParcelFabric = api.createLiveParcelFabric();
    }
})(typeof window !== 'undefined' ? window : globalThis, function liveParcelFabricFactory(root) {
    'use strict';

    const GEOMETRY_EPSILON_M2 = 0.01;
    // Area accounting compares the sum of a parcel's pieces with the parcel itself. The arrangement
    // drops pieces under parcel-arrangement.js MIN_PIECE_M2 (0.25 m²) as clipper artifacts, so a
    // parcel may legitimately come back a few slivers short; one square metre is that budget, two
    // orders of magnitude under any hole a user could see and four under the incident that
    // motivated the invariant. One part per million covers planar-versus-geodesic rounding.
    const COVERAGE_TOLERANCE_M2 = 1;
    const RELATIVE_AREA_TOLERANCE = 1e-6;
    // A replacement vertex this close to its parcel's boundary is on the boundary.
    const VERTEX_TOLERANCE_M = 0.02;
    const CADASTRE_RELEASE_KINDS = new Set([
        'cadastral-ground-release',
        'repository-reset',
        'repository-unload'
    ]);
    const RETIRED_PROVENANCE_FIELDS = Object.freeze([
        'baseParcelIds', 'parentParcelId', 'parentParcelIds', 'ancestorProposal', 'proposalId'
    ]);
    // Step functions (generators) below are driven to completion synchronously by the one-shot
    // mutation methods, and in clock-checked slices by the boot replay (mutation.*Steps).
    const workSlicer = (root && root.__workSlicer)
        || (typeof require === 'function' ? require('../work-slicer.js') : null);
    // One collator for every delta sort: localeCompare with options builds a collator per call,
    // which made sorting a whole-cadastre delta (~6,000 ids) a 185 ms task.
    const ID_COLLATOR = new Intl.Collator(undefined, { numeric: true });

    function clone(value) {
        if (value === undefined || value === null) return value;
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch (_) { /* JSON fallback */ }
        }
        return JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value, seen = new WeakSet()) {
        if (!value || typeof value !== 'object' || seen.has(value)) return value;
        seen.add(value);
        Object.getOwnPropertyNames(value).forEach(key => deepFreeze(value[key], seen));
        return Object.freeze(value);
    }

    function normalizeId(value) {
        return value === undefined || value === null ? '' : String(value).trim();
    }

    function featureId(feature) {
        const props = feature && feature.properties;
        return normalizeId(props && (props.parcelId ?? props.parcel_id ?? props.PARCEL_ID ?? props.id));
    }

    function explicitCadastreIds(feature) {
        const raw = Array.isArray(feature?.properties?.cadastreParcelIds)
            ? feature.properties.cadastreParcelIds
            : [];
        return Array.from(new Set(raw.map(normalizeId).filter(Boolean)));
    }

    // Open-ground provenance (PARCEL-OPTIONAL.md phase 3): a piece minted on ground no cadastral
    // parcel covers names the proposal site's `ground:<siteHash>` here instead of (or beside) its
    // cadastral anchors. It is never a cadastral id and is never indexed as one.
    function explicitGroundIds(feature) {
        const raw = Array.isArray(feature?.properties?.groundIds)
            ? feature.properties.groundIds
            : [];
        return Array.from(new Set(raw.map(normalizeId).filter(id => id.startsWith('ground:') && id.length > 7)));
    }

    function producerId(feature) {
        return normalizeId(feature?.properties?.producedByProposalId);
    }

    function formedByIds(feature) {
        const raw = Array.isArray(feature?.properties?.formedByProposalIds)
            ? feature.properties.formedByProposalIds
            : [];
        return Array.from(new Set(raw.map(normalizeId).filter(Boolean)));
    }

    function assertNoRetiredProvenance(properties, parcelId) {
        const retired = RETIRED_PROVENANCE_FIELDS.find(field => (
            Object.prototype.hasOwnProperty.call(properties || {}, field)
        ));
        if (!retired) return;
        const error = new TypeError(`Live parcel ${parcelId} uses retired provenance field ${retired}.`);
        error.code = 'live-parcel-retired-provenance';
        error.parcelId = parcelId;
        error.field = retired;
        throw error;
    }

    function bboxOf(feature) {
        const coordinates = feature?.geometry?.coordinates;
        if (!Array.isArray(coordinates)) return null;
        let west = Infinity;
        let south = Infinity;
        let east = -Infinity;
        let north = -Infinity;
        const visit = value => {
            if (!Array.isArray(value)) return;
            if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
                const x = Number(value[0]);
                const y = Number(value[1]);
                west = Math.min(west, x);
                south = Math.min(south, y);
                east = Math.max(east, x);
                north = Math.max(north, y);
                return;
            }
            value.forEach(visit);
        };
        visit(coordinates);
        return Number.isFinite(west) ? Object.freeze([west, south, east, north]) : null;
    }

    function boundsArray(bounds) {
        if (Array.isArray(bounds) && bounds.length >= 4) return bounds.map(Number);
        if (!bounds || typeof bounds.getSouthWest !== 'function' || typeof bounds.getNorthEast !== 'function') return null;
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        return [Number(sw.lng), Number(sw.lat), Number(ne.lng), Number(ne.lat)];
    }

    function intersects(left, right) {
        return !!left && !!right
            && left[0] <= right[2] && left[2] >= right[0]
            && left[1] <= right[3] && left[3] >= right[1];
    }

    function isCorridor(feature) {
        const props = feature?.properties || {};
        return props.isCorridor === true || props.isRoad === true || props.isTrack === true;
    }

    function resolveGeometryApi(options) {
        if (options.geometry) return options.geometry;
        if (root?.turf) return root.turf;
        if (typeof require === 'function') {
            try { return require('@turf/turf'); } catch (_) {
                // Unit tests load this browser module from the repository root while Turf belongs
                // to the backend package. Production always takes the root.turf branch above.
                try { return require('../../../backend/node_modules/@turf/turf'); }
                catch (_) { /* caller receives explicit error */ }
            }
        }
        return null;
    }

    function createLiveParcelFabric(options = {}) {
        const geometry = resolveGeometryApi(options);
        const trusted = new WeakSet();
        const subscribers = new Set();
        const participants = new Set();
        const metrics = { normalized: 0, indexUpdates: 0, coverageChecks: 0, worstCoverageDeltaM2: 0, identityReplacements: 0 };
        let active = null;
        let committed = {
            revision: 0,
            byId: new Map(),
            bboxById: new Map(),
            byCadastreId: new Map(),
            byProducerId: new Map(),
            cadastreFacts: new Map()
        };

        function normalizeFeature(input, config = {}) {
            if (trusted.has(input)) return input;
            if (!input || input.type !== 'Feature' || !input.geometry || !/Polygon$/.test(String(input.geometry.type || ''))) {
                const error = new TypeError('Live parcel fabric accepts polygon GeoJSON Features only.');
                error.code = 'invalid-live-parcel-feature';
                throw error;
            }
            const feature = clone(input);
            const sourceId = featureId(feature);
            if (!sourceId) {
                const error = new TypeError(config.cadastreSeed
                    ? 'Cadastral seed has no parcelId.'
                    : 'Live parcel feature has no parcelId.');
                error.code = config.cadastreSeed ? 'cadastral-seed-id-missing' : 'live-parcel-id-missing';
                throw error;
            }
            if (feature.geometry.type === 'MultiPolygon') {
                const components = Array.isArray(feature.geometry.coordinates)
                    ? feature.geometry.coordinates.filter(Array.isArray)
                    : [];
                if (components.length !== 1) {
                    const error = new TypeError('One live parcel must be one connected polygon.');
                    error.code = 'live-parcel-disconnected';
                    error.parcelId = sourceId;
                    error.components = components.length;
                    throw error;
                }
                feature.geometry = { type: 'Polygon', coordinates: components[0] };
            }
            const props = feature.properties || (feature.properties = {});
            assertNoRetiredProvenance(props, sourceId);
            const cadastreIds = config.cadastreSeed ? [normalizeId(config.cadastreId || sourceId)] : explicitCadastreIds(feature);
            const groundIds = config.cadastreSeed ? [] : explicitGroundIds(feature);
            // A piece on open ground only is legitimate when a proposal produced it; the producer
            // stamp is then its whole ownership boundary (removal is by producer, never by scope).
            if (!cadastreIds.length && !(groundIds.length && producerId(feature))) {
                const error = new TypeError(`Generated live parcel ${sourceId} has no explicit cadastral provenance.`);
                error.code = 'live-parcel-provenance-missing';
                error.parcelId = sourceId;
                throw error;
            }
            props.parcelId = sourceId;
            props.id = sourceId;
            props.cadastreParcelIds = cadastreIds;
            if (groundIds.length) props.groundIds = groundIds;
            else delete props.groundIds;
            if (formedByIds(feature).length) props.formedByProposalIds = formedByIds(feature);
            else delete props.formedByProposalIds;
            metrics.normalized += 1;
            deepFreeze(feature);
            trusted.add(feature);
            return feature;
        }

        function connectedFeatures(input, config = {}) {
            const geometryValue = input?.geometry;
            const components = geometryValue?.type === 'MultiPolygon' && Array.isArray(geometryValue.coordinates)
                ? geometryValue.coordinates.filter(Array.isArray)
                : null;
            if (!components) return [normalizeFeature(input, config)];
            // A replacement that IS an original cadastral parcel (an untouched parcel handed back
            // whole by the corridor arrangement) splits exactly like a seed. Refusing it as a
            // disconnected generated piece rejected a 2,071-parcel ground arrival because one
            // cadastral parcel in it had two parts (HR-329924-1177/2).
            const wholeCadastralParcel = !config.cadastreSeed && (() => {
                const id = featureId(input);
                const provenance = explicitCadastreIds(input);
                return !!id && !producerId(input) && (provenance.length === 0 || (provenance.length === 1 && provenance[0] === id));
            })();
            if (!config.cadastreSeed && !wholeCadastralParcel) return [normalizeFeature(input, config)];

            const cadastralId = featureId(input);
            if (!cadastralId) return [normalizeFeature(input, config)];
            const ordered = components.map(coordinates => ({
                coordinates,
                box: bboxOf({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } })
            })).sort((left, right) => {
                for (let index = 0; index < 4; index += 1) {
                    const delta = Number(left.box?.[index]) - Number(right.box?.[index]);
                    if (Number.isFinite(delta) && delta !== 0) return delta;
                }
                return JSON.stringify(left.coordinates).localeCompare(JSON.stringify(right.coordinates));
            });
            return ordered.map((component, index) => normalizeFeature({
                ...input,
                properties: {
                    ...(input.properties || {}),
                    parcelId: components.length > 1 ? `${cadastralId}#cadastre-${index + 1}` : cadastralId,
                    id: components.length > 1 ? `${cadastralId}#cadastre-${index + 1}` : cadastralId,
                    ...(components.length > 1 ? {
                        cadastralPart: true,
                        cadastralPartIndex: index + 1
                    } : {})
                },
                geometry: { type: 'Polygon', coordinates: component.coordinates }
            }, { cadastreSeed: true, cadastreId: cadastralId }));
        }

        function normalizeCadastreFact(input) {
            if (!input || input.type !== 'Feature' || !input.geometry || !/Polygon$/.test(String(input.geometry.type || ''))) {
                const error = new TypeError('Cadastral repository supplied an invalid polygon feature.');
                error.code = 'invalid-cadastral-feature';
                throw error;
            }
            const id = featureId(input);
            if (!id) {
                const error = new Error('Repository seed has no cadastral parcel id.');
                error.code = 'cadastral-seed-id-missing';
                throw error;
            }
            const fact = clone(input);
            const props = fact.properties || (fact.properties = {});
            assertNoRetiredProvenance(props, id);
            props.parcelId = id;
            props.id = id;
            props.cadastreParcelIds = [id];
            metrics.normalized += 1;
            deepFreeze(fact);
            trusted.add(fact);
            return fact;
        }

        function assertActive(draft) {
            if (!active || active !== draft || draft.state !== 'active') {
                const error = new Error('Live parcel fabric mutation is no longer active.');
                error.code = 'live-fabric-mutation-inactive';
                throw error;
            }
        }

        function mutableIndexSet(draft, indexName, key) {
            const index = draft.data[indexName];
            let values = index.get(key);
            if (!values) {
                values = new Set();
                index.set(key, values);
            } else if (values === committed[indexName].get(key)) {
                values = new Set(values);
                index.set(key, values);
            }
            return values;
        }

        function removeFromIndex(draft, indexName, key, id) {
            const values = draft.data[indexName].get(key);
            if (!values || !values.has(id)) return;
            const mutable = mutableIndexSet(draft, indexName, key);
            mutable.delete(id);
            if (!mutable.size) draft.data[indexName].delete(key);
            metrics.indexUpdates += 1;
        }

        function addToIndex(draft, indexName, key, id) {
            const values = mutableIndexSet(draft, indexName, key);
            if (values.has(id)) return;
            values.add(id);
            metrics.indexUpdates += 1;
        }

        function noteCadastre(draft, feature) {
            explicitCadastreIds(feature).forEach(id => draft.changedCadastreIds.add(id));
        }

        function removeOne(draft, id) {
            const before = draft.data.byId.get(id);
            if (!before) return null;
            draft.data.byId.delete(id);
            draft.data.bboxById.delete(id);
            explicitCadastreIds(before).forEach(key => removeFromIndex(draft, 'byCadastreId', key, id));
            const producer = producerId(before);
            if (producer) removeFromIndex(draft, 'byProducerId', producer, id);
            draft.changedIds.add(id);
            noteCadastre(draft, before);
            return before;
        }

        function putOne(draft, feature, replaceExisting = true) {
            const id = featureId(feature);
            const before = draft.data.byId.get(id);
            if (before && !replaceExisting) return false;
            if (before) removeOne(draft, id);
            draft.data.byId.set(id, feature);
            draft.data.bboxById.set(id, bboxOf(feature));
            explicitCadastreIds(feature).forEach(key => addToIndex(draft, 'byCadastreId', key, id));
            const producer = producerId(feature);
            if (producer) addToIndex(draft, 'byProducerId', producer, id);
            draft.changedIds.add(id);
            noteCadastre(draft, feature);
            return true;
        }

        function measuredArea(feature) {
            return feature ? Math.max(0, Number(geometry.area(feature)) || 0) : 0;
        }

        // The coverage invariant deliberately avoids polygon boolean operations. Unioning a
        // corridor scope of several hundred adjacent parcels, or intersecting every pair of
        // pieces, drove turf's clipper into "Unable to find segment in SweepLine tree" and stack
        // overflows on real Šibenik ground. Every check below is per parcel (or per group of
        // parcels joined by a merged piece), uses areas and point-in-polygon only, and is linear
        // in the number of vertices.
        function ringsOf(feature) {
            const g = feature && feature.geometry;
            if (!g) return [];
            if (g.type === 'Polygon') return Array.isArray(g.coordinates) ? g.coordinates : [];
            if (g.type === 'MultiPolygon') return Array.isArray(g.coordinates) ? g.coordinates.flat() : [];
            return [];
        }

        function verticesOf(feature) {
            const out = [];
            ringsOf(feature).forEach(ring => {
                const n = Array.isArray(ring) ? ring.length : 0;
                for (let i = 0; i < n - 1; i += 1) out.push(ring[i]);
            });
            return out;
        }

        function boundaryLinesOf(fact, cache) {
            if (cache.has(fact)) return cache.get(fact);
            let lines = [];
            if (typeof geometry.polygonToLine === 'function' && typeof geometry.pointToLineDistance === 'function') {
                try {
                    const converted = geometry.polygonToLine(fact);
                    const features = converted && converted.type === 'FeatureCollection' ? converted.features : [converted];
                    features.forEach(line => {
                        const lg = line && line.geometry;
                        if (!lg) return;
                        if (lg.type === 'LineString') lines.push(line);
                        else if (lg.type === 'MultiLineString') lg.coordinates.forEach(coords => lines.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }));
                    });
                } catch (_) { lines = []; }
            }
            cache.set(fact, lines);
            return lines;
        }

        // A fact's bounding box widened by twice the vertex tolerance (metres → degrees at the
        // fact's latitude). A vertex outside it cannot be inside the fact nor within tolerance of
        // its boundary, so the point-in-polygon and distance tests are skipped for it.
        const toleranceBoxByFact = new WeakMap();
        function toleranceBoxOf(fact) {
            if (toleranceBoxByFact.has(fact)) return toleranceBoxByFact.get(fact);
            const box = bboxOf(fact);
            let widened = null;
            if (box) {
                const marginLat = (2 * VERTEX_TOLERANCE_M) / 111320;
                const cosLat = Math.cos(((box[1] + box[3]) / 2) * Math.PI / 180);
                const marginLon = marginLat / Math.max(0.01, Math.abs(cosLat));
                widened = [box[0] - marginLon, box[1] - marginLat, box[2] + marginLon, box[3] + marginLat];
            }
            toleranceBoxByFact.set(fact, widened);
            return widened;
        }

        // Exact coordinate equality of two rings lists (no tolerance: an identity replacement hands
        // back the fact's own coordinates).
        function sameRings(left, right) {
            if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
            for (let r = 0; r < left.length; r += 1) {
                const a = left[r];
                const b = right[r];
                if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
                for (let i = 0; i < a.length; i += 1) {
                    if (a[i]?.[0] !== b[i]?.[0] || a[i]?.[1] !== b[i]?.[1]) return false;
                }
            }
            return true;
        }

        // A replacement that IS its single host fact, or one connected component of a
        // MultiPolygon fact, lies inside that fact by construction. Keyed on the geometry itself,
        // not on who asked for the replacement: any piece with different coordinates is checked.
        function isIdentityOfFact(feature, fact) {
            const piece = feature?.geometry;
            const ground = fact?.geometry;
            if (!piece || !ground || piece.type !== 'Polygon') return false;
            if (piece.coordinates === ground.coordinates) return true;
            if (ground.type === 'Polygon') return sameRings(piece.coordinates, ground.coordinates);
            if (ground.type === 'MultiPolygon' && Array.isArray(ground.coordinates)) {
                return ground.coordinates.some(component => sameRings(piece.coordinates, component));
            }
            return false;
        }

        function vertexInsideFact(vertex, fact, cache) {
            const box = toleranceBoxOf(fact);
            if (box && !(vertex[0] >= box[0] && vertex[0] <= box[2] && vertex[1] >= box[1] && vertex[1] <= box[3])) {
                return false;
            }
            try {
                if (geometry.booleanPointInPolygon(vertex, fact)) return true;
            } catch (_) { /* fall through to the distance check */ }
            const lines = boundaryLinesOf(fact, cache);
            if (!lines.length) {
                // Without a distance primitive, accept a vertex within the parcel's bounding box.
                const box = bboxOf(fact);
                return !!box && vertex[0] >= box[0] - 1e-9 && vertex[0] <= box[2] + 1e-9
                    && vertex[1] >= box[1] - 1e-9 && vertex[1] <= box[3] + 1e-9;
            }
            for (const line of lines) {
                try {
                    if (geometry.pointToLineDistance(vertex, line, { units: 'meters' }) <= VERTEX_TOLERANCE_M) return true;
                } catch (_) { /* try the next ring */ }
            }
            return false;
        }

        // Yields after each piece and each vertex tested, so a sliced replacement checks its pieces
        // in short slices; `replaceCadastreScope` runs it to completion in one go.
        function* validateReplacementSteps(draft, scope, replacements) {
            if (!geometry?.area || !geometry?.booleanPointInPolygon) {
                const error = new Error('Geometry operations are required to validate a cadastral replacement.');
                error.code = 'live-fabric-geometry-unavailable';
                throw error;
            }
            if (!scope.size) {
                const error = new Error('Cadastral replacement scope cannot be empty.');
                error.code = 'live-fabric-scope-empty';
                throw error;
            }
            if (!replacements.length) {
                const error = new Error('A cadastral replacement must contain at least one live parcel.');
                error.code = 'live-fabric-empty-replacement';
                throw error;
            }
            const replacementIds = new Set();
            replacements.forEach(feature => {
                const id = featureId(feature);
                if (replacementIds.has(id)) {
                    const error = new Error(`Cadastral replacement contains duplicate id ${id}.`);
                    error.code = 'duplicate-live-parcel-id';
                    throw error;
                }
                replacementIds.add(id);
                const provenance = explicitCadastreIds(feature);
                if (!provenance.length || !provenance.every(value => scope.has(value))) {
                    const error = new Error(`Replacement parcel ${id} has provenance outside the requested cadastral scope.`);
                    error.code = 'live-fabric-scope-violation';
                    error.parcelId = id;
                    throw error;
                }
            });
            const scopeIds = Array.from(scope);
            const facts = new Map(scopeIds.map(id => [id, draft.data.cadastreFacts.get(id)]));
            const missing = scopeIds.filter(id => !facts.get(id));
            if (missing.length) {
                const error = new Error(`Immutable cadastral ground is missing for: ${missing.join(', ')}.`);
                error.code = 'live-fabric-cadastre-facts-missing';
                error.missingIds = missing;
                throw error;
            }

            // Group scope parcels joined by a piece that declares several of them (a merge), so
            // area accounting compares like with like. Corridor and split pieces declare one
            // parcel each and form singleton groups.
            const parent = new Map(scopeIds.map(id => [id, id]));
            const find = id => { let cursor = id; while (parent.get(cursor) !== cursor) cursor = parent.get(cursor); parent.set(id, cursor); return cursor; };
            replacements.forEach(feature => {
                const provenance = explicitCadastreIds(feature);
                for (let i = 1; i < provenance.length; i += 1) {
                    const a = find(provenance[0]);
                    const b = find(provenance[i]);
                    if (a !== b) parent.set(b, a);
                }
            });

            const boundaryCache = new Map();
            const factAreaByGroup = new Map();
            const pieceAreaByGroup = new Map();
            scopeIds.forEach(id => {
                const group = find(id);
                factAreaByGroup.set(group, (factAreaByGroup.get(group) || 0) + measuredArea(facts.get(id)));
            });
            for (const feature of replacements) {
                const provenance = explicitCadastreIds(feature);
                const group = find(provenance[0]);
                const areaM2 = measuredArea(feature);
                pieceAreaByGroup.set(group, (pieceAreaByGroup.get(group) || 0) + areaM2);
                // A vertex beyond every declared parcel's boundary is ground the replacement does
                // not own. Shared edges and clipper drift sit within VERTEX_TOLERANCE_M.
                const hosts = provenance.map(id => facts.get(id));
                if (hosts.length === 1 && isIdentityOfFact(feature, hosts[0])) {
                    metrics.identityReplacements += 1;
                    yield;
                    continue;
                }
                for (const vertex of verticesOf(feature)) {
                    if (!hosts.some(fact => vertexInsideFact(vertex, fact, boundaryCache))) {
                        const error = new Error(`Replacement parcel ${featureId(feature)} lies outside immutable cadastral ground at [${vertex[0]}, ${vertex[1]}].`);
                        error.code = 'live-fabric-replacement-outside';
                        error.parcelId = featureId(feature);
                        error.vertex = vertex.slice(0, 2);
                        throw error;
                    }
                    yield;
                }
            }

            // Members of each group, built once: filtering the whole scope per group was quadratic
            // (a full-cadastre reset of ~6,000 parcels spent ~0.4 s here).
            const membersByGroup = new Map();
            scopeIds.forEach(id => {
                const group = find(id);
                if (!membersByGroup.has(group)) membersByGroup.set(group, []);
                membersByGroup.get(group).push(id);
            });
            factAreaByGroup.forEach((factM2, group) => {
                const pieceM2 = pieceAreaByGroup.get(group) || 0;
                const toleranceM2 = COVERAGE_TOLERANCE_M2 + factM2 * RELATIVE_AREA_TOLERANCE;
                const deltaM2 = pieceM2 - factM2;
                metrics.coverageChecks += 1;
                if (Math.abs(deltaM2) > metrics.worstCoverageDeltaM2) metrics.worstCoverageDeltaM2 = Math.abs(deltaM2);
                const members = membersByGroup.get(group) || [];
                if (deltaM2 > toleranceM2) {
                    // Nothing lies outside (checked per vertex above), so excess area is overlap.
                    const error = new Error(`Replacement parcels overlap by ${deltaM2.toFixed(3)} m² over ${members.join(', ')}.`);
                    error.code = 'live-fabric-replacement-overlap';
                    error.overlapM2 = deltaM2;
                    error.cadastreParcelIds = members;
                    throw error;
                }
                if (-deltaM2 > toleranceM2) {
                    const error = new Error(`Replacement leaves ${(-deltaM2).toFixed(3)} m² of cadastral ground uncovered over ${members.join(', ')}.`);
                    error.code = 'live-fabric-replacement-hole';
                    error.missingM2 = -deltaM2;
                    error.cadastreParcelIds = members;
                    throw error;
                }
            });
        }

        function readFrom(data, id) {
            const feature = data.byId.get(normalizeId(id));
            return feature ? clone(feature) : null;
        }

        // Read-only access to the committed record itself. Every stored feature is deep-frozen at
        // ingress, so handing it out cannot corrupt the fabric, and it skips the structuredClone
        // that `get` pays. Style and hit-test code that only inspects properties must use this:
        // profiled on a 661-parcel corridor apply, cloning on `get` was 63% of a 47 s apply.
        function peekFrom(data, id) {
            return data.byId.get(normalizeId(id)) || null;
        }

        function getManyFrom(data, ids, query = {}) {
            const features = [];
            const missingIds = [];
            const seen = new Set();
            Array.from(ids || []).forEach(raw => {
                const id = normalizeId(raw);
                if (!id || seen.has(id)) return;
                seen.add(id);
                const feature = data.byId.get(id);
                if (feature) features.push(clone(feature));
                else missingIds.push(id);
            });
            if (missingIds.length && query.allowMissing !== true) {
                const error = new Error(`Live parcel fabric is missing: ${missingIds.join(', ')}`);
                error.code = 'live-parcel-missing';
                error.missingIds = missingIds;
                throw error;
            }
            return { features, missingIds };
        }

        function entriesForCadastreFrom(data, ids, query = {}) {
            const parcelIds = new Set();
            Array.from(ids || []).map(normalizeId).filter(Boolean).forEach(id => {
                data.byCadastreId.get(id)?.forEach(parcelId => parcelIds.add(parcelId));
            });
            return Array.from(parcelIds)
                .map(id => data.byId.get(id))
                .filter(feature => query.includeCorridors === true || !isCorridor(feature))
                .map(clone);
        }

        function hasCadastreEntriesFrom(data, ids, query = {}) {
            for (const raw of Array.from(ids || [])) {
                const parcelIds = data.byCadastreId.get(normalizeId(raw));
                if (!parcelIds?.size) continue;
                if (query.includeCorridors === true) return true;
                for (const parcelId of parcelIds) {
                    if (!isCorridor(data.byId.get(parcelId))) return true;
                }
            }
            return false;
        }

        // Return only the requested cadastral IDs that have no matching fabric entries. This is
        // the batched, clone-free counterpart to hasCadastreEntries for repository integration.
        function absentCadastreIdsFrom(data, ids, query = {}) {
            const absent = [];
            const seen = new Set();
            for (const raw of ids || []) {
                const id = normalizeId(raw);
                if (!id || seen.has(id)) continue;
                seen.add(id);
                const parcelIds = data.byCadastreId.get(id);
                let represented = false;
                if (parcelIds?.size) {
                    if (query.includeCorridors === true) represented = true;
                    else {
                        for (const parcelId of parcelIds) {
                            if (!isCorridor(data.byId.get(parcelId))) { represented = true; break; }
                        }
                    }
                }
                if (!represented) absent.push(id);
            }
            return absent;
        }

        function queryBoundsFrom(data, bounds, query = {}, copy = clone) {
            const box = boundsArray(bounds);
            if (!box) return [];
            const result = [];
            data.byId.forEach((feature, id) => {
                if (!intersects(box, data.bboxById.get(id))) return;
                if (query.includeCorridors !== true && isCorridor(feature)) return;
                result.push(copy(feature));
            });
            return result;
        }

        function countBoundsFrom(data, bounds, query = {}) {
            const box = boundsArray(bounds);
            if (!box) return 0;
            let count = 0;
            data.byId.forEach((feature, id) => {
                if (!intersects(box, data.bboxById.get(id))) return;
                if (query.includeCorridors !== true && isCorridor(feature)) return;
                count += 1;
            });
            return count;
        }

        function cadastreIdsForParcelIdsFrom(data, ids, query = {}) {
            const result = [];
            const seen = new Set();
            const append = raw => {
                const id = normalizeId(raw);
                if (!id || seen.has(id)) return;
                seen.add(id);
                result.push(id);
            };
            Array.from(ids || []).forEach(raw => {
                const id = normalizeId(raw);
                if (!id) return;
                const feature = data.byId.get(id);
                if (feature) return explicitCadastreIds(feature).forEach(append);
                if (data.byCadastreId.has(id) || data.cadastreFacts.has(id)) return append(id);
                if (query.allowMissing === true) return;
                const error = new Error(`Live parcel fabric cannot resolve cadastral provenance for ${id}.`);
                error.code = 'live-parcel-provenance-unavailable';
                error.parcelId = id;
                throw error;
            });
            return result;
        }

        function deltaFor(draft) {
            const addedIds = [];
            const updatedIds = [];
            const removedIds = [];
            draft.changedIds.forEach(id => {
                const before = committed.byId.get(id);
                const after = draft.data.byId.get(id);
                if (!before && after) addedIds.push(id);
                else if (before && !after) removedIds.push(id);
                else if (before !== after) updatedIds.push(id);
            });
            const sort = values => Object.freeze(values.sort(ID_COLLATOR.compare));
            return Object.freeze({
                revision: committed.revision + 1,
                fromRevision: committed.revision,
                addedIds: sort(addedIds),
                updatedIds: sort(updatedIds),
                removedIds: sort(removedIds),
                changedCadastreIds: sort(Array.from(draft.changedCadastreIds))
            });
        }

        function participantView(draft) {
            return Object.freeze({
                get: id => readFrom(draft.data, id),
                peek: id => peekFrom(draft.data, id),
                getMany: (ids, query) => getManyFrom(draft.data, ids, query),
                list: () => Array.from(draft.data.byId.values(), clone),
                snapshot: () => ({ revision: committed.revision + 1, parcelIds: Array.from(draft.data.byId.keys()) }),
                // The revision this draft commits as, without copying the parcel ids.
                revision: () => committed.revision + 1
            });
        }

        function beginMutation(meta = {}) {
            if (active) {
                const error = new Error('A live parcel fabric mutation is already active.');
                error.code = 'live-fabric-transaction-active';
                throw error;
            }
            const draft = {
                meta: Object.freeze({ ...meta }),
                state: 'active',
                data: {
                    revision: committed.revision,
                    byId: new Map(committed.byId),
                    bboxById: new Map(committed.bboxById),
                    byCadastreId: new Map(committed.byCadastreId),
                    byProducerId: new Map(committed.byProducerId),
                    cadastreFacts: new Map(committed.cadastreFacts)
                },
                changedIds: new Set(),
                changedCadastreIds: new Set(),
                prepared: [],
                delta: null
            };
            active = draft;

            // One parcel per step. A fact already registered is compared, not normalized again:
            // a replay's reset re-seeds every fact its ground load already seeded.
            function* seedCadastreSteps(features) {
                assertActive(draft);
                for (const raw of Array.isArray(features) ? features : []) {
                    const cadastralId = raw && raw.type === 'Feature' && raw.geometry ? featureId(raw) : '';
                    const existingFact = cadastralId ? draft.data.cadastreFacts.get(cadastralId) : null;
                    let fact = existingFact;
                    if (existingFact) {
                        assertNoRetiredProvenance(raw.properties || {}, cadastralId);
                        if (JSON.stringify(existingFact.geometry) !== JSON.stringify(raw.geometry)) {
                            const error = new Error(`Conflicting immutable cadastral geometry for ${cadastralId}.`);
                            error.code = 'cadastral-geometry-conflict';
                            throw error;
                        }
                    } else {
                        fact = normalizeCadastreFact(raw);
                        draft.data.cadastreFacts.set(featureId(fact), fact);
                    }
                    // Polygon facts are already normalized, frozen, and trusted, so the live
                    // entry reuses that exact object. MultiPolygons retain one immutable union
                    // fact and derive one normalized live object per connected component.
                    if (!draft.data.byCadastreId.get(featureId(fact))?.size) {
                        connectedFeatures(fact, { cadastreSeed: true }).forEach(feature => putOne(draft, feature));
                    }
                    yield;
                    assertActive(draft);
                }
                return Array.from(draft.changedIds);
            }

            function* replaceCadastreScopeSteps(cadastreIds, features) {
                assertActive(draft);
                const scope = new Set(Array.from(cadastreIds || []).map(normalizeId).filter(Boolean));
                for (const feature of draft.data.byId.values()) {
                    const occupied = explicitCadastreIds(feature);
                    if (occupied.some(id => scope.has(id))) {
                        const escaped = occupied.filter(id => !scope.has(id));
                        if (escaped.length) {
                            const error = new Error(`Cadastral replacement scope is not closed: ${featureId(feature)} also occupies ${escaped.join(', ')}`);
                            error.code = 'live-fabric-scope-not-closed';
                            error.parcelId = featureId(feature);
                            error.requestedCadastreIds = Array.from(scope);
                            error.requiredCadastreIds = occupied;
                            throw error;
                        }
                    }
                }
                yield;
                assertActive(draft);
                const replacements = [];
                for (const raw of Array.isArray(features) ? features : []) {
                    replacements.push(...connectedFeatures(raw));
                    yield;
                }
                assertActive(draft);
                yield* validateReplacementSteps(draft, scope, replacements);
                assertActive(draft);
                for (const [id, feature] of Array.from(draft.data.byId.entries())) {
                    if (!explicitCadastreIds(feature).some(value => scope.has(value))) continue;
                    removeOne(draft, id);
                    yield;
                    assertActive(draft);
                }
                for (const feature of replacements) {
                    const existing = draft.data.byId.get(featureId(feature));
                    if (existing) {
                        const error = new Error(`Replacement id ${featureId(feature)} already exists outside its cadastral scope.`);
                        error.code = 'duplicate-live-parcel-id';
                        throw error;
                    }
                    putOne(draft, feature);
                    yield;
                    assertActive(draft);
                }
                return Array.from(draft.changedIds);
            }

            const mutation = {
                // `*Steps` hand out the step function itself, for a caller that runs it in slices
                // (work-slicer.js runSliced) or folds it into its own steps (`yield*`).
                seedCadastre(features) {
                    return workSlicer.runToCompletion(seedCadastreSteps(features));
                },
                seedCadastreSteps,
                upsertFeatures(features, config = {}) {
                    assertActive(draft);
                    for (const raw of Array.isArray(features) ? features : []) {
                        connectedFeatures(raw).forEach(feature => putOne(draft, feature, config.replaceExisting !== false));
                    }
                    return Array.from(draft.changedIds);
                },
                removeIds(ids) {
                    assertActive(draft);
                    return Array.from(ids || []).map(normalizeId).filter(id => !!removeOne(draft, id));
                },
                replaceCadastreScope(cadastreIds, features) {
                    return workSlicer.runToCompletion(replaceCadastreScopeSteps(cadastreIds, features));
                },
                replaceCadastreScopeSteps,
                releaseCadastreScope(cadastreIds, reason, config = {}) {
                    assertActive(draft);
                    const scope = new Set(Array.from(cadastreIds || []).map(normalizeId).filter(Boolean));
                    if (!scope.size || !normalizeId(reason)) {
                        const error = new Error('Releasing cadastral scope requires IDs and an explicit repository reset/unload reason.');
                        error.code = 'live-fabric-release-reason-required';
                        throw error;
                    }
                    if (!CADASTRE_RELEASE_KINDS.has(normalizeId(draft.meta.kind))) {
                        const error = new Error('Cadastral scope release is reserved for repository reset or unload mutations.');
                        error.code = 'live-fabric-release-forbidden';
                        throw error;
                    }
                    Array.from(draft.data.byId.entries()).forEach(([id, feature]) => {
                        if (explicitCadastreIds(feature).some(value => scope.has(value))) removeOne(draft, id);
                    });
                    if (config.unloadFacts === true) scope.forEach(id => draft.data.cadastreFacts.delete(id));
                    scope.forEach(id => draft.changedCadastreIds.add(id));
                    return Array.from(draft.changedIds);
                },
                get: id => (assertActive(draft), readFrom(draft.data, id)),
                getMany: (ids, query) => (assertActive(draft), getManyFrom(draft.data, ids, query)),
                list: () => (assertActive(draft), Array.from(draft.data.byId.values(), clone)),
                // The draft's pieces themselves (deep-frozen), for readers that copy nothing.
                peekList: () => (assertActive(draft), Array.from(draft.data.byId.values())),
                entriesForCadastre: (ids, query) => (assertActive(draft), entriesForCadastreFrom(draft.data, ids, query)),
                // Which of `cadastreIds` hold `vertex` by the rule a replacement is checked with
                // (validateReplacementSteps: inside the immutable parcel or within VERTEX_TOLERANCE_M).
                cadastreIdsHolding(vertex, cadastreIds) {
                    assertActive(draft);
                    const cache = new Map();
                    return (Array.isArray(cadastreIds) ? cadastreIds : []).map(String).filter(id => {
                        const fact = draft.data.cadastreFacts.get(id);
                        return !!fact && vertexInsideFact(vertex, fact, cache);
                    });
                },
                hasCadastreEntries: (ids, query) => (assertActive(draft), hasCadastreEntriesFrom(draft.data, ids, query)),
                absentCadastreIds: (ids, query) => (assertActive(draft), absentCadastreIdsFrom(draft.data, ids, query)),
                producedBy(proposalId) {
                    assertActive(draft);
                    const ids = draft.data.byProducerId.get(normalizeId(proposalId));
                    return ids ? Array.from(ids, id => clone(draft.data.byId.get(id))) : [];
                },
                queryBounds: (bounds, query) => (assertActive(draft), queryBoundsFrom(draft.data, bounds, query)),
                countBounds: (bounds, query) => (assertActive(draft), countBoundsFrom(draft.data, bounds, query)),
                cadastreIdsForParcelIds: (ids, query) => (assertActive(draft), cadastreIdsForParcelIdsFrom(draft.data, ids, query)),
                // Every cadastral id a live piece occupies (the index keys), without copying a piece.
                occupiedCadastreIds: () => (assertActive(draft), Array.from(draft.data.byCadastreId.keys())),
                snapshot: () => (assertActive(draft), {
                    revision: draft.data.revision,
                    featureCount: draft.data.byId.size,
                    parcelIds: Array.from(draft.data.byId.keys())
                }),
                // The draft's revision alone, without copying the parcel ids.
                revision: () => (assertActive(draft), draft.data.revision),
                // `options.slicer` (the boot replay's) is handed to every participant's prepare.
                async prepare(options = {}) {
                    assertActive(draft);
                    draft.delta = deltaFor(draft);
                    const view = participantView(draft);
                    try {
                        for (const participant of participants) {
                            const value = typeof participant.prepare === 'function'
                                ? await participant.prepare(draft.delta, view, options)
                                : draft.delta;
                            draft.prepared.push({ participant, value });
                        }
                        draft.state = 'prepared';
                        return draft.delta;
                    } catch (error) {
                        throw error;
                    }
                },
                publish() {
                    if (!active || active !== draft || draft.state !== 'prepared') {
                        const error = new Error('Live parcel fabric mutation must be prepared before publication.');
                        error.code = 'live-fabric-mutation-not-prepared';
                        throw error;
                    }
                    const previous = committed;
                    const next = { ...draft.data, revision: draft.delta.revision };
                    committed = next;
                    try {
                        for (const entry of draft.prepared) {
                            if (typeof entry.participant.commit !== 'function') continue;
                            const result = entry.participant.commit(entry.value, draft.delta);
                            if (result && typeof result.then === 'function') {
                                throw new Error('Live-fabric participant publication must be synchronous.');
                            }
                        }
                    } catch (error) {
                        committed = previous;
                        for (let index = draft.prepared.length - 1; index >= 0; index -= 1) {
                            try { draft.prepared[index].participant.rollback?.(draft.prepared[index].value, draft.delta); }
                            catch (_) { /* preserve primary failure */ }
                        }
                        active = null;
                        draft.state = 'rolled-back';
                        throw error;
                    }
                    active = null;
                    draft.state = 'published';
                    subscribers.forEach(listener => {
                        try { listener(draft.delta); }
                        catch (error) { console.error('[LiveParcelFabric] subscriber failed', error); }
                    });
                    return draft.delta;
                },
                rollback() {
                    if (draft.state === 'published' || draft.state === 'rolled-back') return false;
                    if (active === draft) active = null;
                    for (let index = draft.prepared.length - 1; index >= 0; index -= 1) {
                        try { draft.prepared[index].participant.rollback?.(draft.prepared[index].value, draft.delta); }
                        catch (_) { }
                    }
                    draft.state = 'rolled-back';
                    return true;
                }
            };
            return Object.freeze(mutation);
        }

        function get(id) { return readFrom(committed, id); }
        function peek(id) { return peekFrom(committed, id); }
        function getMany(ids, query) { return getManyFrom(committed, ids, query); }
        function list() { return Array.from(committed.byId.values(), clone); }
        function entriesForCadastre(ids, query) { return entriesForCadastreFrom(committed, ids, query); }
        function hasCadastreEntries(ids, query) { return hasCadastreEntriesFrom(committed, ids, query); }
        function absentCadastreIds(ids, query) { return absentCadastreIdsFrom(committed, ids, query); }
        function producedBy(proposalId) {
            const ids = committed.byProducerId.get(normalizeId(proposalId));
            return ids ? Array.from(ids, id => clone(committed.byId.get(id))) : [];
        }
        function queryBounds(bounds, query) { return queryBoundsFrom(committed, bounds, query); }
        // The committed (frozen) features themselves, for read-only hot paths such as a block flood
        // fill asking about every member's surroundings: queryBounds' defensive copies were most of
        // that work.
        function peekBounds(bounds, query) { return queryBoundsFrom(committed, bounds, query, feature => feature); }
        function countBounds(bounds, query) { return countBoundsFrom(committed, bounds, query); }
        function cadastreIdsForParcelIds(ids, query) { return cadastreIdsForParcelIdsFrom(committed, ids, query); }
        function claimedCadastreIds() {
            const claimed = new Set();
            committed.byId.forEach(feature => {
                const id = featureId(feature);
                const bases = explicitCadastreIds(feature);
                const produced = !!producerId(feature) || feature.properties?.cadastralPart === true
                    || bases.length !== 1 || bases[0] !== id;
                if (produced) bases.forEach(base => claimed.add(base));
            });
            return claimed;
        }
        function subscribe(listener) {
            if (typeof listener !== 'function') return () => {};
            subscribers.add(listener);
            return () => subscribers.delete(listener);
        }
        function addCommitParticipant(participant) {
            if (!participant || typeof participant !== 'object') throw new TypeError('Commit participant must be an object.');
            participants.add(participant);
            return () => participants.delete(participant);
        }
        // Revision, feature count and every parcel id (a copy): for callers that need the ids.
        function snapshot() {
            return {
                revision: committed.revision,
                featureCount: committed.byId.size,
                parcelIds: Array.from(committed.byId.keys())
            };
        }
        // The committed revision alone, O(1): memo keys read this, not snapshot().
        function revision() { return committed.revision; }
        function diagnostics() { return { ...metrics }; }

        return Object.freeze({
            beginMutation,
            get,
            peek,
            getMany,
            list,
            entriesForCadastre,
            hasCadastreEntries,
            absentCadastreIds,
            producedBy,
            queryBounds,
            peekBounds,
            countBounds,
            claimedCadastreIds,
            cadastreIdsForParcelIds,
            subscribe,
            addCommitParticipant,
            snapshot,
            revision,
            diagnostics,
            featureId,
            explicitCadastreIds,
            explicitGroundIds
        });
    }

    return Object.freeze({ createLiveParcelFabric, featureId, explicitCadastreIds, explicitGroundIds, GEOMETRY_EPSILON_M2 });
});
