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
        // The reservation states of the building's apartments in crowdfunding rounds (ApartmentRound).
        const rounds = doc.createElement('div');
        rounds.className = 'three-apartment-rounds';
        panel.append(label, close, select, rounds, copy, buy, sell, offers, status, results);
        doc.body.appendChild(panel);

        let shown = null, selected = null, message = '', addressable = false, roundsShown = '';
        const openRounds = new Set();
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

        // A link into the app that keeps this page's API and language.
        function appLink(target, text, className = 'cb-link') {
            const url = new URL(target, win.location.origin);
            const here = new URL(win.location.href).searchParams;
            for (const key of ['backend', 'lang']) if (here.has(key) && !url.searchParams.has(key)) url.searchParams.set(key, here.get(key));
            const link = doc.createElement('a');
            link.className = className;
            link.href = url.href;
            link.textContent = text;
            return link;
        }
        function hint(text, announced = false) {
            const line = doc.createElement('p');
            line.className = 'agreement-panel-hint';
            line.textContent = text;
            if (announced) line.setAttribute('role', 'status');
            return line;
        }
        const roundText = (key, fallback, params) => t(`agreement.funding.apartments.${key}`, fallback, params);
        // The chosen apartment as its round offers it: state, terms, round, buyer and, while it can be
        // reserved, the round's own Reserve apartment review (an approval link to the agreement).
        function unitCard({ unit, round }) {
            const view = win.ApartmentRound;
            const card = doc.createElement('div');
            card.className = 'three-apartment-round-unit';
            const head = doc.createElement('p');
            const name = doc.createElement('strong');
            name.textContent = unit.label;
            head.append(name, ' ', view.stateBadge(unit, t));
            const terms = hint(roundText('priceAndDeposit', 'Price {{price}} USDC · Reservation deposit {{deposit}} USDC', {
                price: win.AgreementRecord.formatUsdc(BigInt(unit.priceUsdcAtomic)), deposit: win.AgreementRecord.formatUsdc(BigInt(unit.depositUsdcAtomic)) }));
            const facts = doc.createElement('dl');
            facts.className = 'agreement-panel-facts';
            function fact(term, value) {
                const row = doc.createElement('div');
                const dt = doc.createElement('dt'), dd = doc.createElement('dd');
                dt.textContent = term;
                dd.append(value);
                row.append(dt, dd);
                facts.append(row);
            }
            const roundLink = appLink(`/agreements/${encodeURIComponent(round.cid)}?city=${encodeURIComponent(round.city || '')}`, round.title || round.cid);
            roundLink.dataset.apartmentRoundFocus = 'round';
            fact(roundText('round', 'Crowdfunding round'), roundLink);
            if (unit.buyer) {
                const buyer = doc.createElement('a');
                buyer.className = 'cb-link cb-link--external';
                buyer.href = win.AgreementBridge.explorerUrl({ account: unit.buyer, cluster: 'devnet' });
                buyer.target = '_blank';
                buyer.rel = 'noopener noreferrer';
                buyer.textContent = win.LensCore?.shortKey?.(unit.buyer) || unit.buyer;
                buyer.setAttribute('aria-label', `${roundText('reservedBy', 'Reserved by')} · ${unit.buyer} · Solana Explorer`);
                buyer.dataset.apartmentRoundFocus = 'buyer';
                fact(roundText('reservedBy', 'Reserved by'), buyer);
            }
            card.append(head, terms, facts);
            if (unit.state === 'available') {
                const reserve = appLink(win.ApprovalLink.build({ origin: win.location.origin, action: 'reserve', target: round.cid,
                    params: { city: round.city, unitId: unit.unitId } }), roundText('reserve', 'Reserve apartment'), 'btn btn-primary');
                reserve.dataset.apartmentRoundFocus = 'reserve';
                card.append(reserve);
            }
            return card;
        }
        function drawRounds(data, unit) {
            const states = data?.states || new Map();
            const entry = data?.entry;
            const signature = entry ? JSON.stringify([entry.status, entry.failed, entry.error, entry.readAt, unit?.key || null,
                [...states].map(([key, item]) => [key, item.state, item.reason, item.unit.buyer, item.round.cid])]) : '';
            if (signature === roundsShown) return;
            roundsShown = signature;
            const focus = rounds.contains(doc.activeElement) && doc.activeElement.dataset.apartmentRoundFocus;
            rounds.replaceChildren();
            if (!entry) return;
            // Most buildings have no round: nothing shows until the index names one.
            if (entry.status === 'loading') return;
            if (entry.status === 'reading') { rounds.append(hint(roundText('roundsLoading', 'Reading apartment reservations from Solana…'), true)); return; }
            if (entry.status === 'failed') { rounds.append(hint(roundText('roundsFailed', 'Apartment reservations could not be read.'), true)); return; }
            if (entry.rounds.length) {
                const known = unit && states.get(unit.key);
                if (known) rounds.append(unitCard(known));
                else if (unit) rounds.append(hint(roundText('notOfferedHint', 'This apartment is not offered in a crowdfunding round.')));
                rounds.append(win.ApartmentRound.legendView(t));
                // Each round's stats block folds under a one-line summary, so the panel leaves the model in view.
                for (const view of entry.rounds) {
                    const heading = appLink(`/agreements/${encodeURIComponent(view.cid)}?city=${encodeURIComponent(view.city || '')}`, view.title || view.cid);
                    const details = doc.createElement('details');
                    details.className = 'three-apartment-round';
                    details.open = openRounds.has(view.cid);
                    details.addEventListener('toggle', () => { if (details.open) openRounds.add(view.cid); else openRounds.delete(view.cid); });
                    const summary = doc.createElement('summary');
                    summary.className = 'cb-link';
                    summary.dataset.apartmentRoundFocus = `summary-${view.cid}`;
                    summary.textContent = roundText('roundSummary', '{{title}}: {{reserved}} of {{offered}} reserved · {{percent}}% of the target',
                        { title: view.title || view.cid, reserved: view.counts.reserved, offered: view.counts.offered, percent: view.percent ?? 0 });
                    details.append(summary, win.ApartmentRound.statsView(view, t, { heading }));
                    rounds.append(details);
                }
            }
            if (entry.failed) rounds.append(hint(roundText('roundsPartlyFailed', '{{count}} crowdfunding round(s) could not be read.', { count: entry.failed }), true));
            if (focus) rounds.querySelector(`[data-apartment-round-focus="${focus}"]`)?.focus({ preventScroll: true });
        }

        // `roundData` ({ entry: ApartmentRound.buildingRounds(...), states: buildingStates(...) }) adds
        // the reservation state to each choice and the round's stats; null when nothing is offered here.
        function show(units, unit, suggested, requested, roundData = null) {
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
            const choices = units.map(item => {
                const known = roundData?.states?.get(item.key);
                const name = t('threeMode.controls.apartmentOption', `Floor ${item.level} · Apartment ${item.ordinal}`, { level: item.level, number: item.ordinal });
                return [item.key, known ? [name, known.unit.label, win.ApartmentRound.stateLabel(known.unit, t)].join(' · ') : name];
            });
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
            drawRounds(roundData, unit);
        }
        return { show, hide() { if (!panel.hidden) resetOffers(); panel.hidden = true; message = ''; drawRounds(null, null); }, dispose() { resetOffers(); panel.remove(); } };
    }

    win.ThreeApartmentPanel = { create };
})(window);
