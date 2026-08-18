// Builds a conservative, directed lane graph from OSM ways.
//
// The same pure module runs in the topology viewer and in the backend. Geometry and tag parsing are
// deterministic; an LLM may propose a later version, but it never gets to redefine the source graph.
(function (root, factory) {
    const api = factory(root || {});
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.LaneTopologyGraph = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const SCHEMA_VERSION = 1;
    const COORD_PRECISION = 7;
    const DEFAULT_LANE_WIDTH_M = 3;
    const ABSENT_TOKENS = new Set(['', 'no', 'none', 'false', '0']);
    const PSV_TOKENS = new Set(['yes', 'designated', 'permissive']);
    const DRIVEABLE_HIGHWAYS = new Set([
        'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
        'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
        'unclassified', 'residential', 'living_street', 'service', 'road'
    ]);

    let junctionRulesApi = null;
    function junctionRulesModule() {
        if (junctionRulesApi) return junctionRulesApi;
        junctionRulesApi = (root && root.LaneTopologyJunctionRules)
            || (typeof require === 'function' ? require('./lane-topology-junction-rules.js') : null);
        // Silently skipping would leave every junction unresolved and look exactly like a city whose
        // junctions are all hard, so a missing script tag has to say so.
        if (!junctionRulesApi) {
            throw new Error('LaneTopologyGraph requires lane-topology-junction-rules.js to be loaded first.');
        }
        return junctionRulesApi;
    }

    // Only needed when a caller passes stored answers, so it is resolved lazily: a page that never
    // shows decisions must not fail to build a graph because that script is not loaded.
    let decisionsApi = null;
    function decisionsModule() {
        if (decisionsApi) return decisionsApi;
        decisionsApi = (root && root.LaneTopologyDecisions)
            || (typeof require === 'function' ? require('./lane-topology-decisions.js') : null);
        if (!decisionsApi) {
            throw new Error('LaneTopologyGraph was given decisions but lane-topology-decisions.js is not loaded.');
        }
        return decisionsApi;
    }

    function finiteCoordinate(point) {
        return Array.isArray(point)
            && Number.isFinite(Number(point[0]))
            && Number.isFinite(Number(point[1]));
    }

    function cleanCoordinates(coordinates) {
        return (coordinates || [])
            .filter(finiteCoordinate)
            .map(point => [Number(point[0]), Number(point[1])])
            .filter((point, index, all) => (
                index === 0
                || Math.abs(point[0] - all[index - 1][0]) > 1e-12
                || Math.abs(point[1] - all[index - 1][1]) > 1e-12
            ));
    }

    function coordinateKey(point) {
        return `coord:${point[0].toFixed(COORD_PRECISION)},${point[1].toFixed(COORD_PRECISION)}`;
    }

    function wayNodeIds(feature, coordinateCount) {
        const properties = feature?.properties || {};
        const candidates = [
            properties.osm_node_ids,
            properties.osmNodes,
            properties.node_ids,
            properties.nodes
        ];
        const found = candidates.find(value => Array.isArray(value) && value.length === coordinateCount);
        return found ? found.map(value => String(value)) : null;
    }

    function nodeKey(point, nodeId) {
        return nodeId !== undefined && nodeId !== null
            ? `osm-node:${nodeId}`
            : coordinateKey(point);
    }

    function tagsOf(feature) {
        const properties = feature?.properties || {};
        return {
            ...(properties.osmTags || {}),
            ...(properties.tags || {}),
            ...(properties.highway && !properties.tags?.highway ? { highway: properties.highway } : {}),
            ...(properties.highway_type && !properties.tags?.highway ? { highway: properties.highway_type } : {}),
            ...(properties.railway && !properties.tags?.railway ? { railway: properties.railway } : {}),
            ...(properties.railway_type && !properties.tags?.railway ? { railway: properties.railway_type } : {})
        };
    }

    function osmWayId(feature, fallbackIndex) {
        const properties = feature?.properties || {};
        return String(properties.osm_id ?? properties.id ?? feature?.id ?? `input-${fallbackIndex}`);
    }

    function lineLengthMeters(coordinates) {
        let length = 0;
        for (let index = 1; index < coordinates.length; index += 1) {
            const a = coordinates[index - 1];
            const b = coordinates[index];
            const meanLat = (a[1] + b[1]) * Math.PI / 360;
            const dx = (b[0] - a[0]) * 111320 * Math.cos(meanLat);
            const dy = (b[1] - a[1]) * 110540;
            length += Math.hypot(dx, dy);
        }
        return length;
    }

    function centroidOfCoordinates(coordinates) {
        if (!coordinates.length) return [15.98, 45.81];
        const sum = coordinates.reduce((memo, point) => [memo[0] + point[0], memo[1] + point[1]], [0, 0]);
        return [sum[0] / coordinates.length, sum[1] / coordinates.length];
    }

    function parsePositiveInt(value) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }

    function onewayDirection(tags) {
        const value = String(tags?.oneway ?? '').trim().toLowerCase();
        if (value === 'yes' || value === 'true' || value === '1') return 'forward';
        if (value === '-1' || value === 'reverse') return 'backward';
        return null;
    }

    function splitLaneTokens(tags, key, direction) {
        const suffixed = tags?.[`${key}:${direction}`];
        // A one-way street carries the BARE key: with a single direction of travel there is nothing
        // to disambiguate, so OSM omits the suffix. Reading only the suffixed form silently discards
        // turn:lanes on every one-way avenue — which is where nearly all turn assignments live.
        // Restricted to the direction the way actually runs, so a bare key on a two-way street (where
        // it would span both directions in way order) is still left alone as ambiguous.
        const value = suffixed !== undefined && suffixed !== null
            ? suffixed
            : (onewayDirection(tags) === direction ? tags?.[key] : undefined);
        return value === undefined || value === null
            ? []
            : String(value).split('|').map(token => token.trim().toLowerCase());
    }

    function tokenAllowsPsv(value) {
        return String(value || '')
            .split(';')
            .some(token => PSV_TOKENS.has(token.trim().toLowerCase()));
    }

    function tokenHasRail(value) {
        const token = String(value || '').trim().toLowerCase();
        return !ABSENT_TOKENS.has(token);
    }

    function deriveLaneCounts(tags) {
        const oneway = tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === '-1';
        const totalTagged = parsePositiveInt(tags.lanes);
        const forwardTagged = parsePositiveInt(tags['lanes:forward']);
        const backwardTagged = parsePositiveInt(tags['lanes:backward']);
        const bothTagged = parsePositiveInt(tags['lanes:both_ways']) || 0;
        const defaultTotal = oneway ? 1 : 2;
        let forward;
        let backward;

        if (forwardTagged !== null || backwardTagged !== null || bothTagged > 0) {
            if (forwardTagged !== null) forward = forwardTagged;
            if (backwardTagged !== null) backward = backwardTagged;
            const available = Math.max(0, (totalTagged ?? defaultTotal) - bothTagged);
            if (forward === undefined && backward === undefined) {
                forward = oneway && tags.oneway !== '-1' ? available : Math.ceil(available / 2);
                backward = available - forward;
            } else if (forward === undefined) {
                forward = Math.max(0, available - backward);
            } else if (backward === undefined) {
                backward = Math.max(0, available - forward);
            }
        } else {
            const total = totalTagged ?? defaultTotal;
            if (oneway) {
                forward = tags.oneway === '-1' ? 0 : total;
                backward = tags.oneway === '-1' ? total : 0;
            } else {
                forward = Math.ceil(total / 2);
                backward = total - forward;
            }
        }

        const directionalTotal = forward + backward + bothTagged;
        return {
            oneway,
            totalTagged,
            forward,
            backward,
            both: bothTagged,
            total: Math.max(1, directionalTotal || totalTagged || defaultTotal),
            contradictory: totalTagged !== null && totalTagged !== directionalTotal
        };
    }

    function fallbackProfile(tags, counts) {
        const width = Number.parseFloat(tags.width);
        const laneWidth = Number.isFinite(width) && width > 0
            ? width / counts.total
            : DEFAULT_LANE_WIDTH_M;
        const strips = [];
        for (let index = 0; index < counts.backward; index += 1) {
            strips.push({ type: 'driving', direction: 'backward', width: laneWidth });
        }
        for (let index = 0; index < counts.both; index += 1) {
            strips.push({ type: 'driving', direction: 'both', width: laneWidth });
        }
        for (let index = 0; index < counts.forward; index += 1) {
            strips.push({ type: 'driving', direction: 'forward', width: laneWidth });
        }
        return { strips };
    }

    function orientProfile(profile, options) {
        if (typeof options.orientProfile === 'function') return options.orientProfile(profile);
        if (root.OsmProfile?.orientForRightHandTraffic) return root.OsmProfile.orientForRightHandTraffic(profile);
        return profile;
    }

    function profileForTags(tags, counts, options) {
        const normalizedTags = {
            ...tags,
            lanes: String(counts.total),
            'lanes:forward': String(counts.forward),
            'lanes:backward': String(counts.backward + counts.both)
        };
        const factory = options.profileFromTags
            || root.corridorProfileFromOsmTags;
        let profile = typeof factory === 'function' ? factory(normalizedTags) : null;
        if (!profile?.strips?.length) profile = fallbackProfile(normalizedTags, counts);
        profile = orientProfile(profile, options);
        const strips = profile.strips.map(strip => ({ ...strip }));
        const driving = strips
            .map((strip, index) => ((strip.type === 'driving' || strip.type === 'bus') ? index : -1))
            .filter(index => index >= 0);

        // `lanes:both_ways` is physically between backward and forward traffic. The existing OSM
        // profile bridge has no centre-lane concept, so restore it after orienting the section.
        for (let index = 0; index < counts.both; index += 1) {
            const stripIndex = driving[counts.backward + index];
            if (stripIndex !== undefined) strips[stripIndex].direction = 'both';
        }
        return { strips };
    }

    function stripSpans(profile) {
        const strips = profile?.strips || [];
        const total = strips.reduce((sum, strip) => sum + (Number(strip.width) || 0), 0);
        let cursor = total / 2;
        return strips.map((strip, index) => {
            const width = Number(strip.width) || 0;
            const left = cursor;
            const right = cursor - width;
            cursor = right;
            return { ...strip, index, left, right, offset: (left + right) / 2 };
        });
    }

    function localProjector(coordinates) {
        const origin = centroidOfCoordinates(coordinates);
        const xScale = 111320 * Math.cos(origin[1] * Math.PI / 180);
        const yScale = 110540;
        return {
            project(point) {
                return [(point[0] - origin[0]) * xScale, (point[1] - origin[1]) * yScale];
            },
            unproject(point) {
                return [origin[0] + point[0] / xScale, origin[1] + point[1] / yScale];
            }
        };
    }

    function offsetPolyline(points, offset) {
        if (!points.length) return [];
        const edgeNormals = [];
        for (let index = 1; index < points.length; index += 1) {
            const dx = points[index][0] - points[index - 1][0];
            const dy = points[index][1] - points[index - 1][1];
            const length = Math.hypot(dx, dy);
            edgeNormals.push(length > 1e-9 ? [-dy / length, dx / length] : [0, 0]);
        }
        return points.map((point, index) => {
            const before = edgeNormals[Math.max(0, index - 1)];
            const after = edgeNormals[Math.min(edgeNormals.length - 1, index)];
            let nx = before[0] + after[0];
            let ny = before[1] + after[1];
            const length = Math.hypot(nx, ny);
            if (length > 1e-9) {
                nx /= length;
                ny /= length;
            } else {
                nx = after[0];
                ny = after[1];
            }
            return [point[0] + nx * offset, point[1] + ny * offset];
        });
    }

    function offsetCoordinates(coordinates, offset) {
        const projector = localProjector(coordinates);
        return offsetPolyline(coordinates.map(projector.project), offset).map(projector.unproject);
    }

    function normalizeInputFeatures(input) {
        const features = Array.isArray(input)
            ? input
            : (Array.isArray(input?.features) ? input.features : []);
        return features
            .map((feature, index) => {
                const coordinates = cleanCoordinates(feature?.geometry?.coordinates);
                const tags = tagsOf(feature);
                if (feature?.geometry?.type !== 'LineString' || coordinates.length < 2) return null;
                if (!DRIVEABLE_HIGHWAYS.has(tags.highway)) return null;
                return {
                    feature,
                    sourceIndex: index,
                    osmWayId: osmWayId(feature, index),
                    coordinates,
                    nodeIds: wayNodeIds(feature, coordinates.length),
                    tags
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.osmWayId.localeCompare(b.osmWayId, undefined, { numeric: true }));
    }

    function atomicSections(features) {
        const uses = new Map();
        features.forEach(way => {
            const seen = new Set();
            way.coordinates.forEach((point, index) => {
                const key = nodeKey(point, way.nodeIds?.[index]);
                if (seen.has(key)) return;
                seen.add(key);
                if (!uses.has(key)) uses.set(key, new Set());
                uses.get(key).add(way.osmWayId);
            });
        });

        const sections = [];
        features.forEach(way => {
            const splitIndexes = new Set([0, way.coordinates.length - 1]);
            way.coordinates.forEach((point, index) => {
                const key = nodeKey(point, way.nodeIds?.[index]);
                if ((uses.get(key)?.size || 0) > 1) splitIndexes.add(index);
            });
            const ordered = [...splitIndexes].sort((a, b) => a - b);
            for (let part = 1; part < ordered.length; part += 1) {
                const fromIndex = ordered[part - 1];
                const toIndex = ordered[part];
                if (toIndex <= fromIndex) continue;
                const coordinates = way.coordinates.slice(fromIndex, toIndex + 1);
                const startNodeId = way.nodeIds?.[fromIndex];
                const endNodeId = way.nodeIds?.[toIndex];
                const startNode = nodeKey(coordinates[0], startNodeId);
                const endNode = nodeKey(coordinates[coordinates.length - 1], endNodeId);
                sections.push({
                    id: `section:osm:${way.osmWayId}:${part - 1}:${startNode}:${endNode}`,
                    sourceWayId: way.osmWayId,
                    sourcePart: part - 1,
                    tags: { ...way.tags },
                    name: way.tags.name || null,
                    ref: way.tags.ref || null,
                    highway: way.tags.highway,
                    coordinates,
                    startNode,
                    endNode,
                    startNodeId: startNodeId || null,
                    endNodeId: endNodeId || null,
                    lengthM: lineLengthMeters(coordinates)
                });
            }
        });
        return sections.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    }

    function applyLaneEvidence(lanes, tags, direction) {
        const ordered = lanes
            .filter(lane => lane.direction === direction)
            .sort((a, b) => direction === 'backward' ? b.stripIndex - a.stripIndex : a.stripIndex - b.stripIndex);
        const access = splitLaneTokens(tags, 'access:lanes', direction);
        const psv = splitLaneTokens(tags, 'psv:lanes', direction);
        const turns = splitLaneTokens(tags, 'turn:lanes', direction);
        const changes = splitLaneTokens(tags, 'change:lanes', direction);
        const embedded = splitLaneTokens(tags, 'embedded_rails:lanes', direction);
        const railway = splitLaneTokens(tags, 'railway:lanes', direction);

        ordered.forEach((lane, index) => {
            lane.ordinal = index;
            lane.access = access[index] || 'yes';
            lane.psv = psv[index] || null;
            lane.turn = turns[index] || null;
            lane.change = changes[index] || null;
            lane.embeddedRail = tokenHasRail(embedded[index]) || tokenHasRail(railway[index]);
            const psvOnly = ['no', 'private'].includes(lane.access) && tokenAllowsPsv(lane.psv);
            if (psvOnly) {
                lane.type = 'bus';
                lane.access = 'psv';
            }
        });
    }


    // options.parcelFit = { parcels, turf, project, fit } — absent means no parcel evidence, which
    // is a normal state (any city but Zagreb), not a failure. Reports the disagreement either way:
    // narrowing the road without saying why would hide that the lane count and the land conflict.
    // Local, not corridor-profile's parseOsmNumber: that is a browser global here and undefined
    // under node, so borrowing it would throw only in tests and only on the tagged-width path.
    function taggedWidthMeters(tags) {
        const raw = tags?.width;
        if (raw === undefined || raw === null) return null;
        const parsed = Number.parseFloat(String(raw).replace(',', '.'));
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function applyParcelConstraint(profile, section, options, problems) {
        const config = options.parcelFit;
        const fitApi = config && (config.fit || root.LaneParcelFit);
        if (!config || !fitApi || !Array.isArray(config.parcels) || !config.parcels.length) return profile;
        if (!Array.isArray(section.coordinates) || section.coordinates.length < 2) return profile;
        const project = config.project;
        if (typeof project !== 'function') return profile;

        // Project the parcels HERE, not at the call site. A lat/lng ring measured against a
        // centreline in metres yields distances around 15.99 — plausible enough to raise no
        // problem at all, which is how this first shipped silently doing nothing. Memoised on the
        // config so the whole parcel set is projected once per build, not once per section.
        if (!config.projectedParcels) {
            config.projectedParcels = config.parcels.map(parcel => ({
                ...parcel,
                rings: (parcel.rings || [])
                    .filter(ring => Array.isArray(ring) && ring.length >= 3)
                    .map(ring => ring.map(project))
            })).filter(parcel => parcel.rings.length);
        }
        const parcels = config.projectedParcels;
        if (!parcels.length) return profile;

        const lanes = stripSpans(profile)
            .filter(span => span.type === 'driving' || span.type === 'bus')
            .map(span => ({ offset: span.offset, width: span.width }));
        if (!lanes.length) return profile;

        const fit = fitApi.fitSectionToParcels(
            section.coordinates.map(project), lanes, parcels, { turf: config.turf }
        );
        const problem = fitApi.parcelFitProblem(section, fit, parcels, { turf: config.turf });
        if (problem) problems.push(problem);
        const scaled = fitApi.scaleProfileToFit(profile, fit, {});
        section.parcelNarrowed = !!scaled.scaled;
        if (scaled.scaled && problem) {
            problem.narrowedToFit = true;
            problem.widthScale = scaled.scale;
            // The parcel cannot hold this many lanes even at minimum width, so the COUNT is what
            // disagrees with the land, not the widths. A different fix, and worth saying so.
            if (scaled.flooredBelowParcel) problem.severity = 'error';
        }
        return scaled.profile;
    }

    function sectionLanes(section, options, problems) {
        const counts = deriveLaneCounts(section.tags);
        if (counts.contradictory) {
            problems.push({
                id: `problem:lane-count:${section.id}`,
                type: 'contradictory_lane_counts',
                severity: 'error',
                point: centroidOfCoordinates(section.coordinates),
                sectionIds: [section.id],
                sourceWayIds: [section.sourceWayId],
                message: `OSM lanes=${counts.totalTagged}, but directional tags sum to ${counts.total}.`
            });
        }

        const hasOpposingLanes = counts.oneway
            && ((section.tags.oneway === '-1' ? counts.forward : counts.backward) > 0);
        if (hasOpposingLanes) {
            const exception = section.tags['oneway:psv'] === 'no'
                || section.tags['oneway:bus'] === 'no'
                || section.tags['oneway:tram'] === 'no';
            problems.push({
                id: `problem:directional-exception:${section.id}`,
                type: exception ? 'directional_transit_exception' : 'oneway_direction_contradiction',
                severity: exception ? 'warning' : 'error',
                point: centroidOfCoordinates(section.coordinates),
                sectionIds: [section.id],
                sourceWayIds: [section.sourceWayId],
                message: exception
                    ? 'OSM describes opposing-direction restricted transit access on a generally one-way way; verify physically.'
                    : 'OSM describes opposing lanes on a one-way way without an explicit modal exception.'
            });
        }

        // The road parcel bounds the carriageway, so it constrains the cross-section BEFORE lanes
        // are derived from it — scaling the profile afterwards would leave lane offsets describing
        // a width the strips no longer have.
        const profile = applyParcelConstraint(
            profileForTags(section.tags, counts, options), section, options, problems
        );
        const spans = stripSpans(profile);
        const lanes = spans
            .filter(span => span.type === 'driving' || span.type === 'bus')
            .map(span => {
                const direction = span.direction || 'both';
                const travelCoordinates = direction === 'backward'
                    ? offsetCoordinates(section.coordinates, span.offset).reverse()
                    : offsetCoordinates(section.coordinates, span.offset);
                const fromNode = direction === 'backward' ? section.endNode : section.startNode;
                const toNode = direction === 'backward' ? section.startNode : section.endNode;
                return {
                    id: '',
                    sectionId: section.id,
                    sourceWayId: section.sourceWayId,
                    stripIndex: span.index,
                    ordinal: 0,
                    direction,
                    type: span.type,
                    width: span.width,
                    offset: span.offset,
                    access: 'yes',
                    psv: null,
                    turn: null,
                    change: null,
                    embeddedRail: !!span.embeddedRail,
                    fromNode,
                    toNode,
                    geometry: { type: 'LineString', coordinates: travelCoordinates }
                };
            });
        ['forward', 'backward', 'both'].forEach(direction => applyLaneEvidence(lanes, section.tags, direction));
        lanes.forEach(lane => {
            lane.id = `lane:${section.id}:${lane.direction}:${lane.ordinal}`;
            const span = spans.find(candidate => candidate.index === lane.stripIndex);
            if (span) {
                span.type = lane.type;
                span.direction = lane.direction;
                span.embeddedRail = lane.embeddedRail;
                span.access = lane.access;
            }
        });
        const provenance = (typeof root.LaneWidthProvenance === 'object' && root.LaneWidthProvenance)
            || (typeof require === 'function' ? require('./lane-width-provenance.js') : null);
        if (provenance) {
            section.widthSource = provenance.resolveWidthSource({
                parcelNarrowed: section.parcelNarrowed,
                taggedWidthM: taggedWidthMeters(section.tags)
            });
            lanes.forEach(lane => { lane.widthSource = section.widthSource; });
        }
        section.profile = {
            strips: spans.map(span => {
                const { left, right, offset, index, ...strip } = span;
                return strip;
            })
        };
        section.laneCounts = counts;
        section.laneIds = lanes.map(lane => lane.id);
        return lanes;
    }

    function endpointCoordinate(lane, atEnd) {
        const coordinates = lane.geometry.coordinates;
        return coordinates[atEnd ? coordinates.length - 1 : 0];
    }

    function pointDistanceMeters(a, b) {
        const meanLat = (a[1] + b[1]) * Math.PI / 360;
        return Math.hypot(
            (b[0] - a[0]) * 111320 * Math.cos(meanLat),
            (b[1] - a[1]) * 110540
        );
    }

    function connectSimpleNode(node, sectionsById, lanesBySection, connections, problems) {
        const sectionIds = [...new Set(node.sectionIds)];
        if (sectionIds.length !== 2 || node.degree !== 2) return;
        const lanes = sectionIds.flatMap(sectionId => lanesBySection.get(sectionId) || []);
        const incoming = lanes.filter(lane => lane.toNode === node.id && lane.direction !== 'both');
        const outgoing = lanes.filter(lane => lane.fromNode === node.id && lane.direction !== 'both');
        if (!incoming.length && !outgoing.length) return;

        const candidates = [];
        incoming.forEach(from => outgoing.forEach(to => {
            if (from.sectionId === to.sectionId) return;
            const distance = pointDistanceMeters(endpointCoordinate(from, true), endpointCoordinate(to, false));
            const sameAccess = from.access === to.access || from.access === 'yes' || to.access === 'yes';
            candidates.push({ from, to, distance: distance + (sameAccess ? 0 : 4) });
        }));
        candidates.sort((a, b) => a.distance - b.distance || a.from.id.localeCompare(b.from.id) || a.to.id.localeCompare(b.to.id));

        const usedIncoming = new Set();
        const usedOutgoing = new Set();
        candidates.forEach(candidate => {
            if (usedIncoming.has(candidate.from.id) || usedOutgoing.has(candidate.to.id)) return;
            usedIncoming.add(candidate.from.id);
            usedOutgoing.add(candidate.to.id);
            connections.push({
                id: `connection:${node.id}:${candidate.from.id}->${candidate.to.id}`,
                nodeId: node.id,
                fromLaneId: candidate.from.id,
                toLaneId: candidate.to.id,
                type: 'continue',
                priority: 'continuing',
                confidence: candidate.distance <= 2 ? 0.95 : 0.8,
                source: 'deterministic',
                geometry: {
                    type: 'LineString',
                    coordinates: [endpointCoordinate(candidate.from, true), endpointCoordinate(candidate.to, false)]
                }
            });
        });

        incoming.filter(lane => !usedIncoming.has(lane.id)).forEach(from => {
            const candidate = outgoing
                .map(to => ({ to, distance: pointDistanceMeters(endpointCoordinate(from, true), endpointCoordinate(to, false)) }))
                .sort((a, b) => a.distance - b.distance)[0];
            if (!candidate) return;
            connections.push({
                id: `connection:${node.id}:${from.id}->${candidate.to.id}`,
                nodeId: node.id,
                fromLaneId: from.id,
                toLaneId: candidate.to.id,
                type: 'merge',
                priority: 'yielding',
                confidence: 0.72,
                source: 'deterministic',
                geometry: {
                    type: 'LineString',
                    coordinates: [endpointCoordinate(from, true), endpointCoordinate(candidate.to, false)]
                }
            });
        });
        outgoing.filter(lane => !usedOutgoing.has(lane.id)).forEach(to => {
            const candidate = incoming
                .map(from => ({ from, distance: pointDistanceMeters(endpointCoordinate(from, true), endpointCoordinate(to, false)) }))
                .sort((a, b) => a.distance - b.distance)[0];
            if (!candidate) return;
            connections.push({
                id: `connection:${node.id}:${candidate.from.id}->${to.id}`,
                nodeId: node.id,
                fromLaneId: candidate.from.id,
                toLaneId: to.id,
                type: 'split',
                priority: 'branch',
                confidence: 0.72,
                source: 'deterministic',
                geometry: {
                    type: 'LineString',
                    coordinates: [endpointCoordinate(candidate.from, true), endpointCoordinate(to, false)]
                }
            });
        });

        const atNode = connections.filter(connection => connection.nodeId === node.id);
        const fanOut = new Map();
        const fanIn = new Map();
        atNode.forEach(connection => {
            fanOut.set(connection.fromLaneId, (fanOut.get(connection.fromLaneId) || 0) + 1);
            fanIn.set(connection.toLaneId, (fanIn.get(connection.toLaneId) || 0) + 1);
        });
        atNode.forEach(connection => {
            if ((fanOut.get(connection.fromLaneId) || 0) > 1) connection.type = 'split';
            if ((fanIn.get(connection.toLaneId) || 0) > 1) connection.type = 'merge';
        });
        const invalid = [
            ...[...fanOut].filter(([, count]) => count > 2).map(([laneId, count]) => ({ laneId, count, kind: 'split' })),
            ...[...fanIn].filter(([, count]) => count > 2).map(([laneId, count]) => ({ laneId, count, kind: 'merge' }))
        ];
        invalid.forEach(entry => problems.push({
            id: `problem:nonbinary:${node.id}:${entry.laneId}`,
            type: 'nonbinary_transition',
            severity: 'error',
            point: node.point,
            sectionIds,
            laneIds: [entry.laneId],
            message: `${entry.kind} has ${entry.count} successors/predecessors and must be staged into binary events.`
        }));

        const profiles = sectionIds.map(sectionId => sectionsById.get(sectionId)?.laneCounts?.total || 0);
        const sectionLengths = sectionIds.map(sectionId => sectionsById.get(sectionId)?.lengthM || Infinity);
        if (profiles[0] !== profiles[1] && Math.min(...sectionLengths) < 20) {
            problems.push({
                id: `problem:short-transition:${node.id}`,
                type: 'short_profile_transition',
                severity: 'warning',
                point: node.point,
                sectionIds,
                message: `Lane count changes ${profiles[0]}→${profiles[1]} beside a section shorter than 20 m; taper extent is not represented by OSM.`
            });
        }
    }

    // One reason has to stand for the node in the summary; the full per-approach list is beside it.
    function commonest(values) {
        const counts = new Map();
        values.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
            || 'no_approach_decidable';
    }

    function graphNodes(sections) {
        const nodes = new Map();
        const add = (id, point, sectionId) => {
            if (!nodes.has(id)) nodes.set(id, { id, point, sectionIds: [], degree: 0 });
            const node = nodes.get(id);
            node.sectionIds.push(sectionId);
            node.degree += 1;
        };
        sections.forEach(section => {
            add(section.startNode, section.coordinates[0], section.id);
            add(section.endNode, section.coordinates[section.coordinates.length - 1], section.id);
        });
        return [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    }

    function boundsOf(features) {
        const coordinates = features.flatMap(feature => feature.coordinates);
        if (!coordinates.length) return null;
        return coordinates.reduce((bounds, point) => ({
            west: Math.min(bounds.west, point[0]),
            south: Math.min(bounds.south, point[1]),
            east: Math.max(bounds.east, point[0]),
            north: Math.max(bounds.north, point[1])
        }), { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity });
    }

    function build(input, options = {}) {
        const features = normalizeInputFeatures(input);
        const sections = atomicSections(features);
        const problems = [];
        if (features.some(feature => !feature.nodeIds)) {
            const allCoordinates = features.flatMap(feature => feature.coordinates);
            problems.push({
                id: 'problem:source-node-ids',
                type: 'missing_osm_node_ids',
                severity: 'warning',
                point: centroidOfCoordinates(allCoordinates),
                sourceWayIds: features.filter(feature => !feature.nodeIds).map(feature => feature.osmWayId),
                message: 'The source table omitted ordered OSM node IDs; exact coordinate identity is being used as a temporary fallback.'
            });
        }

        const lanes = [];
        const lanesBySection = new Map();
        sections.forEach(section => {
            const built = sectionLanes(section, options, problems);
            lanes.push(...built);
            lanesBySection.set(section.id, built);
        });
        const nodes = graphNodes(sections);
        const connections = [];
        const sectionsById = new Map(sections.map(section => [section.id, section]));
        nodes.forEach(node => connectSimpleNode(node, sectionsById, lanesBySection, connections, problems));

        // A junction with one lane per direction on every arm has no lane assignment to decide, so
        // it is settled here rather than queued for recognition. Everything the rules decline stays
        // unresolved, and that residue IS the recognition queue.
        const rules = junctionRulesModule();
        const restrictionsByNode = rules.indexRestrictions(options.restrictions);
        let resolvedIntersections = 0;
        let partialIntersections = 0;
        nodes.filter(node => node.degree > 2).forEach(node => {
            const outcome = rules.resolveNode(node, { sectionsById, lanesBySection, restrictionsByNode });
            connections.push(...(outcome.connections || []));
            const open = outcome.open || [];
            if (!outcome.declined && !open.length) {
                resolvedIntersections += 1;
                return;
            }
            if (outcome.connections?.length) partialIntersections += 1;
            // An EMPTY openApproaches means the whole node is open — nothing here could be looked
            // at. A populated one means only those approaches are; the rest are settled above and a
            // consumer must not reopen them.
            const reason = outcome.declined || commonest(open.map(entry => entry.reason));
            const nodeLanes = [...new Set(node.sectionIds || [])]
                .flatMap(sectionId => lanesBySection.get(sectionId) || []);
            problems.push({
                id: `problem:unresolved-intersection:${node.id}`,
                type: 'unresolved_intersection',
                severity: 'warning',
                point: node.point,
                nodeIds: [node.id],
                sectionIds: node.sectionIds,
                // What the rules could not settle, so a caller can route the node to a model, to a
                // split, or to a person instead of treating every unsolved junction alike.
                declineReason: reason,
                // ...and whether routing it anywhere could help. A node whose open approaches have
                // no movement in question — three ways meet but only one carries lanes, so the only
                // way out is back — is still reported, because the rules genuinely could not settle
                // it, but it is not WORK: no answer exists for a model or a person to give. Counting
                // it as work left junctions that could never be closed, and tiles that could never
                // reach 100%.
                decidable: rules.decisionSurface(node, nodeLanes, open) > 0,
                openApproaches: open,
                message: open.length && outcome.connections?.length
                    ? `${node.degree} road arms meet here; ${open.length} of ${open.length
                        + new Set((outcome.connections || []).map(connection => connection.fromLaneId)).size} `
                        + `approaches are still undecided (${reason.replaceAll('_', ' ')}).`
                    : `${node.degree} road arms meet here; lane-to-lane movements have not been `
                        + `inferred yet (${reason.replaceAll('_', ' ')}).`
            });
        });

        const outgoingCounts = new Map();
        const incomingCounts = new Map();
        connections.forEach(connection => {
            outgoingCounts.set(connection.fromLaneId, (outgoingCounts.get(connection.fromLaneId) || 0) + 1);
            incomingCounts.set(connection.toLaneId, (incomingCounts.get(connection.toLaneId) || 0) + 1);
        });

        const graph = {
            schemaVersion: SCHEMA_VERSION,
            generatedAt: options.generatedAt || new Date().toISOString(),
            source: {
                kind: 'osm',
                snapshotAt: options.snapshotAt || null,
                nodeIdentity: features.every(feature => !!feature.nodeIds) ? 'osm-node-id' : 'coordinate-fallback',
                wayIds: features.map(feature => feature.osmWayId)
            },
            coverage: boundsOf(features),
            sections,
            nodes,
            lanes,
            connections,
            problems: problems.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
            stats: {
                sourceWays: features.length,
                sections: sections.length,
                nodes: nodes.length,
                lanes: lanes.length,
                connections: connections.length,
                problems: problems.length,
                unresolvedIntersections: problems.filter(problem => problem.type === 'unresolved_intersection').length,
                resolvedIntersections,
                // Junctions where some approaches are settled and others are not. They count as
                // unresolved — there is still work there — but they are not untouched.
                partialIntersections,
                errors: problems.filter(problem => problem.severity === 'error').length,
                warnings: problems.filter(problem => problem.severity === 'warning').length
            }
        };

        // Answers a person already gave, folded in before the lane tallies below are taken — a
        // decision adds real movements, and a lane whose only movement came from one would
        // otherwise still count as going nowhere.
        if (options.decisions?.length) {
            graph.decisions = decisionsModule().applyDecisions(graph, options.decisions);
            graph.connections.forEach(connection => {
                if (connection.source === 'deterministic') return;
                outgoingCounts.set(connection.fromLaneId, (outgoingCounts.get(connection.fromLaneId) || 0) + 1);
                incomingCounts.set(connection.toLaneId, (incomingCounts.get(connection.toLaneId) || 0) + 1);
            });
        }

        // Derived counts are useful to the viewer but do not affect graph identity.
        graph.lanes.forEach(lane => {
            lane.incomingConnections = incomingCounts.get(lane.id) || 0;
            lane.outgoingConnections = outgoingCounts.get(lane.id) || 0;
        });
        return graph;
    }

    return {
        SCHEMA_VERSION,
        DRIVEABLE_HIGHWAYS,
        build,
        deriveLaneCounts,
        lineLengthMeters,
        coordinateKey
    };
});
