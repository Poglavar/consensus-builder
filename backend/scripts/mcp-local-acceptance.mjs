#!/usr/bin/env node
// Run the exact hosted transport against current public API data, on an ephemeral loopback port.
// Only public reads/drafts run; permanent publication is checked with confirm=false. No model API.
import { writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createMcpHttpService } from '../agents/mcp-http.mjs';
import { checkContracts } from './mcp-check-contracts.mjs';
import { acceptanceFixtures } from './mcp-acceptance-fixtures.mjs';

export async function localAcceptance({ apiBase, appOrigin, agreementCid, output, fetchImpl = fetch }) {
    const fixture = await acceptanceFixtures({ apiBase, appOrigin, agreementCid, fetchImpl });
    const state = { provenance: fixture.provenance, seed: fixture.seed, checks: [], ok: false };
    const save = () => writeFileSync(output, JSON.stringify(state, null, 2)); save();
    const service = createMcpHttpService({ env: { UGT_API_BASE: apiBase, UGT_APP_ORIGIN: appOrigin }, fetchImpl });
    try {
        service.http.listen(0, '127.0.0.1'); await once(service.http, 'listening');
        const report = await checkContracts({ origin: `http://127.0.0.1:${service.http.address().port}`, fixtures: fixture.fixtures,
            onCheck: check => {
                console.error(`[${new Date().toISOString()}] [mcp-acceptance] ${check.tool || check.resource || check.prompt}: ${check.status}`);
                state.checks.push(check); save();
            } });
        state.ok = report.ok; save(); return state;
    } finally { await service.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
    if (args.includes('--help') || !['--api', '--origin', '--agreement', '--output'].every(name => args.includes(name))) {
        console.log('Usage: node scripts/mcp-local-acceptance.mjs --api https://api.example --origin https://app.example --agreement <existing-minted-cid> --output <report.json>\nCurrent public reads and private drafts only. No publication, signatures, payments or model calls.');
    } else {
        const result = await localAcceptance({ apiBase: option('--api'), appOrigin: option('--origin'), agreementCid: option('--agreement'), output: option('--output') });
        console.log(JSON.stringify({ ok: result.ok, checks: result.checks.length, failed: result.checks.filter(c => c.status === 'failed').map(c => c.tool), output: option('--output') }));
        if (!result.ok) process.exitCode = 1;
    }
}
