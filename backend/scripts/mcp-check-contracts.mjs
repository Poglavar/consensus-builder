#!/usr/bin/env node
// Exercise hosted contracts with concrete fixtures. Writes are refused through their real confirmation contract.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MCP_HOSTED_TOOLS } from '../agents/mcp-catalog.js';
import { cidOfObject } from '../cid.js';
const require = createRequire(import.meta.url);
const PlanRecord = require('../../frontend/js/plan-record.js');
const osm = require('../../frontend/js/corridor-osm-form.js');
const contentOf = value => value?.untrusted?.design || value?.untrusted?.agreement || value?.untrusted?.plan || value?.untrusted?.content || value?.design || value?.agreement || value?.plan || value?.content;
export function assertContractResult(tool, value, args = {}) {
    const artifact = contentOf(value);
    const draft = /^ugt_(draft_|modify_design$|edit_design$|edit_plan$|edit_agreement$)/.test(tool);
    if ((draft || value?.cid) && artifact && value.cid !== cidOfObject(artifact)) throw new Error(`CID mismatch from ${tool}`);
    if (draft && (!artifact || !value.cid)) throw new Error(`Missing canonical artifact from ${tool}`);
    if (draft && (!value.draftRef || value.previewStatus !== 'private-link' || !value.previewUrl)) throw new Error(`Missing usable private preview from ${tool}`);
    if (artifact?.schema === 'plan/v1') { const error = PlanRecord.validate(artifact); if (error) throw new Error(error); }
    const goal = ({ugt_draft_road:'road-track',ugt_draft_track:'road-track',ugt_draft_station:'station',ugt_draft_space:args.spaceKind,ugt_draft_parcel_layout:'parcel-layout',ugt_draft_urban_rule:'urban-rule'})[tool];
    if (goal && artifact?.goal !== goal) throw new Error(`Wrong design goal from ${tool}`);
    if (tool === 'ugt_draft_building') {
        const expected = ({freeform:'single',block:'buildings',row:'row',detached:'parcelBased'})[args.typology || 'freeform'];
        if (artifact?.goal !== expected || !artifact.geometry?.buildings?.length) throw new Error('Building constructor did not return its actual typology and geometry');
    }
    if (tool === 'ugt_draft_track') {
        const corridor = osm.toView(artifact.roadProposal?.definition);
        if (!corridor.profile?.strips?.some(lane=>lane.type === 'rail' && lane.gauge === (args.gauge || 1435)) || corridor.metadata?.trackSpeed !== (args.speed || 120)) throw new Error('Track constructor omitted its gauge or speed target');
    }
    if (tool === 'ugt_draft_station' && artifact?.structureProposal?.stationType !== args.stationType) throw new Error('Wrong station type');
    const retitle = args.changes?.findLast(change=>change.type === 'retitle')?.value
        ?? args.edits?.findLast(edit=>edit.path === '/title' && ['add','replace'].includes(edit.op))?.value
        ?? (['ugt_edit_plan','ugt_edit_agreement'].includes(tool) ? args.title ?? args.terms?.title : undefined);
    if (retitle !== undefined && artifact?.title !== retitle) throw new Error(`Requested title edit was not applied by ${tool}`);
    if (['ugt_inspect_plan','ugt_inspect_agreement'].includes(tool) && (!Array.isArray(value?.items) || value.items.some(item=>typeof item.ref !== 'string'))) throw new Error('Inventory lacks explicit references');
    if (tool === 'ugt_list_sources' && (!Array.isArray(value?.items) || !Number.isInteger(value.total) || value.items.some(source=>!source.id || !source.abstraction))) throw new Error('Source discovery lacks typed source identities');
    if (tool === 'ugt_help' && !value?.steps && !value?.contract && !value?.schema && !value?.instructions) throw new Error('Help returned no instructions or schema');
    if (tool === 'ugt_export_draft' && !value?.artifact && !value?.draftArtifact) throw new Error('Export returned no canonical private artifact');
    return true;
}
function confirmationRefused(value, field) {
    if (value?.code === 'confirmation-required') return true;
    if (value?.code === 'invalid-arguments') return Array.isArray(value.constraints) && value.constraints.length > 0
        && value.constraints.every(issue=>issue.field === field && issue.allowedValues?.length === 1 && issue.allowedValues[0] === true);
    return value?.code === 'tool-failed' && /confirm.*must be true/.test(value.untrusted?.message || '');
}
export async function checkContracts({ origin, fixtures = {}, constructionCases = [], onCheck = () => {} }) {
    const client = new Client({ name: 'ugt-contract-check', version: '2' });
    const checks = [], results = new Map();
    const record = check => { checks.push(check); onCheck(check); };
    try {
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin)));
        const { tools } = await client.listTools();
        if (JSON.stringify(tools.map(t=>t.name)) !== JSON.stringify(MCP_HOSTED_TOOLS)) throw new Error('Hosted tool catalogue differs from registration');
        if (tools.some(t=>t.annotations?.destructiveHint)) throw new Error('Hosted server advertises a signing or paid tool');
        const resolve = async (value, stack = []) => {
            if (!value || typeof value !== 'object') return value;
            if (value.$result) {
                if (stack.includes(value.$result)) throw new Error('Circular acceptance result reference');
                if (!results.has(value.$result)) {
                    const target=tools.find(tool=>tool.name===value.$result);
                    if (!target?.annotations?.readOnlyHint || !fixtures[value.$result]) throw new Error('Result references may only execute a supplied read/draft fixture');
                    const result=await client.callTool({name:value.$result,arguments:await resolve(fixtures[value.$result],[...stack,value.$result])});
                    if(result.isError)throw new Error(`Fixture dependency ${value.$result} failed`);
                    results.set(value.$result,result.structuredContent);
                }
                return String(value.path || '').split('.').filter(Boolean).reduce((row,key)=>row?.[key],results.get(value.$result));
            }
            if(Array.isArray(value))return Promise.all(value.map(row=>resolve(row,stack)));
            const entries=[];for(const [key,row]of Object.entries(value))entries.push([key,await resolve(row,stack)]);return Object.fromEntries(entries);
        };
        const run = async (tool, fixture, label) => {
            const write=tool.annotations?.readOnlyHint !== true;
            if (!fixture) {record({tool:tool.name,...(label?{case:label}:{}),status:'missing-fixture'});return;}
            try {
                const confirmation=tool.inputSchema?.properties?.confirmAssetUpload ? 'confirmAssetUpload' : 'confirm';
                const args=await resolve(fixture);
                const result=await client.callTool({name:tool.name,arguments:write?{...args,[confirmation]:false}:args});
                if(write){if(!result.isError||!confirmationRefused(result.structuredContent,confirmation))throw new Error('Write was not rejected specifically by its confirmation contract');}
                else {
                    if(result.isError)throw new Error(`Tool error: ${result.structuredContent?.code || 'unknown'}`);
                    assertContractResult(tool.name,result.structuredContent,args);results.set(tool.name,result.structuredContent);
                }
                record({tool:tool.name,...(label?{case:label}:{}),status:write?'write-refused-without-confirmation':'passed'});
            } catch(error){record({tool:tool.name,...(label?{case:label}:{}),status:'failed',error:error.message});}
        };
        const defaults={ugt_capabilities:{},ugt_explain:{term:'Parcel binding'},ugt_help:{topic:'workflow'},ugt_list_sources:{limit:2}};
        for(const tool of tools)await run(tool,fixtures[tool.name]||defaults[tool.name]);
        for(const test of constructionCases){const tool=tools.find(tool=>tool.name===test.tool);if(!tool)record({case:test.id,status:'failed',error:'Construction tool is absent'});else await run(tool,test.arguments,test.id);}
        for(const resource of(await client.listResources()).resources){try{await client.readResource({uri:resource.uri});record({resource:resource.uri,status:'passed'});}catch(error){record({resource:resource.uri,status:'failed',error:error.message});}}
        for(const prompt of(await client.listPrompts()).prompts){try{await client.getPrompt({name:prompt.name,arguments:{request:'Explain the next review step.'}});record({prompt:prompt.name,status:'passed'});}catch(error){record({prompt:prompt.name,status:'failed',error:error.message});}}
        return {version:2,ok:checks.every(check=>['passed','write-refused-without-confirmation'].includes(check.status)),checks};
    } finally {await client.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
    const args=process.argv.slice(2),option=name=>args[args.indexOf(name)+1];
    if(!args.includes('--origin'))console.log('Usage: node scripts/mcp-check-contracts.mjs --origin <url> --fixtures tools.json\nPublic reads/drafts run. Every write uses false confirmation. Missing fixtures fail. Fixture files may contain {fixtures,constructionCases}.');
    else {const input=args.includes('--fixtures')?JSON.parse(readFileSync(option('--fixtures'),'utf8')):{};const report=await checkContracts({origin:option('--origin'),fixtures:input.fixtures||input,constructionCases:input.constructionCases||[]});console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;}
}
