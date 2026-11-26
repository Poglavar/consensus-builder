import { createRequire } from 'node:module';
import { canonicalBytes, cidOf } from '../cid.js';
import { pinBytes, ipfsGatewayUrl } from '../storage/pinning.js';
import { createUploadRateLimiter } from '../utils/upload-guards.js';
import { canonicalAccount } from '../oracle/lmsr-recipe.js';

const require = createRequire(import.meta.url);
const recipes = require('../../frontend/js/bets/external-recipe.js');

export function setupMarketRecipesRoute(app, { pin = pinBytes, fetchContent = fetch, gateway = ipfsGatewayUrl } = {}) {
    app.post('/markets/recipes', createUploadRateLimiter(), async (req, res) => {
        let prepared;
        try {
            const { proposal, trustedAttester, external } = req.body || {};
            if (![proposal, trustedAttester, external?.schema, external?.credential].every(canonicalAccount)) {
                throw new Error('The agreement, verifier, credential and schema must be Solana public keys.');
            }
            prepared = recipes.build({ proposal, trustedAttester, external });
        } catch (error) { return res.status(400).json({ error: error.message }); }
        try {
            const { cid } = await pin({ bytes: canonicalBytes(prepared.body), cid: prepared.cid, name: 'market-recipe-' + prepared.cid });
            if (cid !== prepared.cid) throw new Error('Published CID differs from the recipe.');
            return res.json({ cid });
        } catch (error) { return res.status(error.status || 502).json({ error: 'Could not publish the market recipe.' }); }
    });

    app.get('/markets/recipes/:cid', async (req, res) => {
        const { cid } = req.params;
        if (!/^bafkrei[a-z2-7]{52}$/.test(cid)) return res.status(400).json({ error: 'A raw market recipe CID is required.' });
        try {
            const response = await fetchContent(gateway(cid), { signal: AbortSignal.timeout(6500) });
            if (!response.ok) return res.status(response.status === 404 ? 404 : 502).json({ error: 'Market recipe is unavailable.' });
            const chunks = [];
            let size = 0;
            for await (const chunk of response.body) {
                size += chunk.length;
                if (size > recipes.MAX_BYTES) throw new Error('Oversized recipe');
                chunks.push(chunk);
            }
            const bytes = Buffer.concat(chunks);
            if (cidOf(bytes) !== cid) throw new Error('Incorrect content digest');
            const body = JSON.parse(bytes.toString('utf8'));
            if (!body.verification?.schema || !body.trustedAttesters?.length || !body.outcomes?.yes) throw new Error('Invalid market recipe');
            return res.set('Cache-Control', 'public, max-age=31536000, immutable').json(body);
        } catch { return res.status(502).json({ error: 'Market recipe could not be verified.' }); }
    });
}
