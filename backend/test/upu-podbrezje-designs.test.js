// The UPU Podbrežje restatement (restatements/upu-podbrezje): the two plans share their designs, the
// remainder leaves out what is built or under construction, and the street axis runs down its band.
import { describe, it, expect } from 'vitest';
import { bandCentreline, fullPlan, NOT_IN_REMAINDER, remainderPlan } from '../../restatements/upu-podbrezje/podbrezje-designs.mjs';

describe('UPU Podbrežje plans', () => {
    const full = fullPlan();
    const remainder = remainderPlan();

    it('the whole plan has both streets, the parcel layout, three parks and eighteen buildings', () => {
        const goals = full.designs.map(design => design.record.goal);
        expect(goals.filter(goal => goal === 'road-track')).toHaveLength(2);
        expect(goals.filter(goal => goal === 'parcel-layout')).toHaveLength(2);
        expect(goals.filter(goal => goal === 'park')).toHaveLength(3);
        expect(goals.filter(goal => goal === 'buildings')).toHaveLength(18);
    });

    it('every building and park stands on its own kazeta plot', () => {
        const layouts = full.designs.filter(design => design.record.goal === 'parcel-layout').map(design => design.record.parcelLayout);
        const layout = { plots: layouts.flatMap(item => item.plots), totalArea: layouts.reduce((sum, item) => sum + item.totalArea, 0) };
        const plotArea = layout.plots.reduce((sum, plot) => sum + plot.area, 0);
        expect(Math.abs(plotArea - layout.totalArea)).toBeLessThan(1);
        for (const design of full.designs.filter(item => item.record.goal === 'buildings')) {
            expect(design.record.geometry.surroundings?.polygon?.type, design.key).toBe('Polygon');
        }
        const park = full.designs.find(design => design.key === 'park-g3').record.geometry;
        expect(layout.plots.some(plot => JSON.stringify(plot.geometry) === JSON.stringify(park))).toBe(true);
    });

    it('the remainder is the whole plan without the built and the under-construction members, design for design', () => {
        const fullByKey = new Map(full.designs.map(design => [design.key, design.record]));
        const left = remainder.designs.map(design => design.key);
        expect(left).toHaveLength(full.designs.length - NOT_IN_REMAINDER.length);
        for (const key of ['zgrada-a3', 'zgrada-a4', 'zgrada-a5', 'zgrada-a6', 'zgrada-a11', 'zgrada-c1', 'ulice-sjever-istok']) {
            expect(left).not.toContain(key);
        }
        remainder.designs.forEach(design => expect(design.record).toEqual(fullByKey.get(design.key)));
    });

    it('every slab stays within its kazeta\'s floor-area limit', () => {
        for (const design of full.designs.filter(item => /^zgrada-a\d+$/.test(item.key))) {
            const match = design.record.description.match(/oko ([\d.]+) m² nadzemne GBP \(najviše kisn [\d,]+ × kazeta = ([\d.]+) m²\)/);
            expect(match, design.key).not.toBeNull();
            const [gbp, limit] = [Number(match[1].replace(/\./g, '')), Number(match[2].replace(/\./g, ''))];
            expect(gbp).toBeLessThanOrEqual(limit * 1.005);
        }
    });
});

describe('bandCentreline', () => {
    it('runs west to east down the middle of a band', () => {
        const band = { type: 'Polygon', coordinates: [[[0, 0], [100, 0], [100, 10], [0, 10], [0, 0]]] };
        const axis = bandCentreline(band, 4);
        expect(axis[0][0]).toBeCloseTo(0, 6);
        expect(axis[axis.length - 1][0]).toBeCloseTo(100, 6);
        axis.forEach(([, y]) => expect(y).toBeCloseTo(5, 6));
    });
});
