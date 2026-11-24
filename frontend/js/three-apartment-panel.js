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
        const results = doc.createElement('div');
        results.className = 'cb-link-row';
        panel.append(label, close, select, copy, offers, status, results);
        doc.body.appendChild(panel);

        let shown = null, selected = null, message = '';
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
            try {
                const response = await win.fetch(`${win.getBackendBase()}/agreements/apartment-offers?${params}`, { signal: controller.signal });
                if (!response.ok) throw new Error(t('threeMode.controls.apartmentOffersFailed', 'Apartment offers could not be loaded.'));
                const { offers: matches } = await response.json();
                if (controller.signal.aborted) return;
                status.textContent = matches.length ? '' : t('threeMode.controls.apartmentOffersEmpty', 'No published apartment offers found.');
                for (const row of matches) {
                    const intent = win.ApprovalLink.build({ origin: win.location.origin, action: 'reserve', target: row.cid, params: { city: row.city, unitId: row.unitId } });
                    const url = new URL(intent);
                    for (const key of ['at', 'lang', 'backend']) if (source.has(key)) url.searchParams.set(key, source.get(key));
                    const link = doc.createElement('a');
                    link.className = 'cb-link'; link.href = url.href; link.textContent = `${row.title || row.cid} · ${row.label}`;
                    results.append(link);
                }
            } catch (error) {
                if (!controller.signal.aborted) status.textContent = error.message;
            }
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
            if (changedUnit) resetOffers();
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
            select.value = unit?.key || '';
            select.disabled = choices.length === 0;
            copy.disabled = !unit;
            if (!win.BusyControl.isBusy(offers)) offers.disabled = !unit;
            const next = requested && !unit ? t('threeMode.controls.apartmentUnavailable', 'The linked apartment is not in the current layout.')
                : !choices.length ? t('threeMode.controls.apartmentsLoading', 'Waiting for the floor plans…') : '';
            if (next !== message || changedUnit) status.textContent = message = next;
        }
        return { show, hide() { if (!panel.hidden) resetOffers(); panel.hidden = true; }, dispose() { resetOffers(); panel.remove(); } };
    }

    win.ThreeApartmentPanel = { create };
})(window);
