// One authority for "how much land is this": the WGS84 ellipsoid.
//
// The browser measures with turf, which is geodesic. PostGIS `ST_Area(geom)` on a projected CRS
// (Zagreb parcels are HTRS96/TM, EPSG:3765) measures in the plane, and the two disagree by the
// projection's scale distortion — measured at 58,226 m² projected against 58,236 m² geodesic for
// one Borovje parcel, and 0.04–0.25% across the plan. That difference surfaced as a replay-fidelity
// warning claiming a proposal took different ground than when published, when the ground was
// identical and only the ruler had changed.
//
// So: any area that leaves the server as an ABSOLUTE m² must be geodesic. Areas used only as a
// ratio against another area in the same CRS may stay projected — the projection cancels — and
// those sites say so.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Every ST_Area(...) occurrence in a file, with a little context either side.
function areaCalls(source) {
    const calls = [];
    const pattern = /ST_Area\s*\(/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        // Balance the parentheses so nested calls come out whole.
        let depth = 0;
        let i = match.index + match[0].length - 1;
        for (; i < source.length; i++) {
            if (source[i] === '(') depth++;
            else if (source[i] === ')') { depth--; if (!depth) break; }
        }
        const call = source.slice(match.index, i + 1);
        const lineStart = source.lastIndexOf('\n', match.index) + 1;
        const lineEnd = source.indexOf('\n', i);
        calls.push({ call, line: source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd) });
    }
    return calls;
}

const isGeodesic = call => call.includes('::geography');
// A ratio compares two areas on the same line, so the units cancel.
const isRatio = line => /ST_Area[\s\S]*(\/|>=|<=|>|<)[\s\S]*ST_Area/.test(line);

describe('absolute areas served to a client are geodesic', () => {
    it.each([
        ['routes/parcels.js', 'calculated_area'],
        ['routes/parcel-lj.js', 'calculated_area'],
        ['routes/parcel-co.js', 'calculated_area'],
        ['routes/road-corridor.js', 'full_area_m2'],
        ['routes/buildings.js', 'footprint_area']
    ])('%s measures %s on the ellipsoid', (path, alias) => {
        const source = read(path);
        const aliased = areaCalls(source).filter(entry => entry.line.includes(alias));
        expect(aliased.length).toBeGreaterThan(0);
        aliased.forEach(entry => {
            expect(isGeodesic(entry.call), `${path} → ${alias}: ${entry.call}`).toBe(true);
        });
    });

    it('road-corridor reports the taken area geodesically too', () => {
        const source = read('routes/road-corridor.js');
        const taken = areaCalls(source).filter(entry => entry.line.includes('taken_area_m2'));
        expect(taken.length).toBeGreaterThan(0);
        taken.forEach(entry => expect(isGeodesic(entry.call)).toBe(true));
    });
});

describe('projected areas are only ever used as ratios', () => {
    it.each([
        'routes/parcels.js',
        'routes/parcel-lj.js',
        'routes/road-corridor.js',
        'routes/buildings.js',
        'buildings/zagreb-3d.js'
    ])('%s has no projected area escaping as an absolute value', path => {
        const source = read(path);
        const offenders = areaCalls(source)
            .filter(entry => !isGeodesic(entry.call) && !isRatio(entry.line))
            .map(entry => entry.line.trim());
        expect(offenders, `projected ST_Area not used as a ratio in ${path}`).toEqual([]);
    });
});

describe('the stamp the fidelity check compares against', () => {
    it('takes its areas from turf, not from SQL', () => {
        // The backfill narrows candidates with PostGIS but must MEASURE with the same module the
        // browser uses, or the stamp and the live computation are two different rulers again.
        const source = read('scripts/backfill-ownership-flow.js');
        expect(source).toContain("frontend/js/proposals/ownership-flow.js");
        const candidateSql = source.slice(source.indexOf('CANDIDATE_SQL'), source.indexOf('function totalCededM2'));
        expect(candidateSql).not.toMatch(/ST_Area/);
    });
});
