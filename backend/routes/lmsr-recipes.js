// Fresh public HTTP projection of the immutable dated-agreement LMSR recipe.
import {
    buildAgreementExecutionByDeadlineRecipe, canonicalAccount, deriveAgreementMarketAddress,
    observeAgreementRecipe, validateAgreementRecipeSource
} from '../oracle/lmsr-recipe.js';
import { createAgreementMarketSource } from '../markets/agreement-source.js';

const ROUTE = '/oracle/recipes/agreement-execution-by-deadline-v1';
const fail = (message, status) => Object.assign(new Error(message), { status });

export function setupLmsrRecipesRoute(app, pool, { env = process.env, readAgreement, now = () => Date.now() } = {}) {
    const read = readAgreement || createAgreementMarketSource(pool, { env });
    app.get(ROUTE, async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const account = req.query.agreement;
            if (!canonicalAccount(account)) throw fail('agreement must be a canonical account', 400);
            const source = validateAgreementRecipeSource(await read(account), account);
            const canonicalMarket = deriveAgreementMarketAddress(source.account, source.sponsor);
            if (req.query.market !== undefined && req.query.market !== canonicalMarket) {
                throw fail('market does not match the canonical agreement LMSR PDA', 400);
            }
            const current = now();
            const nowSeconds = current instanceof Date ? Math.floor(current.getTime() / 1000)
                : Number.isSafeInteger(current)
                    ? (Math.abs(current) < 100_000_000_000 ? current : Math.floor(current / 1000))
                    : NaN;
            if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw fail('Server clock is invalid', 503);
            const recipe = buildAgreementExecutionByDeadlineRecipe(source, canonicalMarket);
            const observation = observeAgreementRecipe(source, nowSeconds);
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
