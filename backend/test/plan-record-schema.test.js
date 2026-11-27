// Keep the published plan schema, shared semantic rules and MCP saved-view validation aligned.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { testI18n } from './helpers/i18n.js';
import Ajv2020 from 'ajv/dist/2020.js';
import { cidOfObject } from '../cid.js';
import { createMcpDiscoveryTools } from '../agents/mcp-discovery.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createUrbanGameTheoryMcpServer } from '../agents/mcp-server.mjs';
import { createNamedPlanViewSchema } from '../agents/mcp-plan-view-schema.js';
import { markUntrusted } from '../agents/mcp-results.js';
const require=createRequire(import.meta.url),PlanRecord=require('../../frontend/js/plan-record.js');
const cids=[cidOfObject({title:'First'}),cidOfObject({title:'Second'})].sort();
const canonical=()=>PlanRecord.create('Named plan',cids,{at:'45,15,17',mode:'2d',city:'london',language:'en'});
const ajv=new Ajv2020();
ajv.addFormat('ugt-map-location',{type:'string',validate:PlanRecord.semanticRules.location});
ajv.addKeyword({keyword:'x-ugt-ascending',type:'array',schemaType:'boolean',validate:(enabled,value)=>!enabled||PlanRecord.semanticRules.ascending(value)});
ajv.addKeyword({keyword:'x-ugt-utf16-maxLength',type:'string',schemaType:'number',validate:(limit,value)=>PlanRecord.semanticRules.text(value,limit)});
ajv.addKeyword({keyword:'x-ugt-plan-codes',type:'array',schemaType:'boolean',validate:(enabled,value)=>!enabled||PlanRecord.semanticRules.codesError(value)===null});
ajv.addKeyword({keyword:'x-ugt-plan-members',type:'object',schemaType:'boolean',validate:(enabled,value,parent,context)=>!enabled||PlanRecord.semanticRules.scheduleError(value,context.rootData.designCids)===null});
const schema=PlanRecord.jsonSchema(),validate=ajv.compile(schema);
describe('shared named-plan JSON Schema',()=>{
    it('keeps sparse saved views sparse while accepting optional permitted scope',()=>{
        const sparse={schema:'plan/v1',title:'Sparse',designCids:[cids[0]],view:{at:'0,0,3',mode:'2d'}};
        const cid=cidOfObject(sparse);
        expect(PlanRecord.validate(sparse)).toBeNull();
        expect(PlanRecord.create('Sparse',[cids[0]],sparse.view).view.settings).toEqual({});
        const scoped={...sparse,view:{...sparse.view,settings:{permittedScope:'surviving'}}};
        expect(PlanRecord.validate(scoped)).toBeNull();
        expect(cidOfObject(sparse)).toBe(cid);
    });
    it('names the street codes a plan claims sorted and deduplicated, and leaves them out when none, keeping the CID',()=>{
        const plain=canonical();
        expect(PlanRecord.create('Named plan',cids,{at:'45,15,17',mode:'2d',city:'london',language:'en'},null,[])).toEqual(plain);
        const claimed=PlanRecord.create('Named plan',cids,{at:'45,15,17',mode:'2d',city:'london',language:'en'},null,
            [{id:'gb-strong-suburbs-street-code',version:'2021'},{id:'a-code',version:'1'},{id:'gb-strong-suburbs-street-code',version:'2021'}]);
        expect(claimed.codes).toEqual([{id:'a-code',version:'1'},{id:'gb-strong-suburbs-street-code',version:'2021'}]);
        expect(PlanRecord.validate(claimed)).toBeNull();expect(validate(claimed)).toBe(true);
        expect(cidOfObject(plain)).not.toBe(cidOfObject(claimed));
        for(const codes of [[],[{id:'Bad Id',version:'1'}],[{id:'b',version:'1'},{id:'a',version:'1'}],[{id:'a',version:'1',extra:true}]]){
            expect(PlanRecord.validate({...plain,codes}),JSON.stringify(codes)).toMatch(/street codes/);
            expect(validate({...plain,codes}),JSON.stringify(codes)).toBe(false);
        }
    });
    it('shares canonical limits and declares semantic extensions explicitly',()=>{
        expect(schema.properties.title.maxLength).toBe(PlanRecord.MAX_TITLE);expect(schema.properties.designCids.maxItems).toBe(PlanRecord.MAX_DESIGNS);
        expect(schema.$comment).toContain('Clients ignoring extensions must not claim full validation');
        const changed=PlanRecord.jsonSchema();changed.properties.title.maxLength=1;expect(PlanRecord.jsonSchema().properties.title.maxLength).toBe(PlanRecord.MAX_TITLE);
    });
    it('accepts every UI language in browser records, MCP inputs and discovery schemas',()=>{
        const languages=testI18n().getSupportedLanguages();
        expect([...schema.properties.view.properties.language.anyOf[1].enum].sort()).toEqual([...languages].sort());
        const viewSchema=createNamedPlanViewSchema();
        for(const language of languages){
            const plan=canonical();plan.view.language=language;
            expect(PlanRecord.validate(plan)).toBeNull();
            expect(validate(plan)).toBe(true);
            expect(viewSchema.parse(plan.view).language).toBe(language);
        }
    });
    it('matches valid omissions, nulls, views and numeric location forms',()=>{
        const basic={schema:'plan/v1',title:'A',designCids:[cids[0]],view:{at:'0,0,3',mode:'model'}};
        for(const value of [canonical(),basic,{...basic,view:{...basic.view,rotate:true}},{...basic,title:'A\nB',view:{at:'85.0511,180,22',mode:'photo',city:null,language:null,camera:{targetLat:85.0511,targetLng:-180,headingDeg:720,pitchRad:-Math.PI/2,range:1},settings:null}},
            {...basic,view:{at:'1e1,0x10,3',mode:'2d',settings:{planningSource:'source-one',existing:'off',permittedScope:'surviving'}}},
            {...basic,schedule:{[cids[0]]:{start:'2026-01',end:'2966-12'}}},{...canonical(),schedule:{[cids[1]]:{start:'2030-05',end:'2030-05'}}}]){
            expect(PlanRecord.validate(value)).toBeNull();expect(validate(value),JSON.stringify(validate.errors)).toBe(true);
        }
    });
    it('matches rejection of malformed fields, noncanonical order, UTF-16 lengths and encoded bounds',()=>{
        const changes=[p=>{delete p.title;},p=>{p.extra=true;},p=>{p.schema='plan/v2';},p=>{p.title='';},p=>{p.title=' Name';},p=>{p.title='Name\n';},p=>{p.title='a'.repeat(161);},p=>{p.title='🌳'.repeat(81);},
            p=>{p.designCids=[];},p=>{p.designCids=[cids[0],cids[0]];},p=>{p.designCids=[...cids].reverse();},p=>{p.designCids=['invalid'];},p=>{p.designCids=Array(1001).fill(cids[0]);},
            p=>{p.view.extra=true;},p=>{p.view.mode='3d';},p=>{delete p.view.at;},p=>{p.view.at='85.0512,0,17';},p=>{p.view.at='0,180.1,17';},p=>{p.view.at='0,0,2.9';},p=>{p.view.at='0,0,22.1';},p=>{p.view.at='0,,17';},p=>{p.view.at='0,0,Infinity';},
            p=>{p.view.language='de';},p=>{p.view.city='';},p=>{p.view.city='🌳'.repeat(51);},p=>{p.view.camera={};},p=>{p.view.camera={targetLat:0,targetLng:0,headingDeg:0,pitchRad:.1,range:1};},p=>{p.view.camera={targetLat:0,targetLng:0,headingDeg:Infinity,pitchRad:0,range:1};},
            p=>{p.view.rotate='yes';},p=>{p.view.rotate=null;},p=>{p.view.settings={unsupported:'on'};},p=>{p.view.settings={existing:''};},p=>{p.view.settings={existing:'🌳'.repeat(101)};},
            p=>{p.schedule={};},p=>{p.schedule={[cidOfObject({title:'Other'})]:{start:'2027-01',end:'2027-02'}};},p=>{p.schedule={[cids[0]]:{start:'2027-03',end:'2027-02'}};},
            p=>{p.schedule={[cids[0]]:{start:'2025-12',end:'2027-02'}};},p=>{p.schedule={[cids[0]]:{start:'2027-01'}};},p=>{p.schedule={[cids[0]]:{start:'2027-01',end:'2027-02',basis:'permit'}};},p=>{p.schedule={[cids[0]]:null};}];
        for(const change of changes){const value=canonical();change(value);expect(PlanRecord.validate(value),JSON.stringify(value)).not.toBeNull();expect(validate(value),JSON.stringify(value)).toBe(false);}
    });
    it('exposes the exact schema through help without moving schema prose into untrusted fields',()=>{
        const result=markUntrusted(createMcpDiscoveryTools({read:{},appOrigin:'https://app.example'}).help({topic:'schemas/plan'}));expect(result.schema).toEqual(schema);expect(result.schema.title).toBe('Named plan/v1');
    });
    it('matches MCP saved-view validation with PlanRecord, including descriptive city text over eighty characters',()=>{
        const viewSchema=createNamedPlanViewSchema();
        const views=[canonical().view,{at:'0,0,17',mode:'model',city:'c'.repeat(100),settings:null,rotate:true},
            {at:'0,0,17',mode:'photo',rotate:'yes'},{at:'0,0,17',mode:'model',rotate:null},
            {at:'85.0512,0,17',mode:'2d'},{at:'0,0,2',mode:'photo'},{at:'0,0,17',mode:'3d'},
            {at:'0,0,17',mode:'2d',camera:{targetLat:0,targetLng:0,headingDeg:0,pitchRad:.1,range:1}},
            {at:'0,0,17',mode:'2d',settings:{unexpected:'on'}},{at:'0,0,17',mode:'2d',city:'c'.repeat(101)}];
        for(const view of views)expect(viewSchema.safeParse(view).success).toBe(PlanRecord.validate({...canonical(),view})===null);
    });
    it('discovers the plan resource and rejects invalid views through real MCP input validation before calling actions',async()=>{
        const received=[];
        const server=createUrbanGameTheoryMcpServer({mode:'hosted',env:{},tools:{draftPlan:args=>{received.push(args);const plan=PlanRecord.create(args.title,args.designs,args.view);return {plan,cid:cidOfObject(plan),designs:args.designs.map(cid=>({cid})),publication:'private'};}}});
        const client=new Client({name:'plan-schema-test',version:'1'}),[clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
        try{
            await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
            expect((await client.listResources()).resources.some(resource=>resource.uri==='ugt://schemas/plan')).toBe(true);
            const resource=await client.readResource({uri:'ugt://schemas/plan'});expect(JSON.parse(resource.contents[0].text)).toEqual(schema);
            const good={title:'Named',designs:[cids[0]],view:{at:'0,0,17',mode:'2d',city:'c'.repeat(100),settings:{permittedScope:'surviving'}}};
            expect((await client.callTool({name:'ugt_draft_plan',arguments:good})).isError).not.toBe(true);expect(received).toHaveLength(1);
            expect(received[0].view.settings).toEqual({permittedScope:'surviving'});
            const languages=['ar','fr','pt','ru','kk'];
            for(const language of languages){
                const result=await client.callTool({name:'ugt_draft_plan',arguments:{...good,view:{...good.view,language}}});
                expect(result.isError).not.toBe(true);expect(received.at(-1).view.language).toBe(language);
            }
            const bad=await client.callTool({name:'ugt_draft_plan',arguments:{...good,view:{...good.view,at:'91,0,17'}}});
            expect(bad.isError).toBe(true);expect(bad.structuredContent).toMatchObject({code:'invalid-arguments',field:'view.at'});expect(received).toHaveLength(1+languages.length);
        }finally{await client.close();await server.close();}
    });

});
