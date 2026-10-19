// A research package becomes a new editable local draft, with no replacement or ownership claim.
import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {importPackage}=require('../../frontend/js/affordabot-handoff.js');
const {createProposalDraftStore}=require('../../frontend/js/proposal-drafts.js');
const {registry}=require('../../frontend/js/proposal-editor-adapters.js');
const {buildResearchProposal}=require('../../frontend/js/affordabot-model.js');
function entry(){return {version:1,proposal:buildResearchProposal({parcelId:'HR-1-2',areaM2:1000,bounds:[0,0,.01,.01],planning:{},evidenceGaps:['ownership']},
    {id:'reform-compact',scenario:'reform',form:'compact',floors:3,gfaM2:600,massing:{type:'Feature',properties:{floors:3},geometry:{type:'Polygon',coordinates:[[[0,0],[.01,0],[.01,.01],[0,.01],[0,0]]]}}},
    {},{title:'Research homes',description:'Research only',proposalId:'research-input',createdAt:'2026-10-19T00:00:00Z'})};}
describe('Affordabot editor handoff',()=>{
    it('round-trips the geometry, evidence and neutral ownership through the real editor adapter',()=>{
        const values=new Map(),store=createProposalDraftStore({storage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)},adapterRegistry:registry});
        const draft=importPackage(entry(),{store,adapter:registry.get('single')});
        expect(draft.sourceProposalId).toBeNull();expect(draft.cityId).toBe('zagreb');expect(draft.goal).toBe('single');
        const proposal=store.buildProposalFromDraft(draft.id);
        expect(proposal.affordabilityResearch.status).toBe('research-draft');expect(proposal.facets.ownership).toBe('no-change');expect(proposal.geometry.buildings).toHaveLength(1);
        expect(proposal.replacementOfProposalId).toBeNull();expect(proposal.affordabilityResearch.ownerConsent).toBe(false);
    });
    it('rejects unrelated packages and cross-city imports',()=>{
        expect(()=>importPackage({version:1,proposal:{city:'zagreb'}})).toThrow();
        expect(()=>importPackage(entry(),{cityId:'another-city'})).toThrow();
    });
});
