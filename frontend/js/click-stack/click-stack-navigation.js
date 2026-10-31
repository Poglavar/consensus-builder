// Shared mobile object navigation and content tabs around the existing 2D/3D inspection panels.
(function (win) {
    'use strict';
    const order = ['ground', 'selection', 'parcels', 'formed', 'built', 'permitted', 'designs', 'plans', 'agreements'];
    const hierarchy = ['parcels', 'formed', 'designs', 'plans', 'agreements'];
    const sessions = new WeakMap();
    const remembered = new Map();
    const t = key => win.i18n.t(`clickStackNavigation.${key}`);
    function listLabel(kind, node) {
        const list = node.matches('.click-stack__choices') ? node : node.querySelector('.click-stack__choices');
        if (!['designs', 'plans', 'agreements'].includes(kind) || !list) return t(kind);
        return `${t(kind)} (${list.dataset.itemCount}${list.dataset.more === 'true' ? '+' : ''})`;
    }
    const icon = name => { const el = document.createElement('i'); el.className = name; el.setAttribute('aria-hidden', 'true'); return el; };
    function button(label, className, run) {
        const el = document.createElement('button'); el.type = 'button'; el.className = className;
        el.setAttribute('aria-label', label); el.title = label;
        el.addEventListener('click', event => { event.stopPropagation(); run(); });
        return el;
    }
    function keyboardTabs(nav) {
        nav.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            const tabs = [...nav.querySelectorAll('[role="tab"]')], index = tabs.indexOf(event.target);
            if (index < 0) return;
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            event.preventDefault(); event.stopPropagation(); tabs[next].click(); tabs[next].focus();
        });
    }
    function showMap(el) {
        el?.classList.remove('is-mobile-full');
        const full = el?.querySelector('.click-stack__size');
        if (full) {
            full.setAttribute('aria-label', t('fullScreen')); full.title = t('fullScreen');
            full.replaceChildren(icon('fas fa-expand'));
        }
    }
    function frame(el, stack, icons, labelOf, select, close) {
        const list = el.querySelector('.click-stack__sections');
        list.id = `${el.id}-sections`;
        const nav = document.createElement('div'); nav.className = 'click-stack__object-tabs';
        nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', t('objects'));
        const sections = [...stack.sections].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
        sections.forEach((section, index) => {
            const selected = stack.selectedKind === section.kind;
            const tab = button(labelOf(section), 'click-stack__object-tab', () => {
                select(section.kind);
                el.querySelector(`.click-stack__object-tab[data-kind="${section.kind}"]`)?.focus({ preventScroll: true });
            });
            tab.dataset.kind = section.kind; tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
            tab.setAttribute('aria-controls', list.id);
            tab.appendChild(icon(icons[section.kind] || 'fas fa-circle'));
            const next = sections[index + 1];
            if (next && hierarchy.includes(section.kind) && hierarchy.indexOf(next.kind) > hierarchy.indexOf(section.kind)) {
                const mark = document.createElement('span'); mark.className = 'click-stack__progression';
                mark.textContent = '›'; mark.setAttribute('aria-hidden', 'true'); tab.appendChild(mark);
            }
            nav.appendChild(tab);
        });
        keyboardTabs(nav); el.insertBefore(nav, el.firstChild);
        const heading = el.querySelector('.is-selected .click-stack__heading');
        if (heading) {
            if (stack.expanded) {
                const full = button(t(el.classList.contains('is-mobile-full') ? 'showMap' : 'fullScreen'),
                    'btn btn-quiet btn-icon click-stack__size', () => {
                        el.classList.toggle('is-mobile-full');
                        const expanded = el.classList.contains('is-mobile-full');
                        full.setAttribute('aria-label', t(expanded ? 'showMap' : 'fullScreen'));
                        full.title = full.getAttribute('aria-label');
                        full.replaceChildren(icon(`fas ${expanded ? 'fa-compress' : 'fa-expand'}`));
                    });
                full.appendChild(icon(`fas ${el.classList.contains('is-mobile-full') ? 'fa-compress' : 'fa-expand'}`));
                heading.appendChild(full);
            } else showMap(el);
            const dismiss = button(t('close'), 'btn btn-quiet btn-icon click-stack__dismiss', close);
            dismiss.appendChild(icon('fas fa-times')); heading.appendChild(dismiss);
        }
        win.MobileDockSheet?.observeOccupancy?.(win, el);
        win.MobileDockSheet?.reportOccupancy?.(win);
    }

    // Page sources retain their DOM, listeners and state. Native panel tabs are promoted into
    // this one bar; selecting them runs the original control, including its loading behaviour.
    function content(body, kind, id) {
        if (!body || !win.MutationObserver) return;
        const previous = sessions.get(body);
        if (previous) { previous.sync(); return; }
        const memoryKey = `${kind}:${id}`;
        let active = remembered.get(memoryKey), signature = '', pages = [];
        const scrolls = new Map();
        const nav = document.createElement('div'); nav.className = 'cb-tabs click-stack__content-tabs';
        nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', t('content'));
        keyboardTabs(nav);
        function select(key) {
            if (active) scrolls.set(active, body.scrollTop);
            active = key; remembered.set(memoryKey, key);
            // Bound the presentation cache without tying it to persisted domain records.
            if (remembered.size > 100) remembered.delete(remembered.keys().next().value);
            apply(); body.scrollTop = scrolls.get(key) || 0;
        }
        function apply() {
            const selected = pages.find(page => page.key === active);
            if (!selected) return;
            const visible = new Set(selected.nodes);
            pages.flatMap(page => page.nodes).forEach(node => node.toggleAttribute('data-stack-hidden', !visible.has(node)));
            body.querySelectorAll('#proposal-details-panel, .click-stack__agreement-properties').forEach(panel => { panel.dataset.stackPage = active; });
            selected.native?.getAttribute('aria-selected') !== 'true' && selected.native?.click();
            nav.querySelectorAll('[role="tab"]').forEach(tab => {
                const on = tab.dataset.page === active;
                tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1;
            });
        }
        function sync() {
            if (!body.isConnected) return;
            pages = [];
            const add = (key, label, node, native) => {
                let page = pages.find(page => page.key === key);
                if (!page) { page = { key, label, nodes: [], native }; pages.push(page); }
                if (!page.nodes.includes(node)) page.nodes.push(node);
            };
            for (const node of [...body.children]) {
                if (node === nav || node.classList.contains('click-stack__selector-wrap')) continue;
                if (node.id === 'proposal-details-panel') {
                    for (const tab of node.querySelectorAll('[data-proposal-tab]')) {
                        const key = tab.dataset.proposalTab;
                        add(`design-${key}`, key === 'overview' ? t('info') : tab.textContent.trim(), node, tab);
                    }
                    add('actions', t('actions'), node);
                } else if (node.id === 'parcel-info-panel') {
                    for (const tab of node.querySelectorAll('[data-parcel-tab-id]')) {
                        const key = tab.dataset.parcelTabId;
                        // The relationship list already represents designs on this one parcel.
                        if (key === 'proposals-tab' && kind !== 'selection' && body.querySelector('.click-stack__choices[data-kind="designs"]')) continue;
                        const label = key === 'proposals-tab' ? `${t('designs')} (${tab.querySelector('.parcel-tab-count')?.textContent || '0'})`
                            : key === 'propose-tab' ? t('actions') : (tab.getAttribute('aria-label') || tab.textContent.trim());
                        add(`parcel-${key}`, label, node, tab);
                    }
                } else if (node.classList.contains('click-stack__agreement-properties') && node.querySelector('[data-agreement-properties-tab]')) {
                    for (const tab of node.querySelectorAll('[data-agreement-properties-tab]')) {
                        add(`agreement-${tab.dataset.agreementPropertiesTab}`, tab.textContent.trim(), node, tab);
                    }
                    add('actions', t('actions'), node);
                } else if (node.classList.contains('click-stack__choices')) {
                    if (node.classList.contains('click-stack__choices--tabs')) {
                        for (const panel of node.querySelectorAll(':scope > .click-stack__choices')) {
                            const tab = node.querySelector(`[aria-controls="${panel.id}"]`);
                            add(`relation-${panel.dataset.kind}`, tab?.textContent.trim() || t(panel.dataset.kind), node, tab);
                        }
                    } else add(`relation-${node.dataset.kind}`, listLabel(node.dataset.kind, node), node);
                } else if (node.classList.contains('click-stack__membership-details')) add('relation-designs', listLabel('designs', node), node);
                else if (node.classList.contains('click-stack__actions') || node.matches('.click-stack__agreement-more, button')) add('actions', t('actions'), node);
                else add('info', t('info'), node);
            }
            if (!pages.length) return;
            if (!pages.some(page => page.key === active)) {
                active = pages.find(page => page.key === (kind === 'plans' ? 'relation-designs' : 'design-overview'))?.key
                    || pages.find(page => page.key === 'parcel-propose-tab')?.key || pages[0].key;
            }
            const next = pages.map(page => `${page.key}:${page.label}`).join('|');
            if (signature !== next) {
                signature = next;
                nav.replaceChildren(...pages.map(page => {
                    const tab = button(page.label, 'cb-tab', () => select(page.key));
                    tab.textContent = page.label; tab.dataset.page = page.key;
                    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', body.id);
                    return tab;
                }));
            }
            if (nav.parentNode !== body) body.insertBefore(nav, body.firstChild);
            body.classList.add('has-content-tabs'); apply();
        }
        const observer = new win.MutationObserver(mutations => {
            if (mutations.some(mutation => mutation.target !== nav && !nav.contains(mutation.target))) sync();
        });
        sessions.set(body, { sync, observer, select }); sync(); observer.observe(body, { childList: true, subtree: true });
    }
    function release(el, keepBody) {
        el?.querySelectorAll('.click-stack__body').forEach(body => {
            if (body !== keepBody) { sessions.get(body)?.observer.disconnect(); sessions.delete(body); }
        });
    }
    function agreements(body, rows, status = {}) {
        if (!body) return;
        const group = body.querySelector(':scope > [data-stack-agreements]');
        const items = rows.filter(row => !row.membershipPlaceholder);
        const next = win.ClickStackRelations.renderGroup({ kind: 'agreements', label: t('agreements'), instances: items }, document, win);
        next.setAttribute('data-stack-agreements', '');
        next.dataset.more = String(!!status.more);
        if (!items.length || status.loading || status.failed) {
            const message = document.createElement('p'); message.className = 'click-stack__facts';
            message.setAttribute('role', 'status');
            message.textContent = status.failed ? win.i18n.t('designMemberships.failed')
                : status.loading ? win.i18n.t('designMemberships.loading') : t('noAgreements');
            next.appendChild(message);
        }
        if (status.failed || status.more) {
            const label = win.i18n.t(`designMemberships.${status.failed ? 'retry' : 'more'}`);
            const more = button(label, 'btn', () => win.BusyControl.track(more, status.load));
            more.textContent = label; more.disabled = !!status.loading; next.appendChild(more);
        }
        if (group) group.replaceWith(next); else body.appendChild(next);
    }
    const selectPage = (body, key) => sessions.get(body)?.select(key);
    win.ClickStackNavigation = { frame, content, release, showMap, agreements, selectPage };
})(window);
