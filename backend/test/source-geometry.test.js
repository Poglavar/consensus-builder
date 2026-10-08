import {describe,it,expect} from 'vitest';
import {sourceGeometry} from '../floor-plans/source-geometry.js';
import {attachRasterEvidence} from '../floor-plans/raster-evidence.js';
import {geometryIssues} from '../floor-plans/geometry-quality.js';

const source=(wallCandidates,issues=[])=>({version:'source-geometry-v1',widthPx:120,heightPx:100,issues,wallCandidates,scaleCandidates:[]});
const wall=(id,a,b,widthPx=6)=>({id,a,b,widthPx});

describe('measured source geometry',()=>{
    it('keeps an actual opening gap between two aligned source walls',()=>{
        const result=sourceGeometry(source([wall('W1',[10,50],[40,50]),wall('W2',[60,50],[90,50])]));
        expect(result.openingCandidates).toEqual(expect.arrayContaining([expect.objectContaining({a:[40,50],b:[60,50],between:['W1','W2']})]));
    });
    it('does not bridge a declared solid source wall as an opening',()=>{
        const result=sourceGeometry(source([
            wall('W1',[10,50],[40,50]),wall('Wsolid',[35,50],[65,50]),wall('W2',[60,50],[90,50])
        ]));
        expect(result.openingCandidates).toHaveLength(0);
    });
    it('does not invent a span between parallel horizontal walls across a room',()=>{
        const result=sourceGeometry(source([wall('W1',[30,20],[90,20]),wall('W2',[30,80],[90,80])]));
        expect(result.openingCandidates).toHaveLength(0);
    });
    it('retains a T-junction aperture extending outward from a collinear wall endpoint',()=>{
        const result=sourceGeometry(source([
            wall('W6',[342,339],[434,339],5),wall('W20',[432.5,257],[432.5,302],4)
        ]));
        expect(result.openingCandidates).toEqual(expect.arrayContaining([
            expect.objectContaining({a:[433.25,302],b:[433.25,339],between:['W6','W20']})
        ]));
    });
    it('retains a corner rail extension along a measured rail endpoint',()=>{
        const result=sourceGeometry(source([
            wall('W1',[10,40],[30,40],5),wall('R1',[30,70],[30,100],4)
        ]));
        expect(result.openingCandidates).toEqual(expect.arrayContaining([
            expect.objectContaining({a:[30,40],b:[30,70],between:['W1','R1']})
        ]));
    });
    it('derives wall polygons and the source frame solely from measured strokes',()=>{
        const result=sourceGeometry(source([wall('W1',[20,20],[80,20],8),wall('W2',[20,20],[20,70],8)]));
        expect(result.wallCandidates[0].corners).toEqual([[20,24],[80,24],[80,16],[20,16]]);
        expect(result.candidateFramePx).toEqual([16,16,64,54]);
        expect(result.outlineCorners).toEqual([[16,16],[80,16],[80,70],[16,70]]);
    });
});

describe('opening topology',()=>{
    it('holds an opening that crosses an interior wall only between the old sparse sample points',()=>{
        const architecture={dimensionsM:[10,10],
            slabs:[[[[0,0],[1,0],[1,1],[0,1]]]],
            walls:[[[[.36,.45],[.44,.45],[.44,.55],[.36,.55]]]],
            openings:[{kind:'window',a:[0,.5],b:[1,.5],depthM:.1}]};
        expect(geometryIssues(architecture)).toContain('An opening overlaps a solid wall; its wall gap needs review.');
    });
});

describe('raster evidence attachment',()=>{
    const reading=()=>({plans:[{unitId:'A1',quality:{issues:[]}}, {unitId:'B1',quality:{issues:[]}}]});
    const evidence=(unitId,issues=[],rasterEvidence={status:'supported'})=>({unitId,issues,rasterEvidence});
    it.each([
        ['missing', [evidence('A1')]],
        ['mismatched', [evidence('A1'),evidence('other')]],
        ['duplicate', [evidence('A1'),evidence('A1')]]
    ])('rejects %s raster-result identity',(_name,results)=>{
        expect(()=>attachRasterEvidence(reading(),results)).toThrow(/identity mismatch|Incomplete/);
    });
    it('holds only the raster-failed plan for review while retaining its diagnostic',()=>{
        const result=attachRasterEvidence(reading(),[
            evidence('A1'),evidence('B1',['Wall 3 has insufficient source-raster support.'],{status:'needs_review',aggregateSupport:.6})
        ]);
        expect(result.plans[0].quality.rasterEvidence).toMatchObject({checked:true,passed:true});
        expect(result.plans[1].quality.rasterEvidence).toMatchObject({checked:true,passed:false,status:'needs_review'});
        expect(result.plans[1].quality.issues).toContain('Wall 3 has insufficient source-raster support.');
    });
});
