// Builds a smooth terrain-following road formation from one longitudinal set of stations.
// Pure planar math keeps terrain sampling, NoData policy, and ruled strip geometry testable.
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.__corridorTerrainFormation = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DEFAULT_MAX_SPACING_M = 4;
    const DEFAULT_SMOOTHING_RADIUS_STATIONS = 2;
    const DEFAULT_OUTLIER_THRESHOLD_M = 1.5;
    const DEFAULT_MAX_NODATA_GAP_M = 12;
    const EPSILON = 1e-9;

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function pointXY(value) {
        if (Array.isArray(value) && finite(value[0]) && finite(value[1])) {
            return [value[0], value[1]];
        }
        if (value && finite(value.x) && finite(value.y)) return [value.x, value.y];
        return null;
    }

    function normalise(vectorX, vectorY) {
        const length = Math.hypot(vectorX, vectorY);
        return length > EPSILON ? [vectorX / length, vectorY / length] : null;
    }

    function median(values) {
        const sorted = (values || []).filter(finite).slice().sort(function (a, b) { return a - b; });
        if (!sorted.length) return null;
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    function observedLowerQuantile(values, fraction) {
        const sorted = (values || []).filter(finite).slice().sort(function (a, b) { return a - b; });
        if (!sorted.length) return null;
        const q = Math.max(0, Math.min(1, finite(Number(fraction)) ? Number(fraction) : 0.5));
        // The seed must be an observed residual. Linear interpolation can land in the empty gap
        // between a small exposed-ground cluster and a much larger canopy cluster, causing the
        // subsequent coherence band to reject both groups.
        const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1));
        return sorted[index];
    }

    // DGU's profile endpoint returns true-metre chainages with nullable EVRF2000 elevations.
    // Interpolate only between nearby valid cells; a broad NoData area must fall back to the visible
    // Google profile rather than becoming an invented bridge across missing terrain.
    function referenceElevationAt(points, distanceM, maxGapM) {
        const distance = Number(distanceM);
        if (!finite(distance)) return null;
        const limit = finite(Number(maxGapM)) ? Math.max(0, Number(maxGapM)) : 40;
        const samples = (points || []).map(function (point) {
            const rawElevation = point
                ? (point.elevAslM ?? point.elevationM ?? point.elevation) : null;
            return {
                dM: Number(point && point.dM),
                elevation: rawElevation == null ? null : Number(rawElevation)
            };
        }).filter(function (point) { return finite(point.dM); })
            .sort(function (a, b) { return a.dM - b.dM; });
        if (!samples.length) return null;
        // The API measures geodesic chainage while the renderer uses a locally scaled Mercator
        // plane. Their endpoint lengths can differ by centimetres, so clamp only a very small
        // projection-tolerance overrun; genuine DGU NoData still remains NoData.
        const endpointToleranceM = Math.min(2, limit);
        const first = samples[0];
        const last = samples[samples.length - 1];
        if (distance < first.dM - EPSILON) {
            return first.dM - distance <= endpointToleranceM + EPSILON && finite(first.elevation)
                ? first.elevation : null;
        }
        if (distance > last.dM + EPSILON) {
            return distance - last.dM <= endpointToleranceM + EPSILON && finite(last.elevation)
                ? last.elevation : null;
        }
        let before = null;
        let after = null;
        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i];
            if (Math.abs(sample.dM - distance) <= EPSILON && finite(sample.elevation)) {
                return sample.elevation;
            }
            if (sample.dM <= distance && finite(sample.elevation)) before = sample;
            if (sample.dM >= distance && finite(sample.elevation)) {
                after = sample;
                break;
            }
        }
        if (!before || !after || after.dM - before.dM > limit + EPSILON) return null;
        if (Math.abs(after.dM - before.dM) <= EPSILON) return before.elevation;
        const t = (distance - before.dM) / (after.dM - before.dM);
        return before.elevation + (after.elevation - before.elevation) * t;
    }

    // Convert an absolute bare-earth reference profile into this Google tile session's arbitrary
    // local Z frame. Only one additive offset is fitted: metres remain 1:1, while a robust median
    // prevents a car, canopy or isolated bad ray from tilting the whole road. Returning null is an
    // explicit quality-gate failure; callers retain their already-valid Google formation.
    function calibrateReferenceFormation(referenceProfile, visibleProfile, options) {
        const opts = options || {};
        if (!referenceProfile || !referenceProfile.ok || !visibleProfile
            || !Array.isArray(referenceProfile.stations) || !Array.isArray(visibleProfile.stations)
            || referenceProfile.stations.length !== visibleProfile.stations.length) return null;
        const minimumPairs = finite(Number(opts.minimumPairs))
            ? Math.max(1, Math.floor(Number(opts.minimumPairs))) : 3;
        const minimumCoverage = finite(Number(opts.minimumCoverage))
            ? Math.max(0, Math.min(1, Number(opts.minimumCoverage))) : 0.5;
        const maximumMadM = finite(Number(opts.maximumMadM))
            ? Math.max(0, Number(opts.maximumMadM)) : 1.5;
        const pairs = [];
        referenceProfile.stations.forEach(function (station, index) {
            const visible = visibleProfile.stations[index];
            const referenceZ = station && station.z;
            const visibleZ = visible && visible.rawZ;
            if (!finite(referenceZ) || !finite(visibleZ)) return;
            pairs.push({ index: index, s: station.s, residual: visibleZ - referenceZ });
        });
        if (pairs.length < minimumPairs) return null;
        const routeLength = Math.max(EPSILON, Number(referenceProfile.length) || 0);
        const coverage = pairs.length > 1
            ? (pairs[pairs.length - 1].s - pairs[0].s) / routeLength : 0;
        if (coverage + EPSILON < minimumCoverage) return null;
        // A road through canopy can have more elevated Google samples than exposed-ground samples.
        // For a bare-earth reference, optionally fit the lowest coherent residual band instead of
        // the route-wide median. Top-hit Google rays are one-sided: foliage raises them, while the
        // lower residual cluster is where the two sources can actually describe the same ground.
        const lowerEnvelopeAnchors = opts.lowerEnvelopeAnchors === true;
        let calibrationPairs = pairs;
        if (lowerEnvelopeAnchors) {
            const anchorSeed = observedLowerQuantile(pairs.map(function (pair) { return pair.residual; }),
                finite(Number(opts.lowerQuantile)) ? Number(opts.lowerQuantile) : 0.25);
            const anchorBandM = finite(Number(opts.anchorBandM))
                ? Math.max(0, Number(opts.anchorBandM)) : 1;
            calibrationPairs = pairs.filter(function (pair) {
                return finite(anchorSeed) && Math.abs(pair.residual - anchorSeed) <= anchorBandM;
            });
            if (calibrationPairs.length < minimumPairs) return null;
        }
        const offset = median(calibrationPairs.map(function (pair) { return pair.residual; }));
        const mad = median(calibrationPairs.map(function (pair) {
            return Math.abs(pair.residual - offset);
        }));
        if (!finite(offset) || !finite(mad) || mad > maximumMadM + EPSILON) return null;
        const inlierToleranceM = lowerEnvelopeAnchors
            ? Math.max(0.25, mad * 3)
            : Math.max(2, mad * 3);
        const inliers = calibrationPairs.filter(function (pair) {
            return Math.abs(pair.residual - offset) <= inlierToleranceM;
        });
        if (inliers.length < minimumPairs) return null;
        if (!lowerEnvelopeAnchors && inliers.length / pairs.length < 0.6) return null;
        if (lowerEnvelopeAnchors) {
            const anchorCoverage = inliers.length > 1
                ? (inliers[inliers.length - 1].s - inliers[0].s) / routeLength : 0;
            if (anchorCoverage + EPSILON < minimumCoverage) return null;
        }
        const verticalOffsetM = finite(Number(opts.verticalOffsetM)) ? Number(opts.verticalOffsetM) : 0;
        const stations = referenceProfile.stations.map(function (station, index) {
            const visible = visibleProfile.stations[index] || {};
            return {
                ...station,
                referenceAslM: finite(station.rawZ) ? station.rawZ : null,
                googleRawZ: finite(visible.rawZ) ? visible.rawZ : null,
                rawZ: finite(visible.rawZ) ? visible.rawZ : null,
                filledZ: finite(visible.filledZ) ? visible.filledZ : null,
                z: finite(station.z) ? station.z + offset + verticalOffsetM : null
            };
        });
        return {
            ...referenceProfile,
            ok: stations.every(function (station) { return finite(station.z); }),
            reason: null,
            stations: stations,
            source: opts.source || 'dgu-calibrated-to-google',
            datum: opts.datum || 'EVRF2000',
            resolutionM: finite(Number(opts.resolutionM)) ? Number(opts.resolutionM) : null,
            calibrationOffsetM: offset,
            calibrationMadM: mad,
            calibrationPairs: pairs.length,
            calibrationInliers: inliers.length,
            calibrationLowerEnvelope: lowerEnvelopeAnchors,
            calibrationCoverage: coverage,
            verticalOffsetM: verticalOffsetM
        };
    }

    // Lowest profile reachable from both directions without exceeding a plausible road grade.
    // This is evidence only: it identifies abrupt elevated surface runs, but never becomes the road
    // height itself. Using it as a datum would recreate the rejected coarse/minimum-surface sag.
    function lowerMaximumGradeEnvelope(stations, values, maximumGrade) {
        const grade = finite(Number(maximumGrade)) ? Math.max(0, Number(maximumGrade)) : 0.2;
        const forward = values.slice();
        const backward = values.slice();
        for (let i = 1; i < values.length; i++) {
            if (!finite(forward[i]) || !finite(forward[i - 1])) continue;
            const ds = Math.max(0, stations[i].s - stations[i - 1].s);
            forward[i] = Math.min(forward[i], forward[i - 1] + grade * ds);
        }
        for (let i = values.length - 2; i >= 0; i--) {
            if (!finite(backward[i]) || !finite(backward[i + 1])) continue;
            const ds = Math.max(0, stations[i + 1].s - stations[i].s);
            backward[i] = Math.min(backward[i], backward[i + 1] + grade * ds);
        }
        return values.map(function (value, index) {
            if (!finite(value)) return null;
            const candidates = [value, forward[index], backward[index]].filter(finite);
            return candidates.length ? Math.min.apply(null, candidates) : null;
        });
    }

    // Fuse a DTM only where two independent signals identify an obstacle: calibrated DGU lies well
    // below Google's top surface AND that visible run rises faster than a plausible ground profile.
    // A low DGU artefact beneath level Google ground therefore has no longitudinal evidence and is
    // ignored. Accepted runs inherit DGU's relative shape, adjusted to meet the nearest trustworthy
    // Google-ground anchors continuously; all exposed-ground stations retain exact Google heights.
    function fitReferenceGroundFormation(referenceProfile, visibleProfile, options) {
        const opts = options || {};
        const failure = function (reason, details) {
            return { ok: false, reason: reason, ...(details || {}) };
        };
        if (!referenceProfile || !referenceProfile.ok || !visibleProfile || !visibleProfile.ok) {
            return failure('invalid-reference-or-visible-profile');
        }
        const visibleStations = Array.isArray(visibleProfile.stations) ? visibleProfile.stations : [];
        const referenceStations = Array.isArray(referenceProfile.stations) ? referenceProfile.stations : [];
        if (visibleStations.length < 2 || visibleStations.length !== referenceStations.length) {
            return failure('reference-station-mismatch');
        }
        const verticalOffsetM = finite(Number(opts.verticalOffsetM))
            ? Number(opts.verticalOffsetM)
            : (finite(Number(visibleProfile.verticalOffsetM)) ? Number(visibleProfile.verticalOffsetM) : 0);
        const calibrated = calibrateReferenceFormation(referenceProfile, visibleProfile, {
            ...opts,
            verticalOffsetM: verticalOffsetM,
            lowerEnvelopeAnchors: true
        });
        if (!calibrated || !calibrated.ok) return failure('reference-calibration-failed');

        const obstacleMinHeightM = finite(Number(opts.obstacleMinHeightM))
            ? Math.max(0, Number(opts.obstacleMinHeightM)) : 1.5;
        const agreementToleranceM = finite(Number(opts.agreementToleranceM))
            ? Math.max(0, Number(opts.agreementToleranceM)) : 0.75;
        const maximumGroundGrade = finite(Number(opts.maximumGroundGrade))
            ? Math.max(0, Number(opts.maximumGroundGrade)) : 0.2;
        const minimumPairs = finite(Number(opts.minimumPairs))
            ? Math.max(1, Math.floor(Number(opts.minimumPairs))) : 3;
        const minimumCoverage = finite(Number(opts.minimumCoverage))
            ? Math.max(0, Math.min(1, Number(opts.minimumCoverage))) : 0.1;
        const visibleSupport = visibleStations.map(function (station) {
            return finite(station && station.rawZ)
                ? station.rawZ + verticalOffsetM
                : (finite(station && station.z) ? station.z : null);
        });
        const gradeEnvelope = lowerMaximumGradeEnvelope(
            visibleStations, visibleSupport, maximumGroundGrade);
        const deltas = visibleSupport.map(function (value, index) {
            const referenceZ = calibrated.stations[index] && calibrated.stations[index].z;
            return finite(value) && finite(referenceZ) ? value - referenceZ : null;
        });
        const trustedAnchors = deltas.map(function (delta, index) {
            return finite(delta) && Math.abs(delta) <= agreementToleranceM ? index : null;
        }).filter(function (index) { return index !== null; });
        const routeLength = Math.max(EPSILON, Number(visibleProfile.length) || 0);
        const anchorCoverage = trustedAnchors.length > 1
            ? (visibleStations[trustedAnchors[trustedAnchors.length - 1]].s
                - visibleStations[trustedAnchors[0]].s) / routeLength
            : 0;
        if (trustedAnchors.length < minimumPairs || anchorCoverage + EPSILON < minimumCoverage) {
            return failure('insufficient-reference-anchors', {
                referenceAgreementAnchors: trustedAnchors.length,
                referenceAnchorCoverage: anchorCoverage
            });
        }

        const candidateRuns = [];
        let cursor = 0;
        while (cursor < deltas.length) {
            if (!(finite(deltas[cursor]) && deltas[cursor] >= obstacleMinHeightM)) {
                cursor += 1;
                continue;
            }
            const start = cursor;
            while (cursor + 1 < deltas.length && finite(deltas[cursor + 1])
                && deltas[cursor + 1] >= obstacleMinHeightM) cursor += 1;
            candidateRuns.push({ start: start, end: cursor });
            cursor += 1;
        }

        const acceptedRuns = candidateRuns.filter(function (run) {
            for (let index = run.start; index <= run.end; index++) {
                if (finite(visibleSupport[index]) && finite(gradeEnvelope[index])
                    && visibleSupport[index] - gradeEnvelope[index] >= obstacleMinHeightM) return true;
            }
            return false;
        });
        if (!acceptedRuns.length) return failure('no-obstacle-evidence');

        const replacementZ = new Map();
        acceptedRuns.forEach(function (run) {
            let leftAnchor = null;
            let rightAnchor = null;
            for (let index = run.start - 1; index >= 0; index--) {
                if (trustedAnchors.includes(index)) { leftAnchor = index; break; }
            }
            for (let index = run.end + 1; index < visibleStations.length; index++) {
                if (trustedAnchors.includes(index)) { rightAnchor = index; break; }
            }
            if (leftAnchor === null && rightAnchor === null) return;
            const leftCorrection = leftAnchor === null ? null : deltas[leftAnchor];
            const rightCorrection = rightAnchor === null ? null : deltas[rightAnchor];
            for (let index = run.start; index <= run.end; index++) {
                let correction = leftCorrection;
                if (!finite(correction)) correction = rightCorrection;
                if (finite(leftCorrection) && finite(rightCorrection)) {
                    const span = visibleStations[rightAnchor].s - visibleStations[leftAnchor].s;
                    const t = span > EPSILON
                        ? (visibleStations[index].s - visibleStations[leftAnchor].s) / span : 0;
                    correction = leftCorrection + (rightCorrection - leftCorrection) * t;
                }
                const referenceZ = calibrated.stations[index] && calibrated.stations[index].z;
                if (finite(referenceZ) && finite(correction)) replacementZ.set(index, referenceZ + correction);
            }
        });
        if (!replacementZ.size) return failure('obstacle-run-without-ground-anchor');

        // Re-run the existing longitudinal filters over the hybrid *support* sequence. The original
        // upper vertical-curve pass may already have propagated a canopy spike several stations into
        // exposed ground; merely replacing the canopy stations would leave those approach ramps in
        // place. Rebuilding from raw Google support plus DGU obstacle runs removes that contamination
        // while preserving the renderer's established outlier and vertical-curve policy.
        const hybridSupport = visibleSupport.map(function (value, index) {
            const replacement = replacementZ.get(index);
            return finite(replacement) ? replacement : value;
        });
        const refiltered = smoothFiniteRuns(
            visibleStations,
            hybridSupport,
            Math.max(0, Math.floor(Number(visibleProfile.smoothingRadiusStations) || 0)),
            finite(Number(visibleProfile.outlierThresholdM))
                ? Number(visibleProfile.outlierThresholdM) : DEFAULT_OUTLIER_THRESHOLD_M
        );
        const refinedSupport = applyVerticalCurveEnvelope(
            visibleStations,
            refiltered,
            Math.max(0, Math.floor(Number(visibleProfile.verticalCurvePasses) || 0))
        );
        if (visibleStations.length >= 4
            && Math.hypot(visibleStations[0].x - visibleStations[visibleStations.length - 1].x,
                visibleStations[0].y - visibleStations[visibleStations.length - 1].y) <= EPSILON
            && finite(refinedSupport[0]) && finite(refinedSupport[refinedSupport.length - 1])) {
            const seamZ = (refinedSupport[0] + refinedSupport[refinedSupport.length - 1]) / 2;
            refinedSupport[0] = seamZ;
            refinedSupport[refinedSupport.length - 1] = seamZ;
        }
        const stations = visibleStations.map(function (station, index) {
            const replacement = replacementZ.get(index);
            return {
                ...station,
                z: finite(refinedSupport[index]) ? refinedSupport[index] : station.z,
                googleSupportZ: visibleSupport[index],
                referenceZ: calibrated.stations[index] && calibrated.stations[index].z,
                groundSource: finite(replacement) ? 'dgu-bare-earth' : 'google-visible-mesh'
            };
        });
        return {
            ...visibleProfile,
            ok: stations.every(function (station) { return finite(station.z); }),
            stations: stations,
            source: opts.source || calibrated.source || 'dgu-dtm-20m',
            datum: opts.datum || calibrated.datum || null,
            resolutionM: calibrated.resolutionM,
            calibrationOffsetM: calibrated.calibrationOffsetM,
            calibrationMadM: calibrated.calibrationMadM,
            calibrationPairs: calibrated.calibrationPairs,
            calibrationInliers: calibrated.calibrationInliers,
            calibrationCoverage: calibrated.calibrationCoverage,
            referenceStatus: 'accepted-obstacle-filter',
            referenceAgreementAnchors: trustedAnchors.length,
            referenceAnchorCoverage: anchorCoverage,
            obstacleRuns: acceptedRuns.length,
            obstacleStations: replacementZ.size,
            obstacleMinHeightM: obstacleMinHeightM,
            maximumGroundGrade: maximumGroundGrade
        };
    }

    function applyStationFrame(station, previous, next) {
        let tangent = null;
        if (previous && next) tangent = normalise(previous[0] + next[0], previous[1] + next[1]);
        if (!tangent) tangent = next || previous || [1, 0];
        station.tangentX = tangent[0];
        station.tangentY = tangent[1];
        station.normalX = -tangent[1];
        station.normalY = tangent[0];
        // Intersect the incoming/outgoing offset lines at a shared mitre station. Clamping
        // prevents a near reversal from shooting the road edge to infinity.
        let scale = 1;
        if (previous && next) {
            const incomingNormal = [-previous[1], previous[0]];
            const cosine = station.normalX * incomingNormal[0] + station.normalY * incomingNormal[1];
            if (Math.abs(cosine) > 0.25) scale = Math.min(4, 1 / Math.abs(cosine));
        }
        station.normalScale = scale;
    }

    function assignStationFrames(stations) {
        for (let i = 0; i < stations.length; i++) {
            const station = stations[i];
            let previous = null;
            let next = null;
            for (let p = i - 1; p >= 0; p--) {
                const direction = normalise(station.x - stations[p].x, station.y - stations[p].y);
                if (direction) {
                    previous = direction;
                    break;
                }
            }
            for (let n = i + 1; n < stations.length; n++) {
                const direction = normalise(stations[n].x - station.x, stations[n].y - station.y);
                if (direction) {
                    next = direction;
                    break;
                }
            }

            applyStationFrame(station, previous, next);
        }
        // A closed line stores its first point again at the end. Give both copies the same cyclic
        // frame so lateral terrain probes and the final ruled join cannot disagree at the seam.
        if (stations.length >= 4) {
            const first = stations[0];
            const last = stations[stations.length - 1];
            if (Math.hypot(first.x - last.x, first.y - last.y) <= EPSILON) {
                const before = stations[stations.length - 2];
                const after = stations[1];
                const previous = normalise(first.x - before.x, first.y - before.y);
                const next = normalise(after.x - first.x, after.y - first.y);
                applyStationFrame(first, previous, next);
                applyStationFrame(last, previous, next);
            }
        }
        return stations;
    }

    // Every original vertex is retained exactly; only the interior of each source segment is
    // subdivided. Stations carry a left-handed road frame shared by all lateral strip bands.
    function densifyPolyline(pointsXY, maxSpacing, distanceScale) {
        const source = (pointsXY || []).map(pointXY);
        if (!source.length || source.some(function (point) { return !point; })) return [];
        const spacing = finite(maxSpacing) && maxSpacing > 0 ? maxSpacing : DEFAULT_MAX_SPACING_M;
        // Input coordinates may be Web Mercator scene metres. `distanceScale` converts one scene
        // unit to one true horizontal metre while x/y remain in the renderer's coordinate frame.
        const scale = finite(distanceScale) && distanceScale > 0 ? distanceScale : 1;
        const stations = [{
            x: source[0][0], y: source[0][1], point: source[0].slice(), s: 0,
            sourceIndex: 0, isSourceVertex: true
        }];
        let cumulative = 0;

        for (let i = 0; i < source.length - 1; i++) {
            const a = source[i];
            const b = source[i + 1];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const sceneLength = Math.hypot(dx, dy);
            const groundLength = sceneLength * scale;
            if (sceneLength <= EPSILON) {
                stations.push({
                    x: b[0], y: b[1], point: b.slice(), s: cumulative,
                    sourceIndex: i + 1, isSourceVertex: true
                });
                continue;
            }
            const intervals = Math.max(1, Math.ceil(groundLength / spacing));
            for (let step = 1; step <= intervals; step++) {
                const t = step / intervals;
                const sourceVertex = step === intervals;
                stations.push({
                    x: a[0] + dx * t,
                    y: a[1] + dy * t,
                    point: [a[0] + dx * t, a[1] + dy * t],
                    s: cumulative + groundLength * t,
                    sourceIndex: sourceVertex ? i + 1 : null,
                    isSourceVertex: sourceVertex
                });
            }
            cumulative += groundLength;
        }
        return assignStationFrames(stations);
    }

    function median(values) {
        if (!values.length) return NaN;
        const ordered = values.slice().sort(function (a, b) { return a - b; });
        const middle = Math.floor(ordered.length / 2);
        return ordered.length % 2
            ? ordered[middle]
            : (ordered[middle - 1] + ordered[middle]) / 2;
    }

    function boundedGapInterpolation(stations, sampled, maxGapM) {
        const filled = sampled.slice();
        const interpolated = new Array(sampled.length).fill(false);
        const unresolvedRanges = [];
        let index = 0;
        while (index < sampled.length) {
            if (finite(sampled[index])) {
                index++;
                continue;
            }
            const start = index;
            while (index < sampled.length && !finite(sampled[index])) index++;
            const end = index - 1;
            const left = start - 1;
            const right = index;
            const bounded = left >= 0 && right < sampled.length;
            const spanM = bounded ? stations[right].s - stations[left].s : Infinity;
            if (bounded && spanM <= maxGapM + EPSILON) {
                const denominator = stations[right].s - stations[left].s;
                for (let i = start; i <= end; i++) {
                    const t = denominator > EPSILON
                        ? (stations[i].s - stations[left].s) / denominator
                        : 0;
                    filled[i] = sampled[left] + (sampled[right] - sampled[left]) * t;
                    interpolated[i] = true;
                }
            } else {
                unresolvedRanges.push({
                    startIndex: start,
                    endIndex: end,
                    startS: stations[start].s,
                    endS: stations[end].s,
                    bounded: bounded,
                    spanM: spanM
                });
            }
        }
        return { values: filled, interpolated: interpolated, unresolvedRanges: unresolvedRanges };
    }

    // Reject only gross, locally unsupported mesh errors. A general moving average made genuine
    // Google terrain hollows disappear and detached the formation from the surface it was meant to
    // follow. Working on endpoint-line residuals preserves every steady grade exactly; a station is
    // replaced by its local median only when it differs by more than the explicit metre threshold.
    function smoothFiniteRuns(stations, values, radius, outlierThresholdM) {
        const result = values.slice();
        if (!(radius > 0)) return result;
        const threshold = finite(outlierThresholdM) && outlierThresholdM >= 0
            ? outlierThresholdM : DEFAULT_OUTLIER_THRESHOLD_M;
        let cursor = 0;
        while (cursor < values.length) {
            while (cursor < values.length && !finite(values[cursor])) cursor++;
            if (cursor >= values.length) break;
            const start = cursor;
            while (cursor < values.length && finite(values[cursor])) cursor++;
            const end = cursor - 1;
            if (end <= start) continue;

            const span = stations[end].s - stations[start].s;
            const residuals = new Array(end - start + 1);
            for (let i = start; i <= end; i++) {
                const t = span > EPSILON ? (stations[i].s - stations[start].s) / span : 0;
                const baseline = values[start] + (values[end] - values[start]) * t;
                residuals[i - start] = values[i] - baseline;
            }

            for (let local = 1; local < residuals.length - 1; local++) {
                const from = Math.max(0, local - radius);
                const to = Math.min(residuals.length - 1, local + radius);
                const localMedian = median(residuals.slice(from, to + 1));
                if (Math.abs(residuals[local] - localMedian) < threshold) continue;
                const globalIndex = start + local;
                const t = span > EPSILON
                    ? (stations[globalIndex].s - stations[start].s) / span
                    : 0;
                const baseline = values[start] + (values[end] - values[start]) * t;
                result[globalIndex] = baseline + localMedian;
            }
            result[start] = values[start];
            result[end] = values[end];
        }
        return result;
    }

    // A civil road should not reproduce every short concave photogrammetry facet. Repeated local
    // chord lifts form a bounded vertical-curve envelope: steady grades remain exact, narrow dips
    // rise toward their neighbours, and no station ever moves below its accepted Google support.
    function applyVerticalCurveEnvelope(stations, values, passes) {
        const count = Math.max(0, Math.floor(Number(passes) || 0));
        let result = values.slice();
        for (let pass = 0; pass < count; pass++) {
            const next = result.slice();
            for (let i = 1; i < result.length - 1; i++) {
                if (!finite(result[i - 1]) || !finite(result[i]) || !finite(result[i + 1])) continue;
                const span = stations[i + 1].s - stations[i - 1].s;
                if (!(span > EPSILON)) continue;
                const t = (stations[i].s - stations[i - 1].s) / span;
                const chord = result[i - 1] + (result[i + 1] - result[i - 1]) * t;
                next[i] = Math.max(result[i], (result[i] + chord) / 2);
            }
            result = next;
        }
        return result;
    }

    function buildFormation(pointsXY, sampleHeight, options) {
        const opts = options || {};
        const maxSpacingM = finite(opts.maxSpacingM) && opts.maxSpacingM > 0
            ? opts.maxSpacingM
            : DEFAULT_MAX_SPACING_M;
        const smoothingRadius = finite(opts.smoothingRadiusStations)
            ? Math.max(0, Math.floor(opts.smoothingRadiusStations))
            : DEFAULT_SMOOTHING_RADIUS_STATIONS;
        const outlierThresholdM = finite(opts.outlierThresholdM)
            ? Math.max(0, opts.outlierThresholdM)
            : DEFAULT_OUTLIER_THRESHOLD_M;
        const verticalCurvePasses = finite(Number(opts.verticalCurvePasses))
            ? Math.max(0, Math.floor(Number(opts.verticalCurvePasses))) : 0;
        const maxNoDataGapM = finite(opts.maxNoDataGapM)
            ? Math.max(0, opts.maxNoDataGapM)
            : DEFAULT_MAX_NODATA_GAP_M;
        const distanceScale = finite(opts.distanceScale) && opts.distanceScale > 0
            ? opts.distanceScale : 1;
        // The sampled values describe the visible terrain support. A small explicit formation
        // clearance may then lift the complete, already-smoothed road profile without changing
        // the raw Google readings used for diagnostics and outlier rejection.
        const verticalOffsetM = finite(opts.verticalOffsetM) ? opts.verticalOffsetM : 0;
        const stations = densifyPolyline(pointsXY, maxSpacingM, distanceScale);
        if (!stations.length) {
            return {
                ok: false, reason: 'invalid-centerline', stations: [], length: 0,
                maxSpacingM: maxSpacingM, unresolvedRanges: []
            };
        }

        const sampled = stations.map(function (station) {
            if (typeof sampleHeight !== 'function') return null;
            const value = sampleHeight(station.x, station.y, station);
            return finite(value) ? value : null;
        });
        const gaps = boundedGapInterpolation(stations, sampled, maxNoDataGapM);
        const outlierSmoothed = smoothFiniteRuns(
            stations, gaps.values, smoothingRadius, outlierThresholdM);
        const smoothed = applyVerticalCurveEnvelope(
            stations, outlierSmoothed, verticalCurvePasses);
        if (stations.length >= 4
            && Math.hypot(stations[0].x - stations[stations.length - 1].x,
                stations[0].y - stations[stations.length - 1].y) <= EPSILON
            && finite(smoothed[0]) && finite(smoothed[smoothed.length - 1])) {
            const seamZ = (smoothed[0] + smoothed[smoothed.length - 1]) / 2;
            smoothed[0] = seamZ;
            smoothed[smoothed.length - 1] = seamZ;
        }
        stations.forEach(function (station, index) {
            station.rawZ = finite(sampled[index]) ? sampled[index] : null;
            station.filledZ = finite(gaps.values[index]) ? gaps.values[index] : null;
            station.z = finite(smoothed[index]) ? smoothed[index] + verticalOffsetM : null;
            station.interpolated = gaps.interpolated[index];
        });
        const ok = stations.length >= 2 && gaps.unresolvedRanges.length === 0
            && stations.every(function (station) { return finite(station.z); });
        return {
            ok: ok,
            reason: ok ? null : (gaps.unresolvedRanges.length ? 'terrain-nodata-gap' : 'insufficient-centerline'),
            stations: stations,
            length: stations[stations.length - 1].s,
            maxSpacingM: maxSpacingM,
            distanceScale: distanceScale,
            verticalOffsetM: verticalOffsetM,
            smoothingRadiusStations: smoothingRadius,
            outlierThresholdM: outlierThresholdM,
            verticalCurvePasses: verticalCurvePasses,
            maxNoDataGapM: maxNoDataGapM,
            unresolvedRanges: gaps.unresolvedRanges
        };
    }

    // Separately fitted graph edges must meet at one exact road-node elevation. Only endpoint
    // coordinates participate: a nearby or crossing profile cannot pull a junction toward its
    // height merely because its line happens to project close to the node. Corrections taper
    // linearly through each affected profile so reconciliation does not create a first-segment kink.
    function reconcileProfileEndpointHeights(profiles, options) {
        const opts = options || {};
        const tolerance = finite(opts.coordinateTolerance)
            ? Math.max(0, opts.coordinateTolerance)
            : 1e-6;
        const uniqueProfiles = [];
        const seenProfiles = new Set();
        (profiles || []).forEach(function (profile) {
            if (!profile || seenProfiles.has(profile) || !Array.isArray(profile.stations)
                || profile.stations.length < 2) return;
            seenProfiles.add(profile);
            uniqueProfiles.push(profile);
        });

        const endpoints = [];
        uniqueProfiles.forEach(function (profile, profileIndex) {
            const lastIndex = profile.stations.length - 1;
            [[0, 'start'], [lastIndex, 'end']].forEach(function (entry) {
                const station = profile.stations[entry[0]];
                if (!station || !finite(station.x) || !finite(station.y) || !finite(station.z)) return;
                endpoints.push({
                    profile: profile,
                    profileIndex: profileIndex,
                    station: station,
                    side: entry[1],
                    x: station.x,
                    y: station.y,
                    z: station.z
                });
            });
        });
        endpoints.sort(function (a, b) {
            return a.x - b.x || a.y - b.y || a.profileIndex - b.profileIndex
                || (a.side === 'start' ? -1 : 1);
        });

        // Complete-link clusters prevent a chain of individually near endpoints from joining two
        // endpoints farther apart than the tolerance.
        const groups = [];
        endpoints.forEach(function (endpoint) {
            let match = null;
            let matchDistance = Infinity;
            groups.forEach(function (group) {
                let maxDistance = 0;
                for (let i = 0; i < group.length; i++) {
                    const distance = Math.hypot(endpoint.x - group[i].x, endpoint.y - group[i].y);
                    if (distance > tolerance + EPSILON) return;
                    if (distance > maxDistance) maxDistance = distance;
                }
                if (maxDistance < matchDistance) {
                    match = group;
                    matchDistance = maxDistance;
                }
            });
            if (match) match.push(endpoint);
            else groups.push([endpoint]);
        });

        const targets = new Map();
        let reconciledGroups = 0;
        groups.forEach(function (group) {
            if (new Set(group.map(function (endpoint) { return endpoint.profile; })).size < 2) return;
            const targetZ = median(group.map(function (endpoint) { return endpoint.z; }));
            if (!finite(targetZ)) return;
            reconciledGroups++;
            group.forEach(function (endpoint) {
                let target = targets.get(endpoint.profile);
                if (!target) {
                    target = {};
                    targets.set(endpoint.profile, target);
                }
                target[endpoint.side] = targetZ;
            });
        });

        let adjustedProfiles = 0;
        let adjustedEndpoints = 0;
        targets.forEach(function (target, profile) {
            const stations = profile.stations;
            const first = stations[0];
            const last = stations[stations.length - 1];
            const startTarget = finite(target.start) ? target.start : first.z;
            const endTarget = finite(target.end) ? target.end : last.z;
            const startDelta = startTarget - first.z;
            const endDelta = endTarget - last.z;
            if (Math.abs(startDelta) <= EPSILON && Math.abs(endDelta) <= EPSILON) return;
            const startS = finite(first.s) ? first.s : 0;
            const endS = finite(last.s) ? last.s : startS;
            const span = endS - startS;
            stations.forEach(function (station, index) {
                if (!finite(station.z)) return;
                const t = Math.abs(span) > EPSILON && finite(station.s)
                    ? Math.max(0, Math.min(1, (station.s - startS) / span))
                    : index / Math.max(1, stations.length - 1);
                station.z += startDelta + (endDelta - startDelta) * t;
            });
            if (finite(target.start)) {
                first.z = startTarget;
                adjustedEndpoints++;
            }
            if (finite(target.end)) {
                last.z = endTarget;
                adjustedEndpoints++;
            }
            adjustedProfiles++;
        });

        return {
            reconciledGroups: reconciledGroups,
            adjustedProfiles: adjustedProfiles,
            adjustedEndpoints: adjustedEndpoints
        };
    }

    function projectToProfile(profile, x, y) {
        const stations = profile && Array.isArray(profile.stations) ? profile.stations : [];
        if (!stations.length || !finite(x) || !finite(y)) return null;
        if (stations.length === 1) {
            const only = stations[0];
            return {
                x: only.x, y: only.y, z: finite(only.z) ? only.z : null, s: only.s,
                tangentX: only.tangentX, tangentY: only.tangentY,
                normalX: only.normalX, normalY: only.normalY,
                offset: (x - only.x) * only.normalX + (y - only.y) * only.normalY,
                distance: Math.hypot(x - only.x, y - only.y), segmentIndex: 0, t: 0
            };
        }

        let best = null;
        for (let i = 0; i < stations.length - 1; i++) {
            const a = stations[i];
            const b = stations[i + 1];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const lengthSquared = dx * dx + dy * dy;
            if (!(lengthSquared > EPSILON * EPSILON)) continue;
            const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared));
            const projectedX = a.x + dx * t;
            const projectedY = a.y + dy * t;
            const distanceSquared = (x - projectedX) * (x - projectedX)
                + (y - projectedY) * (y - projectedY);
            if (best && distanceSquared >= best.distanceSquared) continue;
            const tangent = normalise(dx, dy);
            const normalX = -tangent[1];
            const normalY = tangent[0];
            best = {
                x: projectedX,
                y: projectedY,
                z: finite(a.z) && finite(b.z) ? a.z + (b.z - a.z) * t : null,
                s: a.s + (b.s - a.s) * t,
                tangentX: tangent[0],
                tangentY: tangent[1],
                normalX: normalX,
                normalY: normalY,
                offset: (x - projectedX) * normalX + (y - projectedY) * normalY,
                distance: Math.sqrt(distanceSquared),
                distanceSquared: distanceSquared,
                segmentIndex: i,
                t: t
            };
        }
        if (best) {
            delete best.distanceSquared;
            return best;
        }
        const station = stations[0];
        return {
            x: station.x, y: station.y, z: finite(station.z) ? station.z : null, s: station.s,
            tangentX: station.tangentX, tangentY: station.tangentY,
            normalX: station.normalX, normalY: station.normalY,
            offset: 0, distance: Math.hypot(x - station.x, y - station.y), segmentIndex: 0, t: 0
        };
    }

    // Height varies only along the centerline projection, never laterally. Every point on one
    // cross-section therefore receives exactly the same formation elevation.
    function heightAt(profile, x, y) {
        const frame = projectToProfile(profile, x, y);
        return frame && finite(frame.z) ? frame.z : null;
    }

    // One failed full-entry fit must not discard valid profiles fitted to its remaining surface
    // runs. The returned formation is deliberately the same object as supportProfile so rendering,
    // terrain queries and the photoreal cut quilt share one reconciled station set.
    function resolveSurfaceRunFormation(fullFormation, runAttempt, ownership) {
        if (!runAttempt || !runAttempt.ok) {
            return { formation: null, supportProfile: null };
        }
        if (fullFormation && fullFormation.ok) {
            return { formation: runAttempt, supportProfile: null };
        }
        const owner = ownership || {};
        const profile = {
            ...runAttempt,
            proposalId: owner.proposalId == null ? null : String(owner.proposalId),
            segmentId: owner.segmentId == null ? null : String(owner.segmentId)
        };
        return { formation: profile, supportProfile: profile };
    }

    function offsetPoint(station, offset, verticalOffset) {
        if (!station || !finite(station.x) || !finite(station.y)
            || !finite(station.normalX) || !finite(station.normalY) || !finite(offset)) return null;
        const z = finite(station.z)
            ? station.z + (finite(verticalOffset) ? verticalOffset : 0)
            : null;
        return [
            station.x + station.normalX * offset * (finite(station.normalScale) ? station.normalScale : 1),
            station.y + station.normalY * offset * (finite(station.normalScale) ? station.normalScale : 1),
            z
        ];
    }

    function pushTriangle(target, a, b, c) {
        target.push(
            a[0], a[1], a[2],
            b[0], b[1], b[2],
            c[0], c[1], c[2]
        );
    }

    function pushQuad(target, a, b, c, d) {
        pushTriangle(target, a, b, c);
        pushTriangle(target, a, c, d);
    }

    function samePosition(a, b) {
        return Math.abs(a[0] - b[0]) <= EPSILON
            && Math.abs(a[1] - b[1]) <= EPSILON
            && Math.abs(a[2] - b[2]) <= EPSILON;
    }

    function pushPlanarPolygon(target, points, upward) {
        const cleaned = [];
        (points || []).forEach(function (point) {
            if (!point || (cleaned.length && samePosition(cleaned[cleaned.length - 1], point))) return;
            cleaned.push(point);
        });
        if (cleaned.length > 2 && samePosition(cleaned[0], cleaned[cleaned.length - 1])) cleaned.pop();
        if (cleaned.length < 3) return;
        let signedArea = 0;
        for (let i = 0; i < cleaned.length; i++) {
            const a = cleaned[i];
            const b = cleaned[(i + 1) % cleaned.length];
            signedArea += a[0] * b[1] - b[0] * a[1];
        }
        if (Math.abs(signedArea) <= EPSILON) return;
        if ((upward && signedArea < 0) || (!upward && signedArea > 0)) cleaned.reverse();
        for (let i = 1; i < cleaned.length - 1; i++) {
            pushTriangle(target, cleaned[0], cleaned[i], cleaned[i + 1]);
        }
    }

    // Recover the exact perimeter loops from the explicit top triangles. The mask, visible
    // foundation and streamed-mesh seam must all use this same perimeter; rebuilding a second
    // outline with Turf is what previously created rounded endpoint lobes outside the road quilt.
    function boundaryRingsFromTriangles(positions) {
        const pointKey = function (point) {
            return point.map(function (value) {
                const normalized = Math.abs(value) <= EPSILON ? 0 : value;
                return Number(normalized).toPrecision(15);
            }).join(',');
        };
        const edges = new Map();
        const addEdge = function (a, b) {
            const aKey = pointKey(a);
            const bKey = pointKey(b);
            const key = aKey < bKey ? aKey + '|' + bKey : bKey + '|' + aKey;
            const existing = edges.get(key);
            if (existing) existing.count++;
            else edges.set(key, { a: a.slice(), b: b.slice(), aKey: aKey, bKey: bKey, count: 1 });
        };
        for (let offset = 0; offset + 8 < positions.length; offset += 9) {
            const a = positions.slice(offset, offset + 3);
            const b = positions.slice(offset + 3, offset + 6);
            const c = positions.slice(offset + 6, offset + 9);
            addEdge(a, b);
            addEdge(b, c);
            addEdge(c, a);
        }
        const boundary = Array.from(edges.values()).filter(function (edge) { return edge.count === 1; });
        const outgoing = new Map();
        boundary.forEach(function (edge) {
            if (!outgoing.has(edge.aKey)) outgoing.set(edge.aKey, []);
            outgoing.get(edge.aKey).push(edge);
        });
        const used = new Set();
        const rings = [];
        boundary.forEach(function (firstEdge) {
            if (used.has(firstEdge)) return;
            const ring = [firstEdge.a.slice()];
            let edge = firstEdge;
            let closed = false;
            for (let guard = 0; guard <= boundary.length; guard++) {
                used.add(edge);
                ring.push(edge.b.slice());
                if (edge.bKey === firstEdge.aKey) {
                    closed = true;
                    break;
                }
                const candidates = outgoing.get(edge.bKey) || [];
                edge = candidates.find(function (candidate) { return !used.has(candidate); });
                if (!edge) break;
            }
            if (closed && ring.length >= 4) {
                ring.pop(); // callers close explicitly, avoiding a duplicate mask/seam vertex
                rings.push(ring);
            }
        });
        return rings;
    }

    // `baseZ` is the semantic bottom offset from the formation; `depth` grows upward, so a curb
    // with baseZ=0 and depth=.15 has a top .15 m above the road formation. With depth=0 only the
    // non-indexed top triangles are emitted. Every interval is an explicit ruled quad.
    function buildRuledStripPositions(profile, left, right, baseZ, depth) {
        const stations = profile && Array.isArray(profile.stations) ? profile.stations : [];
        // Corridor strip offsets are authored in true metres. Stations stay in the scene's XY
        // frame, so undo the scene→ground distance scale before adding lateral coordinates.
        const sceneUnitsPerGroundM = profile && finite(profile.distanceScale) && profile.distanceScale > 0
            ? 1 / profile.distanceScale : 1;
        const leftOffset = (finite(left) ? left : 0) * sceneUnitsPerGroundM;
        const rightOffset = (finite(right) ? right : 0) * sceneUnitsPerGroundM;
        const bottomOffset = finite(baseZ) ? baseZ : 0;
        const semanticDepth = finite(depth) ? Math.max(0, depth) : 0;
        const empty = {
            ok: false,
            positions: new Float32Array(0),
            topPositions: new Float32Array(0),
            stationVertices: [],
            boundaryRings: [],
            triangleCount: 0,
            topTriangleCount: 0
        };
        if (stations.length < 2 || Math.abs(leftOffset - rightOffset) <= EPSILON
            || stations.some(function (station) { return !finite(station.z); })) return empty;

        const closed = stations.length >= 4
            && Math.hypot(stations[0].x - stations[stations.length - 1].x,
                stations[0].y - stations[stations.length - 1].y) <= EPSILON;
        const directionBefore = function (index) {
            if (closed && (index === 0 || index === stations.length - 1)) {
                return normalise(stations[0].x - stations[stations.length - 2].x,
                    stations[0].y - stations[stations.length - 2].y);
            }
            for (let i = index - 1; i >= 0; i--) {
                const direction = normalise(stations[index].x - stations[i].x,
                    stations[index].y - stations[i].y);
                if (direction) return direction;
            }
            return null;
        };
        const directionAfter = function (index) {
            if (closed && (index === 0 || index === stations.length - 1)) {
                return normalise(stations[1].x - stations[0].x,
                    stations[1].y - stations[0].y);
            }
            for (let i = index + 1; i < stations.length; i++) {
                const direction = normalise(stations[i].x - stations[index].x,
                    stations[i].y - stations[index].y);
                if (direction) return direction;
            }
            return null;
        };
        const boundaryAt = function (station, previous, next, offset, verticalOffset) {
            const z = station.z + verticalOffset;
            const raw = function (direction) {
                const normalX = -direction[1];
                const normalY = direction[0];
                return [station.x + normalX * offset, station.y + normalY * offset, z];
            };
            if (!previous && !next) {
                const point = offsetPoint(station, offset, verticalOffset);
                return { incoming: point, outgoing: point };
            }
            if (!previous) {
                const point = raw(next);
                return { incoming: point, outgoing: point };
            }
            if (!next) {
                const point = raw(previous);
                return { incoming: point, outgoing: point };
            }
            const turn = previous[0] * next[1] - previous[1] * next[0];
            const directionDot = previous[0] * next[0] + previous[1] * next[1];
            const cosineHalfTurn = Math.sqrt(Math.max(0, (1 + directionDot) / 2));
            // A reversal has the same zero cross-product as a straight line but no usable mitre.
            // Use the same 4x mitre-limit threshold as the station frame; beyond it, bevel both
            // boundaries so a hairpin cannot produce crossed or unbounded road quads.
            if (cosineHalfTurn <= 0.25) {
                return { incoming: raw(previous), outgoing: raw(next) };
            }
            // The inner boundary is a mitre. The outer boundary is a bevel matching the canonical
            // corridor footprint, so the replacement deck never protrudes beyond its carve.
            if (Math.abs(turn) <= EPSILON || turn * offset >= 0) {
                const point = offsetPoint(station, offset, verticalOffset);
                return { incoming: point, outgoing: point };
            }
            return { incoming: raw(previous), outgoing: raw(next) };
        };
        const frames = stations.map(function (station, index) {
            const previous = directionBefore(index);
            const next = directionAfter(index);
            const directionDot = previous && next
                ? previous[0] * next[0] + previous[1] * next[1]
                : 1;
            const hairpin = previous && next
                ? Math.sqrt(Math.max(0, (1 + directionDot) / 2)) <= 0.25
                : false;
            const bottomLeft = boundaryAt(station, previous, next, leftOffset, bottomOffset);
            const bottomRight = boundaryAt(station, previous, next, rightOffset, bottomOffset);
            const lift = function (point) { return [point[0], point[1], point[2] + semanticDepth]; };
            return {
                bottomLeft: bottomLeft,
                bottomRight: bottomRight,
                topLeft: { incoming: lift(bottomLeft.incoming), outgoing: lift(bottomLeft.outgoing) },
                topRight: { incoming: lift(bottomRight.incoming), outgoing: lift(bottomRight.outgoing) },
                centerBottom: [station.x, station.y, station.z + bottomOffset],
                centerTop: [station.x, station.y, station.z + bottomOffset + semanticDepth],
                hairpin: hairpin
            };
        });
        const stationVertices = stations.map(function (station) {
            const bottomLeft = offsetPoint(station, leftOffset, bottomOffset);
            const bottomRight = offsetPoint(station, rightOffset, bottomOffset);
            const topLeft = [bottomLeft[0], bottomLeft[1], bottomLeft[2] + semanticDepth];
            const topRight = [bottomRight[0], bottomRight[1], bottomRight[2] + semanticDepth];
            return {
                left: topLeft,
                right: topRight,
                topLeft: topLeft,
                topRight: topRight,
                bottomLeft: bottomLeft,
                bottomRight: bottomRight,
                topZ: topLeft[2],
                bottomZ: bottomLeft[2]
            };
        });
        const top = [];
        const all = [];
        for (let i = 0; i < frames.length - 1; i++) {
            const a = frames[i];
            const b = frames[i + 1];
            // Winding is +Z for conventional signed offsets: left > right.
            pushQuad(top, a.topLeft.outgoing, a.topRight.outgoing,
                b.topRight.incoming, b.topLeft.incoming);
        }
        const pushJoin = function (incomingFrame, outgoingFrame) {
            if (incomingFrame.hairpin || outgoingFrame.hairpin) {
                // Connecting left-to-left and right-to-right as one quad makes a bow-tie at a
                // reversal. Two centre-fan wedges fill the true bevel without crossed triangles.
                pushPlanarPolygon(top, [
                    incomingFrame.topLeft.incoming,
                    incomingFrame.centerTop,
                    outgoingFrame.topLeft.outgoing
                ], true);
                pushPlanarPolygon(top, [
                    incomingFrame.topRight.incoming,
                    outgoingFrame.topRight.outgoing,
                    incomingFrame.centerTop
                ], true);
                return;
            }
            pushPlanarPolygon(top, [
                incomingFrame.topLeft.incoming,
                incomingFrame.topRight.incoming,
                outgoingFrame.topRight.outgoing,
                outgoingFrame.topLeft.outgoing
            ], true);
        };
        for (let i = 1; i < frames.length - 1; i++) pushJoin(frames[i], frames[i]);
        if (closed) pushJoin(frames[frames.length - 1], frames[0]);
        Array.prototype.push.apply(all, top);

        if (semanticDepth > EPSILON) {
            for (let i = 0; i < frames.length - 1; i++) {
                const a = frames[i];
                const b = frames[i + 1];
                pushQuad(all, a.bottomLeft.outgoing, b.bottomLeft.incoming,
                    b.bottomRight.incoming, a.bottomRight.outgoing);
                pushQuad(all, a.topLeft.outgoing, b.topLeft.incoming,
                    b.bottomLeft.incoming, a.bottomLeft.outgoing);
                pushQuad(all, a.topRight.outgoing, a.bottomRight.outgoing,
                    b.bottomRight.incoming, b.topRight.incoming);
            }
            const pushDepthJoin = function (incomingFrame, outgoingFrame) {
                if (incomingFrame.hairpin || outgoingFrame.hairpin) {
                    pushPlanarPolygon(all, [
                        incomingFrame.bottomLeft.incoming,
                        outgoingFrame.bottomLeft.outgoing,
                        incomingFrame.centerBottom
                    ], false);
                    pushPlanarPolygon(all, [
                        incomingFrame.bottomRight.incoming,
                        incomingFrame.centerBottom,
                        outgoingFrame.bottomRight.outgoing
                    ], false);
                    if (!samePosition(incomingFrame.topLeft.incoming, outgoingFrame.topLeft.outgoing)) {
                        pushQuad(all, incomingFrame.topLeft.incoming, outgoingFrame.topLeft.outgoing,
                            outgoingFrame.bottomLeft.outgoing, incomingFrame.bottomLeft.incoming);
                    }
                    if (!samePosition(incomingFrame.topRight.incoming, outgoingFrame.topRight.outgoing)) {
                        pushQuad(all, outgoingFrame.topRight.outgoing, incomingFrame.topRight.incoming,
                            incomingFrame.bottomRight.incoming, outgoingFrame.bottomRight.outgoing);
                    }
                    return;
                }
                pushPlanarPolygon(all, [
                    incomingFrame.bottomLeft.incoming,
                    incomingFrame.bottomRight.incoming,
                    outgoingFrame.bottomRight.outgoing,
                    outgoingFrame.bottomLeft.outgoing
                ], false);
                if (!samePosition(incomingFrame.topLeft.incoming, outgoingFrame.topLeft.outgoing)) {
                    pushQuad(all, incomingFrame.topLeft.incoming, outgoingFrame.topLeft.outgoing,
                        outgoingFrame.bottomLeft.outgoing, incomingFrame.bottomLeft.incoming);
                }
                if (!samePosition(incomingFrame.topRight.incoming, outgoingFrame.topRight.outgoing)) {
                    pushQuad(all, outgoingFrame.topRight.outgoing, incomingFrame.topRight.incoming,
                        incomingFrame.bottomRight.incoming, outgoingFrame.bottomRight.outgoing);
                }
            };
            for (let i = 1; i < frames.length - 1; i++) pushDepthJoin(frames[i], frames[i]);
            if (closed) pushDepthJoin(frames[frames.length - 1], frames[0]);
            if (!closed) {
                const first = frames[0];
                const last = frames[frames.length - 1];
                pushQuad(all, first.topLeft.incoming, first.bottomLeft.incoming,
                    first.bottomRight.incoming, first.topRight.incoming);
                pushQuad(all, last.topLeft.outgoing, last.topRight.outgoing,
                    last.bottomRight.outgoing, last.bottomLeft.outgoing);
            }
        }

        return {
            ok: true,
            positions: Float32Array.from(all),
            topPositions: Float32Array.from(top),
            stationVertices: stationVertices,
            boundaryRings: boundaryRingsFromTriangles(top),
            triangleCount: all.length / 9,
            topTriangleCount: top.length / 9
        };
    }

    // Expand a ruled strip on every side in true metres. Open profiles receive two real cap
    // intervals rather than a separate flat ShapeGeometry, so nonlinear station heights, bends,
    // mask pixels and the visible foundation remain one watertight geometric contract.
    function buildPaddedRuledStripPositions(profile, left, right, paddingM, baseZ, depth) {
        const padding = finite(paddingM) ? Math.max(0, paddingM) : 0;
        const sourceStations = profile && Array.isArray(profile.stations) ? profile.stations : [];
        if (!(padding > EPSILON) || sourceStations.length < 2) {
            return buildRuledStripPositions(profile, left, right, baseZ, depth);
        }
        const stations = sourceStations.map(function (station) { return { ...station }; });
        const closed = stations.length >= 4
            && Math.hypot(stations[0].x - stations[stations.length - 1].x,
                stations[0].y - stations[stations.length - 1].y) <= EPSILON;
        if (!closed) {
            let firstDirection = null;
            for (let i = 1; i < stations.length && !firstDirection; i++) {
                firstDirection = normalise(stations[i].x - stations[0].x,
                    stations[i].y - stations[0].y);
            }
            let lastDirection = null;
            for (let i = stations.length - 2; i >= 0 && !lastDirection; i--) {
                lastDirection = normalise(stations[stations.length - 1].x - stations[i].x,
                    stations[stations.length - 1].y - stations[i].y);
            }
            const distanceScale = profile && finite(profile.distanceScale) && profile.distanceScale > 0
                ? profile.distanceScale : 1;
            const scenePadding = padding / distanceScale;
            if (firstDirection) {
                const first = stations[0];
                stations.unshift({
                    ...first,
                    x: first.x - firstDirection[0] * scenePadding,
                    y: first.y - firstDirection[1] * scenePadding,
                    point: [first.x - firstDirection[0] * scenePadding,
                        first.y - firstDirection[1] * scenePadding],
                    s: (finite(first.s) ? first.s : 0) - padding,
                    sourceIndex: null,
                    isSourceVertex: false
                });
            }
            if (lastDirection) {
                const last = stations[stations.length - 1];
                stations.push({
                    ...last,
                    x: last.x + lastDirection[0] * scenePadding,
                    y: last.y + lastDirection[1] * scenePadding,
                    point: [last.x + lastDirection[0] * scenePadding,
                        last.y + lastDirection[1] * scenePadding],
                    s: (finite(last.s) ? last.s : Number(profile && profile.length) || 0) + padding,
                    sourceIndex: null,
                    isSourceVertex: false
                });
            }
        }
        assignStationFrames(stations);
        return buildRuledStripPositions(
            { ...profile, stations: stations },
            (finite(left) ? left : 0) + padding,
            (finite(right) ? right : 0) - padding,
            baseZ,
            depth
        );
    }

    // Build the narrow visible annulus outside a ruled road without sending it through a generic
    // polygon triangulator. Both side bands keep every longitudinal station, so a nonlinear grade
    // remains identical to the road/foundation quilt; open endpoints receive explicit cap quads.
    function buildRuledStripCollarPositions(
        profile, left, right, paddingM, leftVerticalOffsetM, rightVerticalOffsetM
    ) {
        const padding = finite(paddingM) ? Math.max(0, paddingM) : 0;
        const leftVerticalOffset = finite(leftVerticalOffsetM) ? leftVerticalOffsetM : 0;
        const rightVerticalOffset = finite(rightVerticalOffsetM)
            ? rightVerticalOffsetM : leftVerticalOffset;
        const stations = profile && Array.isArray(profile.stations) ? profile.stations : [];
        if (!(padding > EPSILON) || stations.length < 2
            || !finite(left) || !finite(right) || !(left > right)) {
            return { ok: false, positions: new Float32Array(0), triangleCount: 0 };
        }
        const leftBand = buildRuledStripPositions(
            profile, left + padding, left, leftVerticalOffset, 0);
        const rightBand = buildRuledStripPositions(
            profile, right, right - padding, rightVerticalOffset, 0);
        if (!leftBand.ok || !rightBand.ok) {
            return { ok: false, positions: new Float32Array(0), triangleCount: 0 };
        }
        const positions = Array.from(leftBand.topPositions).concat(Array.from(rightBand.topPositions));
        const closed = stations.length >= 4
            && Math.hypot(stations[0].x - stations[stations.length - 1].x,
                stations[0].y - stations[stations.length - 1].y) <= EPSILON;
        if (!closed) {
            const distanceScale = profile && finite(profile.distanceScale) && profile.distanceScale > 0
                ? profile.distanceScale : 1;
            const scenePadding = padding / distanceScale;
            const firstDirection = normalise(
                stations[1].x - stations[0].x, stations[1].y - stations[0].y);
            const lastDirection = normalise(
                stations[stations.length - 1].x - stations[stations.length - 2].x,
                stations[stations.length - 1].y - stations[stations.length - 2].y);
            const shifted = function (point, direction, distance) {
                return [
                    point[0] + direction[0] * distance,
                    point[1] + direction[1] * distance,
                    point[2]
                ];
            };
            if (firstDirection) {
                const first = stations[0];
                const innerLeft = offsetPoint(first, left, leftVerticalOffset);
                const innerRight = offsetPoint(first, right, rightVerticalOffset);
                const outerLeft = shifted(
                    offsetPoint(first, left + padding, leftVerticalOffset), firstDirection, -scenePadding);
                const outerRight = shifted(
                    offsetPoint(first, right - padding, rightVerticalOffset), firstDirection, -scenePadding);
                pushQuad(positions, outerLeft, outerRight, innerRight, innerLeft);
            }
            if (lastDirection) {
                const last = stations[stations.length - 1];
                const innerLeft = offsetPoint(last, left, leftVerticalOffset);
                const innerRight = offsetPoint(last, right, rightVerticalOffset);
                const outerLeft = shifted(
                    offsetPoint(last, left + padding, leftVerticalOffset), lastDirection, scenePadding);
                const outerRight = shifted(
                    offsetPoint(last, right - padding, rightVerticalOffset), lastDirection, scenePadding);
                pushQuad(positions, innerLeft, innerRight, outerRight, outerLeft);
            }
        }
        return {
            ok: positions.length > 0,
            positions: Float32Array.from(positions),
            triangleCount: positions.length / 9
        };
    }

    // Whether rebuildTerrainCorridorGroup should COMMIT the freshly-built terrain group or RETAIN
    // the previous one. The group is already per-entry mixed — a corridor entry that fitted carries
    // a terrain deck + shader cut patch, an incomplete one falls back to a flat deck with no patch —
    // so committing a PARTIAL build carves the corridors that fitted while the rest stay flat, which
    // is strictly better than discarding everything for one unstreamed corridor. The invariant to
    // preserve is "never regress": don't replace an existing carve with a flat/uncarved group, and
    // don't drop an already-carved corridor because its tiles momentarily unloaded. So a partial
    // build commits only when there is no prior carve to protect (the first-fit case that was
    // producing zero carve); once a carve exists, an incomplete rebuild retains it, exactly as before.
    // state: { builtChildren, cutPatches, missingKeys, priorCarve } (counts / boolean).
    function decideTerrainCorridorCommit(state) {
        const s = state || {};
        const builtChildren = Number(s.builtChildren) || 0;
        const cutPatches = Number(s.cutPatches) || 0;
        const missingKeys = Number(s.missingKeys) || 0;
        const priorCarve = !!s.priorCarve;
        if (builtChildren <= 0) return { commit: false, reason: 'empty-build' };
        if (cutPatches <= 0) {
            return priorCarve
                ? { commit: false, reason: 'no-carve-keep-prior' }
                : { commit: true, reason: 'flat-only' };
        }
        if (missingKeys <= 0) return { commit: true, reason: 'full' };
        return priorCarve
            ? { commit: false, reason: 'partial-keep-prior' }
            : { commit: true, reason: 'partial' };
    }

    return {
        densifyPolyline: densifyPolyline,
        decideTerrainCorridorCommit: decideTerrainCorridorCommit,
        buildFormation: buildFormation,
        applyVerticalCurveEnvelope: applyVerticalCurveEnvelope,
        referenceElevationAt: referenceElevationAt,
        calibrateReferenceFormation: calibrateReferenceFormation,
        fitReferenceGroundFormation: fitReferenceGroundFormation,
        reconcileProfileEndpointHeights: reconcileProfileEndpointHeights,
        projectToProfile: projectToProfile,
        heightAt: heightAt,
        resolveSurfaceRunFormation: resolveSurfaceRunFormation,
        offsetPoint: offsetPoint,
        buildRuledStripPositions: buildRuledStripPositions,
        buildPaddedRuledStripPositions: buildPaddedRuledStripPositions,
        buildRuledStripCollarPositions: buildRuledStripCollarPositions
    };
});
