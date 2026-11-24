// Fresh public HTTP projection of the immutable dated-agreement LMSR recipe.
import {
    buildAgreementExecutionByDeadlineRecipe, canonicalAccount, externalRecipeProjection,
    observeAgreementRecipe, validateAgreementRecipeSource
} from '../oracle/lmsr-recipe.js';
import { createAgreementMarketSource } from '../markets/agreement-source.js';
import { createAgreementChain } from '../agreements/onchain.js';
import { DEVNET_USDC_MINT } from '../solana/address-book.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const lmsrClient = require('../../frontend/js/solana/lmsr-client.js').configure({ web3 });

const ROUTE = '/oracle/recipes/agreement-execution-by-deadline-v1';
const fail = (message, status) => Object.assign(new Error(message), { status });

export function setupLmsrRecipesRoute(app, pool, { env = process.env, readAgreement, readMarket, now = () => Date.now() } = {}) {
    const chain = createAgreementChain({ env });
    const read = readAgreement || createAgreementMarketSource(pool, { env, chain, allowUndated: true });
    const readChainMarket = readMarket || (async address => lmsrClient.readMarket(await chain.connection(), address));
    app.get(ROUTE, async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const account = req.query.agreement;
            if (!canonicalAccount(account)) throw fail('agreement must be a canonical account', 400);
            const address = req.query.market ?? null;
            if (address !== null && !canonicalAccount(address)) throw fail('market must be a canonical account', 400);
            const source = validateAgreementRecipeSource(await read(account), account, { allowUndated: !!address });
            const market = address ? await readChainMarket(address) : null;
            if (address && (!market || market.proposal !== account || market.stakeMint !== DEVNET_USDC_MINT ||
                ![0, 1].includes(market.kind) || (market.kind === 1 && market.trustedAttester !== source.insiders?.[1]))) {
                throw fail('market is not bound to this agreement', 400);
            }
            if (market?.kind === 1) return res.json(externalRecipeProjection(source, address, market));
            const current = now();
            const nowSeconds = current instanceof Date ? Math.floor(current.getTime() / 1000)
                : Number.isSafeInteger(current)
                    ? (Math.abs(current) < 100_000_000_000 ? current : Math.floor(current / 1000))
                    : NaN;
            if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw fail('Server clock is invalid', 503);
            const recipe = buildAgreementExecutionByDeadlineRecipe(source, address, market);
            const observation = observeAgreementRecipe(source, nowSeconds, recipe.market);
            return res.json({ recipe, observation });
        } catch (cause) {
            const status = cause.status || 503;
            const message = status < 500 ? cause.message : 'Agreement recipe evidence is unavailable';
            const code = message.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
            if (status >= 500) console.error(JSON.stringify({ at: new Date().toISOString(),
                route: ROUTE, code, name: cause.name || 'Error' }));
            return res.status(status).json({ error: code, message });
        }
    });
}
