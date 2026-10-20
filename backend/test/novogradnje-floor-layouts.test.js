import {readPublicCatalogue,readPublicProject} from '../floor-plan-archive/public-catalogue.js';
import {describe,it,expect} from 'vitest';
import express from 'express';
import request from 'supertest';
import {publicProject} from '../floor-plan-archive/public-catalogue.js';
import {setupNovogradnjeRoute as setupSharedNovogradnjeRoute} from '../routes/novogradnje.js';
import {createRequire} from 'node:module';
const setupNovogradnjeRoute=(app,pool)=>setupSharedNovogradnjeRoute(app,pool,{catalogue:{read:()=>readPublicCatalogue(pool),project:token=>readPublicProject(pool,token),sourceUrl:hash=>`https://shared.test/api/floor-plans/sources/${hash}`}});

const {filterProjects}=createRequire(import.meta.url)('../../frontend/novogradnje/catalogue.js');
const hash='c'.repeat(64),floor={id:'typical',label:'Tipični katovi 1.–4.',scope:'floor',levels:[1,2,3,4],hasPlan:true,
    architecture:{schema:'consensus-builder.floor-architecture.v1'},source:{sha256:hash,url:'https://example.test/plan.pdf',page:3}};
const model={siteKey:'registered:floor-example',label:'Primjer',location:{status:'located'},
    envelope:{footprint:{type:'Polygon',coordinates:[[[15,45],[15.001,45],[15.001,45.001],[15,45]]]}},
    inventory:{kind:'existing',constructionYear:2007,apartments:[],floorPlans:[floor]},sources:[]};
const row={site_key:model.siteKey,model,built_at:'2026-10-19T00:00:00Z'};
const db={query:async sql=>({rows:sql.startsWith('SELECT site_key')?[row]:sql.startsWith('SELECT sha256')?[{sha256:hash,media_type:'application/pdf'}]:[]})};
describe('whole-floor drawings in the public catalogue',()=>{
    it('publishes one drawing for repeated floors without inventing apartments',()=>{
        const p=publicProject(row,{detail:true,retained:new Map([[hash,'application/pdf']])});
        expect(p.apartments).toEqual([]);expect(p.planCount).toBe(1);expect(p.kind).toBe('existing');
        expect(p.floorPlans[0]).toMatchObject({scope:'floor',levels:[1,2,3,4],source:{page:3,assetUrl:`/novogradnje/api/source/${hash}`}});
        expect(p.floorPlans[0].url).toBe(`${p.url}tlocrti/typical/`);
        expect(publicProject(row).floorPlans[0]).not.toHaveProperty('architecture');
    });
    it('includes floors by default but does not match them to apartment-size or room filters',()=>{
        const p=publicProject(row);
        expect(filterProjects([p],{})).toHaveLength(1);
        for(const f of [{minArea:0},{maxArea:100},{rooms:3},{orientation:'N'},{kind:'new_build'}])expect(filterProjects([p],f)).toHaveLength(0);
        expect(filterProjects([p],{q:'Primjer'})).toHaveLength(1);
    });
    it('counts floor drawings separately from apartments',async()=>{
        const result=await readPublicCatalogue(db);
        expect(result.counts).toEqual({projects:1,apartments:0,withPlans:1,floorPlans:1});
    });
    it('serves an indexable floor route with CreativeWork metadata and includes it in sitemap',async()=>{
        const app=express();setupNovogradnjeRoute(app,db);const p=publicProject(row);
        const page=await request(app).get(p.floorPlans[0].url).expect(200);
        const canonical=`https://zagreb.lol${p.floorPlans[0].url}`;
        expect(page.text).toContain(`<link rel="canonical" href="${canonical}">`);
        expect(page.text).toContain(`<meta property="og:url" content="${canonical}">`);
        expect(page.text).toContain('Starogradnja');expect(page.text).toContain('2007');expect(page.text).toContain('"floorPlanId":"typical"');
        const ld=JSON.parse(page.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
        expect(ld['@graph'].find(n=>n['@type']==='CreativeWork').url).toBe(canonical);
        expect(ld['@graph'].find(n=>n['@type']==='WebPage').url).toBe(canonical);
        expect(ld['@graph'].some(n=>n['@type']==='Apartment')).toBe(false);
        const sitemap=await request(app).get('/novogradnje/sitemap.xml').expect(200);expect(sitemap.text).toContain(`<loc>${canonical}</loc>`);
        expect(sitemap.text).not.toMatch(/\/(zgrada|stan|tlocrt)\//);
        await request(app).get(`${p.url}stanovi/typical/`).expect(404);
        for(const path of [
            `${p.url}tlocrt/typical/`,
            `/novogradnje/zgrada/${p.slug}/tlocrt/typical/`,
            `/novogradnje/zgrada/${p.slug}/tlocrti/typical/`
        ]) {
            const response=await request(app).get(path).expect(404);
            expect(response.headers.location).toBeUndefined();
        }
    });
});
