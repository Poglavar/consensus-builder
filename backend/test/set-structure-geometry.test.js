// scripts/set-structure-geometry.mjs: a structure's authored body is replaced in both copies the
// row keeps of it, and the CLI refuses to run without a row and a geometry.
import { describe, expect, it } from 'vitest';
import { parseArgs, withGeometry } from '../scripts/set-structure-geometry.mjs';

const square = d => ({ type: 'Polygon', coordinates: [[[0, 0], [d, 0], [d, d], [0, d], [0, 0]]] });

describe('withGeometry', () => {
    it('replaces the body in structure_proposal and proposal_data, leaving the rest alone', () => {
        const row = { id: 14, structure_proposal: { kind: 'park', geometry: square(2), blockName: 'B' },
            proposal_data: { goal: 'park', geometry: square(2), structureProposal: { kind: 'park', geometry: square(2) }, title: 'Park' } };
        const next = withGeometry(row, square(1));
        expect(next.structure_proposal).toEqual({ kind: 'park', geometry: square(1), blockName: 'B' });
        expect(next.proposal_data.structureProposal.geometry).toEqual(square(1));
        expect(next.proposal_data.geometry).toEqual(square(1));
        expect(next.proposal_data.title).toBe('Park');
        expect(row.structure_proposal.geometry).toEqual(square(2));
    });

    it('refuses a non-polygon geometry and a row without an authored body', () => {
        expect(() => withGeometry({ id: 1, structure_proposal: { geometry: square(1) } }, { type: 'Point', coordinates: [0, 0] })).toThrow();
        expect(() => withGeometry({ id: 1, road_proposal: {} }, square(1))).toThrow(/not a structure/);
    });
});

describe('parseArgs', () => {
    it('needs an id, and a geometry unless restoring', () => {
        expect(() => parseArgs(['--geometry', 'x.json'])).toThrow(/--id/);
        expect(() => parseArgs(['--id', '14'])).toThrow(/--geometry/);
        expect(parseArgs(['--id', '14', '--restore'])).toMatchObject({ id: 14, restore: true });
        expect(parseArgs(['--id', '14', '--geometry', 'x.json'])).toMatchObject({ id: 14, apply: false });
        expect(parseArgs(['--help']).help).toBe(true);
    });
});
