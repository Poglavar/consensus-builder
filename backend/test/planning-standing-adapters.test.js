import { describe, expect, it } from 'vitest';
import { edgeStanding } from '../planning/street-width.js';
import { assemblyIndex, dimensionalConstraints, solveRenovacion } from '../planning/providers/bogota-pot-rules.js';

const square = (x = 0, y = 0, w = .0001) => ({ type: 'Feature', id: `p-${x}`, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + w], [x, y + w], [x, y]]] } });
const street = (y = -.0002) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-.001, y], [0, y], [.001, y]] } });

describe('standing and Bogotá assembly', () => {
    it('does not treat a missing-lot gap as a street', () => {
        const parcel = square();
        const across = square(0, .00025);
        expect(edgeStanding(parcel, [parcel, across], { features: [] }).openEdges).toHaveLength(0);
        expect(edgeStanding(parcel, [parcel, across], { features: [street(-.0002)] }).openEdges.length).toBeGreaterThan(0);
    });
    it('uses exact cession boundary and whole block index', () => {
        expect(assemblyIndex({ corner: true, cessionM2: 400 }).index).toBe(5);
        expect(assemblyIndex({ corner: true, cessionM2: 401 }).index).toBe(6);
        expect(assemblyIndex({ wholeBlock: true }).index).toBe(7);
        expect(assemblyIndex({ corner: false, cessionM2: 1000 }).index).toBe(5);
    });
    it('one street opens one edge, a whole perimeter opens four, and a shared boundary closes its edge', () => {
        const parcel = square(), horizontal = y => street(y);
        const vertical = x => ({ type:'Feature', geometry:{ type:'LineString', coordinates:[[x,-.001],[x,.001]] } });
        expect(edgeStanding(parcel, [], {features:[horizontal(-.00006)]})).toMatchObject({openEdges:[0],corner:false,wholeBlock:false});
        const streets = { features:[horizontal(-.00006),vertical(.00016),horizontal(.00016),vertical(-.00006)] };
        expect(edgeStanding(parcel, [], streets)).toMatchObject({openEdges:[0,1,2,3],corner:true,wholeBlock:true});
        const neighbour = square(.0001);
        expect(edgeStanding(parcel, [{ id:'east', geometry:neighbour.geometry, bbox:[.0001,0,.0002,.0001] }], streets))
            .toMatchObject({openEdges:[0,2,3], wholeBlock:false});
    });
    it('assigns different street-wall start heights to the sides with measured opposite ground', () => {
        const { constraints } = dimensionalConstraints({treatment:'RENOVACION',storeys:20,roleWidths:{front:6,side:10,rear:null}});
        const walls = constraints.filter(item => item.role);
        expect(walls.map(item => [item.quantity,item.fromHeightM])).toEqual([['frontSetback',15],['sideSetback',25]]);
    });
    it('removes internal yards for a whole-block solve', () => {
        const result = solveRenovacion({ lotM2: 1000, standing: { wholeBlock: true } }, constraints => ({ floorAreaM2: 1000 }));
        expect(result.index).toBe(7);
        expect(result.constraints.filter(c => ['rearSetback', 'sideSetback'].includes(c.quantity)).every(c => c.value === 0)).toBe(true);
    });
});
