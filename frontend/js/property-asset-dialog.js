// One plot or one flat: who holds it according to the reader's lens, the offers on it, and what a
// person can do (sell, bid, ask lens members to confirm they hold it) or, as a lens member, state who
// first holds it or withdraw that statement. Also the Lens requests screen: what waits for the
// connected wallet as a lens member.
(function (root) {
    'use strict';
    const t = (key, fallback, params = {}) => {
        const fullKey = `propertyOffer.${key}`, value = root.i18n?.t?.(fullKey, params);
        return value && value !== fullKey ? value : String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => params[name] ?? m);
    };
    const tt = (key, fallback, params = {}) => { const value = root.i18n?.t?.(key, params); return value && value !== key ? value : String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, n) => params[n] ?? m); };
    const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
    const D = () => root.PropertyOfferDialog;
    const bridge = () => root.PropertyOfferSolanaBridge;
    const wallet = () => bridge()?.connectedWallet?.() || null;
    const keyEl = (key, mine) => root.KeyLabel.element(key, { you: key === mine, t: tt });
    const base = () => root.resolveBackendBaseUrl().replace(/\/$/, '');
    async function api(path, body) {
        const response = await root.fetch(`${base()}${path}`, { method: body ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(30000),
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || result.message || `HTTP ${response.status}`);
        return result;
    }
    function offerRow(row, onOpen) {
        const item = el('li', 'property-market__row');
        const c = row.content;
        const text = el('span', 'property-market__text', `${c.direction === 'sell' ? t('forSale', 'For sale') : t('wanted', 'Wanted')} · ${D().money(c.price, c.currency)}`);
        const state = el('span', 'cb-badge', t(`status.${row.status}`, row.status || ''));
        const open = el('button', 'btn btn-quiet', t('open', 'Open')); open.type = 'button';
        open.addEventListener('click', () => onOpen(row));
        item.append(text, state, open);
        return item;
    }
    async function openRow(row) { root.PropertyOfferPanel.open((await root.PropertyOfferSync.importOffer(row.cid)).id); }

    /** Ask lens members to state that the connected wallet holds the asset: signed, then listed for them. */
    function requestHolding({ asset, city, parent }) {
        let dialog;
        const form = el('form', 'property-offer-form');
        form.append(el('p', 'property-offer-form__what', D().assetLabel(asset)));
        form.append(el('p', 'sheet-note', t('requestHint', 'Lens members you name see your request. Each decides for itself whether to state that you hold this; nothing happens until one does.')));
        const lens = D().lensField({ legend: t('fields.askLens', 'Lens members to ask'), required: true, parent: () => dialog?.overlay,
            initial: { members: (root.LensPicker?.getEntries?.() || []).map(e => e.address).slice(0, 8), threshold: 1 } });
        form.append(lens.element);
        const note = el('label', 'property-offer-form__field', t('fields.note', 'Evidence or note for them (optional)'));
        const noteInput = el('textarea'); noteInput.maxLength = 1000; noteInput.rows = 3; note.append(noteInput); form.append(note);
        const status = el('p', 'property-offer-form__status'); status.setAttribute('role', 'status'); form.append(status);
        const submit = async () => {
            const claimant = wallet();
            if (!claimant) throw new Error(t('errors.wallet', 'Connect a Solana wallet first.'));
            const members = lens.value().members;
            if (!members.length) throw new Error(t('errors.askLens', 'Name at least one lens member to ask.'));
            const request = { city, asset, claimant, lensMembers: members, note: noteInput.value.trim(), createdAt: new Date().toISOString() };
            const signature = await bridge().signMessage(root.HoldingRequest.message(request));
            await api('/holding-requests', { request, signature });
            dialog.close();
            root.showToast?.(t('requestSent', 'Request sent to {{count}} lens member(s).', { count: members.length }));
        };
        dialog = root.CbDialog.open({ title: t('requestTitle', 'Ask lens members to confirm you hold this'), size: 'md', className: 'property-offer-dialog', body: form, parent,
            actions: [{ id: 'cancel', label: t('cancel', 'Cancel') }, { id: 'send', label: t('sendRequest', 'Sign and send'), role: 'primary', keepOpen: true }] });
        form.id = `${dialog.body.id}-form`;
        const send = dialog.getActionButton('send'); send.type = 'submit'; send.setAttribute('form', form.id);
        form.addEventListener('submit', event => { event.preventDefault(); root.BusyControl.track(send, submit).catch(error => { status.textContent = error.message; }); });
        return dialog;
    }

    /** As a lens member, state who first holds the asset (holder and basis), from the connected wallet. */
    function stateHolder({ asset, holder = '', basis = 'developer', evidence = '', onDone }) {
        let dialog;
        const form = el('form', 'property-offer-form');
        form.append(el('p', 'property-offer-form__what', D().assetLabel(asset)));
        form.append(el('p', 'sheet-note', t('stateHint', 'You state, as a lens member, who first holds this. Anyone who trusts you will see it; sales you confirm later move it on. You can state one first holder per plot or flat, and withdraw it.')));
        const holderField = el('label', 'property-offer-form__field', t('fields.holder', 'Holder’s Solana wallet'));
        const holderInput = el('input'); holderInput.required = true; holderInput.value = holder || wallet() || ''; holderField.append(holderInput); form.append(holderField);
        const basisField = el('label', 'property-offer-form__field', t('fields.basis', 'On what basis'));
        const basisSelect = el('select');
        for (const [value, label] of [['developer', t('basis.developer', 'Developer of a new building')], ['declared', t('basis.declared', 'The holder’s own declaration, checked by me')], ['registry', t('basis.registry', 'An official register')]]) {
            const o = el('option', '', label); o.value = value; o.selected = value === basis; basisSelect.append(o);
        }
        basisField.append(basisSelect); form.append(basisField);
        const evidenceField = el('label', 'property-offer-form__field', t('fields.evidence', 'Evidence (a reference or link, optional)'));
        const evidenceInput = el('input'); evidenceInput.maxLength = 300; evidenceInput.value = evidence; evidenceField.append(evidenceInput); form.append(evidenceField);
        const status = el('p', 'property-offer-form__status'); status.setAttribute('role', 'status'); form.append(status);
        const submit = async () => {
            if (!root.LensCore.isBase58Pubkey(holderInput.value.trim())) throw new Error(t('errors.holder', 'Enter the holder’s Solana wallet address.'));
            await bridge().stateHolding({ asset, holder: holderInput.value.trim(), basis: basisSelect.value, evidence: evidenceInput.value.trim(), onStatus: s => { status.textContent = D().progressText(s.state); } });
            dialog.close(); onDone?.();
        };
        dialog = root.CbDialog.open({ title: t('stateTitle', 'State who holds this'), size: 'md', className: 'property-offer-dialog', body: form,
            actions: [{ id: 'cancel', label: t('cancel', 'Cancel') }, { id: 'state', label: t('stateAction', 'Sign the statement'), role: 'primary', keepOpen: true }] });
        form.id = `${dialog.body.id}-form`;
        const go = dialog.getActionButton('state'); go.type = 'submit'; go.setAttribute('form', form.id);
        form.addEventListener('submit', event => { event.preventDefault(); root.BusyControl.track(go, submit).catch(error => { status.textContent = error.message; }); });
        return dialog;
    }

    /** The asset's sheet: ownership according to your lens, its offers, and the actions. */
    function open({ asset, city }) {
        let dialog;
        const body = el('div', 'property-offer-panel');
        const render = async () => {
            const mine = wallet();
            body.replaceChildren();
            const holder = el('section', 'property-offer-panel__section'); body.append(holder);
            const offers = el('section', 'property-offer-panel__section'); offers.append(el('h4', '', t('offersOnIt', 'Offers on it')));
            const list = el('ul', 'property-market__list'); offers.append(list); body.append(offers);
            const own = el('section', 'property-offer-panel__section'); body.append(own);
            const actions = el('div', 'cb-actions property-offer-panel__actions'); body.append(actions);
            const action = (label, run, primary) => { const b = el('button', `btn${primary ? ' btn-primary' : ''}`, label); b.type = 'button'; b.addEventListener('click', run); actions.append(b); };
            action(t('sellIt', 'Put up for sale'), () => { dialog.close(); D().open({ direction: 'sell', asset, city }); }, true);
            action(t('bidOnIt', 'Offer to buy'), () => { dialog.close(); D().open({ direction: 'buy', asset, city }); });
            action(t('askConfirm', 'Ask lens members to confirm you hold it'), () => requestHolding({ asset, city, parent: dialog.overlay }));
            action(t('stateHolder', 'State who holds it (as a lens member)'), () => stateHolder({ asset, onDone: render }));
            const hash = root.PropertyOfferRecord.assetHash(asset);
            const members = (root.LensPicker?.getEntries?.() || []).map(entry => entry.address).filter(Boolean);
            holder.append(el('h4', '', t('yourLens', 'According to your lens')));
            const holderText = el('div', 'property-offer-panel__holder', t('reading', 'Reading Solana…')); holder.append(holderText);
            const [view, rows] = await Promise.allSettled([members.length ? bridge().lensView([...new Set([...members, ...(mine ? [mine] : [])])], asset) : Promise.resolve(null),
                root.PropertyOfferSync.list({ asset: hash, status: 'open,committed,settled', limit: 20 })]);
            holderText.replaceChildren();
            if (!members.length) holderText.textContent = t('noLens', 'You have not chosen whom you trust yet. Choose lens members to see who holds this.');
            else if (view.status === 'rejected') holderText.textContent = view.reason.message;
            else {
                const lensViews = view.value.views.filter(v => members.includes(v.member));
                const named = [...new Set(lensViews.filter(v => v.holder).map(v => v.holder))];
                if (named.length === 1) holderText.append(el('span', '', t('holderIs', 'Held by ')), keyEl(named[0], mine));
                else if (named.length > 1) { holderText.append(el('span', '', t('holderConflict', 'Your lens members disagree: '))); named.forEach(k => holderText.append(keyEl(k, mine))); }
                else holderText.textContent = t('holderUnknown', 'None of your lens members states who holds this.');
                const ul = el('ul', 'property-offer-panel__members');
                for (const v of lensViews) { const li = el('li'); li.append(keyEl(v.member, mine), el('span', 'property-offer-panel__mark', v.holder ? t('says', 'says {{holder}}', { holder: root.KeyLabel.short(v.holder) }) : t('saysNothing', 'states nothing'))); ul.append(li); }
                holder.append(ul);
                const self = mine && view.value.views.find(v => v.member === mine);
                if (self?.first) {
                    own.append(el('h4', '', t('yourStatement', 'Your statement as a lens member')));
                    const p = el('p', '', t('youStated', 'You stated the first holder: ')); p.append(keyEl(self.first.holder, mine)); own.append(p);
                    const withdraw = el('button', 'btn btn-quiet', t('withdraw', 'Withdraw my statement')); withdraw.type = 'button';
                    withdraw.addEventListener('click', () => root.BusyControl.track(withdraw, async () => { await bridge().withdraw({ attestation: self.first.address }); await render(); }));
                    own.append(withdraw);
                }
            }
            if (rows.status === 'rejected') list.append(el('li', 'sheet-note', rows.reason.message));
            else if (!rows.value.propertyOffers?.length) list.append(el('li', 'sheet-note', t('noOffers', 'No offers on it yet.')));
            else rows.value.propertyOffers.forEach(row => list.append(offerRow(row, r => { dialog.close(); void openRow(r); })));
        };
        dialog = root.CbDialog.open({ title: D().assetLabel(asset), size: 'md', className: 'property-offer-dialog', body, actions: [] });
        void render();
        root.KeyLabel.loadNames().then(() => render());
        return dialog;
    }

    /** Lens requests: what waits for the connected wallet as a lens member. */
    function openRequests() {
        let dialog;
        const body = el('div', 'property-offer-panel');
        const render = async () => {
            const mine = wallet();
            body.replaceChildren();
            if (!mine) { body.append(el('p', '', t('requestsConnect', 'Connect the wallet of a lens member to see what waits for it.'))); return; }
            const offers = el('section', 'property-offer-panel__section'); offers.append(el('h4', '', t('awaitingOffers', 'Sales waiting for your confirmation')));
            const offerList = el('ul', 'property-market__list'); offers.append(offerList);
            const asks = el('section', 'property-offer-panel__section'); asks.append(el('h4', '', t('awaitingHoldings', 'People asking you to confirm they hold something')));
            const askList = el('ul', 'property-market__list'); asks.append(askList);
            body.append(offers, asks);
            const [waiting, requests] = await Promise.allSettled([root.PropertyOfferSync.awaiting(mine), api(`/holding-requests?member=${encodeURIComponent(mine)}`)]);
            if (waiting.status === 'rejected') offerList.append(el('li', 'sheet-note', waiting.reason.message));
            else if (!waiting.value.propertyOffers?.length) offerList.append(el('li', 'sheet-note', t('nothingWaiting', 'Nothing waits for you.')));
            else waiting.value.propertyOffers.forEach(row => {
                const item = offerRow(row, r => { dialog.close(); void openRow(r); });
                item.prepend(el('span', 'property-market__what', D().assetLabel(row.content.asset)));
                offerList.append(item);
            });
            if (requests.status === 'rejected') askList.append(el('li', 'sheet-note', requests.reason.message));
            else if (!requests.value.holdingRequests?.length) askList.append(el('li', 'sheet-note', t('nothingWaiting', 'Nothing waits for you.')));
            else for (const request of requests.value.holdingRequests.map(row => ({ ...row.request, id: row.id }))) {
                const item = el('li', 'property-market__row');
                item.append(el('span', 'property-market__what', D().assetLabel(request.asset)), keyEl(request.claimant, mine));
                if (request.note) item.append(el('span', 'sheet-note', request.note));
                const show = el('a', 'cb-link', t('show', 'Show')); show.href = D().assetHref(request.asset, request.city); item.append(show);
                const state = el('button', 'btn btn-primary', t('stateTheyHold', 'State they hold it')); state.type = 'button';
                state.addEventListener('click', () => stateHolder({ asset: request.asset, holder: request.claimant, basis: 'declared', evidence: `holding-request:${request.id}`, onDone: render }));
                item.append(state);
                askList.append(item);
            }
        };
        const unsubscribe = root.solanaWalletManager?.on?.('stateChanged', () => void render());
        dialog = root.CbDialog.open({ title: t('requestsTitle', 'Lens requests'), size: 'md', className: 'property-offer-dialog', body, actions: [], onClose: () => unsubscribe?.() });
        void render();
        root.KeyLabel.loadNames().then(() => render());
        return dialog;
    }

    root.PropertyAssetDialog = Object.freeze({ open, openRequests, requestHolding, stateHolder });
})(typeof window !== 'undefined' ? window : globalThis);
