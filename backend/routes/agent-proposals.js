// Paid proposal submission for agents. POST /agent/proposals runs the very same create handler as
// the free POST /proposals, behind an x402 pay-to-post gate (exact scheme on Solana, devnet USDC).
// The flow is "upfront": the facilitator verifies AND settles the USDC transfer before the handler
// runs, so a stored row always carries a completed payment, and the verified payer — never anything
// in the body — becomes the record's author and agent.wallet. The free route is untouched: the
// app's own frontend uses it and must never see a 402.

import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import {
    PAYMENT_IDENTIFIER,
    declarePaymentIdentifierExtension,
    extractAndValidatePaymentIdentifier,
    paymentIdentifierResourceServerExtension
} from '@x402/extensions/payment-identifier';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { decodeTransactionFromPayload, getTokenPayerFromTransaction } from '@x402/svm';
import { readFileSync } from 'node:fs';
import { createProposalCreateHandler, proposalCreateBodyValidator } from './proposals.js';
import {
    buildAgentStamp,
    formatAtomicAmount,
    hashAgentProposalRequest,
    readX402Config
} from '../utils/x402-payment.js';

export const AGENT_PROPOSALS_PATH = '/agent/proposals';
export const AGENT_DOCS_PATH = '/docs/agents';

const recipeSchema = JSON.parse(readFileSync(new URL('./agent-recipe-schema.json', import.meta.url), 'utf8'));
// Bazaar embeds this below its own schema. Document-level identifiers are not input constraints,
// and external $id values are deliberately excluded by the discovery protocol.
const {
    $schema: _recipeDialect,
    $id: _recipeId,
    title: _recipeTitle,
    description: _recipeDescription,
    ...agentProposalInputSchema
} = recipeSchema;

export const AGENT_PROPOSALS_DISCOVERY = declareDiscoveryExtension({
    bodyType: 'json',
    input: {
        city: 'zagreb',
        cadastreParcelIds: ['HR-335550-1234/1'],
        type: 'parcel',
        name: 'Agent-proposed infill',
        description: 'Six-storey residential infill matching the neighbouring eaves.',
        offer: 1.5,
        offerCurrency: 'USDC',
        agent: {
            persona: 'densifier-01',
            controller: 'algorithm',
            rationale: 'The lot is underused and close to public transport.',
            run_id: '2026-09-20-densifier-01'
        }
    },
    inputSchema: agentProposalInputSchema,
    output: {
        example: {
            id: 1342,
            proposalId: 'agent-densifier-01-2026-09-20',
            createdAt: '2026-09-20T02:01:03.000Z',
            screenshotUrl: null
        },
        schema: {
            type: 'object',
            required: ['id', 'proposalId', 'createdAt', 'screenshotUrl'],
            properties: {
                id: { type: 'integer' },
                proposalId: { type: 'string' },
                createdAt: { type: 'string', description: 'ISO 8601 creation timestamp.' },
                screenshotUrl: { type: ['string', 'null'] }
            },
            additionalProperties: false
        }
    }
});

// x402 hooks receive the transport context, not the express request. The express adapter keeps the
// request it wraps, and that is the only bridge between "payment settled" and the route handler.
function expressRequestOf(context) {
    return context?.transportContext?.request?.adapter?.req ?? null;
}

async function findProposalByPaymentId(pool, paymentId) {
    const result = await pool.query(`
        SELECT
            id,
            proposal_id,
            created_at,
            screenshot_url,
            author,
            agent_request_hash,
            proposal_data #> '{agent,paid}' AS paid
        FROM proposal
        WHERE agent_payment_id = $1
        LIMIT 1
    `, [paymentId]);
    return result.rows[0] ?? null;
}

export function setupAgentProposalsRoute(app, pool, { env = process.env, facilitatorClient } = {}) {
    const config = readX402Config(env);
    if (!config.enabled) {
        console.warn(`[agent-proposals] x402 gate disabled — missing ${config.missing.join(', ')}; ` +
            `POST ${AGENT_PROPOSALS_PATH} answers 503 until they are set`);
        app.post(AGENT_PROPOSALS_PATH, (req, res) => {
            res.status(503).json({
                error: 'Paid agent submissions are not configured on this server.',
                missing: config.missing
            });
        });
        return { enabled: false, config };
    }

    const scheme = new ExactSvmScheme();
    const facilitator = facilitatorClient ?? (config.usesCdp
        ? createCdpFacilitatorClient({
            apiKeyId: env.CDP_API_KEY_ID,
            apiKeySecret: env.CDP_API_KEY_SECRET,
            baseUrl: config.facilitatorUrl
        })
        : new HTTPFacilitatorClient({ url: config.facilitatorUrl }));
    const server = new x402ResourceServer(facilitator)
        .register(config.network, scheme)
        .registerExtension(paymentIdentifierResourceServerExtension)
        // The upfront flow has no separate verify step: validity is established by settlement. So
        // the last moment to refuse for free is just before settling, and the only source for the
        // payer at that moment is the signed transaction the client sent. A body that names a
        // different author than the wallet paying is refused here, before any USDC moves, rather
        // than charged and then rejected. The settlement receipt remains the authority for the stamp.
        .onBeforeSettle(async (context) => {
            if (context.phase !== 'before-handler') return;
            const req = expressRequestOf(context);
            if (!req) {
                return { abort: true, reason: 'no_request_context', message: 'The payment could not be tied to a request.' };
            }
            let payer = '';
            try {
                payer = getTokenPayerFromTransaction(decodeTransactionFromPayload(context.paymentPayload.payload));
            } catch {
                payer = '';
            }
            if (!payer) {
                return { abort: true, reason: 'invalid_payment_payload', message: 'The payment transaction could not be decoded or names no token payer.' };
            }
            const claimed = req.body?.author;
            if (claimed != null && claimed !== '' && String(claimed) !== payer) {
                return { abort: true, reason: 'author_mismatch', message: `author must be the paying wallet ${payer}, or be omitted.` };
            }

            const { id: paymentId, validation } = extractAndValidatePaymentIdentifier(context.paymentPayload);
            if (!validation.valid) {
                return {
                    abort: true,
                    reason: 'invalid_payment_identifier',
                    message: validation.errors?.join(' ') || 'The payment identifier is invalid.'
                };
            }
            if (!paymentId) {
                return {
                    abort: true,
                    reason: 'payment_identifier_required',
                    message: 'The payment-identifier extension must contain a stable id.'
                };
            }

            const requestHash = hashAgentProposalRequest(req.body);
            let existing;
            try {
                existing = await findProposalByPaymentId(pool, paymentId);
            } catch (error) {
                console.error('[agent-proposals] payment identifier lookup failed:', error);
                return {
                    abort: true,
                    reason: 'idempotency_unavailable',
                    message: 'The payment identifier could not be checked; no payment was settled.'
                };
            }

            if (existing) {
                if (existing.author !== payer || existing.agent_request_hash !== requestHash) {
                    return {
                        abort: true,
                        reason: 'payment_identifier_conflict',
                        message: 'This payment identifier was already used by another wallet or for another request.'
                    };
                }
                const paid = existing.paid || {};
                if (!paid.tx) {
                    return {
                        abort: true,
                        reason: 'idempotency_record_incomplete',
                        message: 'The existing payment record has no settlement transaction; no payment was settled.'
                    };
                }
                req.x402Replay = {
                    id: existing.id,
                    proposalId: existing.proposal_id,
                    createdAt: existing.created_at,
                    screenshotUrl: existing.screenshot_url ?? null
                };
                req.x402PaymentId = paymentId;
                req.x402RequestHash = requestHash;
                req.x402PayerFromTransaction = payer;
                return {
                    skip: true,
                    result: {
                        success: true,
                        transaction: paid.tx,
                        network: paid.network || config.network,
                        payer
                    }
                };
            }

            req.x402PaymentId = paymentId;
            req.x402RequestHash = requestHash;
            req.x402PayerFromTransaction = payer;
        })
        // Settled before the handler (paymentFlow: upfront): stamp the receipt on the request so the
        // handler can persist who paid and with which transaction.
        .onAfterSettle(async (context) => {
            if (context.phase !== 'before-handler' || !context.result?.success) return;
            const req = expressRequestOf(context);
            if (!req) throw new Error('[agent-proposals] settlement hook has no express request to stamp');
            const amountAtomic = context.requirements?.amount ?? null;
            const asset = context.requirements?.asset ?? null;
            const decimals = asset ? scheme.getAssetDecimals(asset, config.network) : undefined;
            req.x402Payment = {
                id: req.x402PaymentId,
                requestHash: req.x402RequestHash,
                // The facilitator names the payer it settled for; the transaction's own token payer is
                // the same key and covers a facilitator that omits the field.
                payer: context.result.payer || req.x402PayerFromTransaction,
                transaction: context.result.transaction,
                network: context.result.network ?? config.network,
                asset,
                amountAtomic,
                amount: Number.isInteger(decimals) ? formatAtomicAmount(amountAtomic, decimals) : null
            };
        });

    const routes = {
        [`POST ${AGENT_PROPOSALS_PATH}`]: {
            accepts: {
                scheme: 'exact',
                network: config.network,
                payTo: config.payTo,
                price: config.priceProposal,
                // Settle before the handler: the row is written only after the USDC moved, and the
                // settlement signature is stored on it. The cost of the choice: a request that fails
                // inside the handler after settlement has still paid.
                extra: { paymentFlow: 'upfront' }
            },
            description: 'Store one proposal on Urban Game Theory (paid, per submission).',
            mimeType: 'application/json',
            serviceName: 'Urban Game Theory',
            tags: ['urban-planning', 'land', 'proposals', 'agents'],
            extensions: {
                ...AGENT_PROPOSALS_DISCOVERY,
                [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true)
            },
            unpaidResponseBody: async () => ({
                contentType: 'application/json',
                body: {
                    error: 'Payment required. Pay the x402 challenge in the PAYMENT-REQUIRED header and retry.',
                    docs: AGENT_DOCS_PATH
                }
            }),
            // A refusal from the hooks above (or a failed settlement) travels in the PAYMENT-RESPONSE
            // header; the default body is `{}`, which tells an agent nothing. Say why in the body too.
            settlementFailedResponseBody: async (context, failure) => ({
                contentType: 'application/json',
                body: {
                    error: failure.errorReason,
                    message: failure.errorMessage,
                    docs: AGENT_DOCS_PATH
                }
            })
        }
    };
    const gate = paymentMiddleware(routes, server);

    const bindPaidAuthor = (req, res, next) => {
        const paid = req.x402Payment;
        if (!paid?.payer || !paid.transaction) {
            // Fail closed: reaching this point without a settlement stamp means the gate did not run.
            return res.status(402).json({ error: 'Payment was not settled for this request.' });
        }
        req.body.agent = buildAgentStamp(req.body.agent, paid);
        req.body.author = paid.payer;
        req.validatedBody.author = paid.payer;
        next();
    };

    const returnIdempotentReplay = (req, res, next) => {
        if (!req.x402Replay) return next();
        return res.status(201).json(req.x402Replay);
    };

    // Validation runs BEFORE the gate so a malformed body is refused for free (400); the payer is
    // bound AFTER it because only settlement knows who paid.
    app.post(
        AGENT_PROPOSALS_PATH,
        proposalCreateBodyValidator,
        gate,
        bindPaidAuthor,
        returnIdempotentReplay,
        createProposalCreateHandler(pool)
    );
    return { enabled: true, config };
}
