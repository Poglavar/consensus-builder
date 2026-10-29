#!/usr/bin/env node
// Serve prepared examples through the existing private draft transport, on loopback only.
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPreviewLinks } from '../agents/mcp-preview-links.js';
import { createMcpHttpService } from '../agents/mcp-http.mjs';

const { values } = parseArgs({ options: {
    frontend: { type: 'string' }, backend: { type: 'string' }, port: { type: 'string' },
    links: { type: 'string' }, sample: { type: 'string' }
} });
function localOrigin(value, name) {
    if (!value) throw new Error(`--${name} is required; use the verified local ${name} origin.`);
    const url = new URL(value);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) throw new Error(`--${name} must be a loopback origin.`);
    return url.origin;
}
const frontend = localOrigin(values.frontend, 'frontend'), backend = localOrigin(values.backend, 'backend');
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be an available unprivileged port.');
const previewOrigin = `http://localhost:${port}`;
const sample = JSON.parse(await readFile(values.sample ? resolve(values.sample)
    : new URL('../../docs/demo/bogota-agreements/sampledata.json', import.meta.url), 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'ugt-bogota-demo-'));
const links = createPreviewLinks({ origin: previewOrigin, appOrigin: frontend, storeDirectory: directory });
let previews;
try {
    previews = sample.agreements.map(({ content }) => {
        const result = links.create({ agreement: content, plan: sample.planFile.plan,
            designs: sample.planFile.designs.map(row => row.content), parcelSourceId: sample.provenance.parcelSourceId });
        if (!result.previewUrl) throw new Error('The private preview store could not admit the demo.');
        const url = new URL(result.previewUrl);
        for (const [key, value] of Object.entries({ backend, city: 'bogota', at: sample.planFile.plan.view.at,
            lang: 'es-CO', existing: 'off', permitted: 'off', proposed: 'solid' })) url.searchParams.set(key, value);
        return { title: content.title, url: url.href, expiresAt: result.previewExpiresAt };
    });
} finally { links.dispose(); }
// Only the private-preview GET route is needed; no publication or MCP tool calls are served.
const service = createMcpHttpService({ env: { UGT_APP_ORIGIN: frontend }, previewOrigin, storeDirectory: directory,
    factory: () => { throw new Error('This local demo serves prepared previews only.'); } });
try {
    await new Promise((yes, no) => { service.http.once('error', no); service.http.listen(port, '127.0.0.1', yes); });
    const result = JSON.stringify({ frontend, backend, previews }, null, 2) + '\n';
    if (values.links) await writeFile(resolve(values.links), result, { mode: 0o600 });
    process.stdout.write(result);
} catch (error) { await service.close(); throw error; }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => service.close().then(() => process.exit(0)));
