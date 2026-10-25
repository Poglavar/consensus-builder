// Shared labeled relationship links and instance choices inside 2D and 3D stack sections.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ClickStackRelations = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    let selectorId = 0;
    const strings = {
        en: {
            memberPlans: 'Member of plans:', memberAgreements: 'Member of agreements:',
            includedDesigns: 'Designs:', createdBy: 'Created by design:', formedFrom: 'Formed from cadastral parcels:',
            formedParcels: 'Forms parcels:', affectsParcels: 'Uses cadastral parcels:', designsOnParcel: 'Designs on this parcel:',
            chooseInstance: 'Choose item'
        },
        hr: {
            memberPlans: 'Član planova:', memberAgreements: 'Član sporazuma:',
            includedDesigns: 'Dizajni:', createdBy: 'Izradio dizajn:', formedFrom: 'Nastalo od katastarskih čestica:',
            formedParcels: 'Oblikuje čestice:', affectsParcels: 'Koristi katastarske čestice:', designsOnParcel: 'Dizajni na ovoj čestici:',
            chooseInstance: 'Odaberite stavku'
        },
        sr: {
            memberPlans: 'Član planova:', memberAgreements: 'Član sporazuma:',
            includedDesigns: 'Dizajni:', createdBy: 'Izradio dizajn:', formedFrom: 'Nastalo od katastarskih parcela:',
            formedParcels: 'Oblikuje parcele:', affectsParcels: 'Koristi katastarske parcele:', designsOnParcel: 'Dizajni na ovoj parceli:',
            chooseInstance: 'Izaberite stavku'
        },
        es: {
            memberPlans: 'Miembro de planes:', memberAgreements: 'Miembro de acuerdos:',
            includedDesigns: 'Diseños:', createdBy: 'Creado por el diseño:', formedFrom: 'Formado a partir de parcelas catastrales:',
            formedParcels: 'Forma parcelas:', affectsParcels: 'Usa parcelas catastrales:', designsOnParcel: 'Diseños en esta parcela:',
            chooseInstance: 'Elegir elemento'
        }
    };
    const keys = Object.freeze({
        memberPlans: 'memberPlans', memberAgreements: 'memberAgreements', includedDesigns: 'includedDesigns',
        createdBy: 'createdBy', formedFrom: 'formedFrom', formedParcels: 'formedParcels',
        affectsParcels: 'affectsParcels', designsOnParcel: 'designsOnParcel'
    });

    function register(win) {
        if (!win?.i18n?.registerTranslations) return;
        for (const [language, entries] of Object.entries(strings)) {
            win.i18n.registerTranslations(language, Object.fromEntries(
                Object.entries(entries).map(([key, value]) => [`clickStackRelations.${key}`, value])
            ));
        }
    }

    function translate(key, win) {
        const fullKey = `clickStackRelations.${key}`;
        const value = win?.i18n?.t?.(fullKey);
        return typeof value === 'string' && value && value !== fullKey ? value : strings.en[key] || key;
    }

    function renderGroup(group, doc, win) {
        if (!group || !doc) return null;
        register(win);
        const choices = doc.createElement('div');
        choices.className = 'click-stack__choices';
        choices.dataset.kind = group.kind || '';
        choices.setAttribute('role', 'group');
        const label = doc.createElement('span');
        label.className = 'click-stack__relation-label';
        label.textContent = translate(keys[group.relation] || group.relation, win);
        choices.setAttribute('aria-label', label.textContent);
        const strip = doc.createElement('div');
        strip.className = 'click-stack__strip';
        for (const instance of group.instances || []) {
            const chip = doc.createElement('button');
            chip.type = 'button';
            chip.className = 'click-stack__chip';
            chip.textContent = instance.label || instance.id || '';
            chip.title = instance.label || instance.id || '';
            chip.dataset.action = 'related';
            chip.dataset.kind = group.kind || '';
            chip.dataset.id = instance.id ?? '';
            strip.appendChild(chip);
        }
        choices.append(label, strip);
        return choices;
    }

    function renderSelector(section, doc, win) {
        if (!section?.multi || !doc) return null;
        register(win);
        const id = `click-stack-selector-${++selectorId}`;
        const wrap = doc.createElement('label');
        wrap.className = 'click-stack__selector-wrap';
        wrap.htmlFor = id;
        const caption = doc.createElement('span');
        caption.className = 'click-stack__selector-label';
        caption.textContent = translate('chooseInstance', win);
        const select = doc.createElement('select');
        select.id = id;
        select.className = 'click-stack__selector';
        select.dataset.action = 'instance';
        select.dataset.kind = section.kind || '';
        (section.instances || []).forEach(instance => {
            const option = doc.createElement('option');
            option.value = String(instance.id ?? '');
            option.textContent = instance.label || instance.id || '';
            select.appendChild(option);
        });
        select.selectedIndex = Number.isInteger(section.selectedIndex) ? section.selectedIndex : 0;
        wrap.append(caption, select);
        return wrap;
    }

    return Object.freeze({ renderGroup, renderSelector });
});
