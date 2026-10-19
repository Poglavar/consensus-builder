// The research API must validate before doing work, bound concurrent work, and surface failed scans.
import {describe,it,expect,vi} from 'vitest';
import request from 'supertest';
import {createRouteApp} from './helpers/create-route-app.js';
import {setupAffordabotRoute} from '../routes/affordabot.js';
describe('Affordabot API',()=>{
    it('describes illustrative inputs and draft-only publication',async()=>{
        const app=createRouteApp(setupAffordabotRoute,{}),response=await request(app).get('/affordabot/config');
        expect(response.status).toBe(200);expect(response.body.assumptionsAre).toBe('illustrative');expect(response.body.publication).toBe('draft-only');
    });
    it('rejects invalid scope and financial inputs before scanning',async()=>{
        const scan=vi.fn(),app=createRouteApp(setupAffordabotRoute,{}, {scan});
        expect((await request(app).post('/affordabot/scan').send({sampleLimit:99999})).status).toBe(400);
        expect((await request(app).post('/affordabot/scan').send({assumptions:{annualInterestPct:-1}})).status).toBe(400);
        expect(scan).not.toHaveBeenCalled();
    });
    it('returns the observed research result without publishing anything',async()=>{
        const pool={},scan=vi.fn().mockResolvedValue({status:'partial',candidates:[],failures:[{parcelId:'bad'}]}),app=createRouteApp(setupAffordabotRoute,pool,{scan});
        const response=await request(app).post('/affordabot/scan').send({});expect(response.status).toBe(200);expect(response.body.status).toBe('partial');expect(scan).toHaveBeenCalledWith(pool,{});
    });
    it('rejects overlapping scans and permits the next one after completion',async()=>{
        let release,started;
        const running=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
        const scan=vi.fn(async()=>{started();return running;}),app=createRouteApp(setupAffordabotRoute,{}, {scan});
        const first=request(app).post('/affordabot/scan').send({}).then(response=>response);
        await entered;
        expect((await request(app).post('/affordabot/scan').send({})).status).toBe(429);
        release({status:'complete',candidates:[]});expect((await first).status).toBe(200);
        expect((await request(app).post('/affordabot/scan').send({})).status).toBe(200);
    });
    it('reports upstream failure without exposing a database error or inventing results',async()=>{
        const scan=vi.fn().mockRejectedValue(new Error('missing table')),app=createRouteApp(setupAffordabotRoute,{}, {scan});
        const response=await request(app).post('/affordabot/scan').send({});expect(response.status).toBe(503);expect(response.body.candidates).toBeUndefined();expect(response.body.error).not.toContain('missing table');
    });
});
