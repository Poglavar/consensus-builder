// Pure lens-model logic shared by the Solana lens picker, proposal Details, the chain parser and the
// member console: base58 keys, directory normalisation, per-parcel coverage, the lens vector codec
// and challenge/response handling. No DOM, no network; exposed as window.LensCore and via CommonJS.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LensCore = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null), function () {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const ALPHABET_INDEX = new Map([...ALPHABET].map((char, index) => [char, index]));
    const COVERAGE_KEYS = ['ownership', 'parcels', 'executed'];
    const VERDICTS = ['executed', 'expired'];
    // A lens is bounded by the 4096-byte proposal account; this only stops a corrupt count from
    // allocating an absurd array before the bounds check catches it.
    const MAX_LENS_KEYS = 120;

    function base58Encode(bytes) {
        const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
        if (!input.length) return '';
        const digits = [0];
        for (const byte of input) {
            let carry = byte;
            for (let i = 0; i < digits.length; i++) {
                carry += digits[i] << 8;
                digits[i] = carry % 58;
                carry = (carry / 58) | 0;
            }
            while (carry > 0) {
                digits.push(carry % 58);
                carry = (carry / 58) | 0;
            }
        }
        let out = '';
        for (let i = 0; i < input.length && input[i] === 0; i++) out += '1';
        if (input.every(byte => byte === 0)) return out;
        for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
        return out;
    }

    // Returns null for anything that is not base58, never throws.
    function base58Decode(text) {
        if (typeof text !== 'string' || !text) return null;
        const bytes = [0];
        for (const char of text) {
            const value = ALPHABET_INDEX.get(char);
            if (value === undefined) return null;
            let carry = value;
            for (let i = 0; i < bytes.length; i++) {
                carry += bytes[i] * 58;
                bytes[i] = carry & 0xff;
                carry >>= 8;
            }
            while (carry > 0) {
                bytes.push(carry & 0xff);
                carry >>= 8;
            }
        }
        let leadingZeros = 0;
        while (leadingZeros < text.length && text[leadingZeros] === '1') leadingZeros++;
        const body = bytes.reverse();
        while (body.length && body[0] === 0) body.shift();
        return Uint8Array.from([...new Array(leadingZeros).fill(0), ...body]);
    }

    // A Solana public key: canonical base58 of exactly 32 bytes (on-curve or not; PDAs are keys too).
    function isBase58Pubkey(value) {
        if (typeof value !== 'string') return false;
        const text = value.trim();
        if (text.length < 32 || text.length > 44) return false;
        const bytes = base58Decode(text);
        return !!bytes && bytes.length === 32 && base58Encode(bytes) === text;
    }

    function shortKey(key) {
        const text = String(key || '');
        return text.length > 12 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
    }

    function count(value) {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    }

    function cleanText(value) {
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    }

    // Only absolute http(s) URLs; a trailing slash is dropped so paths can be appended.
    function normalizeServiceUrl(value) {
        const text = cleanText(value);
        if (!text) return null;
        let url;
        try {
            url = new URL(text);
        } catch (_) {
            return null;
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url.toString().replace(/\/+$/, '');
    }

    function normalizeMember(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const key = cleanText(raw.key);
        if (!key || !isBase58Pubkey(key)) return null;
        const coverage = raw.coverage && typeof raw.coverage === 'object' ? raw.coverage : {};
        return {
            key,
            kind: cleanText(raw.kind),
            name: cleanText(raw.name),
            description: cleanText(raw.description),
            coverage: Object.fromEntries(COVERAGE_KEYS.map(name => [name, count(coverage[name])])),
            serviceUrl: normalizeServiceUrl(raw.serviceUrl ?? raw.service_url)
        };
    }

    // GET /lenses/members body -> members with valid keys, first occurrence of each key kept.
    function normalizeDirectory(body) {
        const list = body && Array.isArray(body.members) ? body.members : [];
        const seen = new Set();
        const members = [];
        for (const raw of list) {
            const member = normalizeMember(raw);
            if (!member || seen.has(member.key)) continue;
            seen.add(member.key);
            members.push(member);
        }
        return members;
    }

    function memberLabel(key, members) {
        const member = (members || []).find(entry => entry && entry.key === key);
        return (member && member.name) || shortKey(key);
    }

    // results: [{ memberKey, parcelUid, attestations: [...] | null }] where null means the member's
    // service could not be asked (no URL, error). Only unexpired ownership attestations the member
    // itself signed for that parcel count; nothing is inferred for a member that was not asked.
    function computeParcelCoverage(parcelIds, results, nowSeconds) {
        const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
        const byParcel = {};
        const byMember = {};
        (parcelIds || []).forEach(parcelUid => { byParcel[parcelUid] = { covered: [], unknown: [] }; });
        let available = false;
        for (const result of results || []) {
            if (!result || !byParcel[result.parcelUid]) continue;
            const stats = byMember[result.memberKey] || (byMember[result.memberKey] = { covered: 0, checked: 0, unknown: 0 });
            const slot = byParcel[result.parcelUid];
            if (!Array.isArray(result.attestations)) {
                stats.unknown += 1;
                if (!slot.unknown.includes(result.memberKey)) slot.unknown.push(result.memberKey);
                continue;
            }
            available = true;
            stats.checked += 1;
            const covers = result.attestations.some(att => att
                && (att.kind === undefined || att.kind === 'ownership')
                && att.parcelUid === result.parcelUid
                && (!att.authority || att.authority === result.memberKey)
                && !(typeof att.expiry === 'number' && att.expiry > 0 && att.expiry < now));
            if (covers && !slot.covered.includes(result.memberKey)) {
                slot.covered.push(result.memberKey);
                stats.covered += 1;
            }
        }
        return { byParcel, byMember, available };
    }

    function isParcelCoveredBy(coverage, parcelUid, keys) {
        const slot = coverage && coverage.byParcel ? coverage.byParcel[parcelUid] : null;
        if (!slot) return false;
        const wanted = new Set(keys || []);
        return slot.covered.some(key => wanted.has(key));
    }

    function filterParcelsByLens(parcelIds, coverage, keys, onlyCovered) {
        const ids = Array.isArray(parcelIds) ? parcelIds.slice() : [];
        if (!onlyCovered || !coverage || !coverage.available) return ids;
        return ids.filter(id => isParcelCoveredBy(coverage, id, keys));
    }

    // Best first: selected-parcel coverage when it was measured, then directory counts, then name.
    function sortMembersByCoverage(members, coverage) {
        const measured = coverage && coverage.byMember ? coverage.byMember : {};
        const score = member => (measured[member.key] && measured[member.key].checked ? measured[member.key].covered : -1);
        return (members || []).slice().sort((a, b) => (score(b) - score(a))
            || (b.coverage.ownership - a.coverage.ownership)
            || (b.coverage.parcels - a.coverage.parcels)
            || String(a.name || a.key).localeCompare(String(b.name || b.key)));
    }

    // Splits pasted text on whitespace/commas/semicolons into valid keys and rejected tokens.
    function parsePastedKeys(text) {
        const tokens = String(text || '').split(/[\s,;]+/).map(token => token.trim()).filter(Boolean);
        const keys = [];
        const invalid = [];
        for (const token of tokens) {
            if (isBase58Pubkey(token)) {
                if (!keys.includes(token)) keys.push(token);
            } else {
                invalid.push(token);
            }
        }
        return { keys, invalid };
    }

    // The keys a Solana mint will send, from stored lens entries ({address,name} or strings).
    // EVM 0x entries and anything else that is not a pubkey are reported, never silently replaced.
    function validateSolanaLens(entries) {
        const keys = [];
        const invalid = [];
        for (const entry of Array.isArray(entries) ? entries : []) {
            const address = typeof entry === 'string' ? entry : (entry && entry.address);
            const text = typeof address === 'string' ? address.trim() : '';
            if (!text) continue;
            if (isBase58Pubkey(text)) {
                if (!keys.includes(text)) keys.push(text);
            } else {
                invalid.push(text);
            }
        }
        if (!keys.length) return { ok: false, error: 'empty', keys, invalid };
        return { ok: true, error: null, keys, invalid };
    }

    function readU32(bytes, offset) {
        if (offset + 4 > bytes.length) throw new RangeError(`lens vector truncated at byte ${offset}`);
        return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) + bytes[offset + 3] * 0x1000000;
    }

    // Borsh Vec<Pubkey>: u32 LE count, then count x 32 bytes. Throws on a truncated or absurd vector.
    function readPubkeyVec(bytes, offset) {
        const body = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
        const length = readU32(body, offset);
        let cursor = offset + 4;
        if (length > MAX_LENS_KEYS || cursor + length * 32 > body.length) {
            throw new RangeError(`lens vector of ${length} keys does not fit in ${body.length - cursor} bytes`);
        }
        const keys = [];
        for (let i = 0; i < length; i++) {
            keys.push(base58Encode(body.subarray(cursor, cursor + 32)));
            cursor += 32;
        }
        return { keys, offset: cursor };
    }

    // The proposal account tail after accepted_parcels: `lens: Vec<Pubkey>`, then `bump: u8`.
    // Anything after the bump (newer fields, zero padding of the fixed-size account) is ignored.
    function decodeProposalLensTail(bytes, offset) {
        const body = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
        const { keys, offset: next } = readPubkeyVec(body, offset);
        const bump = next < body.length ? body[next] : null;
        return { lens: keys, bump, offset: bump === null ? next : next + 1 };
    }

    // Before a wallet signs anything, the service's message must be the challenge it claims to be:
    // naming this wallet, this parcel, the returned nonce, the member key when known, and unexpired.
    function checkChallenge(response, { parcelUid, owner, memberKey = null, nowMs = Date.now() } = {}) {
        if (!response || typeof response !== 'object') return { ok: false, reason: 'malformed' };
        const { challenge, message, expiresAt } = response;
        if (typeof challenge !== 'string' || !challenge || typeof message !== 'string' || !message) {
            return { ok: false, reason: 'malformed' };
        }
        const lines = message.split('\n');
        if (!lines.some(line => line.includes(`Wallet ${owner} `))) return { ok: false, reason: 'wrong_wallet' };
        if (!lines.some(line => line.includes(`parcel ${parcelUid}.`))) return { ok: false, reason: 'wrong_parcel' };
        if (!lines.includes(`Challenge: ${challenge}`)) return { ok: false, reason: 'wrong_challenge' };
        if (memberKey && !lines[0].includes(memberKey)) return { ok: false, reason: 'wrong_member' };
        const expiry = Date.parse(expiresAt);
        if (!Number.isFinite(expiry)) return { ok: false, reason: 'malformed' };
        if (expiry <= nowMs) return { ok: false, reason: 'expired' };
        return { ok: true, reason: null, challenge, message, expiresAt };
    }

    function encodeMessage(message) {
        return new TextEncoder().encode(String(message));
    }

    // Wallets return a Uint8Array or { signature: Uint8Array }; the service takes base58.
    function signatureToBase58(result) {
        const raw = result && result.signature !== undefined ? result.signature : result;
        const bytes = raw instanceof Uint8Array ? raw : (Array.isArray(raw) ? Uint8Array.from(raw) : null);
        if (!bytes || bytes.length !== 64) throw new Error('wallet did not return a 64-byte signature');
        return base58Encode(bytes);
    }

    // HTTP outcome of a member-service call -> one of ok | payment_required | not_configured |
    // refused | error, with the service's own message.
    function classifyServiceResponse(status, body) {
        const message = body && typeof body === 'object'
            ? (cleanText(body.message) || cleanText(body.error))
            : null;
        const code = body && typeof body === 'object' ? cleanText(body.error) : null;
        if (status >= 200 && status < 300) return { kind: 'ok', status, code: null, message: null };
        if (status === 402) return { kind: 'payment_required', status, code, message };
        if (status === 503) return { kind: 'not_configured', status, code, message };
        if (status >= 400 && status < 500) return { kind: 'refused', status, code, message };
        return { kind: 'error', status, code, message };
    }

    // GET /lens/status pricing.ownership -> "0.01 USDC" style label, or null when unpriced/unknown.
    function describeOwnershipPrice(status) {
        const pricing = status && status.pricing && status.pricing.ownership;
        if (!pricing || pricing.enabled !== true) return null;
        const usdc = Number(pricing.priceUsdc);
        if (Number.isFinite(usdc) && usdc > 0) return `${usdc} USDC${pricing.network ? ` (${pricing.network})` : ''}`;
        return cleanText(pricing.price);
    }

    function normalizeAttestations(body) {
        const list = body && Array.isArray(body.attestations) ? body.attestations : [];
        return list.filter(att => att && typeof att.address === 'string').map(att => ({
            address: att.address,
            kind: cleanText(att.kind),
            authority: cleanText(att.authority),
            parcelUid: cleanText(att.parcelUid),
            proposalAccount: cleanText(att.proposalAccount),
            owner: cleanText(att.owner),
            accountHash: cleanText(att.accountHash),
            expiry: Number.isFinite(Number(att.expiry)) ? Number(att.expiry) : null,
            issuedAt: cleanText(att.issuedAt),
            payload: att.payload && typeof att.payload === 'object' ? att.payload : null,
            transactionSignature: cleanText(att.transactionSignature)
        }));
    }

    // Operator verdict form -> request body for POST /lens/verdict, or the first problem.
    function buildVerdictRequest(form) {
        const proposalAccount = cleanText(form && form.proposalAccount);
        if (!proposalAccount || !isBase58Pubkey(proposalAccount)) return { ok: false, error: 'proposal' };
        const verdict = cleanText(form.verdict);
        if (!VERDICTS.includes(verdict)) return { ok: false, error: 'verdict' };
        const observed = cleanText(form.sourceObservedAt);
        const ms = observed ? Date.parse(observed) : NaN;
        if (!Number.isFinite(ms)) return { ok: false, error: 'time' };
        const body = { proposalAccount, verdict, sourceObservedAt: Math.floor(ms / 1000) };
        const evidenceRef = cleanText(form.evidenceRef);
        if (evidenceRef) body.evidenceRef = evidenceRef;
        return { ok: true, error: null, body };
    }

    return {
        COVERAGE_KEYS,
        VERDICTS,
        base58Encode,
        base58Decode,
        isBase58Pubkey,
        shortKey,
        normalizeServiceUrl,
        normalizeMember,
        normalizeDirectory,
        memberLabel,
        computeParcelCoverage,
        isParcelCoveredBy,
        filterParcelsByLens,
        sortMembersByCoverage,
        parsePastedKeys,
        validateSolanaLens,
        readPubkeyVec,
        decodeProposalLensTail,
        checkChallenge,
        encodeMessage,
        signatureToBase58,
        classifyServiceResponse,
        describeOwnershipPrice,
        normalizeAttestations,
        buildVerdictRequest
    };
});
