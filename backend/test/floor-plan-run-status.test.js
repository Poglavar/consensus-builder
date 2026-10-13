// Interrupted source/pipeline rows must not appear live once their worker's lock is gone.
import { expect,it,vi } from 'vitest';
import { latestRun } from '../floor-plans/run-status.js';
it.each([false,true])('reports a stale running row as interrupted (pipeline=%s)',async pipeline=>{
    const row={id:'run-1',status:'running',worker_active:false,counters:{unchanged:10}};
    const db={query:vi.fn(async()=>({rows:[row]}))};
    expect(await latestRun(db,{pipeline})).toMatchObject({status:'interrupted',recordedStatus:'running',workerActive:false,counters:{unchanged:10}});
    expect(db.query.mock.calls[0][1]).toEqual([pipeline?'floor-plan-daily':'floor-plan-crawl']);
});
it('reports the actual lock owner as live and preserves terminal run outcomes',async()=>{
    const db={query:vi.fn(async()=>({rows:[{id:'r',status:'running',worker_active:true}]}))};
    expect(await latestRun(db)).toMatchObject({status:'running',workerActive:true});
    db.query.mockResolvedValue({rows:[{id:'r',status:'partial',worker_active:true}]});
    expect(await latestRun(db)).toMatchObject({status:'partial',workerActive:false});
    db.query.mockResolvedValue({rows:[]});expect(await latestRun(db)).toBeNull();
});
