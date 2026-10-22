// Receipt relay for owner decisions on published agreements (plan-design-agreement.md, M2 "Owner
// decisions"): GET and POST /agreements/:cid/decisions, and POST …/bundle, which pins the canonical
// bundle a wallet then anchors on chain. It replaces the proposal relay (/proposals/:id/owner-decisions),
// re-keyed by the agreement's CID: a decision signs the agreement-decision/v1 statement naming that CID
// (frontend/js/proposals/approval.js decisionContent), so it can never go stale. The server admits a
// decision under the same rules the browser applies (frontend/js/proposals/approval-relay.js admit)
// after re-verifying its three signatures, and stores it append-only; readers verify every decision
// again, so the relay is never trusted.
import { createRequire } from 'node:module';
import { canonicalBytes, cidOf, isCid } from '../cid.js';
import { pinBytes as defaultPinBytes } from '../storage/pinning.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const relay = require('../../frontend/js/proposals/approval-relay.js');
const anchors = require('../../frontend/js/proposals/approval-anchor.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');

export const AGREEMENT_DECISION_TABLE = 'consensus.agreement_decision';
// Decisions on one agreement are admitted one at a time, under this advisory-lock namespace (the
// proposal relay it replaced used 480403).
export const AGREEMENT_DECISION_LOCK_NAMESPACE = 480404;

const log = message => console.log(`[${new Date().toISOString()}] [agreement-decisions] ${message}`);

// The index's status word (routes/agreements.js: from the chain once minted, else from the deadline)
// as the lifecycle the relay closes on.
const LIFECYCLE_STATUS = Object.freeze({ active: 'Active', executed: 'Executed', cancelled: 'Cancelled', expired: 'Expired' });

/**
 * The agreement-like object approval.js, approval-relay.js and approval-anchor.js take, for an indexed
 * agreement (routes/agreements.js serializeAgreementRow): the engine's subject of its published content
 * (AgreementRecord.approvalSubject: input parcels, rule, lens) under its CID, the lifecycle the relay
 * closes on, and its chain account once minted (agreements/onchain.js). The lens member counts
 * decisions over this same object (lens/agreement-decision.js), so both judge them alike.
 */
export function decisionSubject(agreement) {
    return {
        ...agreementRecord.approvalSubject(agreement.content),
        agreementCid: agreement.cid,
        lifecycleStatus: LIFECYCLE_STATUS[agreement.status] || 'Active',
        onchain: agreement.onchain ?? null
    };
}

export function createAgreementDecisionStore(pool) {
    const select = `SELECT receipt FROM ${AGREEMENT_DECISION_TABLE} WHERE agreement_cid = $1 ORDER BY decided_at, signature`;
    return {
        async list(agreementCid) {
            return (await pool.query(select, [agreementCid])).rows.map(row => row.receipt);
        },
        // Runs decide(stored) under a per-agreement lock and stores its receipt when admitted, so two
        // decisions on one agreement cannot both be judged against the same earlier state.
        async record(agreementCid, decide) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [AGREEMENT_DECISION_LOCK_NAMESPACE, agreementCid]);
                const stored = (await client.query(select, [agreementCid])).rows.map(row => row.receipt);
                const verdict = decide(stored);
                if (verdict.ok && !verdict.duplicate) {
                    const { receipt, contextHash } = verdict;
                    await client.query(`INSERT INTO ${AGREEMENT_DECISION_TABLE}
                        (agreement_cid, owner_id, actor_id, decision, context_hash, decided_at, signature, receipt)
                        VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8::jsonb)
                        ON CONFLICT (signature) DO NOTHING`, [
                        agreementCid, receipt.ownerId, receipt.actorId, receipt.decision, contextHash,
                        receipt.decidedAt, receipt.decisionProof.signature, JSON.stringify(receipt)
                    ]);
                }
                await client.query('COMMIT');
                return verdict;
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
            } finally {
                client.release();
            }
        }
    };
}

// The same contract in memory, one decision at a time, for tests and local runs without a database.
export function createMemoryAgreementDecisionStore() {
    const rows = new Map();
    let queue = Promise.resolve();
    return {
        async list(agreementCid) { return [...(rows.get(agreementCid) || [])]; },
        record(agreementCid, decide) {
            const run = queue.then(() => {
                const verdict = decide([...(rows.get(agreementCid) || [])]);
                if (verdict.ok && !verdict.duplicate) rows.set(agreementCid, [...(rows.get(agreementCid) || []), verdict.receipt]);
                return verdict;
            });
            queue = run.catch(() => {});
            return run;
        }
    };
}

// The fields a stored receipt keeps: exactly what its signatures cover, plus the provider that
// verifies it (the receipt approval.js defines; the CID and context come from the agreement).
function storedReceipt(receipt) {
    const { ownerId, actorId, evidence, decidedAt, decision, decisionProof, providerId } = receipt;
    return JSON.parse(JSON.stringify({ ownerId, actorId, evidence, decidedAt, decision, decisionProof, providerId }));
}

/**
 * @param {{ loadAgreement: (cid: string) => Promise<object|null>, store: ReturnType<typeof createAgreementDecisionStore>,
 *   now?: () => number, pinBytes?: typeof defaultPinBytes }} options
 * loadAgreement returns the indexed agreement as GET /agreements/:cid serves it.
 */
export function createAgreementDecisionHandlers({ loadAgreement, store, now = () => Date.now(), pinBytes = defaultPinBytes }) {
    // Bundle CIDs this process has pinned: the same decisions are pinned once.
    const pinned = new Set();
    async function indexed(req, res) {
        const cid = String(req.params.cid || '');
        if (!isCid(cid)) {
            res.status(400).json({ error: 'Not an agreement CID.', code: 'invalid_cid' });
            return null;
        }
        const agreement = await loadAgreement(cid);
        if (!agreement) {
            res.status(404).json({ error: 'Agreement not found', code: 'agreement_not_found' });
            return null;
        }
        return agreement;
    }
    return {
        // → { agreementCid, decisions }: every stored receipt, in signing order.
        async get(req, res) {
            try {
                const agreement = await indexed(req, res);
                if (!agreement) return;
                res.set('Cache-Control', 'no-store');
                res.json({ agreementCid: agreement.cid, decisions: await store.list(agreement.cid) });
            } catch (error) {
                console.error(`[${new Date().toISOString()}] GET /agreements/${req.params.cid}/decisions failed:`, error);
                res.status(500).json({ error: 'Internal server error' });
            }
        },
        // { receipt } → 201 { stored, duplicate: false }, 200 for a decision already stored, or the
        // relay's refusal (approval-relay.js admit) with its status and code.
        async post(req, res) {
            try {
                const agreement = await indexed(req, res);
                if (!agreement) return;
                const subject = decisionSubject(agreement);
                const raw = req.body?.receipt;
                const receipt = raw && typeof raw === 'object' && !Array.isArray(raw) ? storedReceipt(raw) : raw;
                const verdict = await store.record(agreement.cid, stored => {
                    const result = relay.admit(subject, stored, receipt, { now: now() });
                    return result.ok ? { ...result, receipt, contextHash: approval.contextHash(subject) } : result;
                });
                if (!verdict.ok) {
                    log(`refused ${receipt?.decision || 'decision'} on ${agreement.cid} owner ${receipt?.ownerId || '?'}: ${verdict.code}`);
                    return res.status(verdict.status).json({ error: verdict.message, code: verdict.code });
                }
                if (!verdict.duplicate) log(`stored ${receipt.decision} on ${agreement.cid} owner ${receipt.ownerId} signed ${receipt.decidedAt}`);
                res.status(verdict.duplicate ? 200 : 201).json({ stored: true, duplicate: verdict.duplicate === true });
            } catch (error) {
                console.error(`[${new Date().toISOString()}] POST /agreements/${req.params.cid}/decisions failed:`, error);
                res.status(500).json({ error: 'Internal server error' });
            }
        },
        // Pins every applying decision on a minted agreement as one canonical bundle, under the CID of
        // its bytes. The wallet then records the bundle's URI and hash on chain (approval-anchor.js
        // anchor); readers re-hash and re-verify it. → { uri, cid, hash, subject, count }.
        async bundle(req, res) {
            try {
                const agreement = await indexed(req, res);
                if (!agreement) return;
                const subject = decisionSubject(agreement);
                if (!anchors.chainRef(subject)) return res.status(409).json({ error: 'This agreement is not minted on Solana.', code: 'not_minted' });
                const bundle = anchors.bundleOf(subject, await store.list(agreement.cid));
                if (!bundle.decisions.length) return res.status(409).json({ error: 'There is no decision to anchor.', code: 'nothing_to_anchor' });
                const bytes = canonicalBytes(bundle);
                const cid = cidOf(bytes);
                if (!pinned.has(cid)) {
                    await pinBytes({ bytes, name: `agreement-decisions-${cid}`, cid });
                    if (pinned.size >= 1000) pinned.delete(pinned.values().next().value);
                    pinned.add(cid);
                    log(`pinned ${bundle.decisions.length} decision(s) on ${agreement.cid} as ${cid}`);
                }
                // The bundle's sha256 is the digest its CID carries: the same bytes, hashed once.
                res.json({ uri: `ipfs://${cid}`, cid, hash: anchors.hashOf(bundle), subject: bundle.subject, count: bundle.decisions.length });
            } catch (error) {
                console.error(`[${new Date().toISOString()}] POST /agreements/${req.params.cid}/decisions/bundle failed:`, error);
                if (error?.code === 'pinning-unconfigured') return res.status(503).json({ error: 'Pinning is not configured on this server.', code: 'pinning_unconfigured' });
                res.status(502).json({ error: 'The bundle could not be pinned.', code: 'pin_failed' });
            }
        }
    };
}
