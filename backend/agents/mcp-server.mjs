#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { createUrbanGameTheoryTools } from './ugt-agent-tools.js';

const proposalAccount = z.string().min(32).describe('Solana ProposalNFT account address');
const amountUsdc = z.string().regex(/^\d+(\.\d{1,6})?$/).describe('Exact devnet USDC decimal string, for example "0.05"');
const confirmation = z.literal(true).describe('Explicitly authorize this paid or signed devnet action');
const pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).describe('base58 Solana public key');
const recipeHash = z.string().regex(/^(sha256:)?[0-9a-fA-F]{64}$/).describe('Committed 32-byte external-market recipe hash');

function jsonSafe(value) {
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
}

function success(value) {
    const result = jsonSafe(value);
    return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? result : { result }
    };
}

function handler(fn) {
    return async (args) => {
        try {
            return success(await fn(args));
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: error?.message || String(error) }] };
        }
    };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const PAID_IDEMPOTENT = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const PAID_NON_IDEMPOTENT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export function createUrbanGameTheoryMcpServer({ env = process.env, fetchImpl, tools } = {}) {
    const actions = tools || createUrbanGameTheoryTools({ env, fetchImpl });
    const server = new McpServer(
        { name: 'urban-game-theory', version: '0.1.0' },
        { instructions: 'Inspect capabilities first. Read tools are free. Paid and signed tools operate only on Solana devnet, require confirm=true, and are disabled unless UGT_MCP_LIVE=1.' }
    );

    server.registerTool('ugt_capabilities', {
        title: 'Inspect Urban Game Theory capabilities',
        description: 'Read the live machine manifest: x402 prices, endpoints, program IDs, recipes and support semantics.',
        inputSchema: z.object({}), annotations: READ_ONLY
    }, handler(() => actions.capabilities()));

    server.registerTool('ugt_list_proposals', {
        title: 'List land-change proposals',
        description: 'Find real-parcel proposals that an agent may inspect, support or forecast.',
        inputSchema: z.object({
            city: z.string().default('zagreb'),
            lifecycle: z.string().default('Active'),
            limit: z.number().int().min(1).max(100).default(20),
            author: z.string().optional()
        }), annotations: READ_ONLY
    }, handler(args => actions.listProposals(args)));

    server.registerTool('ugt_activity', {
        title: 'Read unified human and agent activity',
        description: 'Read the same activity stream used by the actor explorer for humans, algorithmic agents and LLM agents.',
        inputSchema: z.object({
            limit: z.number().int().min(1).max(250).default(100),
            actor: z.string().optional(), source: z.string().optional(), action: z.string().optional()
        }), annotations: READ_ONLY
    }, handler(args => actions.getActivity(args)));

    server.registerTool('ugt_support_status', {
        title: 'Read proposal support',
        description: 'Read on-chain donation escrow and soft-pledge totals for a proposal.',
        inputSchema: z.object({ proposalAccount }), annotations: READ_ONLY
    }, handler(args => actions.getSupport(args)));

    server.registerTool('ugt_oracle_events', {
        title: 'Read public land events',
        description: 'Read source-hashed proposal lifecycle events used by the resolution recipe.',
        inputSchema: z.object({ proposalAccount, limit: z.number().int().min(1).max(100).default(20) }), annotations: READ_ONLY
    }, handler(args => actions.getOracleEvents(args)));

    server.registerTool('ugt_list_attesters', {
        title: 'List lens members (attesters)',
        description: 'Read the attester directory: lens members with kind and coverage. Pick a proposal lens from it; the contract trusts only keys in a proposal\'s lens.',
        inputSchema: z.object({ kind: z.string().optional().describe('Only members of this kind, for example owner-consent') }),
        annotations: READ_ONLY
    }, handler(args => actions.listAttesters(args)));

    server.registerTool('ugt_request_ownership', {
        title: 'Request a parcel-ownership attestation',
        description: 'Ask a lens member service to attest this agent\'s key as an owner of a parcel: challenge, ed25519 signature with UGT_AGENT_KEYPAIR, POST /lens/ownership. Free when the member is in dry run or the fact is already attested; a priced member is paid over x402 only with UGT_MCP_LIVE=1 and confirm=true. Returns the attestation address and account hash.',
        inputSchema: z.object({
            serviceUrl: z.string().url().describe('Base URL of the lens member service, for example http://127.0.0.1:3095'),
            parcelUid: z.string().min(1).describe('Cadastral parcel id, for example HR-335550-1813/6'),
            confirm: z.boolean().optional().describe('Required (true) only when the member charges for the attestation')
        }),
        annotations: PAID_IDEMPOTENT
    }, handler(args => actions.requestOwnership(args)));

    server.registerTool('ugt_mint_proposal', {
        title: 'Mint a proposal with a chosen lens',
        description: 'Sign mint_and_fund on devnet with UGT_AGENT_KEYPAIR: the parcels (the site\'s binding; may be empty when a site is given), the site and its binding from POST /proposals/binding (they set site_hash and open_ground; open ground executes only through a lens member\'s executed verdict), the lens (lens member keys whose attestations decide this proposal; not only your own key), the image URI and the conditional flag.',
        inputSchema: z.object({
            parcelIds: z.array(z.string().min(1)).default([]),
            site: z.object({
                type: z.enum(['Polygon', 'MultiPolygon']),
                coordinates: z.array(z.any())
            }).optional().describe('The proposal site, GeoJSON EPSG:4326; required when parcelIds is empty'),
            binding: z.object({
                coverage: z.enum(['complete', 'partial', 'none', 'unknown'])
            }).passthrough().optional().describe('The server binding of the site (POST /proposals/binding); required with a site'),
            lens: z.array(pubkey).min(1).describe('Lens member keys, for example from ugt_list_attesters'),
            imageUri: z.string().default(''),
            isConditional: z.boolean().default(true),
            confirm: confirmation
        }),
        annotations: PAID_NON_IDEMPOTENT
    }, handler(args => actions.mintProposal(args)));

    server.registerTool('ugt_inspect_verified_fact', {
        title: 'Inspect a verified-fact payment',
        description: 'Fetch and decode the x402 challenge for a recipe-bound fact without paying.',
        inputSchema: z.object({ proposalAccount, marketAccount: z.string().optional() }), annotations: READ_ONLY
    }, handler(args => actions.inspectVerifiedFact(args)));

    server.registerTool('ugt_buy_verified_fact', {
        title: 'Buy a verified land-change fact',
        description: 'Pay the advertised x402 price in devnet USDC and return the recipe-bound fact plus settlement receipt.',
        inputSchema: z.object({ proposalAccount, marketAccount: z.string().optional(), confirm: confirmation }),
        annotations: PAID_NON_IDEMPOTENT
    }, handler(args => actions.buyVerifiedFact(args)));

    server.registerTool('ugt_submit_proposal', {
        title: 'Submit a paid land-change proposal',
        description: 'Pay x402 in devnet USDC and submit a proposal to the shared API. Retries use proposalId as the payment id.',
        inputSchema: z.object({
            proposal: z.object({
                proposalId: z.string().min(1),
                // Equal to the site's binding (POST /agent/binding answers it). Empty only
                // for a material proposal that carries a site; the server enforces the rest.
                cadastreParcelIds: z.array(z.string().min(1)).default([]),
                site: z.object({
                    type: z.enum(['Polygon', 'MultiPolygon']),
                    coordinates: z.array(z.any())
                }).passthrough().optional().describe('The ground the proposal occupies (GeoJSON, EPSG:4326)'),
                toleranceM: z.number().min(0).max(1).optional().describe('Linear intrusion tolerance in metres (default 0)'),
                city: z.string().optional(), type: z.string().optional(), name: z.string().optional(),
                description: z.string().optional(), offer: z.number().optional(), offerCurrency: z.string().optional(),
                lens: z.array(pubkey).optional().describe('The lens the proposal was minted with (ugt_mint_proposal)'),
                agent: z.object({ persona: z.string().optional(), rationale: z.string().optional(), run_id: z.string().optional() }).optional()
            }).passthrough().refine(p => p.cadastreParcelIds.length > 0 || !!p.site, {
                message: 'Declare cadastreParcelIds, or give a site for a proposal on ground with no cadastral parcel.',
                path: ['cadastreParcelIds']
            }),
            confirm: confirmation
        }), annotations: PAID_IDEMPOTENT
    }, handler(args => actions.submitProposal(args)));

    server.registerTool('ugt_pledge', {
        title: 'Pledge support',
        description: 'Sign an unfunded, revocable on-chain devnet-USDC commitment to a proposal.',
        inputSchema: z.object({ proposalAccount, amountUsdc, confirm: confirmation }), annotations: PAID_IDEMPOTENT
    }, handler(args => actions.pledge(args)));

    server.registerTool('ugt_donate', {
        title: 'Donate to a proposal',
        description: 'Move devnet USDC into the proposal escrow. operationId makes retries idempotent.',
        inputSchema: z.object({ proposalAccount, amountUsdc, operationId: z.string().min(1), confirm: confirmation }), annotations: PAID_IDEMPOTENT
    }, handler(args => actions.donate(args)));

    server.registerTool('ugt_forecast', {
        title: 'Forecast a proposal outcome',
        description: 'Create the proposal market if needed and stake devnet USDC on YES or NO.',
        inputSchema: z.object({ proposalAccount, side: z.enum(['yes', 'no']), amountUsdc, confirm: confirmation }),
        annotations: PAID_NON_IDEMPOTENT
    }, handler(args => actions.forecast(args)));

    server.registerTool('ugt_cancel_proposal', {
        title: 'Cancel an owned proposal',
        description: 'Cancel an active proposal as its on-chain owner. Safe retries read the terminal state first.',
        inputSchema: z.object({ proposalAccount, confirm: confirmation }), annotations: PAID_IDEMPOTENT
    }, handler(args => actions.cancel(args)));

    server.registerTool('ugt_accept_parcel', {
        title: 'Accept one parcel as its attested owner',
        description: 'Sign accept_with_attestations with UGT_AGENT_KEYPAIR as an owner a lens member has attested (ParcelOwnership-v1). member must be in the proposal\'s lens. Without ownershipAttestation the attestation is looked up on the member\'s service (serviceUrl from ugt_list_attesters, GET /lens/attestations); request one first with ugt_request_ownership. A repeat returns the existing acceptance record. The last owner of the last parcel executes the proposal.',
        inputSchema: z.object({
            proposalAccount,
            parcelId: z.string().min(1).describe('Cadastral parcel id in the proposal, for example HR-335550-1813/6'),
            member: pubkey.describe('Lens member key that attested the ownership'),
            ownershipAttestation: pubkey.optional().describe('SAS ParcelOwnership-v1 attestation address; looked up on the member service when absent'),
            payout: pubkey.optional().describe('Where this owner\'s share of escrowed SOL goes on distribution; absent = none'),
            confirm: confirmation
        }),
        annotations: PAID_IDEMPOTENT
    }, handler(args => actions.acceptParcel(args)));

    server.registerTool('ugt_submit_verdict', {
        title: 'Submit a lens member verdict',
        description: 'Permissionlessly submit a lens member\'s ProposalVerdict-v1 attestation with settle_with_verdict: "expired" sets the proposal Expired (its market resolves NO); "executed" only for proposals minted with verdict_may_execute. member must be in the proposal\'s lens. Returns record, the VerdictRecord PDA ["verdict", proposal, verdictAttestation] the settlement creates. Replays (no send) when that record already exists or the proposal already has that status.',
        inputSchema: z.object({
            proposalAccount,
            verdictAttestation: pubkey.describe('SAS ProposalVerdict-v1 attestation address'),
            member: pubkey.describe('Lens member key that signed the verdict'),
            confirm: confirmation
        }),
        annotations: PAID_IDEMPOTENT
    }, handler(args => actions.submitVerdict(args)));

    server.registerTool('ugt_refund_donation', {
        title: 'Refund a donation',
        description: 'Refund this wallet’s identified donation after proposal cancellation or expiry.',
        inputSchema: z.object({ proposalAccount, operationId: z.string().min(1), confirm: confirmation }),
        annotations: PAID_IDEMPOTENT
    }, handler(args => actions.refundDonation(args)));

    server.registerTool('ugt_void_pledge', {
        title: 'Void a terminal pledge',
        description: 'Permissionlessly void an active soft pledge after proposal cancellation or expiry.',
        inputSchema: z.object({ proposalAccount, pledger: z.string().min(32).optional(), confirm: confirmation }),
        annotations: PAID_IDEMPOTENT
    }, handler(args => actions.voidPledge(args)));

    server.registerTool('ugt_revoke_pledge', {
        title: 'Revoke an active pledge',
        description: 'Revoke this wallet’s unfunded soft pledge while the proposal remains active.',
        inputSchema: z.object({ proposalAccount, confirm: confirmation }), annotations: PAID_IDEMPOTENT
    }, handler(args => actions.revokePledge(args)));

    server.registerTool('ugt_release_donations', {
        title: 'Release executed-proposal donations',
        description: 'Permissionlessly release escrowed donations to the captured beneficiary after execution.',
        inputSchema: z.object({ proposalAccount, confirm: confirmation }), annotations: PAID_IDEMPOTENT
    }, handler(args => actions.releaseDonations(args)));

    server.registerTool('ugt_fulfill_pledge', {
        title: 'Fulfill an executed-proposal pledge',
        description: 'Transfer this wallet’s pledged devnet USDC to the captured beneficiary after execution.',
        inputSchema: z.object({ proposalAccount, confirm: confirmation }), annotations: PAID_IDEMPOTENT
    }, handler(args => actions.fulfillPledge(args)));

    server.registerTool('ugt_resolve_market', {
        title: 'Resolve a proposal market',
        description: 'Permissionlessly resolve a market from the proposal account’s terminal state.',
        inputSchema: z.object({ proposalAccount, confirm: confirmation }), annotations: PAID_IDEMPOTENT
    }, handler(args => actions.resolve(args)));

    server.registerTool('ugt_claim_market', {
        title: 'Claim market winnings',
        description: 'Claim this wallet’s winning position or empty-winning-pool refund.',
        inputSchema: z.object({ proposalAccount, side: z.enum(['yes', 'no']), confirm: confirmation }),
        annotations: PAID_IDEMPOTENT
    }, handler(args => actions.claim(args)));

    server.registerTool('ugt_resolve_external_market', {
        title: 'Resolve an external-evidence market',
        description: 'Permissionlessly submit a matching SAS attestation to a recipe-bound external market after close.',
        inputSchema: z.object({ recipeHash, attestation: z.string().min(32), confirm: confirmation }),
        annotations: PAID_IDEMPOTENT
    }, handler(args => actions.resolveExternal(args)));

    server.registerTool('ugt_claim_external_market', {
        title: 'Claim external-market winnings',
        description: 'Claim this wallet’s winning external-market position or empty-winning-pool refund.',
        inputSchema: z.object({ recipeHash, side: z.enum(['yes', 'no']), confirm: confirmation }),
        annotations: PAID_IDEMPOTENT
    }, handler(args => actions.claimExternal(args)));

    return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await import('dotenv/config');
    serveStdio(() => createUrbanGameTheoryMcpServer());
    console.error('Urban Game Theory MCP server running on stdio');
}
