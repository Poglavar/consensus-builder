// Making and taking property offers for one plot or one flat. Making: price in SOL or USDC, a
// deadline and the maker's side lens (a buyer's lens confirms the seller holds it; a seller may name a
// lens that must qualify the buyer). Taking: the other side names its lens, and a buyer pays into
// escrow in the same approval. Shared helpers (asset labels, money, the lens field) live here too.
(function (root) {
    'use strict';
    const t = (key, fallback, params = {}) => {
        const fullKey = `propertyOffer.${key}`, value = root.i18n?.t?.(fullKey, params);
        return value && value !== fullKey ? value : String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => params[name] ?? m);
    };
    const tt = (key, fallback, params = {}) => { const value = root.i18n?.t?.(key, params); return value && value !== key ? value : String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, n) => params[n] ?? m); };
    const node = (tag, className, text) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };
    const Record = () => root.PropertyOfferRecord;
    const connectedWallet = () => root.PropertyOfferSolanaBridge?.connectedWallet?.() || '';
    const currentCity = () => root.CityConfigManager?.getCurrentCityId?.() || root.resolveCurrentCityCode?.() || '';
    const localDateTime = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

    /** "1.25 SOL", "250 USDC". */
    const money = (base, currency) => `${Record().formatAmount(base, currency)} ${currency}`;
    /** What is offered, in words: "Plot KZ-…" or "Floor 5, flat 2". */
    function assetLabel(asset) {
        if (asset?.kind === 'parcel') return t('asset.plot', 'Plot {{id}}', { id: asset.id });
        if (asset?.kind === 'flat') {
            const [level, flat] = root.BuildingUnitLinks.apartmentUnitLocator(asset.unit) || [];
            const storey = root.StoreyNumbering?.storeyLabel?.(Number(level), tt) || `Floor ${level}`;
            return t('asset.flat', '{{storey}}, flat {{flat}}', { storey, flat });
        }
        return '';
    }
    /** A link that opens the asset: the flat in X-ray, or the plot on the map. */
    function assetHref(asset, city) {
        const backend = new URL(root.location.href).searchParams.get('backend');
        if (asset.kind === 'flat') {
            return root.BuildingUnitLinks.offerLink(root.location.href, root.MapShare, { city, language: root.i18n?.getLanguage?.(), ...(backend ? { backend } : {}) }, asset);
        }
        const url = new URL(`/parcel/${encodeURIComponent(asset.id)}`, root.location.href);
        url.searchParams.set('city', city); url.searchParams.set('at', asset.at);
        if (backend) url.searchParams.set('backend', backend);
        return url.href;
    }
    // A plot as an offer names it: its parcel source, id and centre, from the live parcel fabric.
    function plotAsset(parcelId, city = currentCity()) {
        const feature = root.LiveParcelFabric?.get?.(String(parcelId));
        const properties = feature?.properties || {};
        const id = properties.parcelId ?? properties.id ?? feature?.id;
        const sourceId = properties.parcelSource?.sourceId || root.DesignSync?.parcelSourceIdOf?.(city);
        if (!feature?.geometry || id == null || !sourceId) throw new Error(t('errors.parcel', 'This plot is not loaded. Reload parcels and try again.'));
        const [lng, lat] = root.turf.centroid(feature).geometry.coordinates;
        return { kind: 'parcel', sourceId: String(sourceId), id: String(id), at: `${lat.toFixed(6)},${lng.toFixed(6)},18` };
    }

    /**
     * Lens members and how many must confirm: chosen from the lens directory (or pasted keys), shown
     * as key labels. Starts empty or from `initial`; the person's lens preference fills it by default.
     */
    function lensField({ legend, hint, required, initial, parent }) {
        const field = node('fieldset', 'property-offer-form__lens');
        field.append(node('legend', '', legend));
        if (hint) field.append(node('p', 'sheet-note', hint));
        const chips = node('div', 'property-offer-form__lensMembers');
        const threshold = node('select'); threshold.setAttribute('aria-label', t('fields.threshold', 'Confirmations needed'));
        const thresholdLabel = node('label', 'property-offer-form__threshold', t('fields.threshold', 'Confirmations needed'));
        thresholdLabel.append(threshold);
        const choose = node('button', 'btn btn-quiet', t('chooseLens', 'Choose lens members')); choose.type = 'button';
        let members = [...new Set((initial?.members || []).filter(Boolean))];
        let wanted = initial?.threshold || 1;
        const render = () => {
            chips.replaceChildren(...(members.length ? members.map(key => root.KeyLabel.element(key, { t: tt })) : [node('span', 'property-offer-form__empty', required ? t('lensEmptyRequired', 'No lens members yet: choose at least one.') : t('lensEmpty', 'None: anyone may take this offer.'))]));
            threshold.replaceChildren(...members.map((_, i) => { const o = node('option', '', String(i + 1)); o.value = String(i + 1); return o; }));
            thresholdLabel.hidden = members.length < 2;
            threshold.value = String(Math.min(Math.max(wanted, 1), members.length || 1));
        };
        threshold.addEventListener('change', () => { wanted = Number(threshold.value); });
        choose.addEventListener('click', () => root.LensPicker.show({ parent: typeof parent === 'function' ? parent() : parent, entries: members.map(address => ({ address })),
            onClose: entries => { members = [...new Set(entries.map(entry => entry.address).filter(Boolean))].slice(0, Record().MAX_LENS); render(); choose.focus(); } }));
        field.append(chips, thresholdLabel, choose);
        root.KeyLabel.loadNames().then(render);
        render();
        return { element: field, value: () => ({ members: [...members], threshold: members.length ? Number(threshold.value) : 0 }) };
    }
    const preferredLens = () => ({ members: (root.LensPicker?.getEntries?.() || []).map(entry => entry.address).filter(Boolean).slice(0, 8), threshold: 1 });

    function walletRow(form, onConnected) {
        const row = node('div', 'property-offer-form__wallet');
        const show = () => {
            const wallet = connectedWallet();
            row.replaceChildren(node('span', 'property-offer-form__walletLabel', t('fields.wallet', 'Your Solana wallet')));
            if (wallet) { row.append(root.KeyLabel.element(wallet, { you: true, t: tt })); return; }
            const connect = node('button', 'btn btn-primary', tt('wallet.connect', 'Connect wallet')); connect.type = 'button';
            connect.addEventListener('click', () => root.BusyControl.track(connect, async () => {
                await root.walletManager.openConnectorModal({ chain: 'solana' })?.dialog.closed;
                if (connectedWallet()) { show(); onConnected?.(connectedWallet()); }
            }));
            row.append(connect);
        };
        show(); form.append(row);
        return row;
    }
    function currencyField(form, initial = 'USDC') {
        const field = node('fieldset', 'property-offer-form__currency');
        field.append(node('legend', '', t('fields.currency', 'Paid in')));
        for (const currency of ['USDC', 'SOL']) {
            const label = node('label', 'property-offer-form__choice'); const input = node('input');
            input.type = 'radio'; input.name = 'property-offer-currency'; input.value = currency; input.checked = currency === initial;
            label.append(input, node('span', '', currency === 'USDC' ? t('currency.usdc', 'USDC (devnet dollars)') : t('currency.sol', 'SOL')));
            field.append(label);
        }
        form.append(field);
        return () => field.querySelector('input:checked')?.value || initial;
    }
    function statusLine(form) { const status = node('p', 'property-offer-form__status'); status.setAttribute('role', 'status'); form.append(status); return status; }
    const progressText = state => ({ preparing: t('progress.preparing', 'Preparing the transaction…'), awaiting_signature: t('progress.sign', 'Approve it in your wallet…'),
        submitted: t('progress.submitted', 'Sent; waiting for Solana to confirm…'), confirmed: t('progress.confirmed', 'Confirmed on Solana.') })[state] || '';

    /** Make an offer for one asset. */
    function open({ direction, asset, city = currentCity() }) {
        if (!['buy', 'sell'].includes(direction)) throw new Error('Invalid offer direction.');
        if (!root.CbDialog?.open) throw new Error(t('errors.dialog', 'The offer dialog is not available yet.'));
        if (asset.kind === 'flat') { const [sourceCity] = root.BuildingUnitLinks.apartmentLocator(asset.xrayBuilding); if (sourceCity !== 'design') city = sourceCity; }
        let dialog;
        const form = node('form', 'property-offer-form');
        form.append(node('p', 'property-offer-form__what', assetLabel(asset)));
        walletRow(form);
        const currency = currencyField(form);
        const price = node('label', 'property-offer-form__field', direction === 'buy' ? t('fields.bid', 'Your price') : t('fields.ask', 'Asking price'));
        const priceInput = node('input'); priceInput.type = 'text'; priceInput.inputMode = 'decimal'; priceInput.placeholder = '0'; priceInput.required = true; price.append(priceInput); form.append(price);
        const deadline = node('label', 'property-offer-form__field', t('fields.deadline', 'Valid until'));
        const deadlineInput = node('input'); deadlineInput.type = 'datetime-local'; deadlineInput.required = true;
        deadlineInput.value = localDateTime(new Date(Date.now() + 14 * 86400000)); deadline.append(deadlineInput); form.append(deadline);
        const lens = lensField(direction === 'buy'
            ? { legend: t('fields.buyerLens', 'Whom you trust to confirm the seller holds it'), hint: t('buyerLensHint', 'Your money waits in escrow until these lens members confirm the seller holds this; otherwise it returns to you after the deadline.'), required: true, initial: preferredLens(), parent: () => dialog?.overlay }
            : { legend: t('fields.sellerLens', 'Buyer conditions (optional)'), hint: t('sellerLensHint', 'Lens members who must qualify the buyer before the sale completes. Leave it empty to sell to anyone.'), required: false, initial: { members: [], threshold: 0 }, parent: () => dialog?.overlay });
        form.append(lens.element);
        const title = node('label', 'property-offer-form__field', t('fields.title', 'Title (optional)'));
        const titleInput = node('input'); titleInput.type = 'text'; titleInput.maxLength = 140; title.append(titleInput); form.append(title);
        const status = statusLine(form);
        const submit = async () => {
            const wallet = connectedWallet();
            if (!wallet) throw new Error(t('errors.wallet', 'Connect a Solana wallet first.'));
            const chosen = currency();
            const amount = Record().parseAmount(priceInput.value, chosen);
            if (!amount) throw new Error(t('errors.price', 'Enter a positive price in {{currency}}.', { currency: chosen }));
            const expiresAt = new Date(deadlineInput.value).toISOString();
            if (!(Date.parse(expiresAt) > Date.now())) throw new Error(t('errors.deadline', 'Choose a future date.'));
            const content = { schema: Record().PUBLISHED_SCHEMA, ...(titleInput.value.trim() ? { title: titleInput.value.trim() } : {}), city, createdAt: new Date().toISOString(), expiresAt,
                direction, proposer: wallet, currency: chosen, price: amount, lens: lens.value(), asset,
                ...(direction === 'sell' ? { payouts: [{ recipient: wallet, amount }] } : {}) };
            const issue = Record().validate(content);
            if (issue) throw new Error(issue.message);
            const record = root.PropertyOfferSync.create(content);
            let minted;
            try { minted = await root.PropertyOfferSync.mint(record, { onStatus: s => { status.textContent = progressText(s.state); } }); }
            catch (error) {
                if (!error.record?.published) { root.PropertyOfferStore.remove(record.id); throw error; }
                dialog.close(); root.PropertyOfferPanel.open(error.record, { error: error.message }); return;
            }
            dialog.close(); root.PropertyOfferPanel.open(minted);
        };
        dialog = root.CbDialog.open({ title: direction === 'buy' ? t('createBuy', 'Offer to buy') : t('createSell', 'Put up for sale'), size: 'md', className: 'property-offer-dialog', body: form,
            actions: [{ id: 'cancel', label: t('cancel', 'Cancel') }, { id: 'mint', label: direction === 'buy' ? t('mintBuy', 'Make offer and escrow the money') : t('mintSell', 'Put up for sale'), role: 'primary', keepOpen: true }] });
        form.id = `${dialog.body.id}-form`;
        const save = dialog.getActionButton('mint'); save.type = 'submit'; save.setAttribute('form', form.id);
        form.addEventListener('submit', event => { event.preventDefault(); root.BusyControl.track(save, submit).catch(error => { status.textContent = error.message; }); });
        priceInput.focus();
        return dialog;
    }

    /** Take an open offer: buy a listing (name your lens, pay into escrow) or accept a bid (name the payout, optionally a lens that qualifies the buyer). */
    function take(record) {
        const c = record.content;
        let dialog;
        const form = node('form', 'property-offer-form');
        form.append(node('p', 'property-offer-form__what', `${assetLabel(c.asset)} · ${money(c.price, c.currency)}`));
        walletRow(form);
        const buying = c.direction === 'sell';
        const lens = lensField(buying
            ? { legend: t('fields.buyerLens', 'Whom you trust to confirm the seller holds it'), hint: t('takeBuyHint', 'Paying puts {{price}} in escrow. It goes to the seller only when these lens members confirm the seller holds this; otherwise it returns to you after the deadline.', { price: money(c.price, c.currency) }), required: true, initial: preferredLens(), parent: () => dialog?.overlay }
            : { legend: t('fields.sellerLens', 'Buyer conditions (optional)'), hint: t('sellerLensHint', 'Lens members who must qualify the buyer before the sale completes. Leave it empty to sell to anyone.'), required: false, initial: { members: [], threshold: 0 }, parent: () => dialog?.overlay });
        form.append(lens.element);
        if (!buying) form.append(node('p', 'sheet-note', t('takeSellHint', 'You receive {{price}} when the buyer’s lens members confirm you hold this.', { price: money(c.price, c.currency) })));
        const status = statusLine(form);
        const submit = async () => {
            const wallet = connectedWallet();
            if (!wallet) throw new Error(t('errors.wallet', 'Connect a Solana wallet first.'));
            const chosen = lens.value();
            if (buying && !chosen.members.length) throw new Error(t('errors.buyerLens', 'Choose at least one lens member you trust.'));
            const updated = await root.PropertyOfferSolanaBridge.commit(record, { lens: chosen, payouts: buying ? [] : [{ recipient: wallet, amount: c.price }],
                onStatus: s => { status.textContent = progressText(s.state); } });
            dialog.close(); root.PropertyOfferPanel.open(updated);
        };
        dialog = root.CbDialog.open({ title: buying ? t('takeBuy', 'Buy') : t('takeSell', 'Accept this offer'), size: 'md', className: 'property-offer-dialog', body: form,
            actions: [{ id: 'cancel', label: t('cancel', 'Cancel') }, { id: 'take', label: buying ? t('takeBuyAction', 'Pay into escrow') : t('takeSellAction', 'Accept'), role: 'primary', keepOpen: true }] });
        form.id = `${dialog.body.id}-form`;
        const save = dialog.getActionButton('take'); save.type = 'submit'; save.setAttribute('form', form.id);
        form.addEventListener('submit', event => { event.preventDefault(); root.BusyControl.track(save, submit).catch(error => { status.textContent = error.message; }); });
        return dialog;
    }

    root.PropertyOfferDialog = Object.freeze({ open, take, money, assetLabel, assetHref, plotAsset, lensField, progressText });
})(typeof window !== 'undefined' ? window : globalThis);
