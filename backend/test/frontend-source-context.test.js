// Source choices belong to frontend configuration, including choices made away from the current map.
import {describe,it,expect} from 'vitest';
import { cityConfigSource } from './helpers/city-config-source.js';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const WorldCoverage=require('../../frontend/js/world/world-coverage.js');
const BOOT_COVERAGE=require('../../frontend/data/world-coverage.json');
function frontend() {
    const context={URLSearchParams,console,WorldCoverage,BOOT_COVERAGE}; context.window=context;
    runInNewContext(cityConfigSource(),context);
    return context.CityConfigManager;
}
describe('frontend data context',()=>{
    it('names the concrete dataset for imported and live parcels and all building defaults',()=>{
        const manager=frontend();
        for(const city of manager.getAvailableCities()) {
            const context=manager.getDataContext(null,city.id);
            expect(context.parcelSourceId,city.id).toBe(city.parcels.sourceId||city.parcels.source);
            expect(context.buildingSourceId,city.id).toBeTruthy();
        }
        expect(manager.getDataContext(null,'zagreb')).toMatchObject({parcelSourceId:'oss-wfs',buildingSourceId:'gdi-3d',floorModelNamespace:'zagreb'});
        expect(manager.getDataContext(null,'new_york')).toMatchObject({parcelSourceId:'parcel-nyc',buildingSourceId:'nyc-3d',floorModelNamespace:'new_york'});
    });
    it('selects by the requested geometry in the frontend, independently of the session city',()=>{
        const manager=frontend();
        expect(manager.getParcelContext({type:'Point',coordinates:[-74.006,40.7128]},'zagreb'))
            .toEqual({city:'new_york',parcelSourceId:'parcel-nyc'});
    });
    it('routes cadastral dependencies by geometry and coverage, never by city text',()=>{
        const manager=frontend();
        const current=manager.getCurrentCityId();
        const elsewhere=current==='new_york' ? {city:'zagreb',point:[15.9706,45.81305],id:'HR-1'}
            : {city:'new_york',point:[-74.006,40.7128],id:'US-NY-1'};
        const site={type:'Point',coordinates:elsewhere.point};
        for(const city of [current,elsewhere.city,'misleading-label',null]) {
            expect(manager.foreignGroundContextFor({city,site,cadastreParcelIds:[elsewhere.id]})).toBe(elsewhere.city);
            expect(manager.foreignGroundContextFor({city,site,cadastreParcelIds:[]})).toBeNull();
            expect(manager.foreignGroundContextFor({city,content:{city,site},binding:{parcels:[{parcelId:elsewhere.id}]}})).toBe(elsewhere.city);
        }
        expect(manager.foreignGroundContextFor({city:'new_york',site:{type:'Point',coordinates:[35,35]},cadastreParcelIds:[]})).toBeNull();
    });
});
