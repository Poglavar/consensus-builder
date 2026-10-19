// Paid, Bazaar-discoverable oracle reads for agents. Availability and structural integrity are
// checked before the x402 gate, so an agent is never charged for a missing or malformed fact.

import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { buildVerifiedProposalFact } from '../oracle/verified-fact.js';
import { EVENT_TYPE } from '../oracle/proposal-lifecycle.js';
import { readX402OracleConfig } from '../utils/x402-payment.js';
import { eventFromRow, validAddress } from './land-events.js';

export const AGENT_ORACLE_FACTS_PATH = '/agent/oracle/facts';

export const AGENT_ORACLE_FACTS_DISCOVERY = declareDiscoveryExtension({
    input: {
        subject: 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT',
        market: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB'
    },
    inputSchema: {
        type: 'object',
        properties: {
            subject: { type: 'string', description: 'Optional Solana ProposalNFT account to verify; omit for the latest verified fact.' },
            market: { type: 'string', description: 'Optional market account to bind into the returned recipe.' }
        },
        additionalProperties: false
    },
    output: {
        example: {
            fact: {
                eventType: EVENT_TYPE,
                subject: { type: 'proposal', id: 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT' },
                outcome: 'cancelled',
                observedAt: '2026-09-21T16:24:07.000Z'
            },
            recipe: { id: 'proposal-lifecycle-v1', hash: `sha256:${'0'.repeat(64)}` },
            verification: { status: 'verified', checks: { subjectMatches: true } }
        },
        schema: {
            type: 'object',
            required: ['fact', 'recipe', 'verification'],
            properties: {
                fact: { type: 'object' },
                recipe: { type: 'object' },
                verification: { type: 'object' }
            }
        }
    }
});

function facilitatorFor(config, env, supplied) {
    if (supplied) return supplied;
    return config.usesCdp
        ? createCdpFacilitatorClient({
            apiKeyId: env.CDP_API_KEY_ID,
            apiKeySecret: env.CDP_API_KEY_SECRET,
            baseUrl: config.facilitatorUrl
        })
        : new HTTPFacilitatorClient({ url: config.facilitatorUrl });
}

function publicResourceUrl(env) {
    const base = typeof env.PUBLIC_API_BASE_URL === 'string' ? env.PUBLIC_API_BASE_URL.trim().replace(/\/$/, '') : '';
    return base ? `${base}${AGENT_ORACLE_FACTS_PATH}` : null;
}

function parseFactQuery(req, res, next) {
    const proposalAccount = req.query.subject ? validAddress(req.query.subject) : null;
    const marketAccount = req.query.market ? validAddress(req.query.market) : null;
    if (req.query.subject && !proposalAccount) return res.status(400).json({ error: 'subject must be a Solana address' });
    if (req.query.market && !marketAccount) return res.status(400).json({ error: 'market must be a Solana address' });
    req.oracleFactQuery = { proposalAccount, marketAccount };
    next();
}

function loadVerifiedFact(pool) {
    return async (req, res, next) => {
        try {
            const { rows } = await pool.query(`
                SELECT event_id, event_type, subject_type, subject_id, outcome, source_url,
                       source_hash, source_observed_at, attester, transaction_signature,
                       evidence, created_at
                FROM consensus.land_event
                WHERE event_type = $1
                  AND ($2::text IS NULL OR subject_id = $2)
                ORDER BY source_observed_at DESC
                LIMIT 1
            `, [EVENT_TYPE, req.oracleFactQuery.proposalAccount]);
            if (!rows[0]) return res.status(404).json({ error: 'No verified terminal fact exists for this proposal.' });
            const proposalAccount = req.oracleFactQuery.proposalAccount || rows[0].subject_id;
            req.oracleFactBundle = buildVerifiedProposalFact({
                event: eventFromRow(rows[0]),
                proposalAccount,
                marketAccount: req.oracleFactQuery.marketAccount
            });
            next();
        } catch (error) {
            console.error('[agent-oracle-facts] fact preflight failed:', error);
            return res.status(503).json({ error: 'Verified oracle fact is temporarily unavailable.' });
        }
    };
}

export function setupAgentOracleFactsRoute(app, pool, { env = process.env, facilitatorClient } = {}) {
    const config = readX402OracleConfig(env);
    if (!config.enabled) {
        console.warn(`[agent-oracle-facts] x402 gate disabled — missing ${config.missing.join(', ')}; ` +
            `GET ${AGENT_ORACLE_FACTS_PATH} answers 503 until they are set`);
        app.get(AGENT_ORACLE_FACTS_PATH, (_req, res) => res.status(503).json({
            error: 'Paid oracle facts are not configured on this server.',
            missing: config.missing
        }));
        return { enabled: false, config };
    }

    const server = new x402ResourceServer(facilitatorFor(config, env, facilitatorClient))
        .register(config.network, new ExactSvmScheme());
    const routes = {
        [`GET ${AGENT_ORACLE_FACTS_PATH}`]: {
            ...(publicResourceUrl(env) ? { resource: publicResourceUrl(env) } : {}),
            accepts: {
                scheme: 'exact',
                network: config.network,
                payTo: config.payTo,
                price: config.priceOracleFact,
                extra: { paymentFlow: 'upfront' }
            },
            description: 'Return the latest or a subject-selected recipe-bound, source-hashed proposal lifecycle fact.',
            mimeType: 'application/json',
            serviceName: 'Urban Game Theory',
            tags: ['urban-planning', 'land', 'oracle', 'agents'],
            extensions: AGENT_ORACLE_FACTS_DISCOVERY,
            unpaidResponseBody: async () => ({
                contentType: 'application/json',
                body: {
                    error: 'Payment required. Pay the x402 challenge in the PAYMENT-REQUIRED header and retry.',
                    docs: '/docs/agents'
                }
            }),
            settlementFailedResponseBody: async (_context, failure) => ({
                contentType: 'application/json',
                body: {
                    error: failure.errorReason,
                    message: failure.errorMessage,
                    docs: '/docs/agents'
                }
            })
        }
    };
    const gate = paymentMiddleware(routes, server);

    app.get(
        AGENT_ORACLE_FACTS_PATH,
        parseFactQuery,
        loadVerifiedFact(pool),
        gate,
        (req, res) => res.json(req.oracleFactBundle)
    );
    return { enabled: true, config };
}

export { loadVerifiedFact, parseFactQuery, publicResourceUrl };
