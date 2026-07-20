// Unit tests for longitudinal terrain fitting and level, station-matched road strip geometry.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    densifyPolyline,
    buildFormation,
    referenceElevationAt,
    calibrateReferenceFormation,
    referenceFormationWithinVisibleTolerance,
    reconcileProfileEndpointHeights,
    projectToProfile,
    heightAt,
    resolveSurfaceRunFormation,
    offsetPoint,
    buildRuledStripPositions,
    buildPaddedRuledStripPositions,
    buildRuledStripCollarPositions
} = require('../../frontend/js/corridor-terrain-formation.js');

function crossMagnitude(positions, triangleOffset) {
    const ax = positions[triangleOffset];
    const ay = positions[triangleOffset + 1];
    const az = positions[triangleOffset + 2];
    const abx = positions[triangleOffset + 3] - ax;
    const aby = positions[triangleOffset + 4] - ay;
    const abz = positions[triangleOffset + 5] - az;
    const acx = positions[triangleOffset + 6] - ax;
    const acy = positions[triangleOffset + 7] - ay;
    const acz = positions[triangleOffset + 8] - az;
    return Math.hypot(
        aby * acz - abz * acy,
        abz * acx - abx * acz,
        abx * acy - aby * acx
    );
}

describe('corridor terrain stations', () => {
    it('retains source vertices while limiting every added station interval', () => {
        const source = [[0, 0], [3, 0], [3, 11], [13, 11]];
        const stations = densifyPolyline(source, 4);

        source.forEach((point, sourceIndex) => {
            expect(stations.some(station => station.sourceIndex === sourceIndex
                && station.x === point[0] && station.y === point[1])).toBe(true);
        });
        for (let i = 1; i < stations.length; i++) {
            expect(stations[i].s - stations[i - 1].s).toBeLessThanOrEqual(4 + 1e-9);
        }
        expect(stations.at(-1).s).toBeCloseTo(24, 9);
        stations.forEach(station => {
            expect(Math.hypot(station.tangentX, station.tangentY)).toBeCloseTo(1, 9);
            expect(Math.hypot(station.normalX, station.normalY)).toBeCloseTo(1, 9);
            expect(station.tangentX * station.normalX
                + station.tangentY * station.normalY).toBeCloseTo(0, 9);
        });
    });

    it('measures station spacing in true metres while retaining scene coordinates', () => {
        const stations = densifyPolyline([[0, 0], [14, 0]], 4, 0.7);

        expect(stations).toHaveLength(4);
        expect(stations.at(-1).x).toBeCloseTo(14, 9);
        expect(stations.at(-1).s).toBeCloseTo(9.8, 9);
        for (let i = 1; i < stations.length; i++) {
            expect(stations[i].s - stations[i - 1].s).toBeLessThanOrEqual(4 + 1e-9);
        }
    });

    it('preserves the endpoints and steady grade of a 200 m falling road', () => {
        const formation = buildFormation(
            [[0, 0], [200, 0]],
            x => 30 - x * 0.025,
            { maxSpacingM: 4, smoothingRadiusStations: 3, maxNoDataGapM: 8 }
        );

        expect(formation.ok).toBe(true);
        expect(formation.stations[0].z).toBeCloseTo(30, 10);
        expect(formation.stations.at(-1).z).toBeCloseTo(25, 10);
        formation.stations.forEach(station => {
            expect(station.z).toBeCloseTo(30 - station.x * 0.025, 9);
        });
        // Lateral distance never changes the longitudinal formation elevation.
        expect(heightAt(formation, 100, 30)).toBeCloseTo(27.5, 9);
        expect(heightAt(formation, 100, -12)).toBeCloseTo(27.5, 9);
    });

    it('adds explicit road clearance after fitting while preserving raw Google support heights', () => {
        const formation = buildFormation(
            [[0, 0], [20, 0]],
            x => 4 - x * 0.02,
            { maxSpacingM: 4, smoothingRadiusStations: 0, verticalOffsetM: 0.05 }
        );

        expect(formation.ok).toBe(true);
        expect(formation.verticalOffsetM).toBeCloseTo(0.05, 9);
        formation.stations.forEach(station => {
            expect(station.rawZ).toBeCloseTo(4 - station.x * 0.02, 9);
            expect(station.z).toBeCloseTo(station.rawZ + 0.05, 9);
        });
    });

    it('rejects a single canopy spike before smoothing the longitudinal profile', () => {
        const formation = buildFormation(
            [[0, 0], [200, 0]],
            x => 12 - x * 0.01 + (Math.abs(x - 100) < 1e-9 ? 18 : 0),
            { maxSpacingM: 10, smoothingRadiusStations: 2 }
        );

        const middle = formation.stations.find(station => Math.abs(station.x - 100) < 1e-9);
        expect(middle.rawZ).toBeCloseTo(29, 9);
        expect(middle.z).toBeCloseTo(11, 9);
        expect(formation.stations[0].z).toBeCloseTo(12, 9);
        expect(formation.stations.at(-1).z).toBeCloseTo(10, 9);
    });

    it('rejects a low visible-mesh outlier instead of turning it into a road sag', () => {
        const formation = buildFormation(
            [[0, 0], [200, 0]],
            x => 8 + x * 0.005 - (Math.abs(x - 100) < 1e-9 ? 5 : 0),
            { maxSpacingM: 4, smoothingRadiusStations: 2, outlierThresholdM: 1.5 }
        );

        const middle = formation.stations.find(station => Math.abs(station.x - 100) < 1e-9);
        expect(middle.rawZ).toBeCloseTo(3.5, 9);
        expect(middle.z).toBeCloseTo(8.5, 9);
    });

    it('rejects a single moderate mesh seam with the civil-road threshold', () => {
        const formation = buildFormation(
            [[0, 0], [80, 0]],
            x => 8 - x * 0.005 - (Math.abs(x - 40) < 1e-9 ? 0.62 : 0),
            { maxSpacingM: 4, smoothingRadiusStations: 2, outlierThresholdM: 0.45 }
        );

        const middle = formation.stations.find(station => Math.abs(station.x - 40) < 1e-9);
        expect(middle.rawZ).toBeCloseTo(7.18, 9);
        expect(middle.z).toBeCloseTo(7.8, 9);
    });

    it('lifts a sub-threshold short dip into an upper vertical curve without moving below support', () => {
        const formation = buildFormation(
            [[0, 0], [80, 0]],
            x => 8 - x * 0.005 - (Math.abs(x - 40) < 1e-9 ? 0.32 : 0),
            {
                maxSpacingM: 4,
                smoothingRadiusStations: 2,
                outlierThresholdM: 0.45,
                verticalCurvePasses: 8,
                verticalOffsetM: 0.05
            }
        );

        const middle = formation.stations.find(station => Math.abs(station.x - 40) < 1e-9);
        expect(middle.rawZ).toBeCloseTo(7.48, 9);
        expect(middle.z).toBeGreaterThan(7.75);
        formation.stations.forEach(station => {
            expect(station.z).toBeGreaterThanOrEqual(station.rawZ + 0.05 - 1e-9);
        });
        expect(formation.stations[4].z - formation.stations[3].z).toBeCloseTo(-0.02, 9);
    });

    it('preserves a genuine shallow Google-terrain hollow instead of smoothing it flat', () => {
        const formation = buildFormation(
            [[0, 0], [200, 0]],
            x => 14 - x * 0.01 - (Math.abs(x - 100) <= 12
                ? 1 - Math.abs(x - 100) / 12
                : 0),
            { maxSpacingM: 4, smoothingRadiusStations: 2, outlierThresholdM: 1.5 }
        );

        formation.stations.forEach(station => {
            expect(station.z).toBeCloseTo(station.rawZ, 9);
        });
        const middle = formation.stations.find(station => Math.abs(station.x - 100) < 1e-9);
        expect(middle.z).toBeCloseTo(12, 9);
    });

    it('interpolates only short bounded NoData gaps and never substitutes zero', () => {
        const shortGap = buildFormation(
            [[0, 0], [40, 0]],
            x => (x === 10 || x === 15 ? null : 20 - x * 0.1),
            { maxSpacingM: 5, smoothingRadiusStations: 0, maxNoDataGapM: 15 }
        );
        expect(shortGap.ok).toBe(true);
        expect(shortGap.stations.find(station => station.x === 10).z).toBeCloseTo(19, 9);
        expect(shortGap.stations.find(station => station.x === 15).z).toBeCloseTo(18.5, 9);
        expect(shortGap.stations.find(station => station.x === 10).interpolated).toBe(true);

        const longGap = buildFormation(
            [[0, 0], [40, 0]],
            x => (x >= 10 && x <= 25 ? undefined : 20 - x * 0.1),
            { maxSpacingM: 5, smoothingRadiusStations: 0, maxNoDataGapM: 15 }
        );
        expect(longGap.ok).toBe(false);
        expect(longGap.reason).toBe('terrain-nodata-gap');
        expect(longGap.unresolvedRanges).toHaveLength(1);
        expect(longGap.stations.find(station => station.x === 15).z).toBeNull();
        expect(heightAt(longGap, 15, 0)).toBeNull();

        const edgeGap = buildFormation(
            [[0, 0], [20, 0]],
            x => (x === 0 ? null : 5),
            { maxSpacingM: 5, maxNoDataGapM: 100 }
        );
        expect(edgeGap.ok).toBe(false);
        expect(edgeGap.stations[0].z).toBeNull();
    });
});

describe('DGU reference profile calibration', () => {
    it('interpolates only bounded EVRF2000 gaps by true chainage', () => {
        const points = [
            { dM: 0, elevAslM: 120 },
            { dM: 20, elevAslM: null },
            { dM: 40, elevAslM: 118 }
        ];

        expect(referenceElevationAt(points, 10, 40)).toBeCloseTo(119.5, 9);
        expect(referenceElevationAt(points, 20, 40)).toBeCloseTo(119, 9);
        expect(referenceElevationAt(points, 20, 39)).toBeNull();
        expect(referenceElevationAt(points, 50, 40)).toBeNull();
    });

    it('clamps only tiny endpoint chainage drift between geodesic DGU and local Mercator metres', () => {
        const points = [
            { dM: 0, elevAslM: 120 },
            { dM: 99.7, elevAslM: 118 }
        ];

        expect(referenceElevationAt(points, -0.3, 40)).toBe(120);
        expect(referenceElevationAt(points, 100, 40)).toBe(118);
        expect(referenceElevationAt(points, 102, 40)).toBeNull();
    });

    it('keeps DGU relative shape while a robust Google median supplies the local scene datum', () => {
        const reference = buildFormation(
            [[0, 0], [100, 0]],
            x => 120 - x * 0.02,
            { maxSpacingM: 10, smoothingRadiusStations: 0, verticalOffsetM: 0 }
        );
        const visible = buildFormation(
            [[0, 0], [100, 0]],
            x => 2 - x * 0.02 - (x === 50 ? 7 : 0),
            { maxSpacingM: 10, smoothingRadiusStations: 0, verticalOffsetM: 0 }
        );
        const calibrated = calibrateReferenceFormation(reference, visible, {
            verticalOffsetM: 0.05,
            source: 'dgu-dtm-20m',
            datum: 'EVRF2000',
            resolutionM: 20
        });

        expect(calibrated).toBeTruthy();
        expect(calibrated.calibrationOffsetM).toBeCloseTo(-118, 9);
        expect(calibrated.source).toBe('dgu-dtm-20m');
        expect(calibrated.stations[0].z).toBeCloseTo(2.05, 9);
        expect(calibrated.stations.at(-1).z).toBeCloseTo(0.05, 9);
        expect(calibrated.stations[5].googleRawZ).toBeCloseTo(-6, 9);
        expect(calibrated.stations[5].z).toBeCloseTo(1.05, 9);
    });

    it('rejects a poorly matched reference instead of forcing it into the Google scene', () => {
        const reference = buildFormation([[0, 0], [50, 0]], () => 120, {
            maxSpacingM: 10, smoothingRadiusStations: 0
        });
        const noisy = buildFormation([[0, 0], [50, 0]], x => [0, 8, -6, 11, -4, 9][x / 10], {
            maxSpacingM: 10, smoothingRadiusStations: 0
        });

        expect(calibrateReferenceFormation(reference, noisy)).toBeNull();
    });

    it('requires every calibrated station to remain close to the visible Google formation', () => {
        const visible = buildFormation([[0, 0], [20, 0]], x => 2 - x * 0.01, {
            maxSpacingM: 5, smoothingRadiusStations: 0, verticalOffsetM: 0.05
        });
        const aligned = {
            ...visible,
            stations: visible.stations.map(station => ({ ...station, z: station.z + 0.12 }))
        };
        const oneLocalDip = {
            ...aligned,
            stations: aligned.stations.map((station, index) => ({
                ...station,
                z: station.z - (index === 2 ? 0.6 : 0)
            }))
        };

        expect(referenceFormationWithinVisibleTolerance(aligned, visible, 0.25)).toBe(true);
        expect(referenceFormationWithinVisibleTolerance(oneLocalDip, visible, 0.25)).toBe(false);
    });
});

describe('shared graph-node elevations', () => {
    it('gives separately fitted connected profiles one exact endpoint height without a kink', () => {
        const west = buildFormation([[-20, 0], [0, 0]], () => 4, {
            maxSpacingM: 5,
            smoothingRadiusStations: 0
        });
        const east = buildFormation([[0, 0], [20, 0]], () => 8, {
            maxSpacingM: 5,
            smoothingRadiusStations: 0
        });
        const westRaw = west.stations.at(-1).rawZ;
        const eastRaw = east.stations[0].rawZ;

        const result = reconcileProfileEndpointHeights([west, east]);

        expect(result).toEqual({ reconciledGroups: 1, adjustedProfiles: 2, adjustedEndpoints: 2 });
        expect(west.stations.at(-1).z).toBe(6);
        expect(east.stations[0].z).toBe(6);
        expect(west.stations[0].z).toBe(4);
        expect(east.stations.at(-1).z).toBe(8);
        expect(west.stations.at(-2).z).toBeCloseTo(5.5, 9);
        expect(east.stations[1].z).toBeCloseTo(6.5, 9);
        expect(west.stations.at(-1).rawZ).toBe(westRaw);
        expect(east.stations[0].rawZ).toBe(eastRaw);
    });

    it('ignores nearby profile interiors, distant endpoints, and tolerance chains', () => {
        const connectedA = buildFormation([[-10, 0], [0, 0]], () => 2, {
            maxSpacingM: 5,
            smoothingRadiusStations: 0
        });
        const connectedB = buildFormation([[0.04, 0], [10, 0]], () => 4, {
            maxSpacingM: 5,
            smoothingRadiusStations: 0
        });
        const chainedButFar = buildFormation([[0.08, 0], [10, 10]], () => 20, {
            maxSpacingM: 5,
            smoothingRadiusStations: 0
        });
        const crossingInterior = buildFormation([[-5, -5], [5, 5]], () => 30, {
            maxSpacingM: 5,
            smoothingRadiusStations: 0
        });
        const untouched = [chainedButFar, crossingInterior].map(function (profile) {
            return profile.stations.map(function (station) { return station.z; });
        });

        const result = reconcileProfileEndpointHeights(
            [connectedA, connectedB, chainedButFar, crossingInterior],
            { coordinateTolerance: 0.05 }
        );

        expect(result.reconciledGroups).toBe(1);
        expect(connectedA.stations.at(-1).z).toBe(3);
        expect(connectedB.stations[0].z).toBe(3);
        expect(chainedButFar.stations.map(station => station.z)).toEqual(untouched[0]);
        expect(crossingInterior.stations.map(station => station.z)).toEqual(untouched[1]);
    });
});

describe('surface-run terrain fallback', () => {
    it('promotes a successful split run when the complete entry has unresolved NoData', () => {
        const full = buildFormation([[0, 0], [40, 0]], x => (
            x >= 15 && x <= 25 ? null : 6 - x * 0.01
        ), { maxSpacingM: 5, smoothingRadiusStations: 0, maxNoDataGapM: 5 });
        const run = buildFormation([[0, 0], [10, 0]], x => 6 - x * 0.01, {
            maxSpacingM: 5, smoothingRadiusStations: 0
        });

        const resolved = resolveSurfaceRunFormation(full, run, {
            proposalId: 42,
            segmentId: 'west'
        });
        const connectedFullEntry = buildFormation([[10, 0], [20, 0]], () => 8, {
            maxSpacingM: 5, smoothingRadiusStations: 0
        });

        expect(full.ok).toBe(false);
        expect(run.ok).toBe(true);
        expect(resolved.formation).toBe(resolved.supportProfile);
        expect(resolved.supportProfile).not.toBe(run);
        expect(resolved.supportProfile.proposalId).toBe('42');
        expect(resolved.supportProfile.segmentId).toBe('west');
        expect(heightAt(resolved.formation, 5, 0)).toBeCloseTo(5.95, 9);

        reconcileProfileEndpointHeights([resolved.supportProfile, connectedFullEntry]);
        expect(resolved.formation.stations.at(-1).z).toBeCloseTo(6.95, 9);
        expect(connectedFullEntry.stations[0].z).toBeCloseTo(6.95, 9);
    });

    it('does not duplicate a run into terrain support when the full profile already owns it', () => {
        const full = buildFormation([[0, 0], [40, 0]], x => 6 - x * 0.01, {
            maxSpacingM: 5, smoothingRadiusStations: 0
        });
        const run = buildFormation([[0, 0], [10, 0]], x => 6 - x * 0.01, {
            maxSpacingM: 5, smoothingRadiusStations: 0
        });

        const resolved = resolveSurfaceRunFormation(full, run, { proposalId: 42 });

        expect(resolved.formation).toBe(run);
        expect(resolved.supportProfile).toBeNull();
        expect(resolveSurfaceRunFormation(full, { ok: false }, {}).formation).toBeNull();
    });
});

describe('terrain-following ruled strip positions', () => {
    it('keeps every nonlinear 4 m station in the full-width height-mask quilt', () => {
        const formation = buildFormation(
            [[0, 0], [200, 0]],
            x => 6 - x * 0.012 - (Math.abs(x - 100) <= 20
                ? 0.8 * (1 - Math.abs(x - 100) / 20)
                : 0),
            { maxSpacingM: 4, smoothingRadiusStations: 0, distanceScale: 0.7 }
        );
        const quilt = buildRuledStripPositions(formation, 6, -6, 0, 0);

        expect(formation.stations).toHaveLength(36);
        expect(quilt.stationVertices).toHaveLength(formation.stations.length);
        expect(quilt.topTriangleCount).toBe((formation.stations.length - 1) * 2);
        quilt.stationVertices.forEach((vertices, index) => {
            expect(vertices.left[2]).toBeCloseTo(formation.stations[index].z, 9);
            expect(vertices.right[2]).toBeCloseTo(formation.stations[index].z, 9);
            expect(vertices.left[1]).toBeCloseTo(6 / 0.7, 9);
            expect(vertices.right[1]).toBeCloseTo(-6 / 0.7, 9);
        });
        const middleIndex = formation.stations.reduce((best, station, index) => (
            Math.abs(station.x - 100) < Math.abs(formation.stations[best].x - 100) ? index : best
        ), 0);
        expect(quilt.stationVertices[middleIndex].left[2]).toBeLessThan(4.1);
    });

    it('builds the visible collar from explicit nonlinear station quads and endpoint caps', () => {
        const formation = buildFormation(
            [[0, 0], [80, 0]],
            x => 5 - (Math.abs(x - 40) <= 12 ? 1.2 * (1 - Math.abs(x - 40) / 12) : 0),
            { maxSpacingM: 4, smoothingRadiusStations: 0, distanceScale: 0.7 }
        );
        const paddingM = 0.193;
        const collar = buildRuledStripCollarPositions(formation, 6, -6, paddingM, 0.04, 0.2);
        const values = Array.from(collar.positions);
        const xs = values.filter((_value, index) => index % 3 === 0);
        const zs = values.filter((_value, index) => index % 3 === 2);

        expect(collar.ok).toBe(true);
        expect(collar.triangleCount).toBeGreaterThan((formation.stations.length - 1) * 4);
        formation.stations.forEach(station => {
            expect(zs.some(z => Math.abs(z - (station.z + 0.04)) < 1e-5)).toBe(true);
            expect(zs.some(z => Math.abs(z - (station.z + 0.2)) < 1e-5)).toBe(true);
        });
        expect(Math.min(...xs)).toBeCloseTo(-paddingM / 0.7, 5);
        expect(Math.max(...xs)).toBeCloseTo(80 + paddingM / 0.7, 5);
        expect(Math.min(...zs)).toBeLessThan(4);
    });

    it('builds one station-derived padded quilt across side and endpoint mask uncertainty', () => {
        const formation = buildFormation(
            [[0, 0], [20, 0]],
            x => 3 + x * 0.02,
            { maxSpacingM: 4, smoothingRadiusStations: 0, distanceScale: 0.8 }
        );
        const mask = buildPaddedRuledStripPositions(formation, 5, -5, 0.5, 0, 0);
        const foundation = buildPaddedRuledStripPositions(formation, 5, -5, 1, -0.56, 0.6);
        const bounds = result => {
            const values = Array.from(result.topPositions);
            const xs = [];
            const ys = [];
            const zs = [];
            for (let i = 0; i < values.length; i += 3) {
                xs.push(values[i]);
                ys.push(values[i + 1]);
                zs.push(values[i + 2]);
            }
            return {
                minX: Math.min(...xs), maxX: Math.max(...xs),
                minY: Math.min(...ys), maxY: Math.max(...ys),
                minZ: Math.min(...zs), maxZ: Math.max(...zs)
            };
        };

        expect(mask.ok).toBe(true);
        expect(foundation.ok).toBe(true);
        expect(mask.stationVertices).toHaveLength(formation.stations.length + 2);
        expect(foundation.stationVertices).toHaveLength(formation.stations.length + 2);
        expect(mask.boundaryRings).toHaveLength(1);
        expect(foundation.boundaryRings).toHaveLength(1);
        const maskBounds = bounds(mask);
        const foundationBounds = bounds(foundation);
        expect(maskBounds.minX).toBeCloseTo(-0.5 / 0.8, 6);
        expect(maskBounds.maxX).toBeCloseTo(20 + 0.5 / 0.8, 6);
        expect(maskBounds.maxY).toBeCloseTo(5.5 / 0.8, 6);
        expect(foundationBounds.minX).toBeLessThan(maskBounds.minX);
        expect(foundationBounds.maxX).toBeGreaterThan(maskBounds.maxX);
        expect(foundationBounds.minY).toBeLessThan(maskBounds.minY);
        expect(foundationBounds.maxY).toBeGreaterThan(maskBounds.maxY);
        expect(foundationBounds.minZ).toBeCloseTo(formation.stations[0].z + 0.04, 5);
        expect(foundationBounds.maxZ).toBeCloseTo(formation.stations.at(-1).z + 0.04, 5);
        expect(foundation.positions.length).toBeGreaterThan(foundation.topPositions.length);
    });

    it('uses one level elevation for both sides of every station and explicit interval quads', () => {
        const formation = buildFormation(
            [[0, 0], [20, 0]],
            x => 2 - x * 0.05,
            { maxSpacingM: 4, smoothingRadiusStations: 2 }
        );
        const strip = buildRuledStripPositions(formation, 5, -3, 0.05, 0);

        expect(strip.ok).toBe(true);
        expect(strip.topTriangleCount).toBe((formation.stations.length - 1) * 2);
        expect(strip.positions).toEqual(strip.topPositions);
        strip.stationVertices.forEach((vertices, index) => {
            expect(vertices.left[2]).toBeCloseTo(vertices.right[2], 9);
            expect(vertices.topZ).toBeCloseTo(formation.stations[index].z + 0.05, 9);
            expect(vertices.topZ).toBeCloseTo(vertices.bottomZ, 9);
        });
        for (let offset = 0; offset < strip.positions.length; offset += 9) {
            expect(crossMagnitude(strip.positions, offset)).toBeGreaterThan(1e-6);
        }

        const projected = projectToProfile(formation, 8, 7);
        expect(projected.offset).toBeCloseTo(7, 9);
        expect(projected.z).toBeCloseTo(1.6, 9);
        const left = offsetPoint(formation.stations[1], 5, 0.05);
        expect(left[2]).toBeCloseTo(formation.stations[1].z + 0.05, 9);
    });

    it('keeps semantic base height and depth after terrain fitting', () => {
        const formation = buildFormation(
            [[0, 0], [12, 0]],
            x => 1 + x * 0.1,
            { maxSpacingM: 4, smoothingRadiusStations: 0 }
        );
        const strip = buildRuledStripPositions(formation, 2, -2, 0.1, 0.3);

        expect(strip.ok).toBe(true);
        strip.stationVertices.forEach((vertices, index) => {
            const terrainZ = formation.stations[index].z;
            expect(vertices.bottomZ).toBeCloseTo(terrainZ + 0.1, 9);
            expect(vertices.topZ).toBeCloseTo(terrainZ + 0.4, 9);
            expect(vertices.topZ - vertices.bottomZ).toBeCloseTo(0.3, 9);
        });
        expect(strip.triangleCount).toBeGreaterThan(strip.topTriangleCount);
        expect(Array.from(strip.positions).every(Number.isFinite)).toBe(true);
        for (let offset = 0; offset < strip.positions.length; offset += 9) {
            expect(crossMagnitude(strip.positions, offset)).toBeGreaterThan(1e-6);
        }
    });

    it('converts true-metre strip widths into the scene coordinate scale', () => {
        const formation = buildFormation(
            [[0, 0], [14, 0]],
            () => 2,
            { maxSpacingM: 4, distanceScale: 0.7, smoothingRadiusStations: 0 }
        );
        const strip = buildRuledStripPositions(formation, 5, -3, 0, 0);

        expect(strip.ok).toBe(true);
        expect(strip.stationVertices[0].left[1]).toBeCloseTo(5 / 0.7, 9);
        expect(strip.stationVertices[0].right[1]).toBeCloseTo(-3 / 0.7, 9);
    });

    it('bevels the outside of a bend instead of protruding beyond the corridor footprint', () => {
        const formation = buildFormation(
            [[0, 0], [10, 0], [10, 10]],
            () => 0,
            { maxSpacingM: 20, smoothingRadiusStations: 0 }
        );
        const strip = buildRuledStripPositions(formation, 5, -5, 0, 0);
        const points = [];
        for (let i = 0; i < strip.topPositions.length; i += 3) {
            points.push([strip.topPositions[i], strip.topPositions[i + 1]]);
        }

        expect(strip.topTriangleCount).toBe(5); // four segment triangles + one bevel join
        expect(points).toContainEqual([10, -5]);
        expect(points).toContainEqual([15, 0]);
        expect(points).not.toContainEqual([15, -5]); // the rejected both-sides outer mitre
    });

    it('closes a loop with one cyclic frame and no elevation seam', () => {
        const formation = buildFormation(
            [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
            (x, y) => x * 0.1 + y * 0.05,
            { maxSpacingM: 20, smoothingRadiusStations: 0 }
        );
        const strip = buildRuledStripPositions(formation, 2, -2, 0, 0.2);

        expect(formation.stations[0].z).toBeCloseTo(formation.stations.at(-1).z, 9);
        expect(formation.stations[0].normalX).toBeCloseTo(formation.stations.at(-1).normalX, 9);
        expect(formation.stations[0].normalY).toBeCloseTo(formation.stations.at(-1).normalY, 9);
        expect(strip.ok).toBe(true);
        expect(Array.from(strip.positions).every(Number.isFinite)).toBe(true);
        expect(strip.topTriangleCount).toBe(12); // 8 edge triangles + 4 outside-bevel joins
    });

    it('bevels both boundaries at exact and near reversals without unbounded spikes', () => {
        const formation = buildFormation(
            [[0, 0], [10, 0], [0, 0]],
            () => 0,
            { maxSpacingM: 20, smoothingRadiusStations: 0 }
        );
        const strip = buildRuledStripPositions(formation, 3, -3, 0, 0);

        expect(strip.ok).toBe(true);
        expect(Array.from(strip.positions).every(Number.isFinite)).toBe(true);
        expect(Math.max(...Array.from(strip.positions).map(Math.abs))).toBeLessThanOrEqual(10);
        for (let offset = 0; offset < strip.positions.length; offset += 9) {
            expect(crossMagnitude(strip.positions, offset)).toBeGreaterThan(1e-6);
        }

        const nearReversal = buildFormation(
            [[0, 0], [10, 0], [0.2, 1]],
            () => 0,
            { maxSpacingM: 20, smoothingRadiusStations: 0 }
        );
        const nearStrip = buildRuledStripPositions(nearReversal, 3, -3, 0, 0);
        const nearCoordinates = Array.from(nearStrip.positions);
        expect(nearStrip.ok).toBe(true);
        expect(nearCoordinates.every(Number.isFinite)).toBe(true);
        expect(Math.max(...nearCoordinates.map(Math.abs))).toBeLessThanOrEqual(13.1);
    });
});
