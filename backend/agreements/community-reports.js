// An append-only relay of NGO statements. Snapshot checks prove signature consistency, never
// current control of the NGO website; every browser resolves that website again when reading.
import { createRequire } from 'node:module';
import { canonicalBytes, cidOf, isCid } from '../cid.js';
import { pinBytes as defaultPinBytes } from '../storage/pinning.js';
import { isPlainObject } from '../utils/request-validation.js';

const require = createRequire(import.meta.url);
const reports = require('../../frontend/js/community/result.js');

export const COMMUNITY_REPORT_TABLE = 'consensus.community_report';
export const MAX_COMMUNITY_REPORT_BYTES = 96 * 1024;

export function createCommunityReportStore(pool) {
    return {
        async list(agreementCid) {
            return (await pool.query(`SELECT cid, content FROM ${COMMUNITY_REPORT_TABLE}
                WHERE agreement_cid = $1 ORDER BY posted_at, cid COLLATE "C"`, [agreementCid])).rows;
        },
        async append(agreementCid, cid, content) {
            const result = await pool.query(`INSERT INTO ${COMMUNITY_REPORT_TABLE}
                (agreement_cid, cid, posted_at, content) VALUES ($1, $2, $3::timestamptz, $4::jsonb)
                ON CONFLICT (cid) DO NOTHING RETURNING cid`, [agreementCid, cid, content.postedAt, JSON.stringify(content)]);
            return { duplicate: result.rows.length === 0 };
        }
    };
}

export function createMemoryCommunityReportStore() {
    const rows = new Map();
    return {
        async list(agreementCid) {
            return [...rows.values()].filter(row => row.agreementCid === agreementCid)
                .sort((a, b) => a.content.postedAt < b.content.postedAt ? -1 : a.content.postedAt > b.content.postedAt ? 1 : a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0)
                .map(({ cid, content }) => ({ cid, content: structuredClone(content) }));
        },
        async append(agreementCid, cid, content) {
            const duplicate = rows.has(cid);
            if (!duplicate) rows.set(cid, { agreementCid, cid, content: structuredClone(content) });
            return { duplicate };
        }
    };
}

export function createCommunityReportHandlers({ loadAgreement, store, now = () => Date.now(), pinBytes = defaultPinBytes }) {
    const refuse = (res, status, code, error) => res.status(status).json({ code, error });
    async function indexed(cid, res) {
        const agreement = await loadAgreement(cid);
        if (!agreement) refuse(res, 404, 'agreement-not-found', 'Agreement not found.');
        return agreement;
    }
    return {
        async get(req, res) {
            res.set('Cache-Control', 'no-store');
            const cid = req.params.cid;
            if (!isCid(cid)) return refuse(res, 400, 'invalid-cid', 'Not an agreement CID.');
            try {
                if (!await indexed(cid, res)) return;
                return res.json({ agreementCid: cid, reports: await store.list(cid) });
            } catch (error) {
                console.error(`[${new Date().toISOString()}] Community reports could not be read:`, error);
                return refuse(res, 500, 'report-read-failed', 'Reports could not be read.');
            }
        },
        async post(req, res) {
            res.set('Cache-Control', 'no-store');
            const agreementCid = req.params.cid;
            if (!isCid(agreementCid)) return refuse(res, 400, 'invalid-cid', 'Not an agreement CID.');
            const body = req.body;
            if (!isPlainObject(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'cid') || !Object.hasOwn(body, 'content')) {
                return refuse(res, 400, 'bad-request', 'Body must be { cid, content }.');
            }
            if (!isCid(body.cid)) return refuse(res, 400, 'invalid-cid', 'Not a report CID.');
            let bytes, content;
            try {
                bytes = canonicalBytes(body.content);
                if (bytes.length > MAX_COMMUNITY_REPORT_BYTES) return refuse(res, 413, 'too-large', 'Report exceeds 96 KiB.');
                content = reports.normalizeReport(body.content);
                if (!bytes.equals(canonicalBytes(content))) throw new Error('Report must have its canonical shape.');
            } catch (error) {
                return refuse(res, 400, 'invalid-community-report', error.message);
            }
            if (cidOf(bytes) !== body.cid) return refuse(res, 400, 'cid-mismatch', 'Report content does not match its CID.');
            try {
                // Verify the signature before any database access. The indexed organiser is checked
                // independently below; the client cannot substitute a different agreement or NGO.
                const verdict = await reports.verifyReport(content, { agreementCid, organiser: content.attester, now: now() });
                if (!verdict.ok) return refuse(res, 403, verdict.code, verdict.error);
                const agreement = await indexed(agreementCid, res);
                if (!agreement) return;
                const organiser = agreement.content?.consultation?.organiser;
                if (agreement.content?.rule?.electorate !== 'community' || !organiser || organiser !== content.attester) {
                    return refuse(res, 403, 'report-not-authorized', 'Only the named organiser of a community agreement can report.');
                }
                // Reports commonly follow the deadline. Neither lifecycle nor a chain account is
                // an admission condition. Exact canonical bytes must be pinned before indexing.
                try {
                    await pinBytes({ bytes, cid: body.cid, name: `community-report-${body.cid}` });
                } catch (error) {
                    return refuse(res, error?.code === 'pinning-unconfigured' ? 503 : 502,
                        error?.code === 'pinning-unconfigured' ? 'pinning-unconfigured' : 'pin-failed', 'Report could not be pinned.');
                }
                const { duplicate } = await store.append(agreementCid, body.cid, content);
                return res.status(duplicate ? 200 : 201).json({ stored: true, duplicate, cid: body.cid });
            } catch (error) {
                console.error(`[${new Date().toISOString()}] Community report could not be stored:`, error);
                return refuse(res, 500, 'report-store-failed', 'Report could not be stored.');
            }
        }
    };
}
