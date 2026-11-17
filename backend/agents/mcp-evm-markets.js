import * as z from 'zod/v4';
export const evmMarketChain = z.enum(['31337', '84532', '11155111']);
export const evmAgreementKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const amount = z.string().regex(/^\d+(\.\d{1,6})?$/);
const identity = { chainId: evmMarketChain, agreementAccount: evmAgreementKey };
export function registerEvmMarketReadsAndFunding(server, { bettor, handler, readOnly, paid }) {
    server.registerTool('ugt_agreement_market', {
        description: 'Read an EVM agreement market directly from its chain: outcome, price, collateral balance and YES/NO positions. Public testnets require a configured market deployment.',
        inputSchema: z.object({ ...identity, wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() }), annotations: readOnly
    }, handler(args => bettor.inspect(args)));
    server.registerTool('ugt_quote_agreement_shares', {
        description: 'Quote an exact YES/NO share quantity against the EVM Gnosis LMSR maker. Returns atomic USDC; buys and sells do not sign.',
        inputSchema: z.object({ ...identity, side: z.enum(['yes', 'no']), shares: amount, action: z.enum(['buy', 'sell']).default('buy') }), annotations: readOnly
    }, handler(args => bettor.quote(args)));
    server.registerTool('ugt_open_agreement_market', {
        description: 'Open the canonical EVM market as its sponsor, approving only the required USDC seed. liquidityUsdc is b; maxFundingUsdc caps ceil(b ln 2). Local signing, confirmation and UGT_MCP_MAX_MARKET_SEED_USDC (default 3.5) apply.',
        inputSchema: z.object({ ...identity, liquidityUsdc: amount, maxFundingUsdc: amount, confirm: z.literal(true) }), annotations: paid
    }, handler(args => bettor.open(args)));
    server.registerTool('ugt_reclaim_market_seed', {
        description: 'Reclaim the EVM market maker residual as its sponsor after the agreement ends. Winning traders redeem separately; this does not take their collateral.',
        inputSchema: z.object({ ...identity, confirm: z.literal(true) }), annotations: paid
    }, handler(args => bettor.reclaim(args)));
}
