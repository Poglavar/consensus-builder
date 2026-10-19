// Affordabot is a read-only research API. It never publishes a proposal or contacts an authority.
import { scanHousing } from '../affordabot/scan.js';
import { validateScan, scanDefaults } from '../affordabot/source.js';
import { validateReform, reformDefaults } from '../affordabot/planner.js';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const model=require('../../frontend/js/affordabot-model.js');
export function setupAffordabotRoute(app,pool,{scan=scanHousing}={}) {
    let running=false;
    app.get('/affordabot/config',(_req,res)=>res.set('Cache-Control','no-store').json({
        persona:'affordabot',scan:scanDefaults,reform:reformDefaults,assumptions:model.defaults,
        publication:'draft-only',assumptionsAre:'illustrative',accessibility:'straight-line-stop-proximity'
    }));
    app.post('/affordabot/scan',async(req,res)=>{
        res.set('Cache-Control','no-store');
        try {validateScan(req.body);model.validateAssumptions(req.body?.assumptions);validateReform(req.body?.reform);}
        catch(error){return res.status(400).json({error:error.message});}
        if(running)return res.status(429).json({error:'A scan is already running. Try again when it finishes.'});
        running=true;
        try {res.json(await scan(pool,req.body));}
        catch(error){console.error(`[${new Date().toISOString()}] Affordabot scan failed: ${error.message}`);
            res.status(503).json({error:'Housing screening data is unavailable. No results were generated.'});}
        finally{running=false;}
    });
}
