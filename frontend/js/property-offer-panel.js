// Read/action sheet for a locally held property offer. Chain actions deliberately operate on the
// immutable published CID; accepting an open offer records the accepting party separately.
(function (root) {
    'use strict';
    const t = (key, fallback, params = {}) => root.i18n?.t?.(`propertyOffer.${key}`, params) || fallback;
    const short = value => { const text = String(value || ''); return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text; };
    const sol = value => root.PropertyOfferDialog?.sol?.(value) || `${value} lamports`;
    const wallet = () => root.PropertyOfferSolanaBridge?.connectedWallet?.() || null;
    const isExpired = record => Date.parse(record.content.expiresAt) <= Date.now();
    const row = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    const escape = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function open(idOrRecord, { error = null } = {}) {
        let record = typeof idOrRecord === 'string' ? root.PropertyOfferStore?.get?.(idOrRecord) : idOrRecord;
        if (!record) throw new Error(t('errors.missing', 'This property offer is not held on this device.'));
        const body = document.createElement('div'); body.className = 'property-offer-panel';
        let chain = null, chainError = error, reading = false;
        let dialog;
        const render = () => {
            const content = record.content;
            const published = record.published?.cid;
            const direction = content.direction === 'buy' ? t('directions.buy', 'Offer to buy') : t('directions.sell', 'Offer to sell');
            const state = chain?.status || record.onchain?.status || (published ? t('states.published', 'Published') : t('states.draft', 'Draft'));
            const scheduledPayouts = chain?.payouts || content.payouts || [];
            const payouts = scheduledPayouts.length ? `<ul class="property-offer-panel__payouts">${scheduledPayouts.map(item => `<li><code title="${escape(item.recipient)}">${escape(short(item.recipient))}</code> ${escape(sol(item.lamports))}</li>`).join('')}</ul>` : '';
            body.innerHTML = `<h3>${escape(content.title || direction)}</h3><dl class="property-offer-panel__facts">`
                + row(t('fields.direction', 'Direction'), escape(direction)) + row(t('fields.status', 'Status'), escape(state))
                + row(t('fields.price', 'Total price'), escape(sol(content.priceLamports))) + row(t('fields.deadline', 'Deadline'), escape(new Date(content.expiresAt).toLocaleString()))
                + row(t('fields.bundle', 'Parcel bundle'), escape(t('bundle', '{{count}} parcels — all or nothing', { count: content.parcels.length })))
                + row(t('fields.proposer', 'Proposer'), `<code title="${escape(content.proposer)}">${escape(short(content.proposer))}</code>`)
                + row(t('fields.lens', 'Lens'), `<code title="${escape(content.lens)}">${escape(short(content.lens))}</code>`) + `</dl>${payouts}`;
            const status = document.createElement('p'); status.className = 'property-offer-panel__status'; status.setAttribute('role', 'status');
            status.textContent = reading ? t('reading', 'Reading Solana…') : (chainError || ''); body.append(status);
            const actions = document.createElement('div'); actions.className = 'cb-actions property-offer-panel__actions';
            const action = (name, label, primary = false) => {
                if (typeof root.PropertyOfferSolanaBridge?.[name] !== 'function') return false;
                const button = document.createElement('button'); button.type = 'button'; button.className = `btn${primary ? ' btn-primary' : ''}`; button.textContent = label;
                button.addEventListener('click', () => root.BusyControl.track(button, async () => {
                    status.textContent = t('working', 'Working…');
                    const api = root.PropertyOfferSolanaBridge;
                    if (!api?.[name]) throw new Error(t('errors.chainUnavailable', 'Solana property-offer actions are not available yet.'));
                    record = await (name === 'mint' ? root.PropertyOfferSync.mint(record) : api[name](record));
                    status.textContent = t('saved', 'Saved.'); await readChain(); render();
                }).catch(error => { if (error.record) record = error.record; status.textContent = error.message; })); actions.append(button); return true;
            };
            const mine = wallet(); const proposer = content.proposer === mine;
            if (!record.onchain && proposer) action('mint', t('mint', 'Mint offer'), true);
            if (published) {
                if (record.onchain) {
                    const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'btn'; refresh.textContent = t('refresh', 'Refresh Solana status');
                    refresh.addEventListener('click', () => readChain()); actions.append(refresh);
                }
                if (chain?.status === 'Open' && !isExpired(record)) {
                    if (typeof root.PropertyOfferSolanaBridge?.accept === 'function') {
                        const accept = document.createElement('button'); accept.type = 'button'; accept.className = 'btn btn-primary'; accept.textContent = t('accept', 'Accept offer');
                        accept.addEventListener('click', () => root.PropertyOfferDialog?.accept?.(record)); actions.append(accept);
                    }
                    if (proposer) action('cancel', t('cancelOffer', 'Cancel offer'));
                }
                if (chain?.status === 'Accepted' && !isExpired(record)) {
                    if (mine && mine === chain.buyer && chain.escrowLamports === 0n) action('fund', t('fund', 'Fund'), true);
                    if (chain.escrowLamports >= chain.priceLamports) action('release', t('execute', 'Execute'));
                }
                if (['Open', 'Accepted'].includes(chain?.status) && isExpired(record)) action('expire', t('expire', 'Expire offer'));
            }
            body.append(actions);
        };
        async function readChain() {
            if (reading || !record.onchain) return;
            reading = true; chainError = null; render();
            try { chain = await root.PropertyOfferSolanaBridge.read(record); }
            catch (error) { chainError = error.message || String(error); }
            finally { reading = false; render(); }
        }
        dialog = root.CbDialog.open({ title: t('details', 'Property offer'), size: 'md', className: 'property-offer-dialog', body, actions: [] });
        render(); if (record.onchain) void readChain(); return dialog;
    }
    root.PropertyOfferPanel = Object.freeze({ open });
})(typeof window !== 'undefined' ? window : globalThis);
