// The app's layout worker (frontend/js/default-floor-plan-worker.js) loads the shared planner and returns exactly
// the plan the planner gives directly. The worker client and the planner have their own tests in interior-viewer.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
describe('layout worker', () => {
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
