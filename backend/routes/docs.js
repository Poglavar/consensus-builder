import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import { readX402Config, readX402OracleConfig } from '../utils/x402-payment.js';
import { EVENT_TYPE as LAND_EVENT_TYPE, RECIPE_ID as LAND_RECIPE_ID, RECIPE_V2_ID as LAND_RECIPE_V2_ID } from '../oracle/proposal-lifecycle.js';
import { COURT_RECIPE_ID, COURT_RECIPE_V2_ID, COURT_SCHEMA_V2 } from '../oracle/court-parcel-operation.js';
import { classifyExternalMarketChronology } from '../oracle/external-market-chronology.js';
import { PROSPECTIVE_MARKET } from '../oracle/prospective-market-public.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    const solanaProgramId = (name) => {
        try {
            const addresses = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/contracts/addresses.json'), 'utf8'));
            return addresses['solana-devnet']?.[name] || '(unknown)';
        } catch {
            return '(unknown)';
        }
    };
    const marketProgramId = () => solanaProgramId('ProposalMarket');
    const pledgeProgramId = () => solanaProgramId('ProposalPledge');
    const proposalProgramId = () => solanaProgramId('ProposalNFT');
    const parcelProgramId = () => solanaProgramId('ParcelNFT');

    // GET /docs/agents - the agent quickstart: how to pay for and post a proposal over x402.
    app.get('/docs/agents', (req, res) => {
        try {
            const x402 = readX402Config(env);
            const oracleX402 = readX402OracleConfig(env);
            const markdown = fs.readFileSync(path.join(__dirname, 'docs-agents.md'), 'utf8')
                .replace(/\$\(base\)/g, docsBaseUrl(req))
                .replace(/\$\(price\)/g, x402.priceProposal || '(price not configured on this server)')
                .replace(/\$\(oraclePrice\)/g, oracleX402.priceOracleFact || '(price not configured on this server)')
                .replace(/\$\(network\)/g, x402.network || 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')
                .replace(/\$\(marketProgram\)/g, marketProgramId())
                .replace(/\$\(pledgeProgram\)/g, pledgeProgramId())
                .replace(/\$\(proposalProgram\)/g, proposalProgramId())
                .replace(/\$\(parcelProgram\)/g, parcelProgramId())
                .replace(/\$\(date\)/g, new Date().toLocaleDateString());
            res.setHeader('Content-Type', 'text/html');
            res.send(renderDocPage(marked(markdown), 'Agent quickstart — Urban Game Theory'));
        } catch (error) {
            console.error('Error reading docs-agents.md:', error);
            res.status(500).json({ error: 'Failed to load agent documentation' });
        }
    });

    // GET /docs/agents.json - the minimal recipe as JSON Schema plus the live payment terms.
    app.get('/docs/agents.json', (req, res) => {
        try {
            const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-recipe-schema.json'), 'utf8'));
            const x402 = readX402Config(env);
            const oracleX402 = readX402OracleConfig(env);
            const base = docsBaseUrl(req);
            // Live payment terms: never served from a cache (also reached as /agents.json, and through
            // the main site's nginx proxy, which passes this header on).
            res.set('Cache-Control', 'no-store');
            res.json({
                docs: `${base}/docs/agents`,
                schema,
                x402: {
                    enabled: x402.enabled,
                    network: x402.network,
                    facilitatorUrl: x402.facilitatorUrl,
                    payTo: x402.payTo,
                    priceProposal: x402.priceProposal,
                    oracleFactsEnabled: oracleX402.enabled,
                    priceOracleFact: oracleX402.priceOracleFact,
                    paymentFlow: 'upfront',
                    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
                },
                endpoints: {
                    submit: `${base}/agent/proposals`,
                    discovery: `${base}/agent/discovery`,
                    oracleFactDiscovery: `${base}/agent/discovery?resource=oracle-facts`,
                    oracleFactLatest: `${base}/agent/oracle/facts`,
                    oracleFact: `${base}/agent/oracle/facts?subject={proposalAccount}&market={marketAccount}`,
                    read: `${base}/proposals/{id}`,
                    listByAuthor: `${base}/proposals/summary?city={city}&author={wallet}`,
                    listByParcel: `${base}/proposals?parcel_id={cadastreParcelId}`,
                    parcelHistory: `${base}/parcels/{parcelUid}/history`,
                    parcelsUnder: `${base}/parcels/under`,
                    proposalBinding: `${base}/agent/binding`,
                    urbanRules: `${base}/urban-rules?coordinates={lng},{lat}`,
                    buildingFootprints: `${base}/buildings/footprints`,
                    hackathonProof: `${base}/hackathon/proof.json`,
                    prospectiveMarketStatus: `${base}/oracle/markets/prospective/status`,
                    // Every contest in a city (proposals on the same land) with each proposal's yes/no pool.
                    markets: `${base}/markets?city={city}`,
                    lensMembers: `${base}/lenses/members`,
                    agentLensMembers: `${base}/agent/lenses/members`,
                    lensSchemas: `${base}/lenses/schemas`
                },
                // Lens model (lens-model.md): the proposer's chosen list of attesters.
                lens: {
                    recipeField: 'lens',
                    mintArgument: 'lens: vec<pubkey>',
                    rule: 'at least one base58 public key; immutable once minted (fork the proposal to change it)',
                    members: `${base}/agent/lenses/members`,
                    memberFields: ['key', 'kind', 'name', 'description', 'serviceUrl', 'coverage'],
                    memberKinds: ['owner-consent', 'court', 'permit', 'imagery', 'osm', 'lifecycle'],
                    kindMeaning: 'what the member attests, not who it is',
                    schemas: `${base}/lenses/schemas`,
                    attestations: ['ParcelOwnership-v1', 'ProposalVerdict-v1'],
                    ownerAcceptance: 'the parcel owner signs accept_with_attestations with an optional payout key; a signature, not an attestation'
                },
                mcp: {
                    transport: 'stdio',
                    source: 'backend/agents/mcp-server.mjs',
                    command: 'cd backend && npm run mcp',
                    liveActionsEnabledByDefault: false,
                    liveGuard: 'UGT_MCP_LIVE=1 plus confirm=true; all writes use Solana devnet',
                    tools: [
                        'ugt_capabilities', 'ugt_list_proposals', 'ugt_activity', 'ugt_support_status',
                        'ugt_oracle_events', 'ugt_list_attesters', 'ugt_request_ownership',
                        'ugt_mint_proposal', 'ugt_inspect_verified_fact', 'ugt_buy_verified_fact',
                        'ugt_submit_proposal', 'ugt_pledge', 'ugt_donate', 'ugt_forecast',
                        'ugt_cancel_proposal', 'ugt_accept_parcel', 'ugt_submit_verdict', 'ugt_refund_donation',
                        'ugt_void_pledge', 'ugt_revoke_pledge', 'ugt_release_donations',
                        'ugt_fulfill_pledge',
                        'ugt_resolve_market', 'ugt_claim_market',
                        'ugt_resolve_external_market', 'ugt_claim_external_market'
                    ],
                    sharedAdapters: [
                        'x402 proposal client', 'x402 verified-fact client',
                        'proposal pledge client', 'proposal donation client', 'proposal market client'
                    ]
                },
                oracle: {
                    eventType: LAND_EVENT_TYPE,
                    schema: `${base}/oracle/recipe.schema.json`,
                    events: `${base}/oracle/events?subject={proposalAccount}`,
                    // Lens model v2 evidence log, pending devnet deployment: empty until the v2
                    // proposal_nft program is live. Event times are the on-chain accepted_at / settled_at.
                    eventTypes: {
                        proposal_lifecycle: 'terminal proposal state: executed, cancelled or expired (default of ?type=)',
                        proposal_acceptance: 'one per AcceptanceRecord: parcelUid, owner, member, ownership attestation and its sha256 (v2, pending devnet deployment)',
                        proposal_verdict: 'one per VerdictSettled: verdict attestation, its sha256, member, executed or expired (v2, pending devnet deployment)'
                    },
                    eventsByType: `${base}/oracle/events?type={eventType}&subject={proposalAccount}`,
                    eventsByParcel: `${base}/oracle/events?type={eventType}&parcelUid={parcelUid}`,
                    // Permanent per-parcel log: proposals, lens ownership attestations and land events,
                    // oldest first by each source's own time (null and last when the source has none).
                    parcelHistory: {
                        url: `${base}/parcels/{parcelUid}/history`,
                        response: '{ parcelUid, anchor: { account, exists, mintedAt?, source }, events: [{ type, at, proposalId?, proposalAccount?, member?, owner?, transaction?, hash?, link }] }',
                        eventTypes: ['proposal_created', 'proposal_published', 'parcel_ownership', 'proposal_acceptance', 'proposal_verdict', 'proposal_lifecycle'],
                        anchor: 'parcel_nft PDA ["parcel", parcelUid]; an identity only, it carries no ownership',
                        privacy: 'ownership attestations expose member, owner wallet, ownerCount and the account hash; never the evidence reference',
                        caching: 'no-store'
                    },
                    recipeId: LAND_RECIPE_ID,
                    recipe: `${base}/oracle/recipes/${LAND_RECIPE_ID}?proposal={proposalAccount}&market={marketAccount}`,
                    // Precommitted recipes never change under their id: v1 stays byte-identical, v2 adds the lens.
                    recipes: [
                        {
                            id: LAND_RECIPE_ID,
                            url: `${base}/oracle/recipes/${LAND_RECIPE_ID}?proposal={proposalAccount}&market={marketAccount}`,
                            trustedAttesters: 'the ProposalNFT program only',
                            outcomes: { executed: 'YES', cancelled: 'NO' },
                            use: 'proposals whose account carries no lens key'
                        },
                        {
                            id: LAND_RECIPE_V2_ID,
                            url: `${base}/oracle/recipes/${LAND_RECIPE_V2_ID}?proposal={proposalAccount}&market={marketAccount}`,
                            trustedAttesters: 'the ProposalNFT program plus every key in the proposal\'s on-chain lens (read from the account)',
                            outcomes: { executed: 'YES', cancelled: 'NO', expired: 'NO' },
                            use: 'every proposal whose account carries a lens with at least one key (all proposals minted from now on)'
                        }
                    ],
                    source: 'Solana proposal account plus its terminal transaction',
                    attester: solanaProgramId('ProposalNFT'),
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
                    programId: marketProgramId(),
                    cluster: 'devnet',
                    resolution: {
                        yes: 'proposal account status is Executed',
                        no: 'proposal account status is Cancelled',
                        permissionless: true,
                        deadline: null,
                        expired: 'not terminal in the deployed (v1) market program; the proposal must be cancelled or executed on-chain. v2, pending devnet deployment: resolve maps Expired (status 3, set by settle_with_verdict) to NO',
                        oracleRecipe: LAND_RECIPE_ID
                    },
                    idl: 'blockchain/solana/idl/proposal_market.json',
                    client: 'frontend/js/solana/market-client.js',
                    externalResolution: {
                        status: 'live_devnet',
                        account: 'ExternalMarket',
                        oracleRecipe: COURT_RECIPE_ID,
                        proofMarket: '5wyJ7XjbnoPUaDgaHAttdhdS38VmHf1p3jGwwVUeN8QM'
                    }
                },
                // Mint first: markets, pledges, acceptance and the lifecycle oracle all key on the
                // proposal account, and the paid record names it in `onchain` (docs-agents.md, step 3).
                proposalAccount: {
                    programId: proposalProgramId(),
                    cluster: 'devnet',
                    // v3 interface (parcel-optional, PARCEL-OPTIONAL.md "Chain (phase 5)"), pending devnet
                    // deployment. The devnet program is still v1 until the upgrade.
                    interfaceVersion: 'v3, pending devnet deployment',
                    mint: {
                        instruction: 'mint_and_fund',
                        args: ['parcel_ids: vec<string>', 'is_conditional: bool', 'image_uri: string', 'sol_amount: u64', 'lens: vec<pubkey>', 'verdict_may_execute: bool', 'site_hash: [u8; 32]', 'open_ground: bool'],
                        accounts: ['proposal', 'proposal_counter', 'owner', 'system_program'],
                        signer: 'owner: your own wallet; it pays rent for the 4096-byte proposal account',
                        parcelIds: 'the same strings as the record\'s cadastreParcelIds (the site\'s binding); may be empty only with a site_hash, and then open_ground must be true',
                        siteHash: 'sha256 of the canonical site encoding (frontend/js/proposals/site-hash.js); 32 zero bytes when the proposal has no site',
                        openGround: 'true when part of the site lies on no bound parcel (binding coverage not complete, or no parcels); needs a site_hash. Such a proposal also needs a lens member\'s executed verdict to execute',
                        lens: 'must be non-empty; the attesters whose ownership and verdict attestations this proposal accepts',
                        verdictMayExecute: 'true lets a lens member\'s executed verdict count: without parcels it executes the proposal, with parcels and open ground it clears the open ground (owners still consent), with parcels and no open ground it executes without per-parcel consent (permit-style evidence). Set it exactly when open_ground is true unless you mean permit-style evidence',
                        v1: 'the devnet program until the upgrade takes the same args without the trailing verdict_may_execute, site_hash and open_ground',
                        counterPda: 'seeds ["proposal_counter"]',
                        proposalPda: 'seeds ["proposal", count as 8-byte little-endian u64], count read at byte offset 8 of the counter account'
                    },
                    accept: {
                        instruction: 'accept_with_attestations',
                        args: ['parcel_id: string', 'payout: option<pubkey>'],
                        accounts: ['proposal', 'parcel', 'ownership', 'ownership_credential', 'tally', 'record', 'owner', 'payer', 'system_program'],
                        signer: 'owner: the wallet a lens member attested as the parcel owner (ParcelOwnership-v1); payer may be the owner',
                        tallyPda: 'seeds ["consent", proposal, parcel_id] (ConsentTally)',
                        recordPda: 'seeds ["acceptance", proposal, parcel_id, owner] (AcceptanceRecord)',
                        effect: 'a parcel is accepted when every owner its member attested has signed; the proposal is Executed when every parcel is',
                        status: 'v2, pending devnet deployment; replaces accept_proposal'
                    },
                    settle: {
                        instruction: 'settle_with_verdict',
                        args: [],
                        accounts: ['proposal', 'verdict', 'verdict_credential', 'verdict_record', 'submitter', 'system_program'],
                        signer: 'submitter: anyone (signer, writable: pays the verdict record\'s rent); the verdict (ProposalVerdict-v1) must be signed by a lens member',
                        verdictRecordPda: 'seeds ["verdict", proposal, verdict_attestation] (VerdictRecord { proposal, member, verdict_attestation, verdict_hash, verdict, settled_at, bump }); init, so one attestation settles at most once',
                        effect: 'expired sets Expired (3); executed needs verdict_may_execute and sets Executed (1), except on a proposal with parcels and open ground, where it clears the open ground and the proposal executes once every parcel is accepted',
                        event: 'VerdictSettled { proposal, verdict_attestation, verdict_hash, member, status (after settlement), settled_at, verdict (1 executed, 3 expired) }',
                        status: 'v3, pending devnet deployment'
                    },
                    recordLink: {
                        field: 'onchain',
                        proposalId: 'the proposal PDA, base58',
                        transactionHash: 'the mint_and_fund signature',
                        chainId: 'solana-devnet',
                        contractAddress: proposalProgramId()
                    },
                    idl: 'blockchain/solana/idl/proposal_nft.json',
                    client: 'backend/agents/minter.js'
                },
                parcelAccount: {
                    programId: parcelProgramId(),
                    cluster: 'devnet',
                    role: 'parcel anchor: the on-chain identity of a cadastral parcel; v2 (pending devnet deployment) mints it ownerless (owner = default key, the second account is the payer) and ownership reaches the chain only as a lens member\'s ParcelOwnership-v1 attestation',
                    mint: { instruction: 'mint_parcel', args: ['parcel_id: string', 'metadata_uri: string'], accounts: ['parcel', 'payer', 'system_program'] },
                    pda: 'seeds ["parcel", parcel id as UTF-8 bytes]',
                    idl: 'blockchain/solana/idl/parcel_nft.json'
                },
                proposalSupport: {
                    programId: pledgeProgramId(),
                    cluster: 'devnet',
                    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
                    status: `${base}/agent/pledges/{proposalAccount}`,
                    idl: 'blockchain/solana/idl/proposal_pledge.json',
                    client: 'frontend/js/solana/pledge-client.js',
                    donations: {
                        active: 'fund USDC escrow immediately',
                        executed: 'release to the proposal owner',
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
            database: process.env.PGDATABASE,
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
