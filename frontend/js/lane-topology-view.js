(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LaneTopologyView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function createIndex(graph) {
        const lanes = new Map((graph?.lanes || []).map(lane => [lane.id, lane]));
        const connections = new Map(
            (graph?.connections || []).map(connection => [connection.id, connection])
        );
        const nodes = new Map((graph?.nodes || []).map(node => [node.id, node]));
        const incomingByLane = new Map();
        const outgoingByLane = new Map();
        const connectionsByNode = new Map();

        connections.forEach(connection => {
            if (!incomingByLane.has(connection.toLaneId)) incomingByLane.set(connection.toLaneId, []);
            if (!outgoingByLane.has(connection.fromLaneId)) outgoingByLane.set(connection.fromLaneId, []);
            if (!connectionsByNode.has(connection.nodeId)) connectionsByNode.set(connection.nodeId, []);
            incomingByLane.get(connection.toLaneId).push(connection);
            outgoingByLane.get(connection.fromLaneId).push(connection);
            connectionsByNode.get(connection.nodeId).push(connection);
        });

        return { lanes, connections, nodes, incomingByLane, outgoingByLane, connectionsByNode };
    }

    function emptyFocus(kind, id) {
        return {
            kind,
            id,
            laneIds: new Set(),
            connectionIds: new Set(),
            nodeIds: new Set()
        };
    }

    function addConnection(focus, connection) {
        if (!connection) return;
        focus.connectionIds.add(connection.id);
        focus.laneIds.add(connection.fromLaneId);
        focus.laneIds.add(connection.toLaneId);
        if (connection.nodeId) focus.nodeIds.add(connection.nodeId);
    }

    function focusLane(index, laneId) {
        const focus = emptyFocus('lane', laneId);
        const lane = index?.lanes?.get(laneId);
        if (!lane) return focus;
        focus.laneIds.add(laneId);
        if (lane.fromNode) focus.nodeIds.add(lane.fromNode);
        if (lane.toNode) focus.nodeIds.add(lane.toNode);
        (index.incomingByLane.get(laneId) || []).forEach(connection => addConnection(focus, connection));
        (index.outgoingByLane.get(laneId) || []).forEach(connection => addConnection(focus, connection));
        return focus;
    }

    function focusConnection(index, connectionId) {
        const focus = emptyFocus('connection', connectionId);
        addConnection(focus, index?.connections?.get(connectionId));
        return focus;
    }

    function focusNode(index, nodeId) {
        const focus = emptyFocus('node', nodeId);
        if (!index?.nodes?.has(nodeId) && !index?.connectionsByNode?.has(nodeId)) return focus;
        focus.nodeIds.add(nodeId);
        (index.connectionsByNode.get(nodeId) || []).forEach(connection => addConnection(focus, connection));
        return focus;
    }

    function focusFor(index, kind, id) {
        if (kind === 'lane') return focusLane(index, id);
        if (kind === 'connection') return focusConnection(index, id);
        if (kind === 'node') return focusNode(index, id);
        return emptyFocus(kind, id);
    }

    function coordinatesOf(lane) {
        const coordinates = lane?.geometry?.coordinates;
        return Array.isArray(coordinates) ? coordinates : [];
    }

    function localProjection(points) {
        const latitude = points.reduce((sum, point) => sum + Number(point?.[1] || 0), 0)
            / Math.max(1, points.length);
        const xScale = 111320 * Math.cos(latitude * Math.PI / 180);
        const yScale = 110540;
        return {
            project(point) {
                return [Number(point[0]) * xScale, Number(point[1]) * yScale];
            },
            unproject(point) {
                return [point[0] / xScale, point[1] / yScale];
            }
        };
    }

    function normalize(vector) {
        const length = Math.hypot(vector[0], vector[1]);
        if (length < 1e-9) return [0, 0];
        return [vector[0] / length, vector[1] / length];
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function cross(a, b) {
        return a[0] * b[1] - a[1] * b[0];
    }

    function turnHandleLengths(start, end, inbound, outbound, chord) {
        const denominator = cross(inbound, outbound);
        if (Math.abs(denominator) < .08) return null;
        const delta = [end[0] - start[0], end[1] - start[1]];
        const distanceFromStartToCorner = cross(delta, outbound) / denominator;
        const distanceFromEndToCorner = cross(inbound, delta) / denominator;
        const reasonableLimit = Math.max(chord * 4, 20);
        if (
            distanceFromStartToCorner <= .05
            || distanceFromEndToCorner <= .05
            || distanceFromStartToCorner > reasonableLimit
            || distanceFromEndToCorner > reasonableLimit
        ) {
            return null;
        }

        // A quarter-circle fillet uses handles ≈ 0.552 times the distance from each tangent
        // point to their intersection. Keeping both controls between the lane ends and that
        // inner corner prevents the turn from bowing around the outside of the junction.
        return [
            clamp(distanceFromStartToCorner * .552, .05, 14),
            clamp(distanceFromEndToCorner * .552, .05, 14)
        ];
    }

    // The curve a movement traces between two points with known headings: leaves `start` along the
    // heading it arrived on, meets `end` along the heading it leaves on. Shared so a junction guide
    // line and a connection overlay cannot drift into two different ideas of the same turn.
    function curveBetween(start, before, end, after, options) {
        const sampleCount = Number.isFinite(Number(options?.sampleCount)) ? Number(options.sampleCount) : 16;
        const isTurn = !!options?.turn;
        const projection = localProjection([start, before, end, after]);
        const p0 = projection.project(start);
        const p3 = projection.project(end);
        const inbound = normalize([p0[0] - projection.project(before)[0], p0[1] - projection.project(before)[1]]);
        const outbound = normalize([projection.project(after)[0] - p3[0], projection.project(after)[1] - p3[1]]);
        const chord = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
        const defaultHandle = clamp(Math.max(chord * 0.55, 1.8), 1.8, 14);
        const turnHandles = isTurn
            ? turnHandleLengths(p0, p3, inbound, outbound, chord)
            : null;
        const startHandle = turnHandles?.[0] ?? defaultHandle;
        const endHandle = turnHandles?.[1] ?? defaultHandle;
        const p1 = [p0[0] + inbound[0] * startHandle, p0[1] + inbound[1] * startHandle];
        const p2 = [p3[0] - outbound[0] * endHandle, p3[1] - outbound[1] * endHandle];
        const count = clamp(Math.round(sampleCount), 4, 32);
        const result = [];

        for (let indexPosition = 0; indexPosition <= count; indexPosition += 1) {
            const t = indexPosition / count;
            const inverse = 1 - t;
            result.push(projection.unproject([
                inverse ** 3 * p0[0]
                    + 3 * inverse ** 2 * t * p1[0]
                    + 3 * inverse * t ** 2 * p2[0]
                    + t ** 3 * p3[0],
                inverse ** 3 * p0[1]
                    + 3 * inverse ** 2 * t * p1[1]
                    + 3 * inverse * t ** 2 * p2[1]
                    + t ** 3 * p3[1]
            ]));
        }
        result[0] = start;
        result[result.length - 1] = end;
        return result;
    }

    function connectionCurve(connection, index, sampleCount = 16) {
        const fromCoordinates = coordinatesOf(index?.lanes?.get(connection?.fromLaneId));
        const toCoordinates = coordinatesOf(index?.lanes?.get(connection?.toLaneId));
        const fallback = connection?.geometry?.coordinates || [];
        if (fromCoordinates.length < 2 || toCoordinates.length < 2) return fallback;
        return curveBetween(
            fromCoordinates[fromCoordinates.length - 1],
            fromCoordinates[fromCoordinates.length - 2],
            toCoordinates[0],
            toCoordinates[1],
            { sampleCount, turn: connection?.type === 'turn' }
        );
    }

    function pointAlong(coordinates, fraction = 0.5) {
        if (!Array.isArray(coordinates) || !coordinates.length) return null;
        if (coordinates.length === 1) {
            return { point: coordinates[0], before: coordinates[0], after: coordinates[0] };
        }
        const projection = localProjection(coordinates);
        const projected = coordinates.map(projection.project);
        const lengths = [];
        let total = 0;
        for (let index = 1; index < projected.length; index += 1) {
            const length = Math.hypot(
                projected[index][0] - projected[index - 1][0],
                projected[index][1] - projected[index - 1][1]
            );
            lengths.push(length);
            total += length;
        }
        if (total < 1e-9) {
            return {
                point: coordinates[0],
                before: coordinates[0],
                after: coordinates[coordinates.length - 1]
            };
        }
        const target = clamp(Number(fraction) || 0, 0, 1) * total;
        let traversed = 0;
        for (let index = 0; index < lengths.length; index += 1) {
            const next = traversed + lengths[index];
            if (target <= next || index === lengths.length - 1) {
                const ratio = lengths[index] ? (target - traversed) / lengths[index] : 0;
                return {
                    point: [
                        coordinates[index][0] + (coordinates[index + 1][0] - coordinates[index][0]) * ratio,
                        coordinates[index][1] + (coordinates[index + 1][1] - coordinates[index][1]) * ratio
                    ],
                    before: coordinates[index],
                    after: coordinates[index + 1]
                };
            }
            traversed = next;
        }
        return null;
    }

    function trimCoordinates(coordinates, startTrimM = 0, endTrimM = 0) {
        if (!Array.isArray(coordinates) || coordinates.length < 2) return coordinates || [];
        const projection = localProjection(coordinates);
        const projected = coordinates.map(point => projection.project(point));
        const cumulative = [0];
        for (let index = 1; index < projected.length; index += 1) {
            cumulative.push(cumulative[index - 1] + Math.hypot(
                projected[index][0] - projected[index - 1][0],
                projected[index][1] - projected[index - 1][1]
            ));
        }
        const total = cumulative[cumulative.length - 1];
        if (total < .01) return coordinates;
        let start = clamp(Number(startTrimM) || 0, 0, total);
        let end = clamp(Number(endTrimM) || 0, 0, total);
        const maximumTrim = Math.max(0, total - Math.min(1, total * .2));
        if (start + end > maximumTrim && start + end > 0) {
            const scale = maximumTrim / (start + end);
            start *= scale;
            end *= scale;
        }
        const stop = total - end;

        function pointAtDistance(distance) {
            for (let index = 1; index < cumulative.length; index += 1) {
                if (distance > cumulative[index] && index < cumulative.length - 1) continue;
                const span = cumulative[index] - cumulative[index - 1];
                const ratio = span ? (distance - cumulative[index - 1]) / span : 0;
                return [
                    coordinates[index - 1][0]
                        + (coordinates[index][0] - coordinates[index - 1][0]) * ratio,
                    coordinates[index - 1][1]
                        + (coordinates[index][1] - coordinates[index - 1][1]) * ratio
                ];
            }
            return coordinates[coordinates.length - 1];
        }

        const result = [pointAtDistance(start)];
        for (let index = 1; index < coordinates.length - 1; index += 1) {
            if (cumulative[index] > start && cumulative[index] < stop) {
                result.push(coordinates[index]);
            }
        }
        result.push(pointAtDistance(stop));
        return result;
    }

    function junctionSetbacks(graph) {
        const nodes = new Map((graph?.nodes || []).map(node => [node.id, node]));
        const extents = new Map();
        (graph?.lanes || []).forEach(lane => {
            const outerExtent = Math.abs(Number(lane.offset) || 0)
                + Math.max(1.4, (Number(lane.width) || 3) / 2);
            [lane.fromNode, lane.toNode].forEach(nodeId => {
                if (!nodeId || Number(nodes.get(nodeId)?.degree || 0) <= 2) return;
                if (!extents.has(nodeId)) extents.set(nodeId, []);
                extents.get(nodeId).push(outerExtent);
            });
        });
        const setbacks = new Map();
        extents.forEach((values, nodeId) => {
            const node = nodes.get(nodeId);
            const widestApproachHalfWidth = Math.max(3, ...values);
            const degreeAllowance = Number(node?.degree || 0) >= 4 ? 1 : 0;
            setbacks.set(
                nodeId,
                clamp(widestApproachHalfWidth + 2.5 + degreeAllowance, 5.5, 14)
            );
        });
        return setbacks;
    }

    function buildDisplayGraph(graph) {
        if (!graph) return null;
        const setbacks = junctionSetbacks(graph);
        const lanes = (graph.lanes || []).map(lane => {
            const startSetbackM = setbacks.get(lane.fromNode) || 0;
            const endSetbackM = setbacks.get(lane.toNode) || 0;
            const coordinates = trimCoordinates(
                coordinatesOf(lane),
                startSetbackM,
                endSetbackM
            );
            return {
                ...lane,
                geometry: { ...lane.geometry, coordinates },
                displayPortal: {
                    startSetbackM,
                    endSetbackM
                }
            };
        });
        return {
            ...graph,
            lanes,
            display: {
                ...(graph.display || {}),
                junctionPortals: true,
                nodeSetbacksM: Object.fromEntries(setbacks)
            }
        };
    }

    // Below this, a trimmed section is junction interior rather than road, and painting it leaves a
    // stub floating in the middle of the intersection.
    const MIN_PAINTED_SECTION_LENGTH_M = 4;

    // Paint has to stop at the same junction portal the lanes are trimmed to. Section geometry runs
    // node to node, and the node a minor road shares with a major one sits on the MAJOR road's
    // centreline — so unclipped paint drives the minor road's markings into the middle of the major
    // carriageway, which is not how it is marked. trimCoordinates alone will not do: it always keeps
    // ~1 m so a lane never vanishes, and here a section swallowed by the junction must vanish.
    function paintableSections(graph, options) {
        if (!graph) return [];
        const minLengthM = Number.isFinite(Number(options?.minLengthM))
            ? Number(options.minLengthM)
            : MIN_PAINTED_SECTION_LENGTH_M;
        const setbacks = junctionSetbacks(graph);
        const entries = [];
        (graph.sections || []).forEach(section => {
            const coordinates = section?.coordinates;
            if (!Array.isArray(coordinates) || coordinates.length < 2) return;
            const startSetbackM = setbacks.get(section.startNode) || 0;
            const endSetbackM = setbacks.get(section.endNode) || 0;
            const lengthM = Number(section.lengthM);
            // A missing length must not become a real-looking survivor via 0 - setbacks.
            if (Number.isFinite(lengthM) && lengthM - startSetbackM - endSetbackM < minLengthM) return;
            entries.push({
                section,
                coordinates: trimCoordinates(coordinates, startSetbackM, endSetbackM),
                startSetbackM,
                endSetbackM
            });
        });
        return entries;
    }

    return {
        MIN_PAINTED_SECTION_LENGTH_M,
        createIndex,
        focusFor,
        focusLane,
        focusConnection,
        focusNode,
        localProjection,
        curveBetween,
        connectionCurve,
        pointAlong,
        trimCoordinates,
        junctionSetbacks,
        paintableSections,
        buildDisplayGraph
    };
});
