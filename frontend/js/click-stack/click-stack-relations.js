// Shared labeled relationship links and instance choices inside 2D and 3D stack sections.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ClickStackRelations = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    let selectorId = 0;
    const keys = Object.freeze({
        memberPlans: 'memberPlans', includedDesigns: 'includedDesigns',
        createdBy: 'createdBy', formedFrom: 'formedFrom', formedParcels: 'formedParcels',
        affectsParcels: 'affectsParcels', designsOnParcel: 'designsOnParcel'
    });

    function translate(key, win) {
        return win?.i18n?.t?.(`clickStackRelations.${key}`) || key;
    }

    // Presentation follows the authored goal, never a title or the selected physical object.
    function designType(instance, win) {
        const proposal = instance?.proposal || instance;
        const goal = win?.resolveProposalGoalKey?.(proposal) || proposal?.goal;
        const tones = { 'as-is': 'neutral', park: 'success', square: 'warning', lake: 'info', station: 'info',
            single: 'primary', buildings: 'primary', row: 'primary', parcelBased: 'primary',
            'urban-rule': 'primary', 'road-track': 'warning', 'parcel-layout': 'info',
            'ownership-transfer': 'warning' };
        if (!Object.hasOwn(tones, goal)) return null;
        const label = win?.getProposalDisplayTypeLabel?.(proposal) || win?.ProposalDesignGoals?.get(goal)?.label;
        if (!label) return null;
        const badge = win?.getProposalGoalBadge?.(['row', 'parcelBased'].includes(goal) ? 'single' : goal);
        const icon = goal === 'road-track' ? (win?.isTrackProposal?.(proposal) ? '🛤️' : '🛣️') : badge?.text;
        return { goal, label, icon: icon || '📐', tone: tones[goal] };
    }

    function renderDesignType(instance, doc, win) {
        const type = designType(instance, win);
        if (!type || !doc) return null;
        const pill = doc.createElement('span');
        pill.className = `cb-badge cb-badge--${type.tone} proposal-type-badge`;
        pill.dataset.designGoal = type.goal;
        const icon = doc.createElement('span');
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = type.icon;
        const label = doc.createElement('span');
        label.textContent = type.label;
        pill.append(icon, label);
        return pill;
    }

    function renderGroup(group, doc, win) {
        if (!group || !doc) return null;
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
            chip.className = 'btn click-stack__chip';
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

    function designOptionLabel(instance, win, plans = []) {
        const name = instance.label || instance.id || '';
        const type = designType(instance, win);
        const proposal = instance.proposal || instance;
        const cid = instance.cid || win?.DesignSync?.publishedCid?.(proposal);
        const current = win?.NamedPlans?.current;
        const memberships = plans.filter(plan => !plan.membershipPlaceholder && cid
            && (plan.membershipDesignCid === cid || (plan.designCids || plan.content?.designCids || []).includes(cid)));
        if (cid && current?.content?.designCids.includes(cid)) memberships.push({ label: current.content.title });
        const names = [...new Set(memberships.map(plan => plan.label || plan.title).filter(Boolean))];
        return [type && type.label !== name ? type.label : '', name,
            names.length ? `${translate('memberPlans', win)} ${names.join(', ')}` : ''].filter(Boolean).join(' · ');
    }

    function updateSelector(section, container, win, plans = []) {
        let select = container.querySelector('.click-stack__selector');
        if (!section.multi) { select?.closest('.click-stack__selector-wrap')?.remove(); return; }
        if (!select) {
            const wrapper = renderSelector(section, container.ownerDocument, win, plans);
            if (wrapper) container.insertBefore(wrapper, container.firstChild);
            return;
        }
        if (select.dataset.kind !== section.kind) return;
        const ids = section.instances.map(instance => String(instance.id));
        if (select.children.length !== ids.length || [...select.children].some((option, index) => option.value !== ids[index])) {
            select.replaceChildren(...ids.map(id => { const option = container.ownerDocument.createElement('option'); option.value = id; return option; }));
        }
        [...select.children].forEach((option, index) => {
            const instance = section.instances[index];
            option.textContent = section.kind === 'designs' ? designOptionLabel(instance, win, plans) : instance.label || instance.id || '';
        });
        select.selectedIndex = Number.isInteger(section.selectedIndex) ? section.selectedIndex : 0;
        const value = container.querySelector('.click-stack__selector-value');
        const instance = section.instances[select.selectedIndex];
        if (value) value.textContent = instance?.label || instance?.id || '';
    }

    function renderSelector(section, doc, win, plans = []) {
        if (!section?.multi || !doc) return null;
        const id = `click-stack-selector-${++selectorId}`;
        const wrap = doc.createElement('label');
        wrap.className = 'click-stack__selector-wrap';
        wrap.htmlFor = id;
        const caption = doc.createElement('span');
        caption.id = `${id}-label`;
        caption.className = 'click-stack__selector-label';
        const captions = { designs: 'chooseDesign', built: 'chooseBuilding', parcels: 'chooseParcel', formed: 'chooseParcel',
            plans: 'choosePlan', agreements: 'chooseAgreement', permitted: 'choosePermitted' };
        caption.textContent = translate(captions[section.kind] || 'chooseInstance', win);
        const select = doc.createElement('select');
        select.id = id;
        select.className = 'click-stack__selector';
        select.setAttribute('aria-labelledby', caption.id);
        select.dataset.action = 'instance';
        select.dataset.kind = section.kind || '';
        (section.instances || []).forEach(instance => {
            const option = doc.createElement('option');
            option.value = String(instance.id ?? '');
            select.appendChild(option);
        });
        wrap.appendChild(caption);
        if (section.kind === 'designs') {
            const field = doc.createElement('span');
            field.className = 'click-stack__selector-field';
            const value = doc.createElement('span');
            value.className = 'click-stack__selector-value';
            value.setAttribute('aria-hidden', 'true');
            const arrow = doc.createElement('i');
            arrow.className = 'click-stack__selector-arrow fas fa-chevron-down';
            arrow.setAttribute('aria-hidden', 'true');
            field.append(select, value, arrow);
            wrap.appendChild(field);
            select.addEventListener('change', () => {
                const selected = section.instances.find(instance => String(instance.id) === select.value);
                value.textContent = selected?.label || selected?.id || '';
            });
        } else wrap.appendChild(select);
        updateSelector(section, wrap, win, plans);
        return wrap;
    }

    return Object.freeze({ designType, designOptionLabel, renderDesignType, renderGroup, renderSelector, updateSelector });
});
