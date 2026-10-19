// One bounded screening run, shared by HTTP and CLI; the run cannot report complete after a failed site.
import * as turf from '@turf/turf';
import { fetchHousingSites, validateScan } from './source.js';
import { planHousingSites, validateReform } from './planner.js';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {validateAssumptions}=require('../../frontend/js/affordabot-model.js');
export async function scanHousing(pool, input = {}, { fetchSites = fetchHousingSites, now = () => new Date() } = {}) {
    const config=validateScan(input);
    const assumptions=validateAssumptions(config.assumptions), reform=validateReform(config.reform);
    const sites=await fetchSites(pool,config);
    const result=planHousingSites(sites,{turf,assumptions,reform,limit:config.limit});
    return { version:1, persona:'affordabot', city:'zagreb', generatedAt:now().toISOString(),
        search:{bbox:config.bbox,minAreaM2:config.minAreaM2,maxAreaM2:config.maxAreaM2,sampleLimit:config.sampleLimit},
        scanned:sites.length, sampleCapped:sites.length>=config.sampleLimit,
        ...result, publication:{mode:'draft-only',automatedMentions:false,automatedReplies:false}, llmCostUsd:0 };
}
