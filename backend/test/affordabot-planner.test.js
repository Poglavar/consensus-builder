// Geometry, planning-evidence and failure-verdict checks for housing screening.
import { describe,it,expect } from 'vitest';
import * as turf from '@turf/turf';
import {planHousingSites} from '../affordabot/planner.js';
import {siteFromRow,validateScan,fetchHousingSites} from '../affordabot/source.js';
const geometry={type:'Polygon',coordinates:[[[15.95,45.79],[15.951,45.79],[15.951,45.791],[15.95,45.791],[15.95,45.79]]]};
function site(patch={}){return {parcelId:'HR-1-2',geometry,areaM2:turf.area(turf.feature(geometry)),buildingCount:0,planning:{housingUse:true,landUse:{mark:'M1'},rule:{maxFloors:3,minSetbackM:3,maxCoveragePct:30,maxGfaM2:600}},accessibility:{nearestStop:{distanceM:200}},...patch};}
const options={turf};
describe('housing alternatives',()=>{
    it('keeps every footprint inside its source parcel, and its money matches its actual geometry',()=>{
        const result=planHousingSites([site()],options),candidate=result.candidates[0];
        expect(result.status).toBe('complete');expect(candidate.variants.length).toBeGreaterThanOrEqual(3);
        for(const variant of candidate.variants){
            const outside=turf.difference(variant.massing,turf.feature(geometry));
            expect(outside?turf.area(outside):0).toBeLessThan(.02);
            expect(variant.gfaM2).toBeCloseTo(turf.area(variant.massing)*variant.floors,6);
            expect(variant.finance.cost.construction).toBeCloseTo(variant.gfaM2*1600,4);
            if(variant.scenario==='current')expect(variant.gfaM2).toBeLessThanOrEqual(600.01);
            if(variant.form==='courtyard')expect(variant.massing.geometry.coordinates.length).toBeGreaterThan(1);
        }
    });
    it('ranks a lead with a usable planning baseline ahead of an equally sized unknown site',()=>{
        const known=site({parcelId:'known'}),unknown=site({parcelId:'unknown',planning:{housingUse:null,landUse:{},rule:null}});
        const result=planHousingSites([unknown,known],options);
        expect(result.candidates[0].parcelId).toBe('known');
    });
    it('does not turn an unknown baseline into zero homes or a measured uplift',()=>{
        const [candidate]=planHousingSites([site({planning:{housingUse:null,landUse:{},rule:null}})],options).candidates;
        expect(candidate.currentHomes).toBeNull();expect(candidate.addedHomes).toBeNull();
        expect(candidate.variants.every(v=>v.scenario==='reform')).toBe(true);
        expect(candidate.evidenceGaps).toContain('current-capacity');
    });
    it('separates an extracted non-housing designation from missing use data',()=>{
        const [candidate]=planHousingSites([site({planning:{housingUse:false,landUse:{mark:'K2'},rule:null}})],options).candidates;
        expect(candidate.currentHomes).toBe(0);expect(candidate.changes).toContainEqual({field:'housingUse',from:'K2',to:'residential-or-mixed'});
    });
    it('excludes mapped occupation and sensitive land rather than optimizing over them',()=>{
        const result=planHousingSites([site({buildingCount:1}),site({parcelId:'HR-1-3',planning:{sensitiveUse:true}})],options);
        expect(result.candidates).toEqual([]);expect(result.excluded.map(x=>x.reason)).toEqual(['existing-buildings','sensitive-land-use']);
    });
    it('does not call a run complete after a corrupt or unmeasured site',()=>{
        const result=planHousingSites([site(),site({parcelId:'bad',areaM2:null}),site({parcelId:'unknown',buildingCount:null})],options);
        expect(result.candidates).toHaveLength(1);expect(result.status).toBe('partial');expect(result.failures).toHaveLength(2);
    });
    it('respects extracted dwelling and typology limits and identifies the requested relaxations',()=>{
        const rule={maxFloors:3,minSetbackM:5,maxCoveragePct:30,maxUnits:3,minParkingPerUnit:1,allowedTypologies:['detached'],maxGfaM2:600};
        const [candidate]=planHousingSites([site({planning:{housingUse:true,landUse:{mark:'M1'},rule}})],options).candidates;
        const baseline=candidate.variants.filter(v=>v.scenario==='current');
        expect(baseline).toHaveLength(1);expect(baseline[0].form).toBe('compact');expect(baseline[0].finance.homes).toBeLessThanOrEqual(3);
        const courtyard=candidate.variants.find(v=>v.id==='reform-courtyard');
        expect(courtyard.changes.map(c=>c.field)).toEqual(expect.arrayContaining(['floors','setbackM','maxGfaM2','maxUnits','parkingPerHome','typology']));
    });
});
describe('source mapping and bounded scope',()=>{
    it('preserves missing extracted limits and the source timestamps',()=>{
        const value=siteFromRow({maticni_broj_ko:1,broj_cestice:'2/1',area_m2:'1234',land_use_mark:'M2',rule_short_name:'2.7',variables:{max_etage:null},feed_id:7,feed_fetched_at:'2026-10-18T10:00:00Z',parcel_date_added:'2026-10-01T10:00:00Z'});
        expect(value.parcelId).toBe('HR-1-2/1');expect(value.planning.housingUse).toBe(true);expect(value.planning.rule.maxFloors).toBeNull();
        expect(value.accessibility.feedFetchedAt).toBe('2026-10-18T10:00:00Z');expect(value.source.parcelDateAdded).toBe('2026-10-01T10:00:00Z');
        expect(value.accessibility.nearestStop).toBeNull();
    });
    it('refuses inverted, unbounded and unsupported-city scans',()=>{
        expect(()=>validateScan({bbox:[-180,-90,180,90]})).toThrow();expect(()=>validateScan({bbox:[15.97,45.81,15.93,45.78]})).toThrow();
        expect(()=>validateScan({sampleLimit:100000})).toThrow();expect(()=>validateScan({limit:0})).toThrow();
    });
});

describe('bounded read-only source work',()=>{
    it('releases a failed transaction rather than leaking a checked-out connection',async()=>{
        const calls=[],client={query:async(text)=>{calls.push(text);if(text.includes('WITH search'))throw new Error('query canceled');return {rows:[]};},release:()=>calls.push('released')};
        await expect(fetchHousingSites({connect:async()=>client},{})).rejects.toThrow('query canceled');
        expect(calls[0]).toBe('BEGIN READ ONLY');expect(calls[1]).toContain('statement_timeout');
        expect(calls.slice(-2)).toEqual(['ROLLBACK','released']);
    });
});
