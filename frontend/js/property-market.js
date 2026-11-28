// The Market sheet: plots and flats for sale, wanted or sold, in the map area or the whole city, from the
// offer index. Each row says what, where it stands and the price (a sale also who bought it from whom),
// links the plot or flat and opens the offer. The header
// reaches the reader's own lens (whom they trust), their offers and, for lens members, the requests
// that wait for them.
(function (root) {
    'use strict';
    const SHEET_ID = 'market-sheet';
    const doc = root.document;
    const t = (key, fallback, params = {}) => {
        const fullKey = `propertyOffer.${key}`, value = root.i18n?.t?.(fullKey, params);
        return value && value !== fullKey ? value : String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => params[name] ?? m);
    };
    const tt = (key, fallback, params = {}) => { const value = root.i18n?.t?.(key, params); return value && value !== key ? value : String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, n) => params[n] ?? m); };
    const el = (tag, className, text) => { const e = doc.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
    const state = { side: 'sell', kind: '', area: true, mine: false, rows: [], hasMore: false, offset: 0, loading: false, error: null };
    const city = () => root.resolveCurrentCityCode?.() || '';

    function filters() {
        // Sold: offers settled on chain, whichever side made them.
        const f = state.side === 'sold' ? { city: city(), status: 'settled', limit: 30, offset: state.offset }
            : { city: city(), direction: state.side, status: 'open,committed', limit: 30, offset: state.offset };
        if (state.kind) f.kind = state.kind;
        if (state.mine) { const wallet = root.PropertyOfferSolanaBridge?.connectedWallet?.(); if (wallet) f.maker = wallet; }
        if (state.area && root.map?.getBounds) { const b = root.map.getBounds(); f.bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(v => v.toFixed(5)).join(','); }
        return f;
    }
    async function load({ more = false } = {}) {
        if (!more) { state.offset = 0; state.rows = []; }
        state.loading = true; state.error = null; render();
        try {
            const result = await root.PropertyOfferSync.list(filters());
            state.rows = [...state.rows, ...(result.propertyOffers || [])];
            state.hasMore = !!result.hasMore; state.offset = result.nextOffset || state.rows.length;
        } catch (error) { state.error = error.message; }
        state.loading = false; render();
    }
    function segmented(name, options, value, onChange) {
        const group = el('div', 'cb-segmented'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', name);
        for (const [key, label] of options) {
            const b = el('button', 'cb-segmented__option', label); b.type = 'button';
            b.setAttribute('aria-pressed', String(key === value));
            b.addEventListener('click', () => { if (key !== value) onChange(key); });
            group.append(b);
        }
        return group;
    }
    function row(offer) {
        const c = offer.content, D = root.PropertyOfferDialog;
        const item = el('li', 'property-market__row');
        const what = el('span', 'property-market__what', D.assetLabel(c.asset));
        const price = el('strong', 'property-market__price', D.money(c.price, c.currency));
        const stateBadge = el('span', `cb-badge property-market__state property-market__state--${offer.status}`, offer.status === 'settled' ? t('market.sold', 'Sold')
            : offer.status === 'committed' ? t('status.committed', 'Sale in progress') : c.direction === 'sell' ? t('forSale', 'For sale') : t('wanted', 'Wanted'));
        const open = el('button', 'btn btn-quiet', t('open', 'Open')); open.type = 'button';
        open.setAttribute('aria-label', `${t('open', 'Open')}: ${D.assetLabel(c.asset)}, ${D.money(c.price, c.currency)}`);
        open.addEventListener('click', () => root.BusyControl.track(open, async () => root.PropertyOfferPanel.open((await root.PropertyOfferSync.importOffer(offer.cid)).id)));
        item.append(what, price, stateBadge);
        if (c.title) item.append(el('span', 'sheet-note property-market__title', c.title));
        if (offer.status === 'settled' && offer.onchain) {
            const parties = el('span', 'sheet-note property-market__parties');
            const mine = root.PropertyOfferSolanaBridge?.connectedWallet?.() || null;
            const key = k => root.KeyLabel.element(k, { you: k === mine, t: tt });
            parties.append(el('span', '', `${t('fields.buyer', 'Buyer')}: `), key(offer.onchain.buyer), el('span', '', ` · ${t('fields.seller', 'Seller')}: `), key(offer.onchain.seller));
            item.append(parties);
        }
        const asset = el('a', 'cb-link property-market__asset', c.asset.kind === 'flat' ? t('viewFlat', 'View the flat in X-ray') : t('viewPlot', 'Show the plot on the map'));
        asset.href = D.assetHref(c.asset, c.city);
        item.append(asset, open);
        return item;
    }
    function render() {
        const body = doc.getElementById('market-sheet-content');
        if (!body) return;
        body.replaceChildren();
        const tools = el('div', 'property-market__tools');
        const lens = el('button', 'btn btn-quiet', t('market.yourLens', 'Whom you trust')); lens.type = 'button';
        lens.addEventListener('click', () => root.LensPicker.show());
        const requests = el('button', 'btn btn-quiet', t('market.requests', 'Lens requests')); requests.type = 'button';
        requests.addEventListener('click', () => root.PropertyAssetDialog.openRequests());
        tools.append(lens, requests);
        body.append(tools);
        body.append(segmented(t('market.side', 'Side'), [['sell', t('forSale', 'For sale')], ['buy', t('wanted', 'Wanted')], ['sold', t('market.sold', 'Sold')]], state.side, v => { state.side = v; void load(); }));
        body.append(segmented(t('market.kind', 'What'), [['', t('market.all', 'All')], ['flat', t('market.flats', 'Flats')], ['parcel', t('market.plots', 'Plots')]], state.kind, v => { state.kind = v; void load(); }));
        const toggles = el('div', 'property-market__toggles');
        for (const [key, label] of [['area', t('market.inArea', 'Only in the map area')], ['mine', t('market.mine', 'Only mine')]]) {
            const l = el('label', 'property-offer-form__choice'); const box = el('input'); box.type = 'checkbox'; box.checked = state[key];
            box.addEventListener('change', () => { state[key] = box.checked; void load(); });
            l.append(box, el('span', '', label)); toggles.append(l);
        }
        body.append(toggles);
        const status = el('p', 'property-market__status'); status.setAttribute('role', 'status');
        status.textContent = state.loading ? (root.i18n?.t?.('common.busy.loading') || 'Loading…') : state.error || (state.rows.length ? t('market.count', '{{count}} shown', { count: state.rows.length }) : t('market.empty', 'Nothing here yet. Move the map, change the filters, or put something up for sale from a plot or a flat.'));
        body.append(status);
        const list = el('ul', 'property-market__list');
        state.rows.forEach(offer => list.append(row(offer)));
        body.append(list);
        if (state.hasMore && !state.loading) { const more = el('button', 'btn', t('market.more', 'Show more')); more.type = 'button'; more.addEventListener('click', () => load({ more: true })); body.append(more); }
    }
    function init() {
        doc.addEventListener('mapshell:sheetopened', event => { if (event.detail?.id === SHEET_ID) void load(); });
        // Buyers and sellers are shown by name once the key names are known.
        root.KeyLabel?.loadNames?.().then(() => { if (root.MapShell?.isOpen?.(SHEET_ID)) render(); });
        root.map?.on?.('moveend', () => { if (state.area && !state.loading && root.MapShell?.isOpen?.(SHEET_ID)) void load(); });
    }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
    root.PropertyMarket = Object.freeze({ SHEET_ID, load, render });
})(window);
