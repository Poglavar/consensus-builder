// Exercise bounded worker requests and exact parity with the pure planner used by other consumers.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { create } = require('../../frontend/js/default-floor-plan-worker-client.js');
function harness() {
    const workers = [], timers = [];
    const spawn = vi.fn(() => {
        const worker = { postMessage: vi.fn(), terminate: vi.fn() }; workers.push(worker); return worker;
    });
    const planner = create({ spawn, setTimer: fn => (timers.push(fn), timers.length), clearTimer: vi.fn() });
    const reply = (result, id = workers.at(-1).postMessage.mock.calls.at(-1)[0].id) => workers.at(-1).onmessage({data:{id,result}});
    return { planner, workers, timers, spawn, reply };
}
describe('layout worker client', () => {
    it('sends serializable context, permits one pending request and reuses its worker', async () => {
        const h = harness(), first = h.planner.plan({id:'first'}, {turf:{fn(){}},generator:{fn(){}},cache:new Map(),rules:{region:'HR'}});
        expect(h.workers[0].postMessage.mock.calls[0][0].context).toEqual({rules:{region:'HR'}});
        await expect(h.planner.plan({},{})).rejects.toThrow('already in progress');
        h.reply({value:1});await expect(first).resolves.toEqual({value:1});
        const second=h.planner.plan({},{});h.reply({stale:true},999);expect(h.planner.pending).toBe(true);
        h.reply({value:2});await expect(second).resolves.toEqual({value:2});expect(h.spawn).toHaveBeenCalledTimes(1);h.planner.dispose();
    });
    it('cancels, enforces its watchdog, ignores stale worker errors and starts a fresh worker',async()=>{
        const h=harness(), first=h.planner.plan({},{}), old=h.workers[0];h.planner.dispose();
        await expect(first).rejects.toMatchObject({name:'AbortError'});expect(old.terminate).toHaveBeenCalledTimes(1);
        const second=h.planner.plan({},{});old.onerror({message:'stale error'});expect(h.planner.pending).toBe(true);
        h.timers.at(-1)();await expect(second).rejects.toThrow('time limit');expect(h.workers[1].terminate).toHaveBeenCalledTimes(1);
    });
    it('reports worker failures and structured-clone errors without leaving pending work',async()=>{
        const h=harness(), failed=h.planner.plan({},{});h.workers[0].onerror({message:'load failed',preventDefault:vi.fn()});
        await expect(failed).rejects.toThrow('load failed');expect(h.planner.pending).toBe(false);
        const next=harness();next.spawn.mockImplementation(()=>({postMessage(){throw new Error('not cloneable');},terminate:vi.fn()}));
        await expect(next.planner.plan({},{})).rejects.toThrow('not cloneable');expect(next.planner.pending).toBe(false);
    });
    it('returns exactly the same plan through the actual worker entry point',()=>{
        const directory=resolve(import.meta.dirname,'../../frontend/js');let output;
        const sandbox={console,location:{search:'?build=parity'},postMessage:message=>{output=message;}};sandbox.self=sandbox;
        const context=vm.createContext(sandbox);
        sandbox.importScripts=(...paths)=>paths.forEach(path=>vm.runInContext(readFileSync(resolve(directory,path.split('?')[0]),'utf8'),context,{filename:path}));
        vm.runInContext(readFileSync(resolve(directory,'default-floor-plan-worker.js'),'utf8'),context);
        const feature={type:'Feature',geometry:{type:'Polygon',coordinates:[[[16,45.8],[16.00025,45.8],[16.00025,45.80012],[16,45.80012],[16,45.8]]]},properties:{floors:3,id:'parity'}};
        const options={existing:true,parcels:[],neighbours:[],roads:null,heightM:9,storeyFallbackM:3,region:'HR'};
        context.onmessage({data:{id:7,feature,context:options}});
        expect(output.error).toBeUndefined();expect(output.result.slices[0].result.floorPlans).toBeTruthy();
        const direct=context.__defaultFloorPlanContext.planBuilding(feature,{...options,turf:context.turf,generator:context.__defaultFloorPlans,cache:new Map()});
        expect(JSON.stringify(output.result)).toBe(JSON.stringify(direct));
    });
});
