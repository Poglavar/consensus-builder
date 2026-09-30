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
        `- [Lens members](${base}/agent/lenses/members): the attester directory to pick a proposal's lens from; schemas at ${base}/lenses/schemas. Anyone can become a member: POST a signed registration to the same path.`,
        `- [Parcel history](${base}/parcels/{parcelUid}/history): the permanent per-parcel log of proposals, lens ownership attestations and land events.`,
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

// Frozen by lens-model.md: the directory response shape.
const LENS_REGISTRATION_BODY = {
    type: 'object',
    required: ['key', 'credentialName', 'kind', 'name', 'serviceUrl', 'signedAt', 'signature'],
    properties: {
        key: { type: 'string', description: 'The member\'s base58 SAS credential authority.' },
        credentialName: { type: 'string', maxLength: 32 },
        kind: { type: 'string', enum: ['owner-consent', 'court', 'permit', 'imagery', 'osm', 'lifecycle'] },
        name: { type: 'string', maxLength: 64 },
        description: { type: 'string', maxLength: 280 },
        serviceUrl: { type: 'string', description: 'https; the directory probes serviceUrl/lens/status.' },
        signedAt: { type: 'integer', description: 'Unix seconds, within 10 minutes of the server clock.' },
        signature: { type: 'string', description: 'Base58 ed25519 signature by key over the registration message (docs: Becoming a lens member).' }
    }
};

const LENS_MEMBERS_SCHEMA = {
    type: 'object',
    required: ['members'],
    properties: {
        members: {
            type: 'array',
            items: {
                type: 'object',
                required: ['key', 'kind', 'name', 'description', 'serviceUrl', 'coverage'],
                properties: {
                    key: { type: 'string', description: 'Base58 SAS authority public key; put it in a proposal\'s lens.' },
                    kind: { type: ['string', 'null'], enum: ['owner-consent', 'court', 'permit', 'imagery', 'osm', 'lifecycle', null], description: 'What the member attests, not who it is.' },
                    name: { type: ['string', 'null'] },
                    description: { type: ['string', 'null'] },
                    serviceUrl: { type: ['string', 'null'], description: 'Where the member takes attestation requests; null when it has none.' },
                    registeredAt: { type: ['string', 'null'], format: 'date-time', description: 'The member\'s own signed registration time; null when it was only seen on chain.' },
                    coverage: {
                        type: 'object',
                        properties: {
                            ownership: { type: 'integer', description: 'Ownership attestations issued.' },
                            parcels: { type: 'integer', description: 'Distinct parcels covered.' },
                            executed: { type: 'integer', description: 'Proposals executed on its attestations.' }
                        }
                    }
                }
            }
        }
    }
};

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
            '/lenses/members': {
                get: {
                    summary: 'Attester directory: known lens members and their coverage',
                    operationId: 'getLensMembers',
                    responses: { 200: { description: '{ members: [{ key, kind (owner-consent | court | permit | imagery | osm | lifecycle), name, description, serviceUrl, coverage: { ownership, parcels, executed } }] }', content: { 'application/json': { schema: LENS_MEMBERS_SCHEMA } } } }
                }
            },
            '/agent/lenses/members': {
                get: {
                    summary: 'Attester directory (agent alias of /lenses/members)',
                    operationId: 'getAgentLensMembers',
                    responses: { 200: { description: 'Same body as /lenses/members.', content: { 'application/json': { schema: LENS_MEMBERS_SCHEMA } } } }
                },
                post: {
                    summary: 'List yourself as a lens member: a registration signed by the member key, checked against its SAS credential and schemas on chain and its live /lens/status',
                    operationId: 'registerLensMember',
                    requestBody: { required: true, content: { 'application/json': { schema: LENS_REGISTRATION_BODY } } },
                    responses: {
                        201: { description: '{ member } in the directory shape.' },
                        400: { description: 'Malformed field or signedAt outside 10 minutes.' },
                        401: { description: 'Signature does not verify.' },
                        409: { description: 'A registration signed at the same time or later is already stored.' },
                        422: { description: 'credential_missing, schema_missing, service_unreachable or service_mismatch.' },
                        429: { description: 'Too many attempts from this client.' }
                    }
                }
            },
            '/lenses/schemas': {
                get: {
                    summary: 'The lens SAS schemas (ParcelOwnership-v1, ProposalVerdict-v1): layout strings and field lists. An owner\'s yes is not an attestation: the owner signs accept_with_attestations with an optional payout key',
                    operationId: 'getLensSchemas',
                    responses: { 200: { description: '{ sasProgram, schemas: [{ kind, id, name, version, layout, fields, sasLayout }] }' } }
                }
            },
            '/parcels/{parcelUid}/history': {
                get: {
                    summary: 'Permanent per-parcel log: proposals listing the parcel, lens ownership attestations and land events, oldest first by each source\'s own time',
                    operationId: 'getParcelHistory',
                    parameters: [{ name: 'parcelUid', in: 'path', required: true, schema: { type: 'string', maxLength: 128 }, description: 'Cadastral parcel id, URL-encoded (e.g. HR-335347-1208%2F3).' }],
                    responses: {
                        200: { description: '{ parcelUid, anchor: { account, exists, mintedAt?, source }, events: [{ type (proposal_created | proposal_published | parcel_ownership | proposal_acceptance | proposal_verdict | proposal_lifecycle), at (source time or null), proposalId?, proposalAccount?, member?, owner?, transaction?, hash?, link }] }. Unknown parcel: empty events, anchor.exists false.' },
                        400: { description: 'Invalid parcelUid.' }
                    }
                }
            },
            '/oracle/events': {
                get: {
                    summary: 'Persisted land events (proposal lifecycle, acceptances, verdicts)',
                    operationId: 'getOracleEvents',
                    parameters: [
                        { name: 'type', in: 'query', required: false, schema: { type: 'string', enum: ['proposal_lifecycle', 'proposal_acceptance', 'proposal_verdict'] } },
                        { name: 'subject', in: 'query', required: false, schema: { type: 'string' }, description: 'Proposal account.' },
                        { name: 'parcelUid', in: 'query', required: false, schema: { type: 'string' }, description: 'Only events about this parcel: acceptances naming it, lifecycle and verdict events of proposals listing it.' },
                        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } }
                    ],
                    responses: { 200: { description: '{ events, count, eventType, parcelUid? }' }, 400: { description: 'Invalid filter.' } }
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

// The x402 manifest, llms.txt and openapi.json embed the live payment terms (price, payTo), so no
// cache may keep them: a stale copy would advertise a price the 402 no longer asks. The main site's
// nginx proxies x402 and openapi.json here and passes this header through; /agents.json gets the
// same header from its /docs/agents.json handler.
const LIVE_TERMS_CACHE_CONTROL = 'no-store';

export function setupWellKnownRoutes(app, { env = process.env, now = () => new Date() } = {}) {
    app.get('/.well-known/x402', (req, res) => {
        res.set('Cache-Control', LIVE_TERMS_CACHE_CONTROL).json(buildX402Manifest(publicBase(req, env), env));
    });

    app.get('/.well-known/security.txt', (req, res) => {
        res.type('text/plain; charset=utf-8').send(buildSecurityTxt(publicBase(req, env), now()));
    });

    app.get('/llms.txt', (req, res) => {
        res.set('Cache-Control', LIVE_TERMS_CACHE_CONTROL).type('text/markdown; charset=utf-8').send(buildLlmsTxt(publicBase(req, env), env));
    });

    app.get('/openapi.json', (req, res) => {
        res.set('Cache-Control', LIVE_TERMS_CACHE_CONTROL).json(buildOpenApi(publicBase(req, env), env));
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
