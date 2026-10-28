// Root-level discovery documents that crawlers and agents probe on the API host without being told:
// /.well-known/x402 (x402scan-style resource manifest), /.well-known/security.txt (RFC 9116),
// /llms.txt, /openapi.json (agent-facing subset), /agents.json (alias of /docs/agents.json) and
// /robots.txt. All read-only, built from the same x402 config as the paid routes themselves.

import { MCP_READ_PATHS } from './mcp-openapi.js';
import { FEEDBACK_PATHS } from './feedback-openapi.js';
import { readX402OracleConfig } from '../utils/x402-payment.js';
import { publicBase } from './agent-discovery.js';
import { createRequire } from 'node:module';

const publicationDefinitions = createRequire(import.meta.url)('./agent-recipe-schema.json').$defs;
const COMMUNITY_REPORT_CONTENT = {
    $id: 'urn:ugt:community-result:v1',
    ...publicationDefinitions.communityReport,
    $defs: Object.fromEntries(['cid', 'instant', 'organiserDid', 'httpsUrl'].map(key => [key, publicationDefinitions[key]]))
};

// RFC 9116 security contact: the project mailbox.
export const SECURITY_CONTACT = 'mailto:urbangametheory@gmail.com';
// RFC 9116 wants Expires under a year out. Computed per request so the file can never go stale.
const SECURITY_TXT_TTL_DAYS = 180;
const SITE_URL = 'https://urbangametheory.xyz';
const NAME = 'Urban Game Theory API';
const DESCRIPTION = 'Cadastral parcels, 3D buildings, and urban designs and the agreements over them for Zagreb and other cities. '
    + 'Agents publish content-addressed designs and agreements, mint and bet on agreements on Solana devnet, '
    + 'and buy recipe-bound oracle facts over x402 (Solana devnet USDC).';

// The paid x402 resources this server actually offers right now: a route whose config is missing
// answers 503, so it is not advertised (an indexer would probe it and record a broken resource).
export function paidResources(base, env) {
    const oracle = readX402OracleConfig(env);
    const out = [];
    if (oracle.enabled) {
        out.push({
            url: `${base}/agent/oracle/facts`, method: 'GET', price: oracle.priceOracleFact,
            network: oracle.network, payTo: oracle.payTo,
            description: 'Buy a recipe-bound, source-hashed fact about an agreement account\'s terminal state (executed, cancelled or expired).'
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
        instructions: `Read ${base}/docs/agents for the flow. Each paid call answers 402 with a PAYMENT-REQUIRED `
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
        `- [Hosted MCP](${SITE_URL}/mcp): Streamable HTTP for public reads, private drafts, unsigned publication and wallet approval links; never signs or pays.`,
        `- [Agent quickstart](${base}/docs/agents): see what a site binds, publish designs, propose an agreement over them, mint and fund it on Solana devnet, bet, pledge and donate on it; plus the MCP tool surface.`,
        `- [agents.json](${base}/agents.json): the design/v1 and agreement/v1 JSON Schemas, endpoints, program ids, the MCP tool list and the live oracle-fact payment terms.`,
        `- [OpenAPI](${base}/openapi.json): agent-facing endpoints as OpenAPI 3.1.`,
        `- [x402 manifest](${base}/.well-known/x402): paid resources for x402 indexers.`,
        `- [Lens members](${base}/agent/lenses/members): the attester directory to pick an agreement's lens from; schemas at ${base}/lenses/schemas. Anyone can become a member: POST a signed registration to the same path.`,
        `- [Parcel history](${base}/parcels/{parcelUid}/history): the permanent per-parcel log of agreements over the parcel, lens ownership attestations and executions.`,
        '',
        '## Paid endpoints (x402)',
        ...paidLines,
        '',
        '## Optional',
        `- [General API docs](${base}/docs): parcels and buildings.`,
        `- [Bazaar listing proof](${base}/agent/discovery): the hosted x402 Bazaar record for the oracle-facts route.`,
        ''
    ].join('\n');
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
                    key: { type: 'string', description: 'Base58 SAS authority public key; put it in an agreement\'s lens (rule.lens).' },
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
                            executed: { type: 'integer', description: 'Agreements executed on its attestations.' }
                        }
                    }
                }
            }
        }
    }
};

const CID_PROPERTY = { type: 'string', pattern: '^baf(?:krei|ybei)[a-z2-7]{52}$', description: 'CIDv1 UnixFS file, sha2-256, lower-case base32, fixed 256 KiB chunks and raw leaves; single-chunk files use the raw codec (bafkrei…), multi-chunk files use a UnixFS dag-pb root (bafybei…). It covers the object\'s canonical JSON bytes (keys sorted at every depth, no whitespace, UTF-8).' };
const GEOJSON_SITE = { type: 'object', required: ['type', 'coordinates'], properties: { type: { type: 'string', enum: ['Polygon', 'MultiPolygon'] }, coordinates: { type: 'array' } }, description: 'GeoJSON Polygon or MultiPolygon in WGS84: at most 100000 vertices and a 500 km² bounding box.' };

const DESIGN_BINDING_BODY = {
    type: 'object',
    required: ['site'],
    properties: {
        site: GEOJSON_SITE,
        toleranceM: { type: 'number', minimum: 0, maximum: 1, description: 'A parcel is bound when the site reaches into it by more than this width (metres; default 0).' },
        city: { type: 'string' },
        parcelSourceId: { type: 'string', description: 'The parcel source to bind with; the city\'s default when absent.' }
    }
};

const PIN_BODY = {
    type: 'object',
    required: ['kind', 'cid', 'bytes'],
    additionalProperties: false,
    properties: {
        kind: { type: 'string', enum: ['design', 'agreement'] },
        cid: CID_PROPERTY,
        bytes: { type: 'string', contentEncoding: 'base64', description: 'The object\'s canonical bytes, base64; at most 10 MiB.' }
    }
};

const INDEX_DESIGN_BODY = {
    type: 'object',
    required: ['cid', 'content'],
    additionalProperties: false,
    properties: {
        cid: CID_PROPERTY,
        content: { type: 'object', description: 'The design/v1 object (agents.json: schema.$defs.design).' },
        parcelSourceId: { type: ['string', 'null'], maxLength: 100, description: 'The parcel source to bind with; the city\'s default when null.' }
    }
};

const INDEX_AGREEMENT_BODY = {
    type: 'object',
    required: ['cid', 'content'],
    additionalProperties: false,
    properties: {
        cid: CID_PROPERTY,
        content: { type: 'object', description: 'The agreement/v1 object (agents.json: schema.$defs.agreement).' },
        designs: {
            type: 'array',
            description: 'Linked designs the index does not hold yet, indexed in the same transaction (a parcel layout is published only this way).',
            items: { type: 'object', required: ['cid', 'content'], additionalProperties: false, properties: { cid: CID_PROPERTY, content: { type: 'object' } } }
        }
    }
};

const ONCHAIN_BODY = {
    type: 'object',
    required: ['chain', 'cluster', 'account'],
    additionalProperties: false,
    properties: {
        chain: { type: 'string', enum: ['solana'] },
        cluster: { type: 'string', enum: ['devnet'] },
        account: { type: 'string', description: 'The agreement account: PDA ["agreement", sponsor, sha256(cid)] under the agreement program.' },
        signature: { type: ['string', 'null'], description: 'The create transaction\'s signature.' }
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
            ...MCP_READ_PATHS,
            ...FEEDBACK_PATHS,
            '/agent/oracle/facts': {
                get: {
                    tags: ['x402'],
                    summary: 'Buy a verified oracle fact (x402-paid)',
                    operationId: 'getAgentOracleFact',
                    parameters: [
                        { name: 'subject', in: 'query', required: false, schema: { type: 'string' }, description: 'Agreement account; omit for the latest fact.' },
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
                    summary: 'Proof that the paid oracle-facts resource is listed in the hosted x402 Bazaar',
                    operationId: 'getAgentDiscovery',
                    parameters: [{ name: 'resource', in: 'query', required: false, schema: { type: 'string', enum: ['oracle-facts'] } }],
                    responses: { 200: { description: 'Listing state.' }, 400: { description: 'Unknown resource.' } }
                }
            },
            '/agents.json': {
                get: {
                    summary: 'Design and agreement schemas, endpoint map, program ids, MCP tools and live oracle-fact payment terms',
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
                    summary: 'The lens SAS schemas (ParcelOwnership-v1, AgreementDecision-v1, MarketEvidence-v1): layout strings and field lists. An owner\'s yes is not an attestation: it is a signed decision on the agreement, relayed at /agreements/{cid}/decisions',
                    operationId: 'getLensSchemas',
                    responses: { 200: { description: '{ sasProgram, schemas: [{ kind, id, name, version, layout, fields, sasLayout }] }' } }
                }
            },
            '/parcels/{parcelUid}/history': {
                get: {
                    summary: 'Permanent per-parcel log: agreements over the parcel, lens ownership attestations and executions, oldest first by each source\'s own time',
                    operationId: 'getParcelHistory',
                    parameters: [{ name: 'parcelUid', in: 'path', required: true, schema: { type: 'string', maxLength: 128 }, description: 'Cadastral parcel id, URL-encoded (e.g. HR-335347-1208%2F3).' }],
                    responses: {
                        200: { description: '{ parcelUid, anchor: { account, exists (true | false | null), source (chain | unavailable | unseedable) }, events: [{ type (agreement_published | parcel_ownership | agreement_executed), at (source time or null), agreementCid?, title?, account?, lens?, attestation?, member?, owner?, ownerCount?, outcome?, transaction?, hash?, link }] }. agreement_published is the index receiving an agreement that takes the parcel; agreement_executed is its execution on chain, at the account\'s executed_at. Anchor existence is a separate validated account read; unavailable evidence stays null. No anchor mint time is inferred.' },
                        400: { description: 'Invalid parcelUid.' }
                    }
                }
            },
            '/oracle/events': {
                get: {
                    summary: 'Persisted land events (agreement lifecycle, per-parcel executions)',
                    operationId: 'getOracleEvents',
                    parameters: [
                        { name: 'type', in: 'query', required: false, schema: { type: 'string', enum: ['agreement_lifecycle', 'agreement_executed'] } },
                        { name: 'subject', in: 'query', required: false, schema: { type: 'string' }, description: 'Agreement account (the subject of agreement_lifecycle events).' },
                        { name: 'agreement', in: 'query', required: false, schema: { type: 'string' }, description: 'Agreement CID.' },
                        { name: 'parcelUid', in: 'query', required: false, schema: { type: 'string' }, description: 'Only events about this parcel: its own agreement_executed events, and agreement_lifecycle events of agreements that take it.' },
                        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } }
                    ],
                    responses: { 200: { description: '{ events, count, eventType, agreement?, parcelUid? }' }, 400: { description: 'Invalid filter.' } }
                }
            },
            '/oracle/recipes/agreement-execution-v1': {
                get: {
                    summary: 'The precommitted recipe a minted agreement\'s market settles by: executed YES, cancelled or expired NO; its trusted attester is the agreement program',
                    operationId: 'getAgreementExecutionRecipe',
                    parameters: [
                        { name: 'agreement', in: 'query', required: true, schema: { type: 'string' }, description: 'Agreement account.' },
                        { name: 'market', in: 'query', required: false, schema: { type: 'string' }, description: 'The agreement\'s market account, PDA ["market", agreement].' }
                    ],
                    responses: { 200: { description: '{ recipe }' }, 400: { description: 'Invalid agreement or market account.' }, 404: { description: 'No minted agreement has this account.' } }
                }
            },
            '/designs/binding': {
                post: {
                    summary: 'What a design on this site would bind: the parcels the site reaches into by more than the tolerance (an intrusion width). Read-only: nothing is stored and no Origin header is needed',
                    operationId: 'getDesignBinding',
                    requestBody: { required: true, content: { 'application/json': { schema: DESIGN_BINDING_BODY } } },
                    responses: {
                        200: { description: '{ city, parcelSourceId, binding: { parcels: [{ parcelId, overlapM2, intrusionM }], touched, unresolved?, toleranceM, coverage (complete | partial | none | unknown), unsurveyedM2, unknownM2, siteM2, source, parcelSource, computedAt } }' },
                        400: { description: 'invalid-site or invalid-tolerance.' },
                        409: { description: 'binding-unresolved: the site reaches into a parcel by within measurement error of the tolerance; move it a millimetre.' },
                        413: { description: 'too-many-parcels: the site meets more than 5000 parcels.' },
                        503: { description: 'binding-unavailable, or the parcel source is down.' }
                    }
                }
            },
            '/pins': {
                post: {
                    summary: 'Pin a design/v1 or agreement/v1 object as a UnixFS file on IPFS (CIDv1, sha2-256, fixed 256 KiB chunks, raw leaves) with exactly these canonical bytes; single-chunk files use a raw CID and multi-chunk files a UnixFS dag-pb root. The server recomputes the CID and checks the object as the index would. Needs an Origin header of the app; 30 pins per 15 minutes per client',
                    operationId: 'pinObject',
                    requestBody: { required: true, content: { 'application/json': { schema: PIN_BODY } } },
                    responses: {
                        200: { description: '{ cid, pinnedAt }' },
                        400: { description: 'invalid-kind, invalid-cid, invalid-bytes, cid-mismatch, not-canonical, or the object\'s own refusal (invalid-design, invalid-agreement).' },
                        409: { description: 'cid-mismatch: the pinning service answered another CID.' },
                        413: { description: 'too-large: over 10 MiB.' },
                        429: { description: 'upload-rate-limited, with retryAfterSeconds.' }
                    }
                }
            },
            '/designs': {
                get: {
                    summary: 'Indexed designs, newest first',
                    operationId: 'listDesigns',
                    parameters: [
                        { name: 'city', in: 'query', required: false, schema: { type: 'string', maxLength: 100 } },
                        { name: 'bbox', in: 'query', required: false, schema: { type: 'string' }, description: 'minLng,minLat,maxLng,maxLat (WGS84): designs whose site meets it.' },
                        { name: 'q', in: 'query', required: false, schema: { type: 'string', maxLength: 200 }, description: 'Matches the title or the author.' },
                        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000 } }
                    ],
                    responses: { 200: { description: '{ designs: [design row without content], count }; read the content by CID with GET /designs/{cid}.' }, 400: { description: 'Invalid filter.' } }
                },
                post: {
                    summary: 'Index a pinned design/v1 object: the server checks its CID and shape and derives its city and binding. A parcel layout is indexed only with its agreement. Needs an Origin header of the app',
                    operationId: 'indexDesign',
                    requestBody: { required: true, content: { 'application/json': { schema: INDEX_DESIGN_BODY } } },
                    responses: {
                        201: { description: 'The design row: { cid, city, goal, title, author, originCid, binding, content, screenshotUrl, screenshotBeforeUrl, screenshotPairUrl, createdAt }.' },
                        409: { description: 'The CID is indexed already (the body is its row), or binding-unresolved: the site reaches into a parcel by within measurement error of the tolerance.' },
                        400: { description: 'invalid-cid, cid-mismatch, invalid-design, invalid-site, invalid-tolerance, invalid-footprint, site-required or footprint-outside-site.' },
                        422: { description: 'layout-needs-agreement: send a parcel layout in the designs of POST /agreements.' },
                        503: { description: 'binding-unavailable: nothing was stored.' }
                    }
                }
            },
            '/designs/{cid}': {
                get: {
                    summary: 'Read one indexed design',
                    operationId: 'getDesign',
                    parameters: [
                        { name: 'cid', in: 'path', required: true, schema: { type: 'string' }, description: 'Design CID (bafkrei…).' },
                        { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['jsonld'] } }
                    ],
                    responses: { 200: { description: 'The design row.' }, 400: { description: 'invalid-cid.' }, 404: { description: 'design-not-found.' } }
                }
            },
            '/agreements': {
                get: {
                    summary: 'Indexed agreements, newest first, each with its status (from the chain once minted, else from the deadline)',
                    operationId: 'listAgreements',
                    parameters: [
                        { name: 'city', in: 'query', required: false, schema: { type: 'string', maxLength: 100 } },
                        { name: 'design', in: 'query', required: false, schema: { type: 'string' }, description: 'Only agreements linking this design CID.' },
                        { name: 'parcel', in: 'query', required: false, schema: { type: 'string' }, description: 'Only agreements taking this input parcel id.' },
                        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000 } }
                    ],
                    responses: { 200: { description: '{ agreements: [agreement row], count }' }, 400: { description: 'Invalid filter.' } }
                },
                post: {
                    summary: 'Index a pinned agreement/v1 object with the designs it links that the index does not hold yet. Its input parcels must be exactly the union of its designs\' bindings. Needs an Origin header of the app',
                    operationId: 'indexAgreement',
                    requestBody: { required: true, content: { 'application/json': { schema: INDEX_AGREEMENT_BODY } } },
                    responses: {
                        201: { description: 'The agreement row: { cid, city, title, author, designCids, inputParcelIds, parcelSourceId, deadline, status, content, onchain, screenshotUrl, screenshotBeforeUrl, screenshotPairUrl, createdAt }.' },
                        409: { description: 'The CID is indexed already; the body is its row.' },
                        400: { description: 'invalid-cid, cid-mismatch, invalid-agreement (with its section) or a refused carried design.' },
                        422: { description: 'deadline-past, design-not-indexed (missing) or inputs-differ-from-binding (missing, extra).' }
                    }
                }
            },
            '/agreements/{cid}': {
                get: {
                    summary: 'Read one indexed agreement: its content, status and, once minted, its chain account (onchain)',
                    operationId: 'getAgreement',
                    parameters: [
                        { name: 'cid', in: 'path', required: true, schema: { type: 'string' }, description: 'Agreement CID (bafkrei…).' },
                        { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['jsonld'] } }
                    ],
                    responses: { 200: { description: 'The agreement row.' }, 400: { description: 'invalid-cid.' }, 404: { description: 'agreement-not-found.' } }
                }
            },
            '/agreements/{cid}/decisions': {
                get: {
                    summary: 'The owner decisions relayed for an agreement, each a receipt signed over its agreement-decision/v1 statement',
                    operationId: 'getAgreementDecisions',
                    parameters: [{ name: 'cid', in: 'path', required: true, schema: { type: 'string' } }],
                    responses: { 200: { description: '{ agreementCid, decisions: [receipt] }' }, 404: { description: 'agreement_not_found.' } }
                },
                post: {
                    summary: 'Relay one owner decision: { receipt }, re-verified before it is stored. Needs an Origin header of the app',
                    operationId: 'postAgreementDecision',
                    parameters: [{ name: 'cid', in: 'path', required: true, schema: { type: 'string' } }],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['receipt'], properties: { receipt: { type: 'object' } } } } } },
                    responses: { 201: { description: '{ stored: true, duplicate: false }' }, 200: { description: '{ stored: true, duplicate: true }' }, 400: { description: 'The receipt does not verify or is not admitted, with its code.' } }
                }
            },
            '/agreements/{cid}/community-reports': {
                get: {
                    summary: 'Append-only signed NGO reports, ordered by postedAt then CID; no-store. Browsers must resolve live DID Web authorization on every read',
                    operationId: 'getCommunityReports',
                    parameters: [{ name: 'cid', in: 'path', required: true, schema: { type: 'string' } }],
                    responses: { 200: { description: '{ agreementCid, reports: [{ cid, content }] }; snapshot signatures alone do not establish current website authorization.' }, 404: { description: 'agreement-not-found.' } }
                },
                post: {
                    summary: 'Pin and append a community-result/v1 signed by the named community organiser, including after the deadline; server checks snapshot without fetching websites',
                    operationId: 'postCommunityReport',
                    parameters: [{ name: 'cid', in: 'path', required: true, schema: { type: 'string' } }],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['cid', 'content'], additionalProperties: false, properties: { cid: CID_PROPERTY, content: COMMUNITY_REPORT_CONTENT } } } } },
                    responses: { 201: { description: '{ stored: true, duplicate: false, cid }' }, 200: { description: '{ stored: true, duplicate: true, cid }' }, 400: { description: 'Invalid shape or CID.' }, 403: { description: 'Signature or organiser not authorized.' }, 404: { description: 'agreement-not-found.' }, 413: { description: 'Report exceeds 96 KiB.' }, 429: { description: 'Upload rate limit.' }, 502: { description: 'Pin failed.' }, 503: { description: 'Pinning unconfigured.' } }
                }
            },
            '/agreements/{cid}/onchain': {
                post: {
                    summary: 'Record the chain account an agreement was minted as: the server reads the account (it must be the PDA of the agreement\'s sponsor and CID) and the signature on its own RPC. Needs an Origin header of the app',
                    operationId: 'recordAgreementOnchain',
                    parameters: [{ name: 'cid', in: 'path', required: true, schema: { type: 'string' } }],
                    requestBody: { required: true, content: { 'application/json': { schema: ONCHAIN_BODY } } },
                    responses: {
                        201: { description: 'The agreement row with onchain, first record.' },
                        200: { description: 'The agreement row with onchain refreshed.' },
                        400: { description: 'onchain-account-mismatch, onchain-signature-mismatch, unsupported-chain or unsupported-cluster.' },
                        404: { description: 'agreement-not-found, or onchain-account-missing (not visible yet: ask again).' },
                        409: { description: 'onchain-signature-not-found (not visible yet), onchain-recorded-elsewhere, onchain-cid-mismatch, onchain-sponsor-mismatch or onchain-not-agreement.' },
                        422: { description: 'not-binding: only a binding owners\' agreement is minted; no-sponsor: the agreement names no sponsor wallet.' }
                    }
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
