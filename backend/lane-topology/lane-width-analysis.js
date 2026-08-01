// Extracts conservative, road-aligned lane-width candidates from a north-up orthophoto crop.
// Measurements remain inspectable evidence; this module never mutates the lane topology graph.
import { createCanvas, loadImage } from 'canvas';

const EARTH_RADIUS_M = 6_371_008.8;
const DEFAULT_ALONG_STEP_M = 10;
const DEFAULT_WINDOW_LENGTH_M = 18;
const DEFAULT_ACROSS_RESOLUTION_M = 0.15;
const MIN_LANE_WIDTH_M = 2.2;
const MAX_LANE_WIDTH_M = 4.8;
const MIN_PEAK_SEPARATION_M = 0.75;
const MIN_PAINT_SCORE = 0.34;
const MAX_WAYS = 400;
const MAX_WIDTH_CANDIDATES = 3000;
const MAX_BOUNDARY_CANDIDATES = 6000;

export const LANE_WIDTH_ALGORITHM_VERSION = 'cdof-road-strip-v1';

function clamp(value, minimum = 0, maximum = 1) {
    return Math.max(minimum, Math.min(maximum, value));
}

function radians(value) {
    return value * Math.PI / 180;
}

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, fraction) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const position = clamp(fraction) * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function localFrame(bbox) {
    const [west, south, east, north] = bbox;
    const centerLon = (west + east) / 2;
    const centerLat = (south + north) / 2;
    const metresPerDegreeLat = EARTH_RADIUS_M * Math.PI / 180;
    const metresPerDegreeLon = metresPerDegreeLat * Math.cos(radians(centerLat));
    return {
        toLocal([lon, lat]) {
            return [
                (Number(lon) - centerLon) * metresPerDegreeLon,
                (Number(lat) - centerLat) * metresPerDegreeLat
            ];
        },
        toGeographic([x, y]) {
            return [
                Number((centerLon + x / metresPerDegreeLon).toFixed(9)),
                Number((centerLat + y / metresPerDegreeLat).toFixed(9))
            ];
        }
    };
}

function normalizedLineCoordinates(feature) {
    const geometry = feature?.geometry;
    if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)) return [];
    return geometry.coordinates
        .map(point => Array.isArray(point) ? point.slice(0, 2).map(Number) : null)
        .filter(point => point?.length === 2 && point.every(Number.isFinite));
}

function buildPolyline(coordinates, frame) {
    const points = [];
    coordinates.forEach(coordinate => {
        const point = frame.toLocal(coordinate);
        const previous = points[points.length - 1];
        if (!previous || Math.hypot(point[0] - previous[0], point[1] - previous[1]) > 0.05) {
            points.push(point);
        }
    });
    if (points.length < 2) return null;
    const cumulative = [0];
    for (let index = 1; index < points.length; index += 1) {
        cumulative.push(cumulative[index - 1] + Math.hypot(
            points[index][0] - points[index - 1][0],
            points[index][1] - points[index - 1][1]
        ));
    }
    const lengthM = cumulative[cumulative.length - 1];
    if (lengthM < 12) return null;

    function pointAt(chainageM) {
        const target = clamp(chainageM, 0, lengthM);
        let segment = 1;
        while (segment < cumulative.length - 1 && cumulative[segment] < target) segment += 1;
        const startDistance = cumulative[segment - 1];
        const segmentLength = cumulative[segment] - startDistance;
        const fraction = segmentLength > 0 ? (target - startDistance) / segmentLength : 0;
        return [
            points[segment - 1][0] + (points[segment][0] - points[segment - 1][0]) * fraction,
            points[segment - 1][1] + (points[segment][1] - points[segment - 1][1]) * fraction
        ];
    }

    function tangentAt(chainageM, baselineM = 5) {
        const before = pointAt(Math.max(0, chainageM - baselineM));
        const after = pointAt(Math.min(lengthM, chainageM + baselineM));
        const length = Math.hypot(after[0] - before[0], after[1] - before[1]) || 1;
        return [(after[0] - before[0]) / length, (after[1] - before[1]) / length];
    }

    return { points, lengthM, pointAt, tangentAt };
}

function laneCountFor(feature) {
    const tags = feature?.properties?.tags || {};
    const direct = Number.parseInt(tags.lanes, 10);
    if (Number.isFinite(direct) && direct > 0) return Math.min(16, direct);
    const forward = Number.parseInt(tags['lanes:forward'], 10);
    const backward = Number.parseInt(tags['lanes:backward'], 10);
    const sum = (Number.isFinite(forward) ? forward : 0) + (Number.isFinite(backward) ? backward : 0);
    return sum > 0 ? Math.min(16, sum) : null;
}

function imageSampler(imageData, imagery) {
    const width = Number(imageData?.width);
    const height = Number(imageData?.height);
    const data = imageData?.data;
    const bbox = imagery?.bbox?.map(Number);
    if (!Number.isFinite(width) || !Number.isFinite(height) || !data || bbox?.length !== 4) {
        throw new Error('Lane-width analysis requires decoded RGBA image data and its WGS84 bbox.');
    }
    const [west, south, east, north] = bbox;

    return function sample([lon, lat]) {
        const x = (lon - west) / (east - west) * (width - 1);
        const y = (north - lat) / (north - south) * (height - 1);
        if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return null;
        const left = Math.floor(x);
        const top = Math.floor(y);
        const right = Math.min(width - 1, left + 1);
        const bottom = Math.min(height - 1, top + 1);
        const xFraction = x - left;
        const yFraction = y - top;

        function channel(pixelX, pixelY, offset) {
            return data[(pixelY * width + pixelX) * 4 + offset];
        }

        return [0, 1, 2].map(offset => {
            const topValue = channel(left, top, offset) * (1 - xFraction)
                + channel(right, top, offset) * xFraction;
            const bottomValue = channel(left, bottom, offset) * (1 - xFraction)
                + channel(right, bottom, offset) * xFraction;
            return topValue * (1 - yFraction) + bottomValue * yFraction;
        });
    };
}

function luminance(rgb) {
    return rgb ? rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 : null;
}

function paintScore(rgb, neighbourA, neighbourB) {
    if (!rgb || !neighbourA || !neighbourB) return null;
    const value = luminance(rgb);
    const background = (luminance(neighbourA) + luminance(neighbourB)) / 2;
    const saturation = Math.max(...rgb) - Math.min(...rgb);
    const brightness = clamp((value - 95) / 105);
    const contrast = clamp((value - background - 4) / 45);
    const neutral = clamp(1 - saturation / 85);
    return Math.sqrt(brightness * contrast) * neutral;
}

function aggregatePaintProfile({
    center,
    tangent,
    frame,
    sampleImage,
    acrossOffsets,
    alongOffsets,
    neighbourDistanceM
}) {
    const normal = [-tangent[1], tangent[0]];
    return acrossOffsets.map(acrossM => {
        const scores = [];
        let validRows = 0;
        alongOffsets.forEach(alongM => {
            const localPoint = [
                center[0] + tangent[0] * alongM + normal[0] * acrossM,
                center[1] + tangent[1] * alongM + normal[1] * acrossM
            ];
            const sideA = [
                localPoint[0] + normal[0] * neighbourDistanceM,
                localPoint[1] + normal[1] * neighbourDistanceM
            ];
            const sideB = [
                localPoint[0] - normal[0] * neighbourDistanceM,
                localPoint[1] - normal[1] * neighbourDistanceM
            ];
            const score = paintScore(
                sampleImage(frame.toGeographic(localPoint)),
                sampleImage(frame.toGeographic(sideA)),
                sampleImage(frame.toGeographic(sideB))
            );
            if (score == null) return;
            validRows += 1;
            scores.push(score);
        });
        if (validRows < Math.max(5, alongOffsets.length * 0.65)) {
            return { offsetM: acrossM, score: 0, recurrence: 0, validRows };
        }
        const recurrence = scores.filter(score => score >= 0.24).length / validRows;
        const strongMean = quantile(scores, 0.7) * 0.45 + quantile(scores, 0.9) * 0.55;
        const persistence = clamp((recurrence - 0.12) / 0.38);
        return {
            offsetM: acrossM,
            score: strongMean * persistence,
            recurrence,
            validRows
        };
    });
}

export function findPaintPeaks(profile, options = {}) {
    const minimumScore = Number(options.minimumScore) || MIN_PAINT_SCORE;
    const minimumSeparationM = Number(options.minimumSeparationM) || MIN_PEAK_SEPARATION_M;
    const localRadiusM = Number(options.localRadiusM) || 0.45;
    const stepM = profile.length > 1
        ? Math.abs(profile[1].offsetM - profile[0].offsetM)
        : DEFAULT_ACROSS_RESOLUTION_M;
    const radius = Math.max(1, Math.round(localRadiusM / stepM));
    const candidates = profile.filter((entry, index) => {
        if (entry.score < minimumScore || entry.recurrence < 0.2) return false;
        const start = Math.max(0, index - radius);
        const end = Math.min(profile.length - 1, index + radius);
        for (let neighbour = start; neighbour <= end; neighbour += 1) {
            if (profile[neighbour].score > entry.score) return false;
        }
        return true;
    }).sort((a, b) => b.score - a.score);

    const accepted = [];
    candidates.forEach(candidate => {
        if (accepted.some(entry => Math.abs(entry.offsetM - candidate.offsetM) < minimumSeparationM)) {
            return;
        }
        accepted.push(candidate);
    });
    return accepted.sort((a, b) => a.offsetM - b.offsetM);
}

function pointsAcross(center, normal, offsets, frame) {
    return offsets.map(offsetM => frame.toGeographic([
        center[0] + normal[0] * offsetM,
        center[1] + normal[1] * offsetM
    ]));
}

function boundaryFeature({
    wayId,
    chainageM,
    peak,
    polyline,
    normal,
    frame,
    laneCount,
    railInterference
}) {
    const start = polyline.pointAt(Math.max(0, chainageM - 4));
    const end = polyline.pointAt(Math.min(polyline.lengthM, chainageM + 4));
    const coordinates = [start, end].map(point => frame.toGeographic([
        point[0] + normal[0] * peak.offsetM,
        point[1] + normal[1] * peak.offsetM
    ]));
    return {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: {
            kind: 'paint_boundary',
            sourceWayId: wayId,
            chainageM: Number(chainageM.toFixed(1)),
            offsetM: Number(peak.offsetM.toFixed(2)),
            confidence: Number(clamp(peak.score * (railInterference ? 0.72 : 1)).toFixed(3)),
            recurrence: Number(peak.recurrence.toFixed(3)),
            osmLaneCount: laneCount,
            railInterference,
            algorithmVersion: LANE_WIDTH_ALGORITHM_VERSION
        }
    };
}

function measurementFeatures({
    wayId,
    chainageM,
    peaks,
    center,
    normal,
    frame,
    laneCount,
    railInterference
}) {
    const features = [];
    for (let index = 1; index < peaks.length; index += 1) {
        const left = peaks[index - 1];
        const right = peaks[index];
        const measuredWidthM = right.offsetM - left.offsetM;
        if (measuredWidthM < MIN_LANE_WIDTH_M || measuredWidthM > MAX_LANE_WIDTH_M) continue;
        const baseConfidence = clamp(
            0.25
            + Math.min(left.score, right.score) * 0.55
            + Math.min(left.recurrence, right.recurrence) * 0.2
        );
        const confidence = baseConfidence * (railInterference ? 0.72 : 1);
        features.push({
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: pointsAcross(center, normal, [left.offsetM, right.offsetM], frame)
            },
            properties: {
                kind: 'lane_width_candidate',
                measuredWidthM: Number(measuredWidthM.toFixed(2)),
                sourceWayId: wayId,
                chainageM: Number(chainageM.toFixed(1)),
                leftOffsetM: Number(left.offsetM.toFixed(2)),
                rightOffsetM: Number(right.offsetM.toFixed(2)),
                confidence: Number(confidence.toFixed(3)),
                basis: 'paint-to-paint',
                osmLaneCount: laneCount,
                railInterference,
                algorithmVersion: LANE_WIDTH_ALGORITHM_VERSION
            }
        });
    }
    return features;
}

function featureMidpoint(feature, frame) {
    const coordinates = feature.geometry?.coordinates || [];
    if (coordinates.length < 2) return null;
    const start = frame.toLocal(coordinates[0]);
    const end = frame.toLocal(coordinates[coordinates.length - 1]);
    return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
}

function deduplicateMeasurements(features, frame) {
    const accepted = [];
    [...features]
        .sort((a, b) => Number(b.properties?.confidence) - Number(a.properties?.confidence))
        .forEach(feature => {
            const midpoint = featureMidpoint(feature, frame);
            const width = Number(feature.properties?.measuredWidthM);
            if (!midpoint || !Number.isFinite(width)) return;
            const duplicate = accepted.some(existing => {
                const other = featureMidpoint(existing, frame);
                return Math.hypot(midpoint[0] - other[0], midpoint[1] - other[1]) < 1.1
                    && Math.abs(width - Number(existing.properties?.measuredWidthM)) < 0.25;
            });
            if (!duplicate) accepted.push(feature);
        });
    return accepted.sort((a, b) => (
        String(a.properties.sourceWayId).localeCompare(String(b.properties.sourceWayId))
        || a.properties.chainageM - b.properties.chainageM
        || a.properties.leftOffsetM - b.properties.leftOffsetM
    ));
}

function pointToPolylineDistance(point, polyline) {
    let minimum = Infinity;
    for (let index = 1; index < polyline.points.length; index += 1) {
        const start = polyline.points[index - 1];
        const end = polyline.points[index];
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const lengthSquared = dx * dx + dy * dy;
        const fraction = lengthSquared > 0
            ? clamp(((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared)
            : 0;
        const nearest = [start[0] + dx * fraction, start[1] + dy * fraction];
        minimum = Math.min(minimum, Math.hypot(point[0] - nearest[0], point[1] - nearest[1]));
    }
    return minimum;
}

function strongestFeatures(features, limit) {
    if (features.length <= limit) return features;
    return [...features]
        .sort((a, b) => Number(b.properties?.confidence) - Number(a.properties?.confidence))
        .slice(0, limit);
}

export function detectLaneWidthCandidates(imageData, imagery, osmWays, options = {}) {
    const startedAt = performance.now();
    const bbox = imagery?.bbox?.map(Number);
    if (bbox?.length !== 4 || bbox.some(value => !Number.isFinite(value))) {
        throw new Error('Lane-width analysis requires a finite imagery bbox.');
    }
    const frame = localFrame(bbox);
    const sampleImage = imageSampler(imageData, imagery);
    const alongStepM = clamp(Number(options.alongStepM) || DEFAULT_ALONG_STEP_M, 4, 30);
    const windowLengthM = clamp(Number(options.windowLengthM) || DEFAULT_WINDOW_LENGTH_M, 8, 30);
    const acrossResolutionM = clamp(
        Number(options.acrossResolutionM)
            || Math.max(DEFAULT_ACROSS_RESOLUTION_M, Number(imagery.effectiveGsdM) || 0),
        0.1,
        0.35
    );
    const alongResolutionM = Math.max(0.5, Number(imagery.effectiveGsdM) * 3 || 0.5);
    const alongOffsets = [];
    for (
        let offset = -windowLengthM / 2;
        offset <= windowLengthM / 2 + 0.001;
        offset += alongResolutionM
    ) {
        alongOffsets.push(offset);
    }

    const allWays = Array.isArray(osmWays?.features)
        ? osmWays.features
        : Array.isArray(osmWays) ? osmWays : [];
    const roadWays = allWays
        .filter(feature => feature?.properties?.highway_type || feature?.properties?.tags?.highway)
        .slice(0, MAX_WAYS);
    const railPolylines = allWays
        .filter(feature => feature?.properties?.railway_type || feature?.properties?.tags?.railway)
        .map(feature => buildPolyline(normalizedLineCoordinates(feature), frame))
        .filter(Boolean);
    const boundaries = [];
    const rawMeasurements = [];
    let windowsAnalyzed = 0;
    let waysMeasured = 0;

    roadWays.forEach(feature => {
        const coordinates = normalizedLineCoordinates(feature);
        const polyline = buildPolyline(coordinates, frame);
        if (!polyline) return;
        const laneCount = laneCountFor(feature);
        const halfSpanM = clamp((laneCount || 3) * 2.15 + 3.5, 7, 18);
        const acrossOffsets = [];
        for (let offset = -halfSpanM; offset <= halfSpanM + 0.001; offset += acrossResolutionM) {
            acrossOffsets.push(offset);
        }
        const marginM = Math.min(windowLengthM / 2, polyline.lengthM / 4);
        let wayMeasurements = 0;

        for (
            let chainageM = marginM;
            chainageM <= polyline.lengthM - marginM + 0.001;
            chainageM += alongStepM
        ) {
            const center = polyline.pointAt(chainageM);
            if (!sampleImage(frame.toGeographic(center))) continue;
            const tangent = polyline.tangentAt(chainageM);
            const normal = [-tangent[1], tangent[0]];
            const profile = aggregatePaintProfile({
                center,
                tangent,
                frame,
                sampleImage,
                acrossOffsets,
                alongOffsets,
                neighbourDistanceM: Math.max(0.45, acrossResolutionM * 3)
            });
            const peaks = findPaintPeaks(profile, options);
            windowsAnalyzed += 1;
            if (!peaks.length) continue;
            const wayId = String(feature.properties?.osm_id || feature.id || 'unknown');
            const railInterference = Boolean(
                feature.properties?.tags?.railway
                || feature.properties?.tags?.embedded_rails
                || feature.properties?.tags?.tram
                || railPolylines.some(rail => pointToPolylineDistance(center, rail) <= 4.5)
            );
            peaks.forEach(peak => boundaries.push(boundaryFeature({
                wayId,
                chainageM,
                peak,
                polyline,
                normal,
                frame,
                laneCount,
                railInterference
            })));
            const measured = measurementFeatures({
                wayId,
                chainageM,
                peaks,
                center,
                normal,
                frame,
                laneCount,
                railInterference
            });
            rawMeasurements.push(...measured);
            wayMeasurements += measured.length;
        }
        if (wayMeasurements) waysMeasured += 1;
    });

    const deduplicatedMeasurements = deduplicateMeasurements(rawMeasurements, frame);
    const measurements = strongestFeatures(
        deduplicatedMeasurements,
        MAX_WIDTH_CANDIDATES
    );
    const storedBoundaries = strongestFeatures(boundaries, MAX_BOUNDARY_CANDIDATES);
    const widths = measurements.map(feature => feature.properties.measuredWidthM);
    const confidenceValues = measurements.map(feature => feature.properties.confidence);
    const elapsedMs = performance.now() - startedAt;

    return {
        schemaVersion: 1,
        algorithm: {
            version: LANE_WIDTH_ALGORITHM_VERSION,
            method: 'road-aligned longitudinal paint recurrence',
            parameters: {
                alongStepM,
                windowLengthM,
                acrossResolutionM,
                minLaneWidthM: MIN_LANE_WIDTH_M,
                maxLaneWidthM: MAX_LANE_WIDTH_M,
                minPaintScore: Number(options.minimumScore) || MIN_PAINT_SCORE
            },
            limitations: [
                'Paint-to-paint spacing only; kerb and road-edge segmentation is not yet included.',
                'Vehicles, shadows, worn markings and tram rails can hide or imitate boundaries.',
                'Candidates require review and do not alter canonical lane geometry.'
            ]
        },
        source: {
            imagery: imagery.source || null,
            bbox,
            effectiveGsdM: imagery.effectiveGsdM,
            osmSnapshotAt: osmWays?.snapshotAt || null
        },
        measurements: {
            type: 'FeatureCollection',
            features: measurements
        },
        boundaries: {
            type: 'FeatureCollection',
            features: storedBoundaries
        },
        stats: {
            waysConsidered: roadWays.length,
            waysMeasured,
            windowsAnalyzed,
            boundaryCandidates: storedBoundaries.length,
            widthCandidates: measurements.length,
            truncated: boundaries.length > storedBoundaries.length
                || deduplicatedMeasurements.length > measurements.length,
            medianWidthM: widths.length ? Number(median(widths).toFixed(2)) : null,
            medianConfidence: confidenceValues.length
                ? Number(median(confidenceValues).toFixed(3))
                : null,
            runtimeMs: Number(elapsedMs.toFixed(1)),
            externalAiCostUsd: 0
        }
    };
}

export async function analyzeLaneWidths(imageBuffer, imagery, osmWays, options = {}) {
    const image = await loadImage(imageBuffer);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const imageData = context.getImageData(0, 0, image.width, image.height);
    return detectLaneWidthCandidates(imageData, imagery, osmWays, options);
}
