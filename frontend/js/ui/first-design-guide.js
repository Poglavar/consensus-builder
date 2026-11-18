// The getting-started hints of a first visit: one section of the shared banner card that follows
// what the person does, from the first view to their first saved design. It never blocks the map.
(function attachFirstDesignGuide(global) {
    'use strict';

    const doc = global.document;
    const Model = global.FirstDesignGuideModel;
    if (!doc || !Model) return;

    // created: a design was authored in this visit. closed: the hints are over for this page.
    const state = { el: null, shown: null, created: false, closed: false };

    const t = (key, fallback) => {
        const value = global.i18n && typeof global.i18n.t === 'function' ? global.i18n.t(key) : null;
        return value && value !== key ? value : fallback;
    };

    const TEXT = {
        'open-map': ['firstDesignGuide.openMap', 'New here? Designs start on the 2D map: open it, then click any parcel.'],
        'click-parcel': ['firstDesignGuide.clickParcel', 'Click any parcel to choose what to design on it.'],
        'pick-tool': ['firstDesignGuide.pickTool', 'Choose a tool under Actions. Park and Square appear at once; Freeform building opens an editor.'],
        saved: ['firstDesignGuide.saved', 'Your first design is saved in this browser. See it in 3D, or use Share for a link.']
    };
    const ACTIONS = {
        'open-map': ['firstDesignGuide.openMapAction', 'Open the 2D map', () => global.requestMapMode('2d')],
        'how-it-works': ['modal.siteIntro.open', 'How it works', () => global.openSiteIntro()],
        'see-3d': ['firstDesignGuide.see3d', 'See it in 3D', () => { finish(); return global.requestMapMode('model'); }]
    };

    function seen() {
        try { return global.localStorage.getItem(Model.SEEN_KEY) === '1'; } catch (_) { return true; }
    }

    function markSeen() {
        try { global.localStorage.setItem(Model.SEEN_KEY, '1'); } catch (_) { /* the hints end with this page */ }
    }

    function finish() {
        markSeen();
        state.closed = true;
        state.created = false;
        render();
    }

    function currentStep() {
        return Model.step({
            seen: state.closed || seen(),
            created: state.created && !state.closed,
            classes: Array.from(doc.body.classList),
            selectedKind: doc.querySelector('#click-stack .click-stack__section.is-selected')?.dataset.kind || null
        });
    }

    function remove() {
        if (state.el) state.el.remove();
        state.el = null;
        state.shown = null;
    }

    function draw(name) {
        const banner = state.el || doc.createElement('div');
        banner.id = 'first-design-guide';
        banner.className = 'cb-banner cb-banner--dismissible';
        banner.setAttribute('role', 'status');
        banner.dataset.step = name;
        banner.textContent = '';
        const text = doc.createElement('p');
        text.textContent = t(...TEXT[name]);
        banner.appendChild(text);
        Model.actions(name).forEach(id => {
            const [key, fallback, run] = ACTIONS[id];
            const button = doc.createElement('button');
            button.type = 'button';
            // The step's own next move is the primary button; the explainer is always secondary.
            button.className = id === 'how-it-works' ? 'btn btn-sm' : 'btn btn-sm btn-primary';
            button.dataset.guideAction = id;
            button.textContent = t(key, fallback);
            button.addEventListener('click', () => global.BusyControl.track(button, () => run())
                .catch(error => global.showStyledAlert(error.message)));
            banner.appendChild(button);
        });
        const closeLabel = t('firstDesignGuide.close', 'Close getting started hints');
        const close = doc.createElement('button');
        close.type = 'button';
        close.className = 'close-circle-btn cb-banner__close';
        close.setAttribute('aria-label', closeLabel);
        close.title = closeLabel;
        close.textContent = '×';
        close.addEventListener('click', finish);
        banner.appendChild(close);
        if (!state.el) {
            if (!global.__BannerStack || !global.__BannerStack.mount(banner)) return;
            state.el = banner;
        }
        state.shown = name;
    }

    function render(force) {
        const name = currentStep();
        if (!name) return remove();
        if (name === state.shown && force !== true) return;
        // A saved design completes the guide: stored at once, so a reload does not start it again.
        if (name === 'saved') markSeen();
        draw(name);
    }

    function init() {
        // Every fact the model reads is a body class or the open click-stack section, both of
        // which settle within the event that changed them.
        new global.MutationObserver(() => render()).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
        doc.addEventListener('click', () => render());
        global.addEventListener('mapmodechange', () => render());
        global.addEventListener('i18n:translationsLoaded', () => render(true));
        doc.addEventListener('proposalCreated', () => {
            // Only a newcomer's first design is announced; a returning visitor has the flag.
            if (state.closed || (seen() && !state.created)) return;
            state.created = true;
            render();
        });
        render();
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})(window);
