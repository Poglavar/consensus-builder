// Metres are never the active city's (projections.md §2): the city-wide metric pair
// (wgs84ToHTRS96 / htrs96ToWGS84), city-driven metric selection (getMetricCrs, latLngToMetric,
// metricToLatLng) and per-city metric projections are deleted, not wrapped — they made a 19 m street
// in Zagreb 13.65 m wide whenever New York was the active city. This guard fails if any comes back:
// everything measured or built in metres takes an explicit frame (metric-frame.js).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendJs = fileURLToPath(new URL('../../frontend/js/', import.meta.url));

function scripts(dir) {
    return readdirSync(dir).flatMap(name => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === 'vendor' ? [] : scripts(path);
        return name.endsWith('.js') && !name.endsWith('.min.js') ? [path] : [];
    });
}

describe('no city-wide metric projection', () => {
    it('no frontend script calls the deleted pair or city-driven metric selection', () => {
        const offenders = [];
        for (const path of scripts(frontendJs)) {
            const source = readFileSync(path, 'utf8');
            for (const call of ['wgs84ToHTRS96(', 'htrs96ToWGS84(', 'getMetricCrs(', 'CityConfigManager.latLngToMetric', 'CityConfigManager.metricToLatLng']) {
                if (source.includes(call)) offenders.push(`${relative(frontendJs, path)}: ${call}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('no city declares a metric projection', () => {
        const config = readFileSync(join(frontendJs, 'city-config.js'), 'utf8');
        expect(config).not.toMatch(/metricCrs\s*:/);
        expect(config).not.toMatch(/metricDefinition\s*:/);
        expect(config).not.toMatch(/exploreProjection/);
    });

    it('the guard can fail: it sees a call the way it is written', () => {
        expect('const [x, y] = wgs84ToHTRS96(lat, lng);'.includes('wgs84ToHTRS96(')).toBe(true);
        expect("projection: { datasetCrs: 'EPSG:4326', metricCrs: 'EPSG:32618' }").toMatch(/metricCrs\s*:/);
    });
});
