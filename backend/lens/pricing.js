// x402 pricing for the reference lens member's POST /lens/ownership, built the same way as the
// other paid agent routes (routes/agent-oracle-facts.js): exact scheme on Solana, upfront settlement,
// network/facilitator/payee from the shared X402_* env, price from LENS_OWNERSHIP_PRICE_USDC
// (default 0.01). A dry run disables pricing and says so; a live member with incomplete config
// fails closed (503) rather than issuing for free.

import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { CDP_CREDENTIAL_ENV_NAMES, isCdpFacilitatorUrl } from '../utils/x402-payment.js';

export const LENS_OWNERSHIP_PATH = '/lens/ownership';
export const DEFAULT_OWNERSHIP_PRICE_USDC = '0.01';
const REQUIRED_ENV = ['X402_NETWORK', 'X402_FACILITATOR_URL', 'X402_PAY_TO'];

export function readLensPricingConfig(env = process.env) {
    const missing = [];
    const value = name => {
        const raw = typeof env[name] === 'string' ? env[name].trim() : '';
        return raw || null;
    };
    for (const name of REQUIRED_ENV) if (!value(name)) missing.push(name);
    const usesCdp = isCdpFacilitatorUrl(value('X402_FACILITATOR_URL'));
    if (usesCdp) for (const name of CDP_CREDENTIAL_ENV_NAMES) if (!value(name)) missing.push(name);
    const priceUsdc = value('LENS_OWNERSHIP_PRICE_USDC') ?? DEFAULT_OWNERSHIP_PRICE_USDC;
    if (!/^\d+(\.\d{1,6})?$/.test(priceUsdc) || Number(priceUsdc) <= 0) {
        throw new Error(`LENS_OWNERSHIP_PRICE_USDC must be a positive USDC amount with at most 6 decimals, got "${priceUsdc}"`);
    }
    return {
        enabled: missing.length === 0,
        missing,
        network: value('X402_NETWORK'),
        facilitatorUrl: value('X402_FACILITATOR_URL'),
        usesCdp,
        payTo: value('X402_PAY_TO'),
        priceUsdc,
        price: `$${priceUsdc}`
    };
}

function expressRequestOf(context) {
    return context?.transportContext?.request?.adapter?.req ?? null;
}

/**
 * @returns {{ mode: 'dry-run'|'x402'|'unconfigured', enabled: boolean, reason?: string, price?: string,
 *   network?: string, payTo?: string, missing?: string[], gate?: import('express').RequestHandler }}
 */
export function createLensPricing({ dryRun, env = process.env, facilitatorClient } = {}) {
    if (dryRun) return { mode: 'dry-run', enabled: false, reason: 'dry run: x402 pricing is disabled and ownership attestations are free' };
    const config = readLensPricingConfig(env);
    if (!config.enabled) {
        return { mode: 'unconfigured', enabled: false, missing: config.missing, reason: `x402 not configured, missing ${config.missing.join(', ')}` };
    }
    const facilitator = facilitatorClient ?? (config.usesCdp
        ? createCdpFacilitatorClient({ apiKeyId: env.CDP_API_KEY_ID, apiKeySecret: env.CDP_API_KEY_SECRET, baseUrl: config.facilitatorUrl })
        : new HTTPFacilitatorClient({ url: config.facilitatorUrl }));
    const server = new x402ResourceServer(facilitator)
        .register(config.network, new ExactSvmScheme())
        .onAfterSettle(async (context) => {
            if (context.phase !== 'before-handler' || !context.result?.success) return;
            const req = expressRequestOf(context);
            if (!req) throw new Error('[lens-member] settlement hook has no express request to stamp');
            req.lensPayment = {
                payer: context.result.payer ?? null,
                transaction: context.result.transaction,
                network: context.result.network ?? config.network,
                asset: context.requirements?.asset ?? null,
                amountAtomic: context.requirements?.amount ?? null
            };
        });
    const gate = paymentMiddleware({
        [`POST ${LENS_OWNERSHIP_PATH}`]: {
            accepts: {
                scheme: 'exact',
                network: config.network,
                payTo: config.payTo,
                price: config.price,
                extra: { paymentFlow: 'upfront' }
            },
            description: 'Issue one ParcelOwnership-v1 SAS attestation for a verified parcel owner wallet.',
            mimeType: 'application/json',
            serviceName: 'Urban Game Theory lens member',
            tags: ['land', 'attestation', 'lens', 'agents'],
            unpaidResponseBody: async () => ({
                contentType: 'application/json',
                body: { error: 'Payment required. Pay the x402 challenge in the PAYMENT-REQUIRED header and retry.' }
            }),
            settlementFailedResponseBody: async (_context, failure) => ({
                contentType: 'application/json',
                body: { error: failure.errorReason, message: failure.errorMessage }
            })
        }
    }, server);
    return { mode: 'x402', enabled: true, price: config.price, priceUsdc: config.priceUsdc, network: config.network, payTo: config.payTo, gate };
}

// What GET /lens/status and the ownership route tell a caller about pricing (never the gate itself).
export function describePricing(pricing) {
    const { gate: _gate, ...rest } = pricing;
    return rest;
}
