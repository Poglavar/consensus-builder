import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import { readX402OracleConfig } from '../utils/x402-payment.js';
import { describeDatabase } from '../db/connection.cjs';
import { AGREEMENT_EXECUTED_EVENT_TYPE, AGREEMENT_LIFECYCLE_EVENT_TYPE } from '../oracle/agreement-lifecycle.js';
import { AGREEMENT_EXECUTION_RECIPE_ID, SETTLEMENT } from '../oracle/market-recipe.js';
import { AGREEMENT_PUBLISHED_EVENT_TYPE, OWNERSHIP_EVENT_TYPE, PARCEL_PROGRAM_ID } from '../oracle/parcel-history.js';
import { LENS_SCHEMAS, SAS_PROGRAM_ID } from '../oracle/lens-schemas.js';
import { COURT_RECIPE_ID, COURT_RECIPE_V2_ID, COURT_SCHEMA_V2 } from '../oracle/court-parcel-operation.js';
import { classifyExternalMarketChronology } from '../oracle/external-market-chronology.js';
import { PROSPECTIVE_MARKET } from '../oracle/prospective-market-public.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
// The program codecs hold the program ids and seeds the agent docs print (blockchain/solana/programs/*).
const AgreementClient = require('../../frontend/js/solana/agreement-client.js');
const MarketClient = require('../../frontend/js/solana/market-client.js');
const PledgeClient = require('../../frontend/js/solana/pledge-client.js');
const USDC_DEVNET_MINT = PledgeClient.constants.USDC_DEVNET_MINT;
// The tools backend/agents/mcp-server.mjs registers, in its order.
const MCP_TOOLS = Object.freeze([
    'ugt_capabilities', 'ugt_activity', 'ugt_list_agreements', 'ugt_get_agreement', 'ugt_list_attesters',
    'ugt_support_status', 'ugt_oracle_events', 'ugt_inspect_verified_fact', 'ugt_publish_design',
    'ugt_propose_agreement', 'ugt_mint_agreement', 'ugt_fund_agreement', 'ugt_bet_on_agreement',
    'ugt_buy_verified_fact', 'ugt_request_ownership', 'ugt_pledge', 'ugt_donate', 'ugt_refund_donation',
    'ugt_void_pledge', 'ugt_revoke_pledge', 'ugt_release_donations', 'ugt_fulfill_pledge',
    'ugt_resolve_market', 'ugt_claim_market', 'ugt_resolve_external_market', 'ugt_claim_external_market'
]);

// Cache for database schema to serve previous version if refresh fails
let cachedDatabaseSchema = null;
let lastDatabaseRefresh = null;
const DATABASE_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// One page template for every markdown doc served here, so /docs and /docs/agents look the same.
function renderDocPage(htmlContent, title) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f8f9fa;
        }
        .container {
            background: white;
            padding: 40px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #2c3e50;
            border-bottom: 3px solid #3498db;
            padding-bottom: 10px;
            margin-bottom: 30px;
        }
        h2 {
            color: #34495e;
            margin-top: 30px;
            margin-bottom: 15px;
        }
        h3 {
            color: #7f8c8d;
            margin-top: 25px;
            margin-bottom: 10px;
        }
        code {
            background-color: #f1f2f6;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            font-size: 0.9em;
        }
        pre {
            background-color: #2c3e50;
            color: #ecf0f1;
            padding: 20px;
            border-radius: 6px;
            overflow-x: auto;
            margin: 15px 0;
        }
        pre code {
            background: none;
            color: inherit;
            padding: 0;
        }
        ul, ol {
            margin: 15px 0;
            padding-left: 30px;
        }
        li {
            margin: 8px 0;
        }
        a {
            color: #3498db;
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        .endpoint {
            background-color: #e8f4f8;
            border-left: 4px solid #3498db;
            padding: 15px;
            margin: 10px 0;
            border-radius: 0 4px 4px 0;
        }
        .feature-list {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin: 20px 0;
        }
        .feature-card {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 6px;
            border: 1px solid #e9ecef;
        }
        .badge {
            display: inline-block;
            background: #3498db;
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.8em;
            margin-right: 8px;
        }
        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e9ecef;
            color: #6c757d;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="container">
        ${htmlContent}
        <div class="footer">
            <p><strong>Quick Links:</strong> 
                <a href="/docs/agents">Agent quickstart</a> | 
                <a href="/docs/api">API Schema (JSON)</a> | 
                <a href="/docs/database">Database Schema (JSON)</a> | 
                <a href="/health">Health Check</a>
            </p>
        </div>
    </div>
</body>
</html>`;
}

export function setupDocsRoute(app, pool, { env = process.env } = {}) {
    // GET /docs - General documentation (markdown converted to HTML)
    app.get('/docs', (req, res) => {
        try {
            const docsPath = path.join(__dirname, 'docs.md');
            const markdownContent = fs.readFileSync(docsPath, 'utf8');

            // Process the markdown content to replace $(date) with actual date
            const processedContent = markdownContent.replace(/\$\(date\)/g, new Date().toLocaleDateString());

            // Convert markdown to HTML
            const htmlContent = marked(processedContent);

            // Create a complete HTML page with styling
            const fullHtml = renderDocPage(htmlContent, 'Consensus Builder API Documentation');

            res.setHeader('Content-Type', 'text/html');
            res.send(fullHtml);
        } catch (error) {
            console.error('Error reading docs.md:', error);
            res.status(500).json({ error: 'Failed to load documentation' });
        }
    });

    // The base URL printed into the agent docs. Display only (never persisted), so falling back to
    // the request's own host is fine here; PUBLIC_API_BASE_URL wins when set.
    const docsBaseUrl = (req) => (env.PUBLIC_API_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const agreementProgramId = AgreementClient.constants.AGREEMENT_PROGRAM_ID;
    const marketProgramId = MarketClient.constants.PROGRAM_ID;
    const pledgeProgramId = PledgeClient.constants.PROGRAM_ID;
    // The agreement program's id is a readable placeholder until its first devnet deploy
    // (programs/agreement/README.md, "Program id"); the docs say so instead of sending agents to it.
    const agreementProgramDeployed = !/^Agreement1+$/.test(agreementProgramId);
    const agreementProgramStatus = agreementProgramDeployed
        ? 'deployed on devnet'
        : 'pending its devnet deployment: the id is a placeholder, so minting, funding and agreement markets fail until it is deployed';

    // GET /docs/agents - the agent quickstart: publish designs, propose an agreement, mint it and back it.
    app.get('/docs/agents', (req, res) => {
        try {
            const oracleX402 = readX402OracleConfig(env);
            const markdown = fs.readFileSync(path.join(__dirname, 'docs-agents.md'), 'utf8')
                .replace(/\$\(base\)/g, docsBaseUrl(req))
                .replace(/\$\(oraclePrice\)/g, oracleX402.priceOracleFact || '(price not configured on this server)')
                .replace(/\$\(network\)/g, oracleX402.network || 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')
                .replace(/\$\(agreementProgram\)/g, agreementProgramId)
                .replace(/\$\(agreementProgramStatus\)/g, agreementProgramStatus)
                .replace(/\$\(marketProgram\)/g, marketProgramId)
                .replace(/\$\(pledgeProgram\)/g, pledgeProgramId)
                .replace(/\$\(parcelProgram\)/g, PARCEL_PROGRAM_ID)
                .replace(/\$\(date\)/g, new Date().toLocaleDateString());
            res.setHeader('Content-Type', 'text/html');
            res.send(renderDocPage(marked(markdown), 'Agent quickstart — Urban Game Theory'));
        } catch (error) {
            console.error('Error reading docs-agents.md:', error);
            res.status(500).json({ error: 'Failed to load agent documentation' });
        }
    });

    // GET /docs/agents.json - what an agent publishes (design/v1 and agreement/v1 as JSON Schema), the
    // endpoints, the programs, the MCP tools and the live oracle-fact payment terms.
    app.get('/docs/agents.json', (req, res) => {
        try {
            const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-recipe-schema.json'), 'utf8'));
            const oracleX402 = readX402OracleConfig(env);
            const base = docsBaseUrl(req);
            const decision = LENS_SCHEMAS.decision;
            // Live payment terms: never served from a cache (also reached as /agents.json, and through
            // the main site's nginx proxy, which passes this header on).
            res.set('Cache-Control', 'no-store');
            res.json({
                docs: `${base}/docs/agents`,
                schema,
                // The one paid resource: recipe-bound verified facts about agreement accounts.
                x402: {
                    enabled: oracleX402.enabled,
                    resource: `${base}/agent/oracle/facts`,
                    query: {
                        subject: 'the agreement account; omitted, the newest terminal agreement fact',
                        market: 'optional: the agreement\'s market account, bound into the fact\'s recipe'
                    },
                    network: oracleX402.network,
                    facilitatorUrl: oracleX402.facilitatorUrl,
                    payTo: oracleX402.payTo,
                    priceOracleFact: oracleX402.priceOracleFact,
                    paymentFlow: 'upfront',
                    usdcMint: USDC_DEVNET_MINT
                },
                writes: {
                    origin: 'POST /pins, /designs, /agreements, /agreements/{cid}/decisions and /agreements/{cid}/onchain need an Origin header of the app: https://urbangametheory.xyz in production (any localhost origin in development).',
                    readOnlyPosts: ['/designs/binding', '/designs/batch', '/parcels/under', '/buildings/footprints'],
                    pinLimit: '30 pins per 15 minutes per client; a 429 carries retryAfterSeconds',
                    idempotence: 'every object is filed under its CID: publishing it again answers 409 with the row the index holds'
                },
                flow: [
                    'POST /designs/binding { site, toleranceM? }: the parcels a site takes (free; nothing stored)',
                    'POST /pins { kind: "design", cid, bytes }, then POST /designs { cid, content }: one per design; the row carries its binding (a parcel layout waits for its agreement)',
                    'POST /pins { kind: "agreement", cid, bytes }, then POST /agreements { cid, content, designs? }: inputs are exactly the union of the designs\' bindings; designs carries the linked designs the index does not hold yet',
                    'a non-binding agreement (an owner or community vote) stops here: it is a poll in the index, never minted, with no market',
                    'a binding owners\' agreement, as its sponsor: create (and fund) the account on the agreement program, then POST /agreements/{cid}/onchain { chain: "solana", cluster: "devnet", account, signature }',
                    'its owners relay signed decisions to /agreements/{cid}/decisions and its lens member attests AgreementDecision-v1 once the rule passes; anyone records it (attest) and executes; meanwhile anyone may bet, pledge and donate on the account; after the deadline anyone may expire it'
                ],
                endpoints: {
                    designBinding: `${base}/designs/binding`,
                    pins: `${base}/pins`,
                    publishDesign: `${base}/designs`,
                    design: `${base}/designs/{cid}`,
                    designs: `${base}/designs?city={city}&bbox={minLng},{minLat},{maxLng},{maxLat}&q={text}&limit={n}`,
                    designsBatch: `${base}/designs/batch`,
                    proposeAgreement: `${base}/agreements`,
                    agreement: `${base}/agreements/{cid}`,
                    agreements: `${base}/agreements?city={city}&design={designCid}&parcel={parcelId}&limit={n}`,
                    agreementDecisions: `${base}/agreements/{cid}/decisions`,
                    agreementOnchain: `${base}/agreements/{cid}/onchain`,
                    parcelAt: `${base}/parcels?coordinates={lng},{lat}`,
                    parcelsUnder: `${base}/parcels/under`,
                    parcelHistory: `${base}/parcels/{parcelUid}/history`,
                    urbanRules: `${base}/urban-rules?coordinates={lng},{lat}`,
                    buildingFootprints: `${base}/buildings/footprints`,
                    lensMembers: `${base}/lenses/members`,
                    agentLensMembers: `${base}/agent/lenses/members`,
                    lensSchemas: `${base}/lenses/schemas`,
                    // Every contest in a city (agreements over shared land) with each minted agreement's yes/no pool.
                    markets: `${base}/markets?city={city}`,
                    support: `${base}/agent/pledges/{agreementAccount}`,
                    oracleEvents: `${base}/oracle/events?subject={agreementAccount}`,
                    // The recipe a minted agreement's market settles by (routes/markets.js). `market` is optional;
                    // when given it must be the agreement's pool, PDA ["market", agreementAccount].
                    marketRecipe: `${base}/oracle/recipes/${AGREEMENT_EXECUTION_RECIPE_ID}?agreement={agreementAccount}`,
                    marketRecipeForMarket: `${base}/oracle/recipes/${AGREEMENT_EXECUTION_RECIPE_ID}?agreement={agreementAccount}&market={marketAccount}`,
                    // Paid through x402: `subject` is the agreement account, `market` optional (see x402.query).
                    oracleFact: `${base}/agent/oracle/facts?subject={agreementAccount}`,
                    oracleFactForMarket: `${base}/agent/oracle/facts?subject={agreementAccount}&market={marketAccount}`,
                    oracleFactLatest: `${base}/agent/oracle/facts`,
                    discovery: `${base}/agent/discovery`,
                    oracleFactDiscovery: `${base}/agent/discovery?resource=oracle-facts`,
                    activity: `${base}/agent/activity?limit={n}`,
                    hackathonProof: `${base}/hackathon/proof.json`,
                    prospectiveMarketStatus: `${base}/oracle/markets/prospective/status`
                },
                design: {
                    schema: 'design/v1',
                    jsonSchema: '#/schema/$defs/design',
                    cid: 'CIDv1, raw codec, sha2-256, base32 lower case (bafkrei…) over the canonical bytes: JSON with keys sorted at every depth, no whitespace, UTF-8',
                    types: {
                        road: { goals: ['road-track'], payload: 'roadProposal' },
                        building: { goals: ['single', 'buildings', 'row', 'parcelBased'], payload: 'buildingProposal' },
                        structure: { goals: ['park', 'square', 'lake', 'station'], payload: 'structureProposal' },
                        urbanRule: { goals: ['urban-rule'] },
                        parcelLayout: { goals: ['parcel-layout'], payload: 'parcelLayout', publish: 'only in the designs of POST /agreements' }
                    },
                    binding: 'the server derives the parcels a design\'s site takes (intrusion width above toleranceM); a design names no parcels',
                    ownership: 'a design never moves ownership: applying it carries ownership over (whoever held the ground still holds the pieces); who receives which piece is an agreement\'s allocations',
                    examples: `${base}/designs?city=zagreb&limit=5`
                },
                agreement: {
                    schema: 'agreement/v1',
                    jsonSchema: '#/schema/$defs/agreement',
                    inputs: 'exactly the parcels the designs take (the union of their server bindings), with a holders snapshot, plus openGroundM2',
                    outputs: 'every piece on the input land after the designs are applied, by hash (piece1-sha256:…), with areaM2, fromParcelIds, role and producedBy',
                    outputRoles: ['plot', 'remainder', 'corridor', 'part', 'parcel'],
                    allocations: { holders: 'the carried-over holding (no line means the same)', party: 'one holder of the input land', public: 'the public', joint: 'shares summing to 1' },
                    money: '{ currency: "EUR", lines: [{ ownerKey, amountCents }] }: + receives, − pays',
                    rules: {
                        ownerDeal: { electorate: 'owners', binding: true },
                        ownerVote: { electorate: 'owners', binding: false },
                        communityVote: { electorate: 'community', binding: false, approvalConfig: null }
                    },
                    // Only a binding owners' agreement is minted, funded, attested, executed and bet on.
                    minting: 'binding owners\' agreements only (ownerDeal); an owner or community vote is a poll in the index: never minted, no market',
                    sponsor: 'the base58 wallet that mints and funds it; its account is PDA ["agreement", sponsor, sha256(cid)]',
                    status: 'active | executed | cancelled | expired: from the chain once minted (onchain.status), else from the deadline',
                    decisions: {
                        relay: `${base}/agreements/{cid}/decisions`,
                        statement: '{ schema: "agreement-decision/v1", agreementCid, ownerId, actorId, contextHash, decision, decidedAt }',
                        receipt: '{ ownerId, actorId, evidence: { rights, authority }, decision: "approve" | "withdraw", decidedAt, decisionProof, providerId }',
                        evidence: 'the lens member\'s rights and authority facts for the agreement: POST {serviceUrl}/lens/approval/rights, /lens/approval/challenge, /lens/approval/authority',
                        counting: 'owners rules only: the approval engine (frontend/js/proposals/approval.js tally) counts the relayed receipts, each re-verified; a community vote has no owner approval rule, so no owner decision can satisfy it'
                    }
                },
                agreementProgram: {
                    programId: agreementProgramId,
                    deployed: agreementProgramDeployed,
                    status: agreementProgramStatus,
                    cluster: 'devnet',
                    idl: 'blockchain/solana/idl/agreement.json',
                    client: 'frontend/js/solana/agreement-client.js',
                    readme: 'blockchain/solana/programs/agreement/README.md',
                    pda: 'seeds ["agreement", sponsor (authority), sha256(cid as UTF-8)]: only the sponsor can create its agreement\'s account',
                    account: {
                        space: AgreementClient.constants.AGREEMENT_ACCOUNT_SPACE,
                        offsets: AgreementClient.AGREEMENT_OFFSETS,
                        fields: 'authority, lens, payout, deadline (unix s, 0 none), created_at, required_lamports, escrow_lamports, status, open_ground, decision, decision_attested_at, decision_observed_at, decision_attestation, decision_hash, executed_at, bump, cid',
                        statuses: ['Active', 'Executed', 'Cancelled', 'Expired'],
                        decisions: ['Pending', 'Satisfied']
                    },
                    instructions: {
                        create: {
                            args: ['cid: string', 'lens: pubkey', 'deadline: i64', 'open_ground: bool', 'required_lamports: u64', 'payout: pubkey'],
                            accounts: ['agreement (mut, init: the PDA)', 'authority (signer, mut: the sponsor; pays the rent)', 'system_program'],
                            requires: 'cid 1-64 ASCII letters and digits; lens and payout not the default key; deadline 0 or in the future'
                        },
                        fund: { args: ['lamports: u64'], accounts: ['agreement (mut)', 'authority (signer, mut)', 'system_program'], requires: 'the sponsor; Active; before the deadline' },
                        attest: { args: [], accounts: ['agreement (mut)', 'attestation (the lens\'s AgreementDecision-v1)', 'credential (its SAS credential)'], requires: 'Active; decision Pending; before the deadline; permissionless' },
                        execute: { args: [], accounts: ['agreement (mut)', 'payout (mut)'], requires: 'decision Satisfied; before the deadline; escrow_lamports >= required_lamports; permissionless; the whole escrow goes to payout' },
                        cancel: { args: [], accounts: ['agreement (mut)', 'authority (signer, mut)'], requires: 'the sponsor; Active; no decision recorded; the escrow returns to the sponsor' },
                        expire: { args: [], accounts: ['agreement (mut)', 'authority (mut)'], requires: 'Active; the deadline set and passed; permissionless; the escrow returns to the sponsor' }
                    },
                    decisionAttestation: {
                        schema: `${decision.name}-v${decision.version}`,
                        layout: decision.layout,
                        sasLayout: decision.sasLayout,
                        schemaPda: `["schema", credential, "${decision.name}", [${decision.version}]] under SAS ${SAS_PROGRAM_ID}`,
                        decision: 'always "satisfied": the lens attests once the agreement\'s rule passes over the relayed owner decisions, before the deadline; there is no refusal: an agreement not decided by its deadline expires',
                        sponsor: 'must equal the account\'s authority, so an attestation fits one account only',
                        evidenceRef: 'sha256: over the counted receipts (approval.stableStringify, in signing order)',
                        issuer: 'the lens key the account names, on its member service (operator only)'
                    }
                },
                // Lens model (lens-model.md): the attesters an agreement trusts.
                lens: {
                    ruleField: 'rule.lens',
                    programLens: 'the agreement program names exactly one lens key per account; it must not be the sponsor',
                    members: `${base}/agent/lenses/members`,
                    memberFields: ['key', 'kind', 'name', 'description', 'serviceUrl', 'registeredAt', 'coverage'],
                    memberKinds: ['owner-consent', 'court', 'permit', 'imagery', 'osm', 'lifecycle'],
                    kindMeaning: 'what the member attests, not who it is',
                    schemas: `${base}/lenses/schemas`,
                    attestations: Object.values(LENS_SCHEMAS).map(item => `${item.name}-v${item.version}`),
                    ownerDecision: 'an owner\'s yes is not an attestation: it is a decision signed over the agreement CID and relayed at /agreements/{cid}/decisions'
                },
                mcp: {
                    transport: 'stdio',
                    source: 'backend/agents/mcp-server.mjs',
                    command: 'cd backend && npm run mcp',
                    liveActionsEnabledByDefault: false,
                    liveGuard: 'UGT_MCP_LIVE=1 in the MCP process plus confirm=true in the call, for every index write and every paid or signed action; chain actions use Solana devnet only',
                    env: ['UGT_API_BASE', 'UGT_APP_ORIGIN', 'UGT_AGENT_KEYPAIR', 'UGT_MCP_LIVE', 'UGT_MCP_MAX_USDC_PER_ACTION', 'SOLANA_RPC_URL'],
                    usdcCap: 'UGT_MCP_MAX_USDC_PER_ACTION (default 0.25) caps every stake, pledge and donation, and every x402 price, before anything is signed',
                    tools: MCP_TOOLS,
                    sharedAdapters: [
                        'design and agreement index client', 'agreement minter', 'agreement market client',
                        'agreement pledge and donation clients', 'x402 verified-fact client', 'lens ownership client'
                    ]
                },
                oracle: {
                    eventType: AGREEMENT_LIFECYCLE_EVENT_TYPE,
                    schema: `${base}/oracle/recipe.schema.json`,
                    events: `${base}/oracle/events?subject={agreementAccount}`,
                    // Written by the agreement lifecycle oracle (oracle/agreement-lifecycle-job.mjs) from the
                    // agreement program's accounts. Event times are the chain's own: executed_at from the
                    // account, cancelled_at / expired_at from the program's event.
                    eventTypes: {
                        [AGREEMENT_LIFECYCLE_EVENT_TYPE]: 'terminal agreement account state: executed, cancelled or expired (default of ?type=); subject the agreement account',
                        [AGREEMENT_EXECUTED_EVENT_TYPE]: 'one per input parcel of an executed agreement, its history entry: agreement CID, account, lens and decision attestation; subject the parcel'
                    },
                    eventsByAgreement: `${base}/oracle/events?type={eventType}&agreement={agreementCid}`,
                    eventsByParcel: `${base}/oracle/events?type={eventType}&parcelUid={parcelUid}`,
                    // Permanent per-parcel log: agreements over the parcel, lens ownership attestations and
                    // executions, oldest first by each source's own time (null and last when it has none).
                    parcelHistory: {
                        url: `${base}/parcels/{parcelUid}/history`,
                        response: '{ parcelUid, anchor: { account, exists (true | false | null), source (chain | unavailable | unseedable) }, events: [{ type, at, agreementCid?, title?, account?, lens?, attestation?, member?, owner?, ownerCount?, outcome?, transaction?, hash?, link }] }',
                        eventTypes: [AGREEMENT_PUBLISHED_EVENT_TYPE, OWNERSHIP_EVENT_TYPE, AGREEMENT_EXECUTED_EVENT_TYPE],
                        anchor: `parcel_nft (${PARCEL_PROGRAM_ID}) PDA ["parcel", parcelUid]; an identity only, it carries no ownership. Existence requires a validated devnet account read; unavailable evidence stays null. No mint time is inferred from touched transactions.`,
                        privacy: 'ownership attestations expose member, owner wallet, ownerCount and the account hash; never the evidence reference',
                        caching: 'no-store'
                    },
                    // The recipe an agreement's market settles by (oracle/market-recipe.js); the paid
                    // verified fact binds it to an agreement_lifecycle event.
                    recipeId: AGREEMENT_EXECUTION_RECIPE_ID,
                    recipe: {
                        url: `${base}/oracle/recipes/${AGREEMENT_EXECUTION_RECIPE_ID}?agreement={agreementAccount}`,
                        urlForMarket: `${base}/oracle/recipes/${AGREEMENT_EXECUTION_RECIPE_ID}?agreement={agreementAccount}&market={marketAccount}`,
                        market: 'optional; when given it must be the agreement\'s pool, PDA ["market", agreementAccount]',
                        subject: '{ chain: "solana:devnet", agreementAccount, agreementCid, marketAccount }',
                        trustedAttesters: 'the agreement program, which executes an account only on the attestation of the lens it names',
                        outcomes: Object.fromEntries(Object.entries(SETTLEMENT).map(([status, side]) => [status, side.toUpperCase()])),
                        precommitted: 'never changes under its id; every verified fact carries it too'
                    },
                    source: 'Solana agreement account plus its terminal transaction',
                    attester: agreementProgramId,
                    publicRecords: {
                        summary: `${base}/oracle/public-records/summary`,
                        source: 'Croatian judiciary e-Oglasna archive',
                        attestation: 'Solana Attestation Service on devnet',
                        privacy: 'aggregate-only from this API; parcel-level legal records remain in the dedicated oracle boundary',
                        marketIntegration: 'ExternalMarket verifier and first court-SAS settlement are live on devnet'
                    },
                    externalMarket: {
                        status: 'live_devnet',
                        recipeId: COURT_RECIPE_ID,
                        recipe: `${base}/oracle/recipes/${COURT_RECIPE_ID}?parcelUid={parcelUid}&yesOperation={yesOperation}&noOperation={noOperation}&closesAt={unixSeconds}`,
                        verification: 'permissionless direct SAS account parsing; outcome is derived from the committed operation mapping',
                        proofMarket: '5wyJ7XjbnoPUaDgaHAttdhdS38VmHf1p3jGwwVUeN8QM',
                        proofResolution: '39sN9w1Pj75Hp7vjxQzaNQ89uRxSsTjFFoE4GCPfWXMU7v1koLEUtV6odzUfQcxuZJNWwXhs1UWKswSMRQbdLETJ',
                        proofClaim: '2Ht5ZdVHZuFdEu5PkhkQxqNjoPQSBM9jeGaWKPiWzpLjbWtahP5bhKh3offRcvKDVN6JBFMy6piozWnEExy3RNzJ',
                        proof: {
                            recipeHash: '956161fdc52eb86424952ad2cd447b9876720fee4459c4af541095e211b1df75',
                            attestation: '12VxrWBkHfabA1jdV9HfniPNSj95Tp16uhXprpXzPgWk',
                            evidenceHash: '6a2dcae7c7b3c0ed7c8d9f93f415a5296f1293b0001e7857a806589b04eac789',
                            create: '5rcKhFUdkEaoXiyme4WBEEdQdW9dxvR6tPhqdAxUoW1T4KYC6LqwkBGf91T634pLRMUcbAsFeHvgoKghVTf2hBAD',
                            yesStake: 'fvSPdGu3DTpJ9MNpQX5iFw8MyjFkqmrdKjoSn9LfbXEYtAPjJTQT7vLcc1HDvicEZTcDwsw55MG7KKCaSUg7bnE',
                            noStake: '4nVnKJAFnPfqk6fPqa1cK6GQVQxSzZFd9tmWUAaZE79ZVRKZqyfWhawPy1SenkfctLpormsKXKY2GJLSQLiQp7M4',
                            yesStakeAtomic: '10000',
                            noStakeAtomic: '10000',
                            payoutAtomic: '20000',
                            decimals: 6,
                            chronology: classifyExternalMarketChronology({
                                marketCreatedAt: 1790001502,
                                yesStakeAt: 1790001504,
                                noStakeAt: 1790001507,
                                marketClosesAt: 1790001574,
                                evidenceCreatedAt: 1778592577,
                                resolvedAt: 1790001575,
                                claimedAt: 1790001577
                            })
                        },
                        prospectiveProof: {
                            status: 'market_open_awaiting_post_close_evidence',
                            attestationStatus: 'live_devnet',
                            v2Attestations: 5,
                            proofAttestation: 'AoF7DacKAkH3YcuWFp6vgYkVUspT8whmX1WWfWVUabFe',
                            proofTransaction: '5rRaRysV8hNmNDXiMoXGpLYNEFZxRZrQk6uQxG1A1cHwEjMEJcVUG4zn1QPZkBKhBX8dLMipjWFrswzqE1HMa9Ta',
                            market: PROSPECTIVE_MARKET.market,
                            recipeHash: PROSPECTIVE_MARKET.recipeHash,
                            closesAt: PROSPECTIVE_MARKET.closesAt,
                            transactions: PROSPECTIVE_MARKET.transactions,
                            script: 'blockchain/solana/scripts/prospective-external-market.mjs',
                            recipeId: COURT_RECIPE_V2_ID,
                            recipe: `${base}/oracle/recipes/${COURT_RECIPE_V2_ID}?parcelUid={parcelUid}&yesOperation={yesOperation}&noOperation={noOperation}&closesAt={unixSeconds}`,
                            schema: COURT_SCHEMA_V2,
                            schemaUrl: `https://explorer.solana.com/address/${COURT_SCHEMA_V2}?cluster=devnet`,
                            schemaRegistration: '3JqgCCCeM8Duf8mVtYbi5reZQBZvZ1QZPQojTpV9LKDWjsMq8rXLw56c2mhdP3WLraPx1SUednLwqpuwFhhzwQpa',
                            marketProgramUpgrade: '5rxykVhB775kvWzNvoJTjL2GxgKKkTKBywQcoDwQNEZW3shCjUHTBQsjxjwDtqLKbPpUxds8Rot5qbvcMUwsKfQG',
                            temporalGuard: 'proposal_market requires market close <= sourceObservedAt <= resolution time',
                            requirement: 'wait for a matching official record published after close, attest it with V2, then settle permissionlessly'
                        }
                    }
                },
                market: {
                    programId: marketProgramId,
                    cluster: 'devnet',
                    subject: 'the agreement account (market-client.js names it `proposal`)',
                    pda: 'seeds ["market", agreementAccount]',
                    positionPda: 'seeds ["position", market, owner, side (u8: 0 no, 1 yes)]',
                    stakeMint: USDC_DEVNET_MINT,
                    stakeDecimals: 6,
                    resolution: {
                        yes: 'the agreement account is Executed',
                        no: 'the agreement account is Cancelled or Expired',
                        permissionless: true,
                        deadline: 'stakes are taken while the agreement is Active and before its deadline; a passed deadline resolves NO only once someone expires the account',
                        oracleRecipe: AGREEMENT_EXECUTION_RECIPE_ID
                    },
                    contests: `${base}/markets?city={city}`,
                    idl: 'blockchain/solana/idl/proposal_market.json',
                    client: 'frontend/js/solana/market-client.js',
                    externalResolution: {
                        status: 'live_devnet',
                        account: 'ExternalMarket',
                        oracleRecipe: COURT_RECIPE_ID,
                        proofMarket: '5wyJ7XjbnoPUaDgaHAttdhdS38VmHf1p3jGwwVUeN8QM'
                    }
                },
                support: {
                    programId: pledgeProgramId,
                    cluster: 'devnet',
                    subject: 'the agreement account (pledge-client.js names it `proposal`)',
                    mint: USDC_DEVNET_MINT,
                    status: `${base}/agent/pledges/{agreementAccount}`,
                    pdas: {
                        donationEscrow: 'seeds ["donation_escrow", agreementAccount]',
                        donationPosition: 'seeds ["donation", escrow, donor, sha256(operationId)]',
                        pledgeBook: 'seeds ["pledge_book", agreementAccount]',
                        pledge: 'seeds ["pledge", book, pledger]'
                    },
                    idl: 'blockchain/solana/idl/proposal_pledge.json',
                    client: 'frontend/js/solana/pledge-client.js',
                    donations: {
                        active: 'fund the USDC escrow immediately',
                        executed: 'release to the beneficiary the escrow fixed when it was created',
                        cancelledOrExpired: 'each donor refunds their own receipts',
                        idempotency: 'SHA-256 a stable operation id into an immutable donation-position PDA'
                    },
                    pledges: {
                        active: 'record or update an unfunded, revocable commitment',
                        executed: 'the pledger signs to fulfil it from their wallet',
                        cancelledOrExpired: 'void the commitment without moving funds'
                    }
                }
            });
        } catch (error) {
            console.error('Error building /docs/agents.json:', error);
            res.status(500).json({ error: 'Failed to load agent schema' });
        }
    });

    // GET /docs/api - API schema (OpenAPI compatible)
    app.get('/docs/api', (req, res) => {
        try {
            const apiSchemaPath = path.join(__dirname, 'api-schema.json');
            const apiSchema = JSON.parse(fs.readFileSync(apiSchemaPath, 'utf8'));

            // Set proper content type for OpenAPI
            res.setHeader('Content-Type', 'application/json');
            res.json(apiSchema);
        } catch (error) {
            console.error('Error reading API schema:', error);
            res.status(500).json({ error: 'Failed to load API schema' });
        }
    });

    // GET /docs/database - Database schema from information_schema
    app.get('/docs/database', async (req, res) => {
        try {
            const now = Date.now();

            // Check if we need to refresh the cache
            if (!cachedDatabaseSchema || !lastDatabaseRefresh ||
                (now - lastDatabaseRefresh) > DATABASE_CACHE_DURATION) {

                console.log('Refreshing database schema cache...');
                const freshSchema = await generateDatabaseSchema(pool);
                cachedDatabaseSchema = freshSchema;
                lastDatabaseRefresh = now;
            }

            res.json(cachedDatabaseSchema);
        } catch (error) {
            console.error('Error generating database schema:', error);

            // If we have a cached version, serve it
            if (cachedDatabaseSchema) {
                console.log('Serving cached database schema due to error');
                res.json(cachedDatabaseSchema);
            } else {
                res.status(500).json({ error: 'Failed to load database schema' });
            }
        }
    });
}

async function generateDatabaseSchema(pool) {
    const client = await pool.connect();

    try {
        // Get all tables in the public schema, excluding backup and temporary tables
        const tablesQuery = `
            SELECT 
                table_name,
                obj_description(c.oid) as table_comment
            FROM information_schema.tables t
            LEFT JOIN pg_class c ON c.relname = t.table_name
            WHERE table_schema = 'public'
            AND table_name NOT LIKE '%_bkp%'
            AND table_name NOT LIKE '%_tmp%'
            ORDER BY table_name;
        `;

        const tablesResult = await client.query(tablesQuery);

        const schema = {
            title: "Consensus Builder Database Schema",
            description: "Live database schema generated from information_schema (public schema only, excluding backup and temporary tables)",
            generated_at: new Date().toISOString(),
            database: describeDatabase().database,
            schema: 'public',
            excluded_patterns: ['_bkp', '_tmp'],
            tables: {}
        };

        // For each table, get column information
        for (const table of tablesResult.rows) {
            const tableName = table.table_name;
            const tableComment = table.table_comment;

            const columnsQuery = `
                SELECT 
                    column_name,
                    data_type,
                    is_nullable,
                    column_default,
                    character_maximum_length,
                    numeric_precision,
                    numeric_scale,
                    obj_description(pgc.oid, 'pg_class') as column_comment
                FROM information_schema.columns c
                LEFT JOIN pg_class pgc ON pgc.relname = c.table_name
                WHERE table_schema = 'public' 
                AND table_name = $1
                ORDER BY ordinal_position;
            `;

            const columnsResult = await client.query(columnsQuery, [tableName]);

            // Get constraints (primary keys, foreign keys, etc.)
            const constraintsQuery = `
                SELECT 
                    tc.constraint_name,
                    tc.constraint_type,
                    kcu.column_name,
                    ccu.table_name AS foreign_table_name,
                    ccu.column_name AS foreign_column_name
                FROM information_schema.table_constraints tc
                LEFT JOIN information_schema.key_column_usage kcu
                    ON tc.constraint_name = kcu.constraint_name
                LEFT JOIN information_schema.constraint_column_usage ccu
                    ON ccu.constraint_name = tc.constraint_name
                WHERE tc.table_schema = 'public' 
                AND tc.table_name = $1
                ORDER BY tc.constraint_type, kcu.ordinal_position;
            `;

            const constraintsResult = await client.query(constraintsQuery, [tableName]);

            // Get indexes
            const indexesQuery = `
                SELECT 
                    indexname,
                    indexdef
                FROM pg_indexes 
                WHERE schemaname = 'public' 
                AND tablename = $1
                ORDER BY indexname;
            `;

            const indexesResult = await client.query(indexesQuery, [tableName]);

            schema.tables[tableName] = {
                comment: tableComment,
                columns: {},
                constraints: {},
                indexes: {}
            };

            // Process columns
            for (const column of columnsResult.rows) {
                const columnInfo = {
                    type: column.data_type,
                    nullable: column.is_nullable === 'YES',
                    default: column.column_default,
                    comment: column.column_comment
                };

                // Add type-specific information
                if (column.character_maximum_length) {
                    columnInfo.max_length = column.character_maximum_length;
                }
                if (column.numeric_precision) {
                    columnInfo.precision = column.numeric_precision;
                }
                if (column.numeric_scale) {
                    columnInfo.scale = column.numeric_scale;
                }

                schema.tables[tableName].columns[column.column_name] = columnInfo;
            }

            // Process constraints
            for (const constraint of constraintsResult.rows) {
                const constraintType = constraint.constraint_type;
                const constraintName = constraint.constraint_name;

                if (!schema.tables[tableName].constraints[constraintType]) {
                    schema.tables[tableName].constraints[constraintType] = [];
                }

                const constraintInfo = {
                    name: constraintName,
                    column: constraint.column_name
                };

                if (constraintType === 'FOREIGN KEY') {
                    constraintInfo.references = {
                        table: constraint.foreign_table_name,
                        column: constraint.foreign_column_name
                    };
                }

                schema.tables[tableName].constraints[constraintType].push(constraintInfo);
            }

            // Process indexes
            for (const index of indexesResult.rows) {
                schema.tables[tableName].indexes[index.indexname] = {
                    definition: index.indexdef
                };
            }
        }

        return schema;

    } finally {
        client.release();
    }
}
