// Tests the affordability claims: capital recovery, missing evidence and who actually pays for parking.
import { describe,it,expect } from 'vitest';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {rentalFeasibility,validateAssumptions,buildResearchProposal}=require('../../frontend/js/affordabot-model.js');
const shape={gfaM2:1000,siteAreaM2:500};
const inputs={constructionEurM2:1000,landEurM2:0,softCostPct:0,contingencyPct:0,annualInterestPct:0,loanYears:50,operatingEurM2Month:0,vacancyPct:0,utilitiesMonth:0};
describe('rental feasibility',()=>{
    it('recovers the full building cost over whole homes, including the zero-interest case',()=>{
        const result=rentalFeasibility(shape,inputs);
        expect(result.homes).toBe(16);expect(result.rentMonth).toBeCloseTo(1000000/600/16,8);
        expect(result.cost.financed).toBe(1000000);expect(result.withinTarget).toBe(true);
    });
    it('charges parking and land to residents rather than calling them free',()=>{
        const base=rentalFeasibility(shape,inputs),parking=rentalFeasibility(shape,{...inputs,parkingPerHome:.6,parkingEur:10000,landEurM2:100});
        expect(parking.cost.parkingSpaces).toBe(10);expect(parking.cost.land).toBe(50000);
        expect(parking.rentMonth-base.rentMonth).toBeCloseTo(150000/600/16,8);
    });
    it('keeps financing finite at an extremely small interest rate',()=>{
        const result=rentalFeasibility(shape,{...inputs,annualInterestPct:1e-100});
        expect(result.rentMonth).toBeCloseTo(1000000/600/16,8);
    });
    it('charges the extracted parking minimum in the baseline even when the proposed scenario removes it',()=>{
        const base=rentalFeasibility({...shape,minParkingPerHome:1},{...inputs,parkingEur:10000});
        expect(base.cost.parkingSpaces).toBe(16);expect(base.assumptions.parkingPerHome).toBe(1);
    });
    it('counts vacancy and utilities in the household burden and rent target',()=>{
        const result=rentalFeasibility(shape,{...inputs,vacancyPct:10,utilitiesMonth:100,householdIncomeMonth:1000});
        expect(result.targetRentMonth).toBe(200);
        expect(result.rentMonth).toBeCloseTo(1000000/600/.9/16,8);
        expect(result.totalHousingMonth).toBeCloseTo(result.rentMonth+100,8);
    });
    it('calculates the capital support needed to meet the target',()=>{
        const expensive=rentalFeasibility(shape,{...inputs,householdIncomeMonth:100});
        const funded=rentalFeasibility(shape,{...inputs,householdIncomeMonth:100,grantPerHome:expensive.additionalGrantPerHome});
        expect(funded.rentMonth).toBeCloseTo(expensive.targetRentMonth,8);
        expect(funded.cost.financed).toBeGreaterThanOrEqual(0);
    });
    it('does not claim capital support can solve an operating-cost deficit',()=>{
        const result=rentalFeasibility(shape,{...inputs,householdIncomeMonth:100,operatingEurM2Month:2});
        expect(result.operatingFloorAboveTarget).toBe(true);
    });
    it('preserves missing costs as unknown, including land that must not silently become free',()=>{
        const result=rentalFeasibility(shape,{...inputs,landEurM2:null});
        expect(result.homes).toBe(16);expect(result.rentMonth).toBeNull();expect(result.missing).toContain('landEurM2');
        expect(rentalFeasibility({gfaM2:null,siteAreaM2:500},inputs).homes).toBeNull();
    });
    it('keeps all capital costs when a dwelling limit caps the usable home count',()=>{
        const result=rentalFeasibility({...shape,maxHomes:2},inputs);
        expect(result.homes).toBe(2);expect(result.cost.capital).toBe(1000000);expect(result.rentMonth).toBeCloseTo(1000000/600/2,8);
    });
    it('rejects unsafe numeric values instead of returning plausible nonsense',()=>{
        expect(()=>validateAssumptions({landEurM2:-1})).toThrow();expect(()=>validateAssumptions({vacancyPct:100})).toThrow();
        expect(()=>validateAssumptions({constructionEurM2:'1600'})).toThrow();expect(()=>validateAssumptions({unused:1})).toThrow();
    });
    it('brackets the base rent with a construction-cost sensitivity range',()=>{
        const result=rentalFeasibility(shape,inputs);
        expect(result.rentLowMonth).toBeLessThan(result.rentMonth);expect(result.rentHighMonth).toBeGreaterThan(result.rentMonth);
    });
});
describe('research proposal',()=>{
    it('preserves source parcel identity and the authored hole without asserting ownership or approval',()=>{
        const geometry={type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]],[[.2,.2],[.2,.8],[.8,.8],[.8,.2],[.2,.2]]]};
        const site={parcelId:'HR-1-2',areaM2:500,planning:{vintage:'2025'},accessibility:{method:'straight-line-stop-proximity'},bounds:[0,0,1,1],evidenceGaps:['ownership']};
        const variant={massing:{type:'Feature',geometry,properties:{}},scenario:'reform',form:'courtyard',gfaM2:1000,floors:6};
        const proposal=buildResearchProposal(site,variant,inputs,{proposalId:'research-1',title:'Housing',description:'Research only',createdAt:'2026-10-19T00:00:00Z'});
        expect(proposal.geometry.buildings[0].geometry.coordinates).toHaveLength(2);
        expect(proposal.cadastreParcelIds).toEqual(['HR-1-2']);expect(proposal.facets.ownership).toBe('no-change');
        expect(proposal.affordabilityResearch.ownerConsent).toBe(false);expect(proposal.affordabilityResearch.authorityApproval).toBe(false);
        expect(proposal.offer).toBe(0);expect(proposal.author).toBeUndefined();
        expect(variant.massing.properties).toEqual({});
    });
});
