(function (win) {
    'use strict';

    function create({ translate: t, onChoose, onClose, linkFor }) {
        const doc = win.document;
        const panel = doc.createElement('section');
        panel.className = 'three-apartment-panel';
        panel.hidden = true;
        const label = doc.createElement('label');
        label.id = 'three-apartment-title';
        panel.setAttribute('aria-labelledby', label.id);
        const select = doc.createElement('select');
        select.id = 'three-apartment-select';
        label.htmlFor = select.id;
        const copy = doc.createElement('button');
        copy.type = 'button';
        copy.className = 'btn';
        copy.textContent = t('threeMode.controls.apartmentCopy', 'Copy apartment link');
        const close = doc.createElement('button');
        close.type = 'button';
        close.className = 'btn three-apartment-close';
        close.textContent = '×';
        close.setAttribute('aria-label', t('common.close', 'Close'));
        const status = doc.createElement('div');
        status.setAttribute('role', 'status');
        const offers = doc.createElement('button');
        offers.type = 'button';
        offers.className = 'btn';
        offers.textContent = t('threeMode.controls.findApartmentOffers', 'Find apartment offers');
        function offerButton(direction) {
            const button = doc.createElement('button');
            button.type = 'button';
            button.className = 'btn';
            button.textContent = direction === 'buy' ? t('threeMode.controls.offerToBuyApartment', 'Offer to buy apartment')
                : t('threeMode.controls.offerToSellApartment', 'Offer to sell apartment');
            button.addEventListener('click', () => {
                const href = selected && linkFor(selected);
                if (!href) return;
                const source = new URL(href).searchParams;
                win.PropertyOfferDialog.open({ direction, apartment: { xrayBuilding: source.get('xrayBuilding'),
                    unit: source.get('unit'), at: source.get('at'), ...(source.has('access') ? { access: source.get('access') } : {}) } });
            });
            return button;
        }
        const buy = offerButton('buy'), sell = offerButton('sell');
        const results = doc.createElement('div');
        results.className = 'cb-link-row';
        panel.append(label, close, select, copy, buy, sell, offers, status, results);
        doc.body.appendChild(panel);

        let shown = null, selected = null, message = '', addressable = false;
        let request = null;
        function resetOffers() {
            request?.abort();
            request = null;
            results.replaceChildren();
            status.textContent = '';
        }
        select.addEventListener('change', () => onChoose(select.value || null));
        close.addEventListener('click', onClose);
        offers.addEventListener('click', () => win.BusyControl.track(offers, async () => {
            const href = selected && linkFor(selected);
            if (!href) return;
            resetOffers();
            const controller = new AbortController();
            request = controller;
            const source = new URL(href).searchParams;
            const params = new URLSearchParams(['city', 'xrayBuilding', 'unit'].map(name => [name, source.get(name)]));
            status.textContent = t('threeMode.controls.apartmentOffersLoading', 'Finding published apartment offers…');
            async function lookup(path) {
                const response = await win.fetch(`${win.getBackendBase()}/${path}?${params}`, {
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            }
            function appendLink(target, label) {
                const url = new URL(target, win.location.origin);
                for (const key of ['city', 'at', 'lang', 'backend']) if (source.has(key) && !url.searchParams.has(key)) url.searchParams.set(key, source.get(key));
                const link = doc.createElement('a');
                link.className = 'cb-link';
                link.href = url.href;
                link.textContent = label;
                results.append(link);
            }
            const [funding, standalone] = await Promise.allSettled([lookup('agreements/apartment-offers'), lookup('property-offers')]);
            if (controller.signal.aborted) return;
            for (const row of funding.value?.offers || []) {
                const url = win.ApprovalLink.build({ origin: win.location.origin, action: 'reserve', target: row.cid,
                    params: { city: row.city, unitId: row.unitId } });
                const title = row.title || row.label, amount = win.AgreementRecord.formatUsdc(row.depositUsdcAtomic);
                appendLink(url, t('threeMode.controls.apartmentFundingDeposit', `Reserve in ${title} · ${amount} USDC deposit`, { title, amount }));
            }
            for (const row of standalone.value?.propertyOffers || []) {
                const label = row.content.direction === 'buy' ? buy.textContent : sell.textContent;
                const price = win.PropertyOfferDialog.sol(row.content.priceLamports);
                appendLink(`/property-offers/${encodeURIComponent(row.cid)}`, [label, price, row.content.title].filter(Boolean).join(' · '));
            }
            status.textContent = funding.status === 'rejected' || standalone.status === 'rejected'
                ? t('threeMode.controls.apartmentOffersFailed', 'Apartment offers could not be loaded.')
                : results.childElementCount ? '' : t('threeMode.controls.apartmentOffersEmpty', 'No published apartment offers found.');
        }));
        copy.addEventListener('click', async () => {
            const unit = selected;
            const href = unit && linkFor(unit);
            if (!href) return;
            const copied = await win.copyTextWithFeedback(href);
            if (panel.hidden || selected?.key !== unit.key) return;
            status.textContent = copied ? t('common.copied', 'Copied') : t('threeMode.controls.apartmentCopyFailed', 'Could not copy the apartment link.');
        });

        function show(units, unit, suggested, requested) {
            panel.hidden = false;
            const changedUnit = selected?.key !== unit?.key || selected?.group !== unit?.group;
            if (changedUnit) {
                resetOffers();
                addressable = !!(unit && linkFor(unit));
            }
            selected = unit;
            const title = suggested ? t('threeMode.controls.suggestedApartments', 'Estimated apartments')
                : t('threeMode.controls.apartments', 'Apartments');
            if (label.textContent !== title) label.textContent = title;
            const choices = units.map(item => [item.key, t('threeMode.controls.apartmentOption',
                `Floor ${item.level} · Apartment ${item.ordinal}`, { level: item.level, number: item.ordinal })]);
            const signature = JSON.stringify(choices);
            if (signature !== shown) {
                shown = signature;
                select.replaceChildren(new Option(t('threeMode.controls.chooseApartment', 'Choose an apartment'), ''),
                    ...choices.map(([key, name]) => new Option(name, key)));
            }
            if (select.value !== (unit?.key || '')) select.value = unit?.key || '';
            select.disabled = choices.length === 0;
            copy.disabled = buy.disabled = sell.disabled = offers.disabled = !addressable;
            const next = requested && !unit ? t('threeMode.controls.apartmentUnavailable', 'The linked apartment is not in the current layout.')
                : !choices.length ? t('threeMode.controls.apartmentsLoading', 'Waiting for the floor plans…')
                : unit && !addressable ? t('threeMode.controls.apartmentPublishHint', 'Publish this design to share the apartment or make an offer.') : '';
            if (next !== message || changedUnit) status.textContent = message = next;
        }
        return { show, hide() { if (!panel.hidden) resetOffers(); panel.hidden = true; message = ''; }, dispose() { resetOffers(); panel.remove(); } };
    }

    win.ThreeApartmentPanel = { create };
})(window);
