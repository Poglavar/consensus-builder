// HTTP calls of the lens model with fetch injected: the backend attester directory and one lens
// member service (status, challenge, ownership, attestations, operator verdict). No DOM; exposed as
// window.LensServiceClient and via CommonJS so node tests can drive it with a fake fetch.
(function (root, factory) {
    const core = (root && root.LensCore) || (typeof require === 'function' ? require('./lens-core.js') : null);
    const api = factory(core);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LensServiceClient = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null), function (LensCore) {
    const OPERATOR_TOKEN_HEADER = 'x-lens-operator-token';

    function resolveFetch(fetchImpl) {
        const impl = fetchImpl || (typeof fetch === 'function' ? fetch : null);
        if (!impl) throw new Error('LensServiceClient: no fetch implementation');
        return impl;
    }

    function joinUrl(base, path) {
        const trimmed = String(base || '').replace(/\/+$/, '');
        if (!trimmed) throw new Error('LensServiceClient: base URL is required');
        return `${trimmed}${path}`;
    }

    // One request -> { status, body, outcome } where outcome is LensCore.classifyServiceResponse.
    // A network failure is outcome.kind 'error' with status 0, never a thrown exception, so every UI
    // caller renders the same way.
    async function request(url, { method = 'GET', body, headers = {}, fetchImpl } = {}) {
        const init = { method, headers: { Accept: 'application/json', ...headers } };
        if (body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        let response;
        try {
            response = await resolveFetch(fetchImpl)(url, init);
        } catch (error) {
            return { status: 0, body: null, outcome: { kind: 'error', status: 0, code: 'network', message: error && error.message ? error.message : String(error) } };
        }
        let parsed = null;
        try {
            parsed = await response.json();
        } catch (_) {
            parsed = null;
        }
        return { status: response.status, body: parsed, outcome: LensCore.classifyServiceResponse(response.status, parsed) };
    }

    async function fetchDirectory({ base, fetchImpl } = {}) {
        const result = await request(joinUrl(base, '/lenses/members'), { fetchImpl });
        return { ...result, members: result.outcome.kind === 'ok' ? LensCore.normalizeDirectory(result.body) : [] };
    }

    async function fetchStatus({ serviceUrl, fetchImpl } = {}) {
        return request(joinUrl(serviceUrl, '/lens/status'), { fetchImpl });
    }

    async function fetchAttestations({ serviceUrl, filter = {}, fetchImpl } = {}) {
        const params = new URLSearchParams();
        ['parcelUid', 'proposalAccount', 'owner', 'kind', 'limit'].forEach(name => {
            if (filter[name] !== undefined && filter[name] !== null && String(filter[name]).trim()) params.set(name, String(filter[name]).trim());
        });
        const query = params.toString();
        const result = await request(joinUrl(serviceUrl, `/lens/attestations${query ? `?${query}` : ''}`), { fetchImpl });
        return { ...result, attestations: result.outcome.kind === 'ok' ? LensCore.normalizeAttestations(result.body) : null };
    }

    async function requestChallenge({ serviceUrl, parcelUid, owner, fetchImpl } = {}) {
        return request(joinUrl(serviceUrl, '/lens/challenge'), { method: 'POST', body: { parcelUid, owner }, fetchImpl });
    }

    async function submitOwnership({ serviceUrl, parcelUid, owner, signature, challenge, fetchImpl } = {}) {
        return request(joinUrl(serviceUrl, '/lens/ownership'), { method: 'POST', body: { parcelUid, owner, signature, challenge }, fetchImpl });
    }

    // The token is passed per call and never stored by this module.
    async function postVerdict({ serviceUrl, token, body, fetchImpl } = {}) {
        return request(joinUrl(serviceUrl, '/lens/verdict'), {
            method: 'POST', body, headers: { [OPERATOR_TOKEN_HEADER]: String(token || '') }, fetchImpl
        });
    }

    // Asks every member that declares a serviceUrl about every parcel (ownership only). Members
    // without a URL contribute `attestations: null`, i.e. unknown, never "not covered".
    async function collectParcelCoverage({ members, parcelIds, fetchImpl, concurrency = 6, nowSeconds } = {}) {
        const jobs = [];
        for (const member of members || []) {
            for (const parcelUid of parcelIds || []) jobs.push({ member, parcelUid });
        }
        const results = new Array(jobs.length);
        let next = 0;
        async function worker() {
            while (next < jobs.length) {
                const index = next++;
                const { member, parcelUid } = jobs[index];
                if (!member.serviceUrl) {
                    results[index] = { memberKey: member.key, parcelUid, attestations: null };
                    continue;
                }
                const response = await fetchAttestations({ serviceUrl: member.serviceUrl, filter: { parcelUid, kind: 'ownership' }, fetchImpl });
                results[index] = { memberKey: member.key, parcelUid, attestations: response.attestations };
            }
        }
        await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
        return LensCore.computeParcelCoverage(parcelIds, results, nowSeconds);
    }

    // Owner flow against one member: challenge -> checked message -> wallet signature -> ownership.
    // `sign(bytes)` is the wallet's signMessage. Returns { step, outcome, body, price? } at the first
    // stop; step 'done' carries the attestation. A 402 answers with the member's advertised price.
    async function runOwnershipFlow({ serviceUrl, parcelUid, owner, memberKey = null, sign, fetchImpl, nowMs } = {}) {
        const challengeResult = await requestChallenge({ serviceUrl, parcelUid, owner, fetchImpl });
        if (challengeResult.outcome.kind !== 'ok') return { step: 'challenge', outcome: challengeResult.outcome, body: challengeResult.body };
        const checked = LensCore.checkChallenge(challengeResult.body, { parcelUid, owner, memberKey, nowMs });
        if (!checked.ok) return { step: 'check', outcome: { kind: 'refused', status: 0, code: checked.reason, message: null }, body: challengeResult.body };
        const signature = LensCore.signatureToBase58(await sign(LensCore.encodeMessage(checked.message)));
        const ownership = await submitOwnership({ serviceUrl, parcelUid, owner, signature, challenge: checked.challenge, fetchImpl });
        if (ownership.outcome.kind === 'payment_required') {
            const status = await fetchStatus({ serviceUrl, fetchImpl });
            const price = status.outcome.kind === 'ok' ? LensCore.describeOwnershipPrice(status.body) : null;
            return { step: 'payment', outcome: ownership.outcome, body: ownership.body, price };
        }
        if (ownership.outcome.kind !== 'ok') return { step: 'ownership', outcome: ownership.outcome, body: ownership.body };
        return { step: 'done', outcome: ownership.outcome, body: ownership.body };
    }

    return {
        OPERATOR_TOKEN_HEADER,
        request,
        fetchDirectory,
        fetchStatus,
        fetchAttestations,
        requestChallenge,
        submitOwnership,
        postVerdict,
        collectParcelCoverage,
        runOwnershipFlow
    };
});
