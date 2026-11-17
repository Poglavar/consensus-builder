// EVM market access for local MCP and agent controllers; browser and bots share the exact codec.
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { evmProvider, loadAddressBook } from '../chain/evm.js';
const require = createRequire(import.meta.url);
const Markets = require('../../frontend/js/chain/evm-markets.js');
const error = (code, message) => { throw Object.assign(new Error(message), { code }); };
export function marketAdapter(chainId, { env = process.env, signing = false, provider, addressBook = loadAddressBook() } = {}) {
    const connected = provider || evmProvider(chainId, { env });
    let signer;
    if (signing) {
        if (!env.UGT_AGENT_EVM_PRIVATE_KEY) error('no-evm-key', 'Set UGT_AGENT_EVM_PRIVATE_KEY for local EVM signing.');
        try { signer = new ethers.Wallet(env.UGT_AGENT_EVM_PRIVATE_KEY, connected); }
        catch (_) { error('invalid-evm-key', 'The EVM signing key is invalid.'); }
    }
    return Markets.create({ ethers, provider: connected, signer, chainId, addresses: addressBook[String(Number(chainId))] });
}
export function createEvmBettor({ env = process.env, adapter = marketAdapter } = {}) {
    const read = chainId => adapter(chainId, { env });
    const write = (chainId, confirm) => {
        if (!/^(1|true)$/i.test(String(env.UGT_MCP_LIVE || '')) || confirm !== true) error('live-disabled', 'Local signing requires UGT_MCP_LIVE=1 and confirm=true.');
        return adapter(chainId, { env, signing: true });
    };
    const units = value => {
        if (typeof value !== 'string' || !/^\d+(\.\d{1,6})?$/.test(value)) error('invalid-amount', 'Use a positive decimal string with up to six places.');
        return Markets.atomic(ethers.parseUnits(value, 6));
    };
    const capped = (value, cap) => { const n = units(value); if (n > units(cap)) error('spend-cap', 'The amount exceeds the configured per-action cap.'); return n; };
    return {
        inspect: ({ chainId, agreementAccount, wallet }) => read(chainId).read(agreementAccount, wallet),
        quote: ({ chainId, agreementAccount, side, shares, action = 'buy' }) => read(chainId).quote({ key: agreementAccount, side, shares: units(shares), action }),
        async buy({ chainId, agreementAccount, side, amountUsdc, confirm }) {
            const client = write(chainId, confirm);
            const budget = capped(amountUsdc, env.UGT_MCP_MAX_USDC_PER_ACTION || '0.25');
            const quote = await client.quoteBudget({ key: agreementAccount, side, budget });
            return client.trade({ key: agreementAccount, side, action: 'buy', shares: quote.shares, limit: budget });
        },
        async sell({ chainId, agreementAccount, side, shares, minReturnUsdc, confirm }) {
            const client = write(chainId, confirm), quantity = units(shares);
            const quote = await client.quote({ key: agreementAccount, side, shares: quantity, action: 'sell' });
            return client.trade({ key: agreementAccount, side, action: 'sell', shares: quantity,
                limit: minReturnUsdc === undefined ? quote.amountAtomic : units(minReturnUsdc) });
        },
        open: ({ chainId, agreementAccount, liquidityUsdc, maxFundingUsdc, confirm }) => write(chainId, confirm).open({
            key: agreementAccount, liquidity: units(liquidityUsdc),
            maxFunding: capped(maxFundingUsdc, env.UGT_MCP_MAX_MARKET_SEED_USDC || '3.5') }),
        resolve: ({ chainId, agreementAccount, confirm }) => write(chainId, confirm).resolve({ key: agreementAccount }),
        claim: ({ chainId, agreementAccount, side, confirm }) => write(chainId, confirm).claim({ key: agreementAccount, side }),
        reclaim: ({ chainId, agreementAccount, confirm }) => write(chainId, confirm).reclaim({ key: agreementAccount })
    };
}
