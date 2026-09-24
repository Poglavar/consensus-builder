// Root-level discovery documents that crawlers and agents probe on the API host without being told:
// /.well-known/x402 (x402scan-style resource manifest), /.well-known/security.txt (RFC 9116),
// /llms.txt, /openapi.json (agent-facing subset), /agents.json (alias of /docs/agents.json) and
// /robots.txt. All read-only, built from the same x402 config as the paid routes themselves.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readX402Config, readX402OracleConfig } from '../utils/x402-payment.js';
import { publicBase } from './agent-discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// RFC 9116 security contact: the project mailbox.
export const SECURITY_CONTACT = 'mailto:urbangametheory@gmail.com';
// RFC 9116 wants Expires under a year out. Computed per request so the file can never go stale.
const SECURITY_TXT_TTL_DAYS = 180;
const SITE_URL = 'https://urbangametheory.xyz';
const NAME = 'Urban Game Theory API';
const DESCRIPTION = 'Cadastral parcels, 3D buildings and urban-development proposals for Zagreb and other cities. '
    + 'Agents post proposals and buy recipe-bound oracle facts over x402 (Solana devnet USDC).';

// The paid x402 resources this server actually offers right now: a route whose config is missing
// answers 503, so it is not advertised (an indexer would probe it and record a broken resource).
export function paidResources(base, env) {
    const proposals = readX402Config(env);
    const oracle = readX402OracleConfig(env);
    const out = [];
    if (proposals.enabled) {
        out.push({
            url: `${base}/agent/proposals`, method: 'POST', price: proposals.priceProposal,
            network: proposals.network, payTo: proposals.payTo,
            description: 'Post an urban-development proposal on cadastral parcels; the paying wallet becomes its author.'
        });
    }
    if (oracle.enabled) {
        out.push({
            url: `${base}/agent/oracle/facts`, method: 'GET', price: oracle.priceOracleFact,
            network: oracle.network, payTo: oracle.payTo,
            description: 'Buy a recipe-bound, signed oracle fact about a proposal lifecycle or market.'
        });
    }
    return out;
}

export function buildX402Manifest(base, env) {
    const resources = paidResources(base, env);
    return {
        version: 1,
        x402Version: 2,
        name: NAME,
        description: DESCRIPTION,
        resources: resources.map(r => r.url),
        endpoints: resources,
        docs: `${base}/docs/agents`,
        agents: `${base}/agents.json`,
        openapi: `${base}/openapi.json`,
        llms: `${base}/llms.txt`,
        instructions: `Read ${base}/docs/agents for the recipe. Each paid call answers 402 with a PAYMENT-REQUIRED `
            + 'header; retry with the signed x402 payment to settle and receive the result.'
    };
}

export function buildSecurityTxt(base, now = new Date()) {
    const expires = new Date(now.getTime() + SECURITY_TXT_TTL_DAYS * 24 * 60 * 60 * 1000);
    expires.setUTCHours(0, 0, 0, 0);
    return [
        `Contact: ${SECURITY_CONTACT}`,
        `Expires: ${expires.toISOString()}`,
        'Preferred-Languages: en, hr',
        `Canonical: ${base}/.well-known/security.txt`,
        ''
    ].join('\n');
}

export function buildLlmsTxt(base, env) {
    const paid = paidResources(base, env);
    const paidLines = paid.length
        ? paid.map(r => `- [${r.method} ${r.url}](${base}/docs/agents): ${r.description} Price ${r.price} on ${r.network}.`)
        : ['- Paid x402 routes are not configured on this server.'];
    return [
        `# ${NAME}`,
        '',
        `> ${DESCRIPTION}`,
        '',
        `The human app is ${SITE_URL}. This host is its JSON API.`,
        '',
        '## Agent docs',
        `- [Agent quickstart](${base}/docs/agents): how to pay for and post a proposal over x402, plus the MCP tool surface.`,
        `- [agents.json](${base}/agents.json): the proposal recipe as JSON Schema with live payment terms and endpoints.`,
        `- [OpenAPI](${base}/openapi.json): agent-facing endpoints as OpenAPI 3.1.`,
        `- [x402 manifest](${base}/.well-known/x402): paid resources for x402 indexers.`,
        '',
        '## Paid endpoints (x402)',
        ...paidLines,
        '',
        '## Optional',
        `- [General API docs](${base}/docs): parcels, buildings, proposals.`,
        `- [Bazaar listing proof](${base}/agent/discovery): the hosted x402 Bazaar record for the proposal route.`,
        ''
    ].join('\n');
}

function readRecipeSchema() {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-recipe-schema.json'), 'utf8'));
    // OpenAPI 3.1 embeds JSON Schema 2020-12 directly; the standalone document markers do not belong inline.
    delete schema.$schema;
    delete schema.$id;
    return schema;
}

export function buildOpenApi(base, env) {
    const paid = Object.fromEntries(paidResources(base, env).map(r => [r.url, r]));
    const x402 = (url) => paid[url]
        ? { 'x-x402': { price: paid[url].price, network: paid[url].network, payTo: paid[url].payTo } }
        : { 'x-x402': { enabled: false } };
    const paymentRequired = { description: 'Payment required: the PAYMENT-REQUIRED header carries the x402 terms.' };
    return {
        openapi: '3.1.0',
        info: {
            title: NAME,
            version: '1.0.0',
            description: `${DESCRIPTION} Only the agent-facing subset is described here; see ${base}/docs for the rest.`
        },
        servers: [{ url: base }],
        tags: [{ name: 'x402', description: 'Paid over the x402 protocol.' }],
        paths: {
            '/agent/proposals': {
                post: {
                    tags: ['x402'],
                    summary: 'Post a proposal (x402-paid)',
                    operationId: 'postAgentProposal',
                    requestBody: { required: true, content: { 'application/json': { schema: readRecipeSchema() } } },
                    responses: {
                        201: { description: 'Proposal created.' },
                        400: { description: 'Invalid recipe.' },
                        402: paymentRequired,
                        503: { description: 'x402 is not configured on this server.' }
                    },
                    ...x402(`${base}/agent/proposals`)
                }
            },
            '/agent/oracle/facts': {
                get: {
                    tags: ['x402'],
                    summary: 'Buy a verified oracle fact (x402-paid)',
                    operationId: 'getAgentOracleFact',
                    parameters: [
                        { name: 'subject', in: 'query', required: false, schema: { type: 'string' }, description: 'Proposal account; omit for the latest fact.' },
                        { name: 'market', in: 'query', required: false, schema: { type: 'string' }, description: 'Market account.' }
                    ],
                    responses: {
                        200: { description: 'Signed fact.' },
                        402: paymentRequired,
                        503: { description: 'x402 oracle facts are not configured on this server.' }
                    },
                    ...x402(`${base}/agent/oracle/facts`)
                }
            },
            '/agent/discovery': {
                get: {
                    summary: 'Proof that a paid resource is listed in the hosted x402 Bazaar',
                    operationId: 'getAgentDiscovery',
                    parameters: [{ name: 'resource', in: 'query', required: false, schema: { type: 'string', enum: ['proposals', 'oracle-facts'] } }],
                    responses: { 200: { description: 'Listing state.' }, 400: { description: 'Unknown resource.' } }
                }
            },
            '/agents.json': {
                get: {
                    summary: 'Proposal recipe, live payment terms and endpoint map',
                    operationId: 'getAgentsManifest',
                    responses: { 200: { description: 'Agent manifest.' } }
                }
            },
            '/proposals/{id}': {
                get: {
                    summary: 'Read a proposal',
                    operationId: 'getProposal',
                    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                    responses: { 200: { description: 'Proposal.' }, 404: { description: 'Not found.' } }
                }
            }
        }
    };
}

export function setupWellKnownRoutes(app, { env = process.env, now = () => new Date() } = {}) {
    app.get('/.well-known/x402', (req, res) => {
        res.json(buildX402Manifest(publicBase(req, env), env));
    });

    app.get('/.well-known/security.txt', (req, res) => {
        res.type('text/plain; charset=utf-8').send(buildSecurityTxt(publicBase(req, env), now()));
    });

    app.get('/llms.txt', (req, res) => {
        res.type('text/markdown; charset=utf-8').send(buildLlmsTxt(publicBase(req, env), env));
    });

    app.get('/openapi.json', (req, res) => {
        res.json(buildOpenApi(publicBase(req, env), env));
    });

    // Alias, not a copy: re-dispatch to the /docs/agents.json handler so the two can never differ.
    // Relies on this route being registered BEFORE setupDocsRoute (see backend/index.js).
    app.get('/agents.json', (req, res, next) => {
        req.url = '/docs/agents.json';
        next();
    });

    app.get('/robots.txt', (req, res) => {
        res.type('text/plain; charset=utf-8').send([
            '# JSON API for https://urbangametheory.xyz. Agents: see /llms.txt and /.well-known/x402.',
            'User-agent: *',
            'Allow: /',
            ''
        ].join('\n'));
    });
}
