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
        affectsParcels: 'affectsParcels', designsOnParcel: 'designsOnParcel', affectedBy: 'affectedBy',
        designParcels: 'designParcels'
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

    // A group with tabs (a design's formed and input parcels): one tab per group, each showing its
    // own strip. The tabs switch here, so both stacks (2D and 3D) get them without wiring.
    function renderTabs(group, doc, win) {
        const choices = doc.createElement('div');
        choices.className = 'click-stack__choices click-stack__choices--tabs';
        choices.dataset.kind = group.kind || '';
        choices.setAttribute('role', 'group');
        choices.setAttribute('aria-label', translate(keys[group.relation] || group.relation, win));
        const tablist = doc.createElement('div');
        tablist.className = 'cb-tabs cb-tabs--fill';
        tablist.setAttribute('role', 'tablist');
        const panels = group.tabs.map((tab, index) => {
            const id = `click-stack-relation-${++selectorId}`;
            const button = doc.createElement('button');
            button.type = 'button';
            button.className = 'cb-tab';
            button.id = `${id}-tab`;
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-controls', id);
            button.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
            button.textContent = `${translate(`${keys[tab.relation] || tab.relation}Tab`, win)} (${tab.count})`;
            tablist.appendChild(button);
            const panel = renderGroup({ ...tab, tabs: null }, doc, win);
            panel.id = id;
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', button.id);
            panel.hidden = index !== 0;
            panel.querySelector('.click-stack__relation-label')?.remove();
            button.addEventListener('click', () => {
                [...tablist.children].forEach(other => other.setAttribute('aria-selected', other === button ? 'true' : 'false'));
                panels.forEach(other => { other.hidden = other !== panel; });
            });
            return panel;
        });
        choices.append(tablist, ...panels);
        return choices;
    }

    function renderGroup(group, doc, win) {
        if (!group || !doc) return null;
        if (Array.isArray(group.tabs) && group.tabs.length) return renderTabs(group, doc, win);
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
        // An item highlights its object (hover, focus, click) and never navigates; its own open
        // button takes the stack to the object (docs/click-stack.md, "Object lists").
        for (const instance of group.instances || []) {
            const name = instance.label || instance.id || '';
            const item = doc.createElement('span');
            item.className = 'click-stack__link';
            const chip = doc.createElement('button');
            chip.type = 'button';
            chip.className = 'btn click-stack__chip';
            chip.textContent = name;
            chip.title = name;
            chip.dataset.action = 'preview';
            chip.dataset.kind = group.kind || '';
            chip.dataset.id = instance.id ?? '';
            chip.setAttribute('aria-pressed', 'false');
            const open = doc.createElement('button');
            open.type = 'button';
            open.className = 'btn btn-icon click-stack__open';
            open.dataset.action = 'related';
            open.dataset.kind = group.kind || '';
            open.dataset.id = instance.id ?? '';
            const openLabel = win?.i18n?.t?.('lists.openNamed', { title: name }) || `Open ${name}`;
            open.title = openLabel;
            open.setAttribute('aria-label', openLabel);
            const icon = doc.createElement('i');
            icon.className = 'fas fa-arrow-right';
            icon.setAttribute('aria-hidden', 'true');
            open.appendChild(icon);
            item.append(chip, open);
            strip.appendChild(item);
        }
        choices.append(label, strip);
        return choices;
    }

    // The object a related item names: a peer in its own section, else a member of the selected
    // object (a plan's designs, which are read without being imported).
    function relatedInstance(stack, kind, id, selectedOf) {
        const section = stack?.sections?.find(entry => entry.kind === kind);
        return section?.instances.find(instance => String(instance.id) === String(id))
            || selectedOf(stack, stack?.selectedKind)?.members?.find(member => String(member.id) === String(id))
            || null;
    }

    // Hover and keyboard focus show an item's object; a click keeps it shown (pressed) until it is
    // clicked again or the stack highlights a section anew. `show(kind, id, { pinned })` draws one
    // object; `restore()` draws the section's own highlight again.
    function bindPreview(container, { show, restore }) {
        let pinned = null;
        // The whole item (its name and its open button) shows the object.
        const itemOf = target => {
            const item = target?.closest?.('.click-stack__link');
            return item && container.contains(item) ? item : null;
        };
        const chipOf = item => item.querySelector('[data-action="preview"]');
        const back = () => {
            if (pinned && !pinned.isConnected) pinned = null; // its list was rendered anew
            if (pinned) show(pinned.dataset.kind, pinned.dataset.id, { pinned: false }); else restore();
        };
        const enter = event => {
            const item = itemOf(event.target);
            if (!item || item.contains(event.relatedTarget)) return;
            const chip = chipOf(item);
            show(chip.dataset.kind, chip.dataset.id, { pinned: false });
        };
        const leave = event => {
            const item = itemOf(event.target);
            if (item && !item.contains(event.relatedTarget)) back();
        };
        container.addEventListener('mouseover', enter);
        container.addEventListener('mouseout', leave);
        container.addEventListener('focusin', enter);
        container.addEventListener('focusout', leave);
        container.addEventListener('click', event => {
            const chip = event.target?.closest?.('[data-action="preview"]');
            if (!chip || !container.contains(chip)) return;
            const same = pinned === chip;
            if (pinned) pinned.setAttribute('aria-pressed', 'false');
            pinned = same ? null : chip;
            if (pinned) {
                pinned.setAttribute('aria-pressed', 'true');
                show(chip.dataset.kind, chip.dataset.id, { pinned: true });
            } else restore();
        });
        return {
            // The section's own highlight came back (a selection, a refresh): no item stays pressed.
            reset() {
                if (pinned?.isConnected) pinned.setAttribute('aria-pressed', 'false');
                pinned = null;
            }
        };
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

    // The design card's actions, above its panel: Add to plan (PlanDialog.addDesign) and Download. A published
    // design this browser holds no copy of is imported first, as opening it does.
    function renderDesignActions(instance, doc, win) {
        if (!instance || !doc) return null;
        const actions = doc.createElement('div');
        actions.className = 'cb-actions click-stack__actions click-stack__actions--design';
        const add = doc.createElement('button');
        add.type = 'button';
        add.className = 'btn btn-add-to-plan';
        add.dataset.designAction = 'add-to-plan';
        const icon = doc.createElement('i');
        icon.className = 'fas fa-list';
        icon.setAttribute('aria-hidden', 'true');
        const label = doc.createElement('span');
        label.textContent = win?.i18n?.t?.('planDialog.addToPlan') || 'Add to plan';
        add.append(icon, label);
        add.addEventListener('click', () => win.BusyControl.track(add, async () => {
            let key = instance.id;
            if (!win.proposalStorage.getProposal(key) && instance.serverId) {
                const proposal = await win.DesignSync.importDesign(await win.DesignSync.fetchDesign(instance.serverId));
                key = win.getProposalKey(proposal) || proposal.proposalId;
            }
            return win.PlanDialog.addDesign(key);
        }));
        actions.appendChild(add);
        // Download: the design as a file; one this browser holds no copy of is fetched, not stored.
        const download = doc.createElement('button');
        download.type = 'button';
        download.className = 'btn';
        download.dataset.designAction = 'download';
        const downloadIcon = doc.createElement('i');
        downloadIcon.className = 'fas fa-download';
        downloadIcon.setAttribute('aria-hidden', 'true');
        const downloadLabel = doc.createElement('span');
        downloadLabel.textContent = win?.i18n?.t?.('common.download') || 'Download';
        download.append(downloadIcon, downloadLabel);
        download.addEventListener('click', () => win.BusyControl.track(download, async () => {
            const record = win.proposalStorage.getProposal(instance.id) || (instance.serverId
                ? { ...win.DesignSync.localDesignFromRow(await win.DesignSync.fetchDesign(instance.serverId), { apiBase: win.DesignSync.apiBase() }), proposalId: instance.serverId }
                : null);
            if (record) win.PlanFileUI.design(record);
        }).catch(error => win.showStyledAlert(error.message)));
        actions.appendChild(download);
        return actions;
    }

    return Object.freeze({ designType, designOptionLabel, renderDesignType, renderGroup, relatedInstance, bindPreview,
        renderSelector, updateSelector, renderDesignActions });
});
