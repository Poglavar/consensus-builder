// Shared automatic-activation keyboard behavior for tablists. Existing click handlers own selection.
(function (global) {
    'use strict';
    const bound = new WeakSet();
    function sync(list) {
        if (!list) return;
        list.querySelectorAll('[role="tab"]').forEach(tab => {
            tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
        });
    }
    function bind(list) {
        if (!list || bound.has(list)) return;
        bound.add(list);
        sync(list);
        list.addEventListener('keydown', event => {
            const tabs = [...list.querySelectorAll('[role="tab"]')].filter(tab => !tab.hidden && !tab.disabled && (!tab.getClientRects || tab.getClientRects().length > 0));
            const index = tabs.indexOf(event.target);
            if (index < 0 || !tabs.length) return;
            const vertical = list.getAttribute('aria-orientation') === 'vertical';
            const previous = vertical ? 'ArrowUp' : 'ArrowLeft';
            const next = vertical ? 'ArrowDown' : 'ArrowRight';
            let target;
            if (event.key === 'Home') target = 0;
            else if (event.key === 'End') target = tabs.length - 1;
            else if (event.key === previous) target = (index + tabs.length - 1) % tabs.length;
            else if (event.key === next) target = (index + 1) % tabs.length;
            else return;
            event.preventDefault();
            tabs[target].focus();
            const id = tabs[target].id;
            tabs[target].click();
            // Some owners rebuild their tablist on activation; restore focus to its replacement.
            if (id && !tabs[target].isConnected) document.getElementById(id)?.focus();
        });
    }
    global.CbTabs = { bind, sync };
    function bindStatic() {
        ['.planning-tabs', '#parcel-info-panel .parcel-tabs', '.block-tabs', '#road-analysis-panel .tabs'].forEach(selector => bind(document.querySelector(selector)));
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindStatic);
    else bindStatic();
})(window);
