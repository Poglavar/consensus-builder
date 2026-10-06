// Schelling-point parcel plans: "Meridians and parallels".
//
// Where no parcel register can be loaded, the people planning a place still need ground to stand
// on. A Schelling point is a plan everyone arrives at independently, because every input to it is
// something everybody already agrees on. This one uses three such inputs:
//
//   1. The graticule. Meridians and parallels are fixed by the Equator and Greenwich; nobody owns
//      them and anyone with a GPS can find them.
//   2. Shlomo Angel's arterial grid (Angel et al., "Making Room for a Planet of Cities", Lincoln
//      Institute 2011; the Ethiopia and Colombia urban-expansion programmes): arterial roads about
//      30 m wide spaced about 1 km apart, so that every point is within a ten-minute walk of a road
//      that can carry public transport, laid out BEFORE the land is built on.
//   3. Integer division. Each ~1 km superblock is cut into n x m equal cells by local streets.
//
// Everything below is a pure function of those numbers, so two strangers get the same parcel ids and
// the same geometry for the same place. No network, no Leaflet, no randomness: the module runs the
// same in the browser and under node (backend/test/schelling-grid.test.js).
//
// What it produces is NOT a cadastre. Every feature is stamped provenance 'schelling-point' and
// estimated: true, and the UI labels it as a plan, never as a register.
(function attachSchellingGrid(global) {
    'use strict';

    const ALGORITHM = 'meridians-parallels';

    // WGS84.
    const A = 6378137;
    const F = 1 / 298.257223563;
    const E2 = 2 * F - F * F;
    const DEG = Math.PI / 180;

    // Arterial spacing is chosen in whole arcseconds that divide a degree evenly, so the grid is
    // anchored to whole degrees and the same whichever degree you count from. Divisors of 3600 that
    // read as round numbers; 16, 48, 144 or 225 are divisors too but nobody would call them round.
    const ARCSECOND_LADDER = Object.freeze([
        1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 36, 40, 45, 60, 72, 90, 120, 180, 240, 300, 360, 600, 720, 900, 1200, 1800, 3600
    ]);

    const DEFAULTS = Object.freeze({
        arterialSpacingM: 1000,   // Angel: ~1 km
        arterialWidthM: 30,       // Angel: ~30 m right of way
        streetWidthM: 12,         // a two-lane local street with footways
        targetBlockM: 120         // a short, walkable block face (Barcelona 113 m, Manhattan's short side 80 m)
    });

    const MAX_SUBDIVISION = 40;

    function metersPerDegreeLat(latDeg) {
        const s = Math.sin(latDeg * DEG);
        return (A * (1 - E2)) / Math.pow(1 - E2 * s * s, 1.5) * DEG;
    }

    function metersPerDegreeLon(latDeg) {
        const s = Math.sin(latDeg * DEG);
        return (A / Math.sqrt(1 - E2 * s * s)) * Math.cos(latDeg * DEG) * DEG;
    }

    function metersPerArcsecondLat(latDeg) { return metersPerDegreeLat(latDeg) / 3600; }
    function metersPerArcsecondLon(latDeg) { return metersPerDegreeLon(latDeg) / 3600; }

    // The ladder step whose length is closest to the target, judged by ratio rather than difference
    // so that 30" (-7%) beats 36" (+11%) and no step is favoured just for being large.
    function chooseStep(targetMeters, metersPerArcsecond) {
        if (!(targetMeters > 0) || !(metersPerArcsecond > 0)) throw new RangeError('Step targets must be positive.');
        const wanted = targetMeters / metersPerArcsecond;
        let best = ARCSECOND_LADDER[0];
        let bestError = Infinity;
        ARCSECOND_LADDER.forEach(step => {
            const error = Math.abs(Math.log(step / wanted));
            if (error < bestError) { bestError = error; best = step; }
        });
        return best;
    }

    function clampInt(value, min, max) {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) return min;
        return Math.min(max, Math.max(min, n));
    }

    function positiveNumber(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    }

    // A plan is fully determined by the whole-degree parallel it is computed for and four
    // parameters. The reference latitude is ROUNDED TO A WHOLE DEGREE on purpose: it is itself a
    // Schelling point, so two people looking at different corners of the same city build identical
    // geometry. The cosine drift across half a degree changes a 12 m street by centimetres.
    function planFor(options = {}) {
        const lat = Number(options.lat);
        if (!Number.isFinite(lat) || Math.abs(lat) > 85) throw new RangeError('A plan needs a latitude between -85 and 85.');
        const refLat = Math.round(lat);
        const arterialSpacingM = positiveNumber(options.arterialSpacingM, DEFAULTS.arterialSpacingM);
        const arterialWidthM = positiveNumber(options.arterialWidthM, DEFAULTS.arterialWidthM);
        const streetWidthM = positiveNumber(options.streetWidthM, DEFAULTS.streetWidthM);
        const targetBlockM = positiveNumber(options.targetBlockM, DEFAULTS.targetBlockM);

        const mLat = metersPerArcsecondLat(refLat);
        const mLon = metersPerArcsecondLon(refLat);
        const stepLatSec = chooseStep(arterialSpacingM, mLat);
        const stepLonSec = chooseStep(arterialSpacingM, mLon);
        const superblockLatM = stepLatSec * mLat;
        const superblockLonM = stepLonSec * mLon;
        const nLat = clampInt(superblockLatM / targetBlockM, 1, MAX_SUBDIVISION);
        const nLon = clampInt(superblockLonM / targetBlockM, 1, MAX_SUBDIVISION);
        const localLatSec = stepLatSec / nLat;
        const localLonSec = stepLonSec / nLon;
        const cellLatM = localLatSec * mLat;
        const cellLonM = localLonSec * mLon;
        if (Math.min(cellLatM, cellLonM) <= Math.max(arterialWidthM, streetWidthM)) {
            throw new RangeError('Streets this wide leave no room for a block; widen the block target or narrow the streets.');
        }

        const hemisphere = refLat < 0 ? 'S' : 'N';
        const code = `${stepLonSec}x${stepLatSec}-${nLon}x${nLat}-${arterialWidthM}-${streetWidthM}@${Math.abs(refLat)}${hemisphere}`;

        return Object.freeze({
            algorithm: ALGORITHM,
            code,
            refLat,
            arterialSpacingM, arterialWidthM, streetWidthM, targetBlockM,
            metersPerArcsecond: Object.freeze({ lat: mLat, lon: mLon }),
            arterial: Object.freeze({ stepLatSec, stepLonSec, spacingLatM: superblockLatM, spacingLonM: superblockLonM }),
            subdivision: Object.freeze({ nLat, nLon }),
            local: Object.freeze({ stepLatSec: localLatSec, stepLonSec: localLonSec, cellLatM, cellLonM }),
            // Street right-of-way comes out of the cell on both sides, half from each street.
            block: Object.freeze({
                widthM: cellLonM - streetWidthM,
                depthM: cellLatM - streetWidthM,
                areaM2: (cellLonM - streetWidthM) * (cellLatM - streetWidthM),
                // Blocks that front an arterial give up the wider half-width on that side.
                arterialSetbackM: (arterialWidthM - streetWidthM) / 2
            })
        });
    }

    // ---- geometry ------------------------------------------------------------------------------

    function mod(value, n) { return ((value % n) + n) % n; }

    function isArterialLat(plan, j) { return mod(j, plan.subdivision.nLat) === 0; }
    function isArterialLon(plan, i) { return mod(i, plan.subdivision.nLon) === 0; }

    function latOfLine(plan, j) { return j * plan.local.stepLatSec / 3600; }
    function lonOfLine(plan, i) { return i * plan.local.stepLonSec / 3600; }

    // Half right-of-way of a line, in degrees along the axis perpendicular to it.
    function halfWidthLatDeg(plan, j) {
        const width = isArterialLat(plan, j) ? plan.arterialWidthM : plan.streetWidthM;
        return width / 2 / (plan.metersPerArcsecond.lat * 3600);
    }
    function halfWidthLonDeg(plan, i) {
        const width = isArterialLon(plan, i) ? plan.arterialWidthM : plan.streetWidthM;
        return width / 2 / (plan.metersPerArcsecond.lon * 3600);
    }

    function rectangle(west, south, east, north) {
        return {
            type: 'Polygon',
            coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
        };
    }

    function rectangleAreaM2(plan, west, south, east, north) {
        return (east - west) * plan.metersPerArcsecond.lon * 3600 * (north - south) * plan.metersPerArcsecond.lat * 3600;
    }

    function intersects(box, west, south, east, north) {
        return !(east < box[0] || west > box[2] || north < box[1] || south > box[3]);
    }

    function featureFor(plan, kind, i, j, west, south, east, north, extra) {
        const parcelId = `MP:${plan.code}:${kind}:${i}:${j}`;
        const isRoad = kind !== 'B';
        const areaM2 = Math.round(rectangleAreaM2(plan, west, south, east, north));
        return {
            type: 'Feature',
            properties: Object.assign({
                parcelId,
                id: parcelId,
                parcel_id: parcelId,
                parcel_number: `${kind} ${i}/${j}`,
                kind: kind === 'B' ? 'block' : 'street',
                isRoad,
                provenance: 'schelling-point',
                estimated: true,
                schelling: { algorithm: ALGORITHM, code: plan.code },
                area_m2: areaM2,
                // The parcel panel reads calculatedArea, which the coordinate converter fills in
                // for cadastral features; these arrive already in WGS84 and skip that converter.
                calculatedArea: areaM2
            }, extra || {}),
            geometry: rectangle(west, south, east, north)
        };
    }

    // The tiling. Cell (i, j) spans L_i..L_{i+1} by P_j..P_{j+1} and is covered by exactly three
    // pieces, none overlapping:
    //   B  the block, the cell inset by the half right-of-way of each bounding line;
    //   EW the east-west street segment centred on P_j, running from L_i - hw to L_{i+1} - hw, so
    //      it also owns the intersection at its western end;
    //   NS the north-south street segment centred on L_i between the two east-west strips.
    // Their union is [L_i - hw_i, L_{i+1} - hw_{i+1}] x [P_j - hw_j, P_{j+1} - hw_{j+1}], and those
    // boxes tile the plane as i and j run, so all land is in some parcel and no two parcels overlap.
    function piecesOfCell(plan, i, j) {
        const L0 = lonOfLine(plan, i);
        const L1 = lonOfLine(plan, i + 1);
        const P0 = latOfLine(plan, j);
        const P1 = latOfLine(plan, j + 1);
        const hwL0 = halfWidthLonDeg(plan, i);
        const hwL1 = halfWidthLonDeg(plan, i + 1);
        const hwP0 = halfWidthLatDeg(plan, j);
        const hwP1 = halfWidthLatDeg(plan, j + 1);
        const roadClassEW = isArterialLat(plan, j) ? 'arterial' : 'local';
        const roadClassNS = isArterialLon(plan, i) ? 'arterial' : 'local';
        return [
            { kind: 'B', i, j, west: L0 + hwL0, south: P0 + hwP0, east: L1 - hwL1, north: P1 - hwP1, extra: null },
            { kind: 'EW', i, j, west: L0 - hwL0, south: P0 - hwP0, east: L1 - hwL1, north: P0 + hwP0, extra: { roadClass: roadClassEW } },
            { kind: 'NS', i, j, west: L0 - hwL0, south: P0 + hwP0, east: L0 + hwL0, north: P1 - hwP1, extra: { roadClass: roadClassNS } }
        ];
    }

    // Every parcel that touches the box [west, south, east, north] (degrees). The same parcel comes
    // out identical from any box that touches it, which is what lets a per-cell transport dedupe by
    // id without ever seeing two versions of one parcel.
    function featuresInBbox(plan, bbox) {
        const box = Array.isArray(bbox) ? bbox.map(Number) : null;
        if (!box || box.length < 4 || box.some(value => !Number.isFinite(value))) throw new TypeError('featuresInBbox needs [west, south, east, north].');
        const stepLatDeg = plan.local.stepLatSec / 3600;
        const stepLonDeg = plan.local.stepLonSec / 3600;
        const iMin = Math.floor(box[0] / stepLonDeg) - 1;
        const iMax = Math.ceil(box[2] / stepLonDeg) + 1;
        const jMin = Math.floor(box[1] / stepLatDeg) - 1;
        const jMax = Math.ceil(box[3] / stepLatDeg) + 1;
        const cells = (iMax - iMin + 1) * (jMax - jMin + 1);
        if (cells > 250000) throw new RangeError(`Refusing to lay out ${cells} cells for one request.`);
        const features = [];
        for (let j = jMin; j <= jMax; j += 1) {
            for (let i = iMin; i <= iMax; i += 1) {
                piecesOfCell(plan, i, j).forEach(piece => {
                    if (!intersects(box, piece.west, piece.south, piece.east, piece.north)) return;
                    features.push(featureFor(plan, piece.kind, piece.i, piece.j, piece.west, piece.south, piece.east, piece.north, piece.extra));
                });
            }
        }
        return features;
    }

    // Rebuild one parcel from its id. Ids are opaque to the rest of the app; only this module reads
    // them, and only ids it minted itself (the plan code must match).
    function featureForId(plan, parcelId) {
        const match = /^MP:(.+):(B|EW|NS):(-?\d+):(-?\d+)$/.exec(String(parcelId || ''));
        if (!match || match[1] !== plan.code) return null;
        const i = Number(match[3]);
        const j = Number(match[4]);
        const piece = piecesOfCell(plan, i, j).find(candidate => candidate.kind === match[2]);
        return piece ? featureFor(plan, piece.kind, i, j, piece.west, piece.south, piece.east, piece.north, piece.extra) : null;
    }

    // ---- the numbers the explainer shows ------------------------------------------------------

    function formatDms(valueDeg, axis) {
        const sign = valueDeg < 0 ? -1 : 1;
        const abs = Math.abs(valueDeg);
        let degrees = Math.floor(abs + 1e-9);
        let minutesFloat = (abs - degrees) * 60;
        let minutes = Math.floor(minutesFloat + 1e-9);
        let seconds = (minutesFloat - minutes) * 60;
        seconds = Math.round(seconds * 100) / 100;
        if (seconds >= 60) { seconds -= 60; minutes += 1; }
        if (minutes >= 60) { minutes -= 60; degrees += 1; }
        const hemisphere = axis === 'lon' ? (sign < 0 ? 'W' : 'E') : (sign < 0 ? 'S' : 'N');
        const secondsText = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(2).replace(/0+$/, '');
        return `${degrees}° ${minutes}′ ${secondsText}″ ${hemisphere}`;
    }

    // The arterial lines nearest a point, as degrees-minutes-seconds: this is the "it is at X minutes
    // and Y seconds" the explainer promises, computed rather than asserted.
    function nearestArterials(plan, lat, lng) {
        const stepLatDeg = plan.arterial.stepLatSec / 3600;
        const stepLonDeg = plan.arterial.stepLonSec / 3600;
        const latLine = Math.round(Number(lat) / stepLatDeg) * stepLatDeg;
        const lonLine = Math.round(Number(lng) / stepLonDeg) * stepLonDeg;
        return {
            latLine, lonLine,
            latText: formatDms(latLine, 'lat'),
            lonText: formatDms(lonLine, 'lon'),
            latDistanceM: Math.abs(Number(lat) - latLine) * plan.metersPerArcsecond.lat * 3600,
            lonDistanceM: Math.abs(Number(lng) - lonLine) * plan.metersPerArcsecond.lon * 3600
        };
    }

    function describe(plan, point) {
        const round = (value, digits = 0) => Number(Number(value).toFixed(digits));
        const summary = {
            algorithm: plan.algorithm,
            code: plan.code,
            refLat: plan.refLat,
            metersPerArcsecondLat: round(plan.metersPerArcsecond.lat, 2),
            metersPerArcsecondLon: round(plan.metersPerArcsecond.lon, 2),
            arterialStepLatSec: plan.arterial.stepLatSec,
            arterialStepLonSec: plan.arterial.stepLonSec,
            arterialSpacingLatM: round(plan.arterial.spacingLatM),
            arterialSpacingLonM: round(plan.arterial.spacingLonM),
            arterialWidthM: plan.arterialWidthM,
            streetWidthM: plan.streetWidthM,
            nLat: plan.subdivision.nLat,
            nLon: plan.subdivision.nLon,
            localStepLatSec: round(plan.local.stepLatSec, 3),
            localStepLonSec: round(plan.local.stepLonSec, 3),
            cellLatM: round(plan.local.cellLatM),
            cellLonM: round(plan.local.cellLonM),
            blockWidthM: round(plan.block.widthM),
            blockDepthM: round(plan.block.depthM),
            blockAreaM2: round(plan.block.areaM2),
            blockAreaHa: round(plan.block.areaM2 / 10000, 2),
            blocksPerSuperblock: plan.subdivision.nLat * plan.subdivision.nLon
        };
        if (point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng))) {
            summary.nearest = nearestArterials(plan, point.lat, point.lng);
        }
        return summary;
    }

    const api = Object.freeze({
        ALGORITHM,
        ARCSECOND_LADDER,
        DEFAULTS,
        metersPerDegreeLat,
        metersPerDegreeLon,
        metersPerArcsecondLat,
        metersPerArcsecondLon,
        chooseStep,
        planFor,
        featuresInBbox,
        featureForId,
        nearestArterials,
        formatDms,
        describe
    });

    global.SchellingGrid = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
