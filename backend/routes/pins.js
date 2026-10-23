// POST /pins (plan-design-agreement.md, M2 "Courier and index"): the courier that pins a design or an
// agreement the browser has addressed itself. The server recomputes the CID from the exact bytes sent,
// pins those bytes through Pinata with CIDv1 (storage/pinning.js) and answers only when Pinata's CID is
// the same one, so the browser can verify what it later mints against. This route spends OUR Pinata
// quota, so it is no open relay: it takes one canonical design/v1 or agreement/v1 object of at most
// MAX_PINNED_OBJECT_BYTES (10 MiB, chunked as an IPFS file), shaped as the index would accept it, within the
// upload routes' per-client rate limit.
import { canonicalBytes, cidOf, isCid } from '../cid.js';
import { MAX_PINNED_OBJECT_BYTES, pinBytes as defaultPinBytes } from '../storage/pinning.js';
import { isPlainObject } from '../utils/request-validation.js';
import { createUploadRateLimiter } from '../utils/nft-asset-upload.js';
import { DESIGN_SCHEMA, validateDesignContent } from './designs.js';
import { AGREEMENT_SCHEMA, validateAgreementContent } from './agreements.js';

// What each kind of object is, and how the index would check it.
const KINDS = Object.freeze({
    design: { schema: DESIGN_SCHEMA, validate: content => validateDesignContent(content) },
    agreement: { schema: AGREEMENT_SCHEMA, validate: content => validateAgreementContent(content) }
});
// A repeated-group regex over megabytes can overflow the JS engine's backtracking stack.
function isBase64(value) {
    if (typeof value !== 'string' || !value.length || value.length % 4) return false;
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    return !/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding));
}
const MAX_BASE64_LENGTH = Math.ceil(MAX_PINNED_OBJECT_BYTES / 3) * 4;

const refuse = (res, status, code, error, extra = {}) => res.status(status).json({ error, code, ...extra });

/**
 * POST /pins { kind: 'design' | 'agreement', cid, bytes (base64) } → 200 { cid, pinnedAt }.
 * @param deps { pinBytes?, uploadRateLimiter? } (routes/content-routes.js)
 */
export function setupPinsRoute(app, deps = {}) {
    const pin = deps.pinBytes || defaultPinBytes;
    app.post('/pins', deps.uploadRateLimiter || createUploadRateLimiter(), async (req, res) => {
        const body = req.body;
        if (!isPlainObject(body) || Object.keys(body).some(key => !['kind', 'cid', 'bytes'].includes(key))) {
            return refuse(res, 400, 'bad-request', 'Body must be { kind, cid, bytes }.');
        }
        const kind = Object.prototype.hasOwnProperty.call(KINDS, body.kind) ? KINDS[body.kind] : null;
        if (!kind) return refuse(res, 400, 'invalid-kind', 'kind must be design or agreement.');
        if (!isCid(body.cid)) return refuse(res, 400, 'invalid-cid', 'cid must be a CIDv1 UnixFS sha2-256 base32 CID.');
        if (typeof body.bytes === 'string' && body.bytes.length > MAX_BASE64_LENGTH) {
            return refuse(res, 413, 'too-large', `A pinned object is at most ${MAX_PINNED_OBJECT_BYTES} bytes.`);
        }
        if (!isBase64(body.bytes)) {
            return refuse(res, 400, 'invalid-bytes', 'bytes must be the object\'s canonical bytes, base64-encoded.');
        }
        const bytes = Buffer.from(body.bytes, 'base64');
        if (bytes.length > MAX_PINNED_OBJECT_BYTES) {
            return refuse(res, 413, 'too-large', `A pinned object is at most ${MAX_PINNED_OBJECT_BYTES} bytes; this one is ${bytes.length}.`);
        }
        const computedCid = cidOf(bytes);
        if (computedCid !== body.cid) {
            return refuse(res, 400, 'cid-mismatch', `The bytes are ${computedCid}, not ${body.cid}.`, { cid: body.cid, computedCid });
        }

        // Only a canonical object of the named kind, as the index would take it.
        let content;
        try {
            content = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch (_) {
            return refuse(res, 400, 'invalid-object', 'The bytes are not UTF-8 JSON.');
        }
        let canonical = null;
        try { canonical = canonicalBytes(content); } catch (_) { canonical = null; }
        if (!canonical || !canonical.equals(bytes)) {
            return refuse(res, 400, 'not-canonical', 'The bytes are not the object\'s canonical form (keys sorted at every depth, no whitespace).');
        }
        if (!isPlainObject(content) || content.schema !== kind.schema) {
            return refuse(res, 400, 'invalid-kind', `Pins of kind ${body.kind} hold ${kind.schema} objects.`);
        }
        const checked = kind.validate(content);
        if (!checked.ok) {
            const { ok: _ok, status, ...refused } = checked;
            return res.status(status).json(refused);
        }

        try {
            const pinned = await pin({ bytes, name: `${body.kind}-${body.cid}`, cid: body.cid });
            return res.json({ cid: pinned.cid, pinnedAt: pinned.pinnedAt });
        } catch (error) {
            if (error?.code === 'cid-mismatch') {
                return refuse(res, error.status === 400 ? 400 : 409, 'cid-mismatch', error.message,
                    { cid: body.cid, ...(error.pinnedCid ? { pinnedCid: error.pinnedCid } : {}), ...(error.computedCid ? { computedCid: error.computedCid } : {}) });
            }
            if (error?.code === 'pinning-unconfigured') return refuse(res, 503, 'pinning-unconfigured', 'Pinning is not configured on this server.');
            console.error(`[${new Date().toISOString()}] POST /pins ${body.kind} ${body.cid} failed:`, error);
            return refuse(res, 502, 'pin-failed', 'The object could not be pinned.');
        }
    });
}
