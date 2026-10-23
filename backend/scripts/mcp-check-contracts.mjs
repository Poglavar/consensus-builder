#!/usr/bin/env node
// Exercise the hosted MCP contract without publishing, signing, paying or claiming live success
// for missing fixtures. An explicit origin and fixtures make each operation concrete and repeatable.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MCP_HOSTED_TOOLS } from '../agents/mcp-catalog.js';
import { cidOfObject } from '../cid.js';

export async function checkContracts({ origin, fixtures = {}, onCheck = () => {} }) {
    const client = new Client({ name: 'ugt-contract-check', version: '1' });
    const checks = [];
    const record = check => { checks.push(check); onCheck(check); };
    try {
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin)));
        const { tools } = await client.listTools();
        if (JSON.stringify(tools.map(t => t.name)) !== JSON.stringify(MCP_HOSTED_TOOLS)) throw new Error('Hosted tool catalogue differs from registration');
        if (tools.some(t => t.annotations?.destructiveHint)) throw new Error('Hosted server advertises a signing or paid tool');
        for (const tool of tools) {
            const publish = ['ugt_publish_design', 'ugt_propose_agreement', 'ugt_submit_feedback'].includes(tool.name);
            const defaults = { ugt_capabilities: {}, ugt_explain: { term: 'Parcel binding' } };
            const args = fixtures[tool.name] || defaults[tool.name];
            if (!args && !publish) { record({ tool: tool.name, status: 'missing-fixture' }); continue; }
            try {
                const result = await client.callTool({ name: tool.name, arguments: publish ? { ...args, confirm: false } : args });
                if (Boolean(result.isError) !== publish) { record({ tool: tool.name, status: 'failed', result }); continue; }
                const value = result.structuredContent;
                const artifact = value?.untrusted?.design || value?.untrusted?.agreement || value?.untrusted?.content;
                const draft = /^ugt_(draft_|modify_design$|edit_design$|edit_plan$)/.test(tool.name);
                // Capabilities contain schema descriptors called "design" and "agreement";
                // those are not draft artifacts and have no content CID.
                if ((draft || value?.cid) && artifact && value.cid !== cidOfObject(artifact)) throw new Error(`CID mismatch from ${tool.name}`);
                if (draft && (!artifact || !value.cid)) throw new Error(`Missing canonical artifact from ${tool.name}`);
                record({ tool: tool.name, status: publish ? 'write-refused-without-confirmation' : 'passed' });
            } catch (error) { record({ tool: tool.name, status: 'failed', error: error.message }); }
        }
        for (const resource of (await client.listResources()).resources) {
            try { await client.readResource({ uri: resource.uri }); record({ resource: resource.uri, status: 'passed' }); }
            catch (error) { record({ resource: resource.uri, status: 'failed', error: error.message }); }
        }
        for (const prompt of (await client.listPrompts()).prompts) {
            try { await client.getPrompt({ name: prompt.name, arguments: { request: 'Explain the next review step.' } }); record({ prompt: prompt.name, status: 'passed' }); }
            catch (error) { record({ prompt: prompt.name, status: 'failed', error: error.message }); }
        }
        return { ok: checks.every(c => ['passed', 'write-refused-without-confirmation'].includes(c.status)), checks };
    } finally { await client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const option = name => args[args.indexOf(name) + 1];
    if (!args.includes('--origin')) console.log('Usage: node scripts/mcp-check-contracts.mjs --origin https://urbangametheory.xyz --fixtures tools.json\nOnly public reads and drafts run. Writes are tested with confirm=false. Missing fixtures fail the check.');
    else {
        const report = await checkContracts({ origin: option('--origin'), fixtures: args.includes('--fixtures') ? JSON.parse(readFileSync(option('--fixtures'), 'utf8')) : {} });
        console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
    }
}
