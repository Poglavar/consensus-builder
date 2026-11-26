// The planning application preview (frontend/js/planning/application-preview.js): which cities get a
// submission target, the red line from the designs' sites, and figures that stay null when no
// building states them, never 0.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const Preview = require('../../frontend/js/planning/application-preview.js');
const { geometryAreaM2 } = require('../../frontend/js/proposals/plan-yield.js');
const config = JSON.parse(readFileSync(new URL('../../frontend/data/planning-sources.json', import.meta.url), 'utf8'));

const rect = (lon0, lat0, lon1, lat1) => ({ type: 'Polygon', coordinates: [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]] });
const building = (geometry, properties) => ({ type: 'Feature', geometry, properties });
const helpers = {
    siteOf: record => record.site || null,
    unite: features => features.slice(1).reduce((union, feature) => turf.union(union, feature), features[0]),
    areaOf: geometryAreaM2
};

describe('submission target', () => {
    it('gives an English city the Open Digital Planning target and a city without that jurisdiction none', () => {
        const target = Preview.targetFor(config, ['gb-eng-planning']);
        expect(target).toMatchObject({ id: 'gb-eng-odp-application', jurisdiction: 'GB-ENG', format: 'Open Digital Planning' });
        expect(target.systems).toEqual(['PlanX', 'BOPS']);
        expect(Preview.targetFor(config, [])).toBeNull();
        expect(Preview.targetFor(config, ['no-such-rule-set'])).toBeNull();
        expect(Preview.targetFor({ ...config, submissionTargets: [] }, ['gb-eng-planning'])).toBeNull();
    });
});

describe('preview', () => {
    const target = Preview.targetFor(config, ['gb-eng-planning']);
    const west = rect(0.12, 52.2, 0.1205, 52.2003), east = rect(0.1205, 52.2, 0.121, 52.2003);

    it('draws the red line around every design site and measures the buildings', () => {
        const records = [
            { site: west, buildingProposal: { buildings: [building(rect(0.1201, 52.2001, 0.1203, 52.2002), { floors: 4, height: 12 })] } },
            { site: east, buildingProposal: { buildings: [building(rect(0.1206, 52.2001, 0.1208, 52.2002), { floors: 7, height: 21 })] } }
        ];
        const model = Preview.preview({ records, target, link: 'https://example.test/plans/x', ...helpers });
        const expected = geometryAreaM2(rect(0.12, 52.2, 0.121, 52.2003));
        expect(model.redLine.areaM2).toBeCloseTo(expected, 0);
        expect(model.figures.buildings).toBe(2);
        expect(model.figures.tallestStoreys).toBe(7);
        expect(model.figures.grossFloorAreaM2).toBeGreaterThan(0);
        expect(model.figures.homes).toBeGreaterThan(0);
        expect(model.attachments).toEqual(['sitePlan.proposed', 'visualisations']);
        const boundary = Preview.boundaryFeature(model, 'Riverside');
        expect(boundary).toMatchObject({ type: 'Feature', properties: { name: 'Riverside', format: 'gb-eng-odp-application', link: 'https://example.test/plans/x' } });
        expect(boundary.geometry.type).toMatch(/Polygon$/);
    });

    it('leaves figures no building states as null and has no red line without a site', () => {
        const model = Preview.preview({ records: [{ buildingProposal: { buildings: [building(rect(0.1201, 52.2001, 0.1203, 52.2002), {})] } }], target, ...helpers });
        expect(model.redLine).toBeNull();
        expect(model.figures).toMatchObject({ buildings: 1, grossFloorAreaM2: null, homes: null, tallestStoreys: null, openSpaceM2: null });
        expect(Preview.boundaryFeature(model, 'x')).toBeNull();
        expect(Preview.preview({ records: [], target: null, ...helpers })).toBeNull();
    });
});
