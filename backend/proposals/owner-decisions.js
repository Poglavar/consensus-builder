// Receipt relay for abstract owner decisions (land-readjustmend.md §19): GET and POST
// /proposals/:id/owner-decisions, and POST …/bundle, which pins the canonical bundle a wallet then
// anchors on chain (§20). The server admits a decision under the same rules the browser
// applies (frontend/js/proposals/approval-relay.js) after re-verifying its three signatures, and
// stores it append-only; readers verify every decision again, so the relay is never trusted.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const relay = require('../../frontend/js/proposals/approval-relay.js');
const anchors = require('../../frontend/js/proposals/approval-anchor.js');

export const OWNER_DECISION_TABLE = 'consensus.proposal_owner_decision';
// Decisions for one proposal are admitted one at a time; distinct from PROPOSAL_ID_LOCK_NAMESPACE.
export const OWNER_DECISION_LOCK_NAMESPACE = 480403;

const log = message => console.log(`[${new Date().toISOString()}] [owner-decisions] ${message}`);

export function createOwnerDecisionStore(pool) {
    const select = `SELECT receipt FROM ${OWNER_DECISION_TABLE} WHERE proposal_id = $1 ORDER BY decided_at, signature`;
    return {
        async list(proposalId) {
            return (await pool.query(select, [proposalId])).rows.map(row => row.receipt);
        },
        // Runs decide(stored) under a per-proposal lock and stores its receipt when admitted, so two
        // decisions for one proposal cannot both be judged against the same earlier state.
        async record(proposalId, decide) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [OWNER_DECISION_LOCK_NAMESPACE, proposalId]);
                const stored = (await client.query(select, [proposalId])).rows.map(row => row.receipt);
                const verdict = decide(stored);
                if (verdict.ok && !verdict.duplicate) {
                    const { receipt, contextHash } = verdict;
                    await client.query(`INSERT INTO ${OWNER_DECISION_TABLE}
                        (proposal_id, owner_id, actor_id, decision, effect_hash, context_hash, decided_at, signature, receipt)
                        VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::jsonb)
                        ON CONFLICT (signature) DO NOTHING`, [
                        proposalId, receipt.ownerId, receipt.actorId, receipt.decision, receipt.effectHash, contextHash,
                        receipt.acceptedAt, receipt.decisionProof.signature, JSON.stringify(receipt)
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
export function createMemoryOwnerDecisionStore() {
    const rows = new Map();
    let queue = Promise.resolve();
    return {
        async list(proposalId) { return [...(rows.get(proposalId) || [])]; },
        record(proposalId, decide) {
            const run = queue.then(() => {
                const verdict = decide([...(rows.get(proposalId) || [])]);
                if (verdict.ok && !verdict.duplicate) rows.set(proposalId, [...(rows.get(proposalId) || []), verdict.receipt]);
                return verdict;
            });
            queue = run.catch(() => {});
            return run;
        }
    };
}

// The fields a stored receipt keeps: exactly what its signatures cover, plus the provider that verifies it.
function storedReceipt(receipt) {
    const { ownerId, actorId, effectHash, evidence, acceptedAt, decision, decisionProof, providerId } = receipt;
    return JSON.parse(JSON.stringify({ ownerId, actorId, effectHash, evidence, acceptedAt, decision, decisionProof, providerId }));
}

async function pinWithPinata(bundle, name) {
    const { uploadMetadataToPinata } = await import('../routes/ipfs.js');
    return (await uploadMetadataToPinata(bundle, name)).ipfsUri;
}

/**
 * @param {{ loadProposal: (id: string) => Promise<object|null>, store: ReturnType<typeof createOwnerDecisionStore>,
 *   now?: () => number, pinJson?: (bundle: object, name: string) => Promise<string> }} options
 * loadProposal returns the published proposal as GET /proposals/:id serves it; pinJson pins a JSON
 * document and returns its ipfs:// URI.
 */
export function createOwnerDecisionHandlers({ loadProposal, store, now = () => Date.now(), pinJson = pinWithPinata }) {
    // Bundle hash -> pinned URI: the same decisions are pinned once per process.
    const pinned = new Map();
    const approval = require('../../frontend/js/proposals/approval.js');
    async function published(req, res) {
        const proposal = await loadProposal(String(req.params.id || ''));
        if (!proposal?.proposalId) {
            res.status(404).json({ error: 'Proposal not found', code: 'proposal_not_found' });
            return null;
        }
        return proposal;
    }
    return {
        async get(req, res) {
            try {
                const proposal = await published(req, res);
                if (!proposal) return;
                res.set('Cache-Control', 'no-store');
                res.json({ proposalId: proposal.proposalId, decisions: await store.list(String(proposal.proposalId)) });
            } catch (error) {
                console.error(`[${new Date().toISOString()}] GET /proposals/${req.params.id}/owner-decisions failed:`, error);
                res.status(500).json({ error: 'Internal server error' });
            }
        },
        // Pins every applying decision of a minted proposal as one canonical bundle. The browser's
        // wallet then records its URI and hash on chain; readers re-hash and re-verify it.
        async bundle(req, res) {
            try {
                const proposal = await published(req, res);
                if (!proposal) return;
                if (!anchors.chainRef(proposal)) return res.status(409).json({ error: 'This proposal is not minted on Solana.', code: 'not_minted' });
                const bundle = anchors.bundleOf(proposal, await store.list(String(proposal.proposalId)));
                if (!bundle.decisions.length) return res.status(409).json({ error: 'There is no decision to anchor.', code: 'nothing_to_anchor' });
                const hash = anchors.hashOf(bundle);
                if (!pinned.has(hash)) {
                    if (pinned.size >= 1000) pinned.delete(pinned.keys().next().value);
                    pinned.set(hash, await pinJson(bundle, `owner-decisions-${hash.slice('sha256:'.length, 'sha256:'.length + 16)}`));
                    log(`pinned ${bundle.decisions.length} decision(s) for ${bundle.subject} as ${pinned.get(hash)}`);
                }
                res.json({ uri: pinned.get(hash), hash, subject: bundle.subject, count: bundle.decisions.length });
            } catch (error) {
                console.error(`[${new Date().toISOString()}] POST /proposals/${req.params.id}/owner-decisions/bundle failed:`, error);
                res.status(502).json({ error: 'The bundle could not be pinned.', code: 'pin_failed' });
            }
        },
        async post(req, res) {
            try {
                const proposal = await published(req, res);
                if (!proposal) return;
                const raw = req.body?.receipt;
                const receipt = raw && typeof raw === 'object' && !Array.isArray(raw) ? storedReceipt(raw) : raw;
                const proposalId = String(proposal.proposalId);
                const verdict = await store.record(proposalId, stored => {
                    const result = relay.admit(proposal, stored, receipt, { now: now() });
                    return result.ok ? { ...result, receipt, contextHash: approval.contextHash(proposal) } : result;
                });
                if (!verdict.ok) {
                    log(`refused ${receipt?.decision || 'decision'} for ${proposalId} owner ${receipt?.ownerId || '?'}: ${verdict.code}`);
                    return res.status(verdict.status).json({ error: verdict.message, code: verdict.code });
                }
                if (!verdict.duplicate) log(`stored ${receipt.decision} for ${proposalId} owner ${receipt.ownerId} signed ${receipt.acceptedAt}`);
                res.status(verdict.duplicate ? 200 : 201).json({ stored: true, duplicate: verdict.duplicate === true });
            } catch (error) {
                console.error(`[${new Date().toISOString()}] POST /proposals/${req.params.id}/owner-decisions failed:`, error);
                res.status(500).json({ error: 'Internal server error' });
            }
        }
    };
}
