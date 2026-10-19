import { describe, it, expect, vi } from 'vitest';
import { readBuildingContext, CONTEXT_LIMIT, CONTEXT_RADIUS_M } from '../floor-plan-archive/building-context.js';

const footprint = { type:'Polygon', coordinates:[[[16,45],[16.001,45],[16.001,45.001],[16,45]]] };
const project = { model:{ envelope:{ footprint } } };
describe('bounded public building surroundings', () => {
    it('does not query without a project footprint', async () => {
        const db={query:vi.fn()};
        expect(await readBuildingContext(db,{})).toBeNull();expect(db.query).not.toHaveBeenCalled();
    });
    it('excludes the replaced survey building and retains a common measured altitude', async () => {
        const old={object_id:1,z_min:123,replaced:true},neighbour={object_id:2,z_min:125,faces:[]},missing={object_id:3,z_min:null};
        const db={query:vi.fn().mockResolvedValue({rows:[neighbour,old,missing]})};
        expect(await readBuildingContext(db,project)).toMatchObject({buildings:[neighbour],groundZ:123,radiusM:65,source:'zagreb-3d',surveyYear:2022,truncated:false});
        const [sql,params]=db.query.mock.calls[0];
        expect(sql).toContain('ST_DWithin');expect(params).toEqual([JSON.stringify(footprint),CONTEXT_RADIUS_M,CONTEXT_LIMIT+1]);
    });
    it('reports truncation and never uses missing altitude as sea level', async () => {
        const rows=Array.from({length:CONTEXT_LIMIT+1},(_,object_id)=>({object_id,z_min:100+object_id,faces:[]}));
        const db={query:vi.fn().mockResolvedValue({rows})};
        const result=await readBuildingContext(db,project);
        expect(result.buildings).toHaveLength(CONTEXT_LIMIT);expect(result.truncated).toBe(true);
        db.query.mockResolvedValue({rows:[{z_min:null},{z_min:'123'}]});
        expect(await readBuildingContext(db,project)).toMatchObject({buildings:[],groundZ:null});
    });
});
