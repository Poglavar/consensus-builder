// Publication and browser copies of standalone purchase/sale agreements.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = { browser: factory };
    if (root?.document) root.PropertyOfferSync = factory(root);
})(typeof window === 'undefined' ? null : window, function (win) {
    'use strict';
    const store = () => win.PropertyOfferStore;
    const records = () => win.PropertyOfferRecord;
    const base = () => win.resolveBackendBaseUrl().replace(/\/$/, '');
    const localCopyOf = cid => store().list().find(record => record.published?.cid === cid) || null;
    async function request(path, body) {
        const response = await win.fetch(`${base()}/property-offers${path}`, {
            method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(30000),
            headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        const result = await response.json();
        if (!response.ok && !(response.status === 409 && result.cid)) throw Object.assign(new Error(result.error || `HTTP ${response.status}`), { code: result.code });
        return result;
    }
    function create(content) {
        return store().save({ id: records().newId(), content: records().published(content), published: null, onchain: null, acceptance: null });
    }
    function localRecord(row, existing) {
        return { ...existing, id: existing?.id || records().newId(), content: row.content,
            published: { cid: row.cid, publishedAt: row.createdAt, apiBase: base() },
            onchain: row.onchain || existing?.onchain || null, acceptance: row.acceptance || null };
    }
    async function fetchOffer(cid) {
        if (!win.Cid.isCid(cid)) throw new Error('Invalid property offer CID.');
        const row = await request(`/${encodeURIComponent(cid)}`);
        if (row.cid !== cid || records().cid(row.content) !== cid) throw new Error('Property offer content does not match its CID.');
        return row;
    }
    async function publish(record) {
        const current = typeof record === 'string' ? store().get(record) : record;
        const content = records().published(current.content), cid = records().cid(content);
        const row = await request('', { cid, content });
        if (row.cid !== cid || records().cid(row.content) !== cid) throw new Error('Published offer content does not match its CID.');
        return store().save(localRecord(row, current));
    }
    async function importOffer(cid) { return store().save(localRecord(await fetchOffer(cid), localCopyOf(cid))); }
    async function openDetails(cid) { const record = await importOffer(cid); return win.PropertyOfferPanel.open(record.id); }
    function link(cid, { city } = {}) {
        const record = localCopyOf(cid);
        const url = new URL(`/property-offers/${encodeURIComponent(cid)}`, win.resolveFrontendBaseUrl());
        url.searchParams.set('city', city || record?.content.city || win.resolveCurrentCityCode());
        // Carry an explicit development backend through shared local links.
        const current = new URL(win.location.href);
        if (current.searchParams.has('backend')) url.searchParams.set('backend', current.searchParams.get('backend'));
        for (const name of ['at', 'lang']) if (current.searchParams.has(name)) url.searchParams.set(name, current.searchParams.get(name));
        return url.href;
    }
    async function recordOnchain(record, ref) {
        const row = await request(`/${encodeURIComponent(record.published.cid)}/onchain`, ref);
        return store().save(localRecord(row, record));
    }
    function download(record) {
        const blob = new Blob([JSON.stringify(record.content, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob), a = win.document.createElement('a');
        a.href = url; a.download = `property-offer-${record.published?.cid || record.id}.json`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    return Object.freeze({ create, publish, fetchOffer, importOffer, openDetails, link, localCopyOf, recordOnchain, download, request });
});
