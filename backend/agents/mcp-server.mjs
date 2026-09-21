#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { createUrbanGameTheoryTools } from './ugt-agent-tools.js';

const proposalAccount = z.string().min(32).describe('Solana ProposalNFT account address');
const amountUsdc = z.string().regex(/^\d+(\.\d{1,6})?$/).describe('Exact devnet USDC decimal string, for example "0.05"');
const confirmation = z.literal(true).describe('Explicitly authorize this paid or signed devnet action');

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
                cadastreParcelIds: z.array(z.string().min(1)).min(1),
                city: z.string().optional(), type: z.string().optional(), name: z.string().optional(),
                description: z.string().optional(), offer: z.number().optional(), offerCurrency: z.string().optional(),
                agent: z.object({ persona: z.string().optional(), rationale: z.string().optional(), run_id: z.string().optional() }).optional()
            }).passthrough(),
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

    return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await import('dotenv/config');
    serveStdio(() => createUrbanGameTheoryMcpServer());
    console.error('Urban Game Theory MCP server running on stdio');
}
