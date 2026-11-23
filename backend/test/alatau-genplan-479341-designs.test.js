// Tests for restatements/alatau-genplan-479341: the designs district-designs.mjs builds from the committed
// zone snapshot (one block layout whose plots are the general plan's zones, one road placed in the street
// ground, one park per green zone), their areas against the district, and the committed plan file.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { appTurf as turf } from '../agents/mcp-geometry.js';
import { AUTHOR, CITY, DECREE_DATE, PLAN_FILE, districtPlan, districtPlanFile } from '../../restatements/alatau-genplan-479341/district-designs.mjs';
import { planObjects } from '../scripts/lib/restatement-publish.mjs';

const require = createRequire(import.meta.url);
const PlanFile = require('../../frontend/js/plan-file.js');
const LayoutValidation = require('../../frontend/js/parcel-layout-validation.js');

const feature = geometry => ({ type: 'Feature', properties: {}, geometry });
const area = geometry => turf.area(feature(geometry));
const symmetricDifferenceM2 = (a, b) => {
    const one = turf.difference(feature(a), feature(b)), two = turf.difference(feature(b), feature(a));
    return (one ? turf.area(one) : 0) + (two ? turf.area(two) : 0);
};
const plan = districtPlan();
const objects = planObjects(plan);
const { ground } = plan;
const byGoal = goal => objects.filter(object => object.content.goal === goal);
const layout = byGoal('parcel-layout')[0].content.parcelLayout;

const DISTRICT_ZONES = ['476365', '476370', '479336', '479340', '479341', '479343', '479346', '479350', '479492',
    '480457', '480511', '480585', '480588', '480589', '480595', '480997', '482147', '482149'];

describe('the district of the Alatau general plan', () => {
    it('holds the 3×3 of blocks around zone 479341 and every zone inside it', () => {
        expect(ground.zones.features.map(zone => String(zone.id)).sort()).toEqual(DISTRICT_ZONES);
        expect(ground.district.properties.centreZone).toBe('479341');
        expect(ground.zones.features.every(zone => zone.properties.use.stage === 'planned' && zone.properties.landBasis === 'zone')).toBe(true);
    });

    it('leaves out only the square inside green ring 480457, which no zone covers', () => {
        expect(ground.unzoned).toHaveLength(1);
        expect(area(ground.unzoned[0])).toBeCloseTo(1254.5, 0);
        const ring = ground.zones.features.find(zone => zone.id === '480457').geometry;
        expect(turf.booleanWithin(turf.centroid(feature(ground.unzoned[0])), feature(ring))).toBe(false);
    });
});

describe('the restated designs', () => {
    it('are one block layout, one road and eight parks, with no buildings or urban rules', () => {
        expect(objects.map(object => object.content.goal)).toEqual(['parcel-layout', 'road-track', ...Array(8).fill('park')]);
        expect(objects.every(object => object.content.city === CITY && object.content.author === AUTHOR)).toBe(true);
    });

    it('are dated on the decree, one millisecond apart in formation order', () => {
        expect(objects.map(object => object.content.authoredAt))
            .toEqual(objects.map((_, index) => new Date(Date.parse(DECREE_DATE) + index).toISOString()));
    });

    it('give every plot from one zone of the plan: the whole zone, or its part inside the district', () => {
        expect(layout.plots).toHaveLength(DISTRICT_ZONES.length);
        ground.plots.forEach((plot, index) => {
            const zone = ground.zones.features.find(item => String(item.id) === plot.zoneId);
            expect(layout.plots[index].geometry).toEqual(plot.geometry);
            const expected = plot.clipped ? turf.intersect(feature(zone.geometry), feature(ground.outline)).geometry : zone.geometry;
            expect(symmetricDifferenceM2(plot.geometry, expected)).toBeLessThan(0.01);
        });
        expect(ground.plots.filter(plot => plot.clipped).map(plot => plot.zoneId).sort()).toEqual(['480511', '480997']);
    });

    it('tile the district: plot areas sum to the outline less the unzoned square, within 1 m²', () => {
        const plotSum = layout.plots.reduce((sum, plot) => sum + area(plot.geometry), 0);
        const district = area(ground.outline) - area(ground.unzoned[0]);
        expect(Math.abs(plotSum - district)).toBeLessThan(1);
        expect(Math.abs(area(layout.pool) - district)).toBeLessThan(1);
        expect(LayoutValidation.validate(layout, { turf }).valid).toBe(true);
    });

    it('place one bounded road on exactly the street ground', () => {
        const [road] = byGoal('road-track');
        const street = ground.plots.find(plot => plot.use.key === 'roads');
        expect(road.content.roadProposal.definition.bound).toBeTruthy();
        expect(symmetricDifferenceM2(road.content.roadProposal.definition.bound.site, street.geometry)).toBeLessThan(0.01);
    });

    it('give each green or parks zone one park on its plot and no furniture', () => {
        const green = ground.plots.filter(plot => plot.use.group === 'green');
        expect(byGoal('park').map(park => park.content.structureProposal.geometry)).toEqual(green.map(plot => plot.geometry));
        expect(byGoal('park').every(park => !(park.content.structureProposal.decorationDesign?.trees?.length))).toBe(true);
    });

    it('have deterministic CIDs, the same in the committed plan file', async () => {
        expect(planObjects(districtPlan()).map(object => object.cid)).toEqual(objects.map(object => object.cid));
        const committed = PlanFile.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
        expect(committed).toEqual(await districtPlanFile());
        expect([...committed.plan.designCids].sort()).toEqual(objects.map(object => object.cid).sort());
        expect(committed.plan.title).toBe(plan.title);
    });
});
