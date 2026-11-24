// The compact authoring surface for immutable property-offer/v1 records.  An offer always names
// the exact property selected when this dialog opens.
(function (root) {
    'use strict';

    const t = (key, fallback, params = {}) => {
        const fullKey = `propertyOffer.${key}`, value = root.i18n?.t?.(fullKey, params);
        return value && value !== fullKey ? value : fallback;
    };
    const node = (tag, className, text) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };
    const shortKey = value => {
        const text = String(value || '');
        return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
    };
    const connectedWallet = () => {
        const state = root.solanaWalletManager?.getState?.();
        return state?.status === 'connected' && state.accounts?.[0] ? String(state.accounts[0]) : '';
    };
    const city = () => root.CityConfigManager?.getCurrentCityId?.() || root.resolveCurrentCityCode?.() || '';
    const localDateTime = date => {
        const offset = date.getTimezoneOffset() * 60000;
        return new Date(date.getTime() - offset).toISOString().slice(0, 16);
    };
    const lamports = value => {
        const text = String(value || '').trim();
        if (!/^\d+(?:\.\d{0,9})?$/.test(text)) return null;
        const [whole, fraction = ''] = text.split('.');
        const raw = `${whole}${fraction.padEnd(9, '0')}`.replace(/^0+(?=\d)/, '');
        return BigInt(raw || '0').toString();
    };
    const sol = value => {
        try {
            const raw = BigInt(String(value || '0'));
            const whole = raw / 1000000000n;
            const fraction = String(raw % 1000000000n).padStart(9, '0').replace(/0+$/, '');
            return `${whole}${fraction ? `.${fraction}` : ''} SOL`;
        } catch (_) { return '0 SOL'; }
    };
    // Parcel references come from the live parcel fabric, the authoritative land record; the Leaflet
    // layers only present it.
    const parcelRefs = ids => {
        const refs = ids.map(id => root.LiveParcelFabric?.get?.(id)).map(feature => {
            const properties = feature?.properties || {};
            const source = properties.parcelSource || {};
            const id = properties.parcelId ?? properties.id ?? feature?.id;
            return id == null ? null : {
                sourceId: String(source.sourceId || root.DesignSync?.parcelSourceIdOf?.(city()) || ''),
                id: String(id),
                ...(source.snapshotId ? { snapshotId: String(source.snapshotId) } : {})
            };
        }).filter(ref => ref?.sourceId && ref.id);
        if (refs.length !== ids.length) throw new Error(t('errors.parcels', 'The exact current parcel references are unavailable. Reload parcels and try again.'));
        return refs;
    };
    const selectedLens = () => root.LensPicker?.getEntries?.()[0]?.address || '';

    function open({ direction, parcelIds, apartment = null, city: offerCity = city() }) {
        const ids = Array.from(parcelIds || [], String);
        if (!['buy', 'sell'].includes(direction)) throw new Error('Invalid offer direction.');
        if (!ids.length && !apartment) throw new Error(t('errors.select', 'Select at least one parcel first.'));
        if (!root.CbDialog?.open) throw new Error(t('errors.dialog', 'The offer dialog is not available yet.'));
        const parcels = apartment ? [] : parcelRefs(ids);
        if (apartment) {
            const [sourceCity] = root.BuildingUnitLinks.apartmentLocator(apartment.xrayBuilding);
            if (sourceCity !== 'design') offerCity = sourceCity;
        }
        const wallet = connectedWallet();
        const form = node('form', 'property-offer-form');
        const title = node('label', 'property-offer-form__field', t('fields.title', 'Title'));
        const titleInput = node('input'); titleInput.type = 'text'; titleInput.maxLength = 140;
        titleInput.value = apartment ? (direction === 'buy' ? t('defaults.buyApartmentTitle', 'Offer to buy apartment') : t('defaults.sellApartmentTitle', 'Offer to sell apartment')) : direction === 'buy'
            ? t('defaults.buyTitle', `Offer to buy ${parcels.length} parcel(s)`, { count: parcels.length }) : t('defaults.sellTitle', `Offer to sell ${parcels.length} parcel(s)`, { count: parcels.length });
        title.append(titleInput); form.append(title);
        const facts = node('dl', 'property-offer-form__facts');
        [[t('fields.direction', 'Direction'), direction === 'buy' ? t('directions.buy', 'Offer to buy') : t('directions.sell', 'Offer to sell')],
            ...(apartment ? [[t('fields.apartment', 'Apartment'), `${apartment.xrayBuilding} · ${apartment.unit}`]] : [[t('fields.bundle', 'Parcel bundle'), t('bundle', '{{count}} parcels — all or nothing', { count: parcels.length })]]),
            [t('fields.wallet', 'Your Solana wallet'), wallet ? shortKey(wallet) : t('walletMissing', 'Connect a Solana wallet first')]]
            .forEach(([label, value]) => { const row = node('div'); row.append(node('dt', '', label), node('dd', '', value)); facts.append(row); });
        form.append(facts);
        if (!wallet) {
            const connect = node('button', 'btn btn-quiet', root.i18n?.t('wallet.connect') || 'Connect wallet');
            connect.type = 'button';
            connect.addEventListener('click', () => root.BusyControl.track(connect, async () => {
                await root.walletManager.openConnectorModal({ chain: 'solana' })?.dialog.closed;
                const address = connectedWallet();
                if (!address) return;
                facts.lastElementChild.querySelector('dd').textContent = shortKey(address);
                const recipient = payouts?.querySelector('input');
                if (recipient && !recipient.value) recipient.value = address;
                connect.hidden = true;
                priceInput.focus();
            }).catch(error => { status.textContent = error.message; }));
            form.append(connect);
        }
        const price = node('label', 'property-offer-form__field', t('fields.price', 'Total price (SOL)'));
        const priceInput = node('input'); priceInput.type = 'text'; priceInput.inputMode = 'decimal'; priceInput.placeholder = '0.00'; priceInput.required = true; price.append(priceInput); form.append(price);
        const deadline = node('label', 'property-offer-form__field', t('fields.deadline', 'Offer deadline'));
        const deadlineInput = node('input'); deadlineInput.type = 'datetime-local'; deadlineInput.required = true;
        deadlineInput.value = localDateTime(new Date(Date.now() + 7 * 86400000)); deadline.append(deadlineInput); form.append(deadline);
        const lens = node('label', 'property-offer-form__field', t('fields.lens', 'Lens'));
        const lensRow = node('div', 'property-offer-form__lens');
        const lensInput = node('input'); lensInput.type = 'text'; lensInput.required = true; lensInput.value = selectedLens(); lensInput.placeholder = t('lensPlaceholder', 'Solana lens member address');
        const chooseLens = node('button', 'btn', t('chooseLens', 'Choose lens')); chooseLens.type = 'button';
        chooseLens.addEventListener('click', () => root.LensPicker.show({ parent: dialog.overlay, single: true,
            entries: lensInput.value.trim() ? [{ address: lensInput.value.trim() }] : [],
            onClose: entries => { lensInput.value = entries[0]?.address || ''; lensInput.focus(); } }));
        lensRow.append(lensInput, chooseLens); lens.append(lensRow); form.append(lens);
        if (apartment) form.append(node('p', 'sheet-note', t('lensQualification', 'The lens you choose decides whether the other party qualifies for this offer.')));
        let payouts = null;
        if (direction === 'sell') {
            payouts = node('fieldset', 'property-offer-form__payouts');
            payouts.append(node('legend', '', t('fields.payouts', 'Sale payout schedule')),
                node('p', 'sheet-note', t('payoutHint', 'The listed recipients receive this total when the sale completes.')));
            const rows = node('div', 'property-offer-form__payoutRows'); payouts.append(rows);
            const add = node('button', 'btn', t('addPayout', 'Add recipient')); add.type = 'button';
            const addRow = (recipient = wallet, amount = '') => {
                const row = node('div', 'property-offer-form__payout');
                const recipientInput = node('input'); recipientInput.required = true; recipientInput.setAttribute('aria-label', t('recipient', 'Recipient wallet')); recipientInput.placeholder = t('recipient', 'Recipient wallet'); recipientInput.value = recipient;
                const amountInput = node('input'); amountInput.required = true; amountInput.setAttribute('aria-label', t('amountSol', 'SOL amount')); amountInput.inputMode = 'decimal'; amountInput.placeholder = t('amountSol', 'SOL amount'); amountInput.value = amount;
                const remove = node('button', 'btn', t('remove', 'Remove')); remove.type = 'button'; remove.addEventListener('click', () => row.remove());
                row.append(recipientInput, amountInput, remove); rows.append(row);
            };
            addRow(wallet); add.addEventListener('click', () => addRow()); payouts.append(add); form.append(payouts);
        }
        const status = node('p', 'property-offer-form__status'); status.setAttribute('role', 'status'); form.append(status);
        let dialog, save;
        const submit = async event => {
            event.preventDefault();
            const wallet = connectedWallet();
            const priceLamports = lamports(priceInput.value);
            const expiresAt = new Date(deadlineInput.value).toISOString();
            if (!wallet) throw new Error(t('errors.wallet', 'Connect a Solana wallet first.'));
            if (!priceLamports || BigInt(priceLamports) < 1n) throw new Error(t('errors.price', 'Enter a positive SOL price.'));
            if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw new Error(t('errors.deadline', 'Choose a future deadline.'));
            const content = { schema: 'property-offer/v1', title: titleInput.value.trim() || null, city: offerCity, createdAt: new Date().toISOString(), expiresAt, direction,
                proposer: wallet, buyer: direction === 'buy' ? wallet : null, seller: direction === 'sell' ? wallet : null,
                lens: lensInput.value.trim(), priceLamports, ...(apartment ? { apartment } : { parcels }) };
            if (direction === 'sell') {
                const payoutRows = [...payouts.querySelectorAll('.property-offer-form__payout')];
                content.payouts = payoutRows.map(row => ({ recipient: row.children[0].value.trim(), lamports: lamports(row.children[1].value) || '0' }));
            }
            const issue = root.PropertyOfferRecord?.validate?.(content, { now: new Date() });
            if (issue) throw new Error(issue.message || String(issue));
            status.textContent = t('working', 'Working…');
            const record = root.PropertyOfferSync.create(content);
            let minted;
            try { minted = await root.PropertyOfferSync.mint(record); }
            catch (error) {
                if (!error.record?.published) { root.PropertyOfferStore.remove(record.id); throw error; }
                dialog.close(); root.PropertyOfferPanel.open(error.record || record, { error: error.message });
                return;
            }
            dialog.close(); root.PropertyOfferPanel.open(minted);
        };
        form.addEventListener('submit', event => root.BusyControl?.track ? root.BusyControl.track(save, () => submit(event)).catch(error => { status.textContent = error.message; }) : submit(event).catch(error => { status.textContent = error.message; }));
        dialog = root.CbDialog.open({ title: direction === 'buy' ? t('createBuy', 'Offer to buy') : t('createSell', 'Offer to sell'), size: 'md', className: 'property-offer-dialog', body: form,
            actions: [
                { id: 'cancel', label: t('cancel', 'Cancel') },
                { id: 'mint', label: t('mint', 'Mint offer'), role: 'primary', keepOpen: true }
            ] });
        form.id = `${dialog.body.id}-form`;
        save = dialog.getActionButton('mint');
        save.type = 'submit'; save.setAttribute('form', form.id);
        titleInput.focus();
        return dialog;
    }
    // Every owner signs this same candidate. It can safely travel as JSON between wallets: the
    // bridge recomputes its offer-bound hashes, while the lens verifies all seller signatures.
    function accept(record, { sharedId = record.acceptanceSessionId || null } = {}) {
        const content = record?.content;
        if (!content) throw new Error(t('errors.missing', 'This property offer is not held on this device.'));
        const form = node('form', 'property-offer-form');
        form.append(node('p', 'sheet-note', content.apartment
            ? t('awaitQualification', 'The named lens must qualify this counterparty before acceptance.')
            : t('acceptPayoutHint', 'Every seller signs this exact payout schedule before it can be accepted.')));
        const buyerField = node('label', 'property-offer-form__field', t('fields.buyer', 'Buyer wallet'));
        const buyer = node('input'); buyer.required = true; buyer.value = content.direction === 'buy' ? content.proposer : connectedWallet(); buyer.readOnly = content.direction === 'buy'; buyerField.append(buyer); form.append(buyerField);
        const sellerField = node('label', 'property-offer-form__field', t('fields.seller', 'Seller representative wallet'));
        const seller = node('input'); seller.required = true; seller.value = content.direction === 'sell' ? content.proposer : connectedWallet(); seller.readOnly = content.direction === 'sell'; sellerField.append(seller); form.append(sellerField);
        const schedule = node('fieldset', 'property-offer-form__payouts'); schedule.append(node('legend', '', t('fields.payouts', 'Payout schedule')));
        const rows = node('div', 'property-offer-form__payoutRows'); schedule.append(rows); form.append(schedule);
        const editable = content.direction === 'buy';
        const addRow = (recipient = '', amount = '') => {
            const row = node('div', 'property-offer-form__payout');
            const to = node('input'); to.required = true; to.readOnly = !editable; to.setAttribute('aria-label', t('recipient', 'Recipient wallet')); to.placeholder = t('recipient', 'Recipient wallet'); to.value = recipient;
            const value = node('input'); value.required = true; value.readOnly = !editable; value.setAttribute('aria-label', t('amountSol', 'SOL amount')); value.inputMode = 'decimal'; value.placeholder = t('amountSol', 'SOL amount'); value.value = amount;
            row.append(to, value);
            if (editable) { const remove = node('button', 'btn', t('remove', 'Remove')); remove.type = 'button'; remove.addEventListener('click', () => row.remove()); row.append(remove); }
            rows.append(row);
        };
        (content.payouts || [{ recipient: content.apartment ? seller.value : '', lamports: content.priceLamports }]).forEach(row => addRow(row.recipient, sol(row.lamports).replace(' SOL', '')));
        if (editable) { const add = node('button', 'btn', t('addPayout', 'Add recipient')); add.type = 'button'; add.addEventListener('click', () => addRow()); schedule.append(add); }
        const signers = node('p', 'property-offer-form__status'); signers.setAttribute('role', 'status'); form.append(signers);
        const status = node('p', 'property-offer-form__status'); status.setAttribute('role', 'status'); form.append(status);
        let candidate = record.acceptanceDraft || null, dialog;
        const showConsents = () => {
            if (content.apartment) return;
            const owners = (candidate?.consents || []).map(row => shortKey(row.owner)).join(', ');
            const waiting = (candidate?.payouts || []).filter(row => !(candidate?.consents || []).some(c => c.owner === row.recipient)).map(row => shortKey(row.recipient)).join(', ');
            signers.textContent = (owners ? t('consentsBy', 'Seller consent(s): {{owners}}', { owners }) : t('noConsents', 'No seller consents attached yet.'))
                + (waiting ? ` — ${t('waitingFor', 'Waiting for: {{owners}}', { owners: waiting })}` : '');
        };
        const makeCandidate = async () => {
            const payouts = [...rows.children].filter(row => row.classList.contains('property-offer-form__payout')).map(row => ({ recipient: row.children[0].value.trim(), lamports: lamports(row.children[1].value) || '0' }));
            const previous = candidate;
            candidate = await root.PropertyOfferSolanaBridge.prepareAcceptance(record, { buyer: buyer.value.trim(), seller: seller.value.trim(), payouts });
            if (previous && root.PropertyOfferSolanaBridge.acceptanceId(previous) === root.PropertyOfferSolanaBridge.acceptanceId(candidate)) candidate.consents = previous.consents;

            if (sharedId && root.PropertyOfferSolanaBridge.acceptanceId(candidate) !== sharedId) sharedId = null;
            record = root.PropertyOfferStore.save({ ...record, acceptanceDraft: candidate, acceptanceSessionId: sharedId });
            showConsents();
            return candidate;
        };
        const receive = shared => {
            sharedId = shared.id; candidate = shared.candidate;
            record = root.PropertyOfferStore.save({ ...record, acceptanceDraft: candidate, acceptanceSessionId: sharedId });
            buyer.value = candidate.buyer; seller.value = candidate.seller;
            rows.replaceChildren(); candidate.payouts.forEach(row => addRow(row.recipient, sol(row.lamports).replace(' SOL', '')));
            showConsents();
        };
        const refreshShared = async () => {
            if (!sharedId) throw new Error(t('shareFirst', 'Share this acceptance first.'));
            receive(await root.PropertyOfferSync.fetchAcceptance(record, sharedId));
        };
        const share = async () => {
            await makeCandidate();
            receive(await root.PropertyOfferSolanaBridge.shareAcceptance(record, candidate));
            const link = root.PropertyOfferSync.acceptanceLink(record, sharedId);
            await root.ShareDialog.open({ kind: 'agreement', title: content.title || t('details', 'Property offer'), link });
        };
        const download = () => { const blob = new Blob([JSON.stringify(candidate, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'property-offer-acceptance.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); };
        const importInput = node('input'); importInput.type = 'file'; importInput.accept = 'application/json'; importInput.hidden = true;
        importInput.addEventListener('change', async () => { const file = importInput.files?.[0]; if (!file) return; try { if (file.size > 65536) throw new Error('Acceptance files must be at most 64 KiB.'); const imported = JSON.parse(await file.text()); if (imported.cid !== record.published.cid) throw new Error('This acceptance belongs to another offer.'); candidate = await root.PropertyOfferSolanaBridge.prepareAcceptance(record, imported); if (sharedId && root.PropertyOfferSolanaBridge.acceptanceId(candidate) !== sharedId) sharedId = null; record = root.PropertyOfferStore.save({ ...record, acceptanceDraft: candidate, acceptanceSessionId: sharedId }); buyer.value = candidate.buyer || buyer.value; seller.value = candidate.seller || seller.value; rows.replaceChildren(); (candidate.payouts || []).forEach(row => addRow(row.recipient, sol(row.lamports).replace(' SOL', ''))); showConsents(); } catch (error) { status.textContent = error.message || t('errors.import', 'That acceptance JSON could not be read.'); } }); form.append(importInput);
        dialog = root.CbDialog.open({ title: t('accept', 'Accept offer'), size: 'md', className: 'property-offer-dialog', body: form, actions: [] });
        const actions = node('div', 'cb-actions property-offer-form__actions');
        const button = (label, run, primary = false) => { const item = node('button', `btn${primary ? ' btn-primary' : ''}`, label); item.type = 'button'; item.addEventListener('click', () => root.BusyControl.track(item, run).catch(error => { status.textContent = error.message; })); return item; };
        actions.append(button(t('shareAcceptance', 'Share acceptance link'), share));
        if (!content.apartment) actions.append(button(t('refreshConsents', 'Refresh signatures'), async () => { await makeCandidate(); await refreshShared(); }),
            button(t('signConsent', 'Sign my seller consent'), async () => {
                await makeCandidate(); candidate = await root.PropertyOfferSolanaBridge.signAcceptance(record, candidate);
                record = root.PropertyOfferStore.save({ ...record, acceptanceDraft: candidate });
                if (sharedId) {
                    const mine = root.PropertyOfferSolanaBridge.connectedWallet();
                    receive(await root.PropertyOfferSync.request(`/${record.published.cid}/acceptances/${sharedId}/consents`, candidate.consents.find(c => c.owner === mine)));
                }
                showConsents();
            }));
        actions.append(button(t('downloadAcceptance', 'Download acceptance'), async () => { await makeCandidate(); download(); }),
            button(t('importAcceptance', 'Import acceptance JSON'), async () => importInput.click()),
            button(t('accept', 'Accept offer'), async () => { await makeCandidate(); if (sharedId) await refreshShared(); status.textContent = t('working', 'Working…'); record = await root.PropertyOfferSolanaBridge.accept(record, { candidate }); record = root.PropertyOfferStore.save({ ...record, acceptanceDraft: null }); dialog.close(); root.PropertyOfferPanel?.open?.(record); }, true));
        form.append(actions);
        if (candidate) {
            buyer.value = candidate.buyer; seller.value = candidate.seller;
            rows.replaceChildren(); candidate.payouts.forEach(row => addRow(row.recipient, sol(row.lamports).replace(' SOL', '')));
            showConsents();
        }
        if (sharedId) {
            const controls = [...form.querySelectorAll('input,button')];
            controls.forEach(control => { control.disabled = true; }); status.textContent = t('working', 'Working…');
            refreshShared().then(() => { status.textContent = ''; }).catch(error => { status.textContent = error.message; })
                .finally(() => controls.forEach(control => { control.disabled = false; }));
        }
        return dialog;
    }
    root.PropertyOfferDialog = Object.freeze({ open, accept, lamports, sol, parcelRefs });
})(typeof window !== 'undefined' ? window : globalThis);
