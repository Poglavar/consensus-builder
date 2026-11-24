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
        panel.append(label, close, select, copy, status);
        doc.body.appendChild(panel);

        let shown = null, selected = null, message = '';
        select.addEventListener('change', () => onChoose(select.value || null));
        close.addEventListener('click', onClose);
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
            const changedUnit = selected?.key !== unit?.key;
            selected = unit;
            const title = suggested ? t('threeMode.controls.suggestedApartments', 'Suggested apartments')
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
            const next = requested && !unit ? t('threeMode.controls.apartmentUnavailable', 'The linked apartment is not in the current layout.')
                : !choices.length ? t('threeMode.controls.apartmentsLoading', 'Waiting for the floor plans…') : '';
            if (next !== message || changedUnit) status.textContent = message = next;
        }
        return { show, hide() { panel.hidden = true; }, dispose() { panel.remove(); } };
    }

    win.ThreeApartmentPanel = { create };
})(window);
