// Read/action sheet for a locally held property offer. Chain actions deliberately operate on the
// immutable published CID; accepting an open offer records the accepting party separately.
(function (root) {
    'use strict';
    const t = (key, fallback, params = {}) => {
        const fullKey = `propertyOffer.${key}`, value = root.i18n?.t?.(fullKey, params);
        return value && value !== fullKey ? value : String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => params[name] ?? match);
    };
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
        let readPromise = null;
        let dialog;
        const render = () => {
            const focused = body.contains(document.activeElement) ? document.activeElement.dataset.action : null;
            const content = record.content;
            const published = record.published?.cid;
            const direction = content.direction === 'buy' ? t('directions.buy', 'Offer to buy') : t('directions.sell', 'Offer to sell');
            const state = chain?.status || record.onchain?.status || (published ? t('states.published', 'Published') : t('states.draft', 'Draft'));
            const scheduledPayouts = chain?.payouts?.length ? chain.payouts : (content.payouts || []);
            const payouts = scheduledPayouts.length ? `<section class="property-offer-panel__section"><h4>${escape(t('fields.payouts', 'Payout schedule'))}</h4><ul class="property-offer-panel__payouts">${scheduledPayouts.map(item => `<li><code title="${escape(item.recipient)}">${escape(item.recipient)}</code><span>${escape(sol(item.lamports))}</span></li>`).join('')}</ul></section>` : '';
            const currentCity = root.CityConfigManager?.getCurrentCityId?.() || root.resolveCurrentCityCode?.() || '';
            const currentSource = currentCity ? root.DesignSync?.parcelSourceIdOf?.(currentCity) : '';
            const parcels = (content.parcels || []).map(parcel => {
                const canLocate = !parcel.snapshotId && content.city === currentCity && parcel.sourceId === currentSource;
                const disabled = canLocate ? '' : ' disabled';
                return `<li><button type="button" class="cb-link property-offer-panel__locate" data-parcel-id="${escape(parcel.id)}"${disabled} aria-label="${escape(t('locateParcel', 'Locate parcel {{id}}', { id: parcel.id }))}">${escape(parcel.id)}</button><span>${escape(t('fields.parcelSource', 'Source'))}: <code>${escape(parcel.sourceId)}</code>${parcel.snapshotId ? ` · ${escape(t('fields.parcelSnapshot', 'Snapshot'))}: <code>${escape(parcel.snapshotId)}</code>` : ''}</span></li>`;
            }).join('');
            const unusedKey = root.PropertyOfferClient?.constants?.DEFAULT_PUBKEY || '11111111111111111111111111111111';
            const buyer = chain?.buyer || content.buyer || (content.direction === 'buy' ? content.proposer : '');
            const seller = chain?.seller || content.seller || (content.direction === 'sell' ? content.proposer : '');
            const roleAddress = value => value && String(value) !== unusedKey ? String(value) : '';
            const roleValue = value => roleAddress(value) ? `<code title="${escape(roleAddress(value))}">${escape(roleAddress(value))}</code>` : escape(t('notSet', 'Not set'));
            body.innerHTML = `<h3>${escape(content.title || direction)}</h3><dl class="property-offer-panel__facts">`
                + row(t('fields.direction', 'Direction'), escape(direction)) + row(t('fields.status', 'Status'), escape(state))
                + row(t('fields.price', 'Total price'), escape(sol(content.priceLamports))) + row(t('fields.deadline', 'Deadline'), escape(new Date(content.expiresAt).toLocaleString()))
                + row(t('fields.bundle', 'Parcel bundle'), escape(t('bundle', '{{count}} parcels — all or nothing', { count: content.parcels.length })))
                + row(t('fields.buyer', 'Buyer'), roleValue(buyer)) + row(t('fields.seller', 'Seller'), roleValue(seller))
                + row(t('fields.proposer', 'Proposer'), `<code title="${escape(content.proposer)}">${escape(short(content.proposer))}</code>`)
                + row(t('fields.lens', 'Lens'), `<code title="${escape(content.lens)}">${escape(short(content.lens))}</code>`) + `</dl>`
                + `<section class="property-offer-panel__section"><h4>${escape(t('fields.parcels', 'Parcels'))}</h4><ul class="property-offer-panel__parcels">${parcels}</ul></section>${payouts}`;
            const cluster = record.onchain?.cluster || root.solanaWalletManager?.getCluster?.() || 'devnet';
            let account = chain?.address || record.onchain?.account;
            if (!account && published) {
                try { account = root.PropertyOfferClient?.getOfferPda?.(published, content.proposer)?.[0]?.toBase58?.() || null; } catch (_) { /* no configured client yet */ }
            }
            if (published && account) {
                const section = document.createElement('section'); section.className = 'property-offer-panel__section';
                const heading = document.createElement('h4'); heading.textContent = t('fields.solanaAccount', 'Solana account'); section.append(heading);
                if (cluster === 'devnet') {
                    const link = document.createElement('a'); link.className = 'cb-link cb-link--external';
                    link.href = `https://explorer.solana.com/address/${encodeURIComponent(account)}?cluster=devnet`;
                    link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = account; section.append(link);
                } else {
                    const value = document.createElement('code'); value.textContent = account; section.append(value);
                    const local = document.createElement('p'); local.className = 'property-offer-panel__hint'; local.textContent = t('localnetExplorerUnavailable', 'Localnet accounts are not available on the public Solana explorer.'); section.append(local);
                }
                body.append(section);
            }
            body.querySelectorAll('[data-parcel-id]:not(:disabled)').forEach(button => button.addEventListener('click', () => root.BusyControl.track(button, async () => {
                const id = button.dataset.parcelId;
                try {
                    if (typeof root.locateParcelById !== 'function') throw new Error(t('errors.locateUnavailable', 'Parcel locating is not available.'));
                    const result = await root.locateParcelById(id);
                    if (!result?.ok) throw new Error(result?.message || t('errors.locateFailed', 'Could not locate this parcel.'));
                    status.textContent = t('parcelLocated', 'Located parcel {{id}}.', { id });
                } catch (locateError) { status.textContent = locateError.message || String(locateError); }
            })));
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
            if (!record.onchain && !chain && !reading && proposer) action('mint', t('mint', 'Mint offer'), true);
            if (published) {
                const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'btn'; refresh.textContent = t('refresh', 'Refresh Solana status');
                refresh.dataset.action = 'refresh';
                if (readPromise) root.BusyControl.track(refresh, readPromise);
                refresh.addEventListener('click', readChain); actions.append(refresh);
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
            if (focused) body.querySelector(`[data-action="${focused}"]`)?.focus();
        };
        function readChain() {
            if (reading || !record.published?.cid) return readPromise;
            reading = true; chainError = null;
            readPromise = Promise.resolve().then(async () => {
                chain = await root.PropertyOfferSolanaBridge.read(record);
                if (chain && !record.onchain && typeof root.PropertyOfferSolanaBridge.refresh === 'function') {
                    try { record = await root.PropertyOfferSolanaBridge.refresh(record); }
                    catch (error) { if (error.record) record = error.record; throw error; }
                }
            }).catch(error => { chainError = error.message || String(error); })
                .finally(() => { reading = false; readPromise = null; render(); });
            render(); return readPromise;
        }
        const unsubscribe = root.solanaWalletManager?.on?.('stateChanged', () => render());
        dialog = root.CbDialog.open({ title: t('details', 'Property offer'), size: 'md', className: 'property-offer-dialog', body, actions: [], onClose: () => unsubscribe?.() });
        render(); if (record.published?.cid) void readChain(); return dialog;
    }
    root.PropertyOfferPanel = Object.freeze({ open });
})(typeof window !== 'undefined' ? window : globalThis);
