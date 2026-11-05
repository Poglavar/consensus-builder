// Planning funnel wiring (docs/planning-usage-and-diagnostics.md): once the visitor opts in, forwards
// AppDiagnostics observations to Clarity as events/tags and uploads each distinct one to the private
// store. The ask appears on the first error; the Status log dialog holds the choice afterwards.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.document && root.AppDiagnostics) root.AppFunnel = api.install(root, root.AppDiagnostics);
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const UPLOAD_DELAY_MS = 10000;
    // The visitor's sharing choice, 'yes' or 'no'; absent means not asked yet.
    const CONSENT_KEY = 'ugt-diagnostics-sharing';
    // Click-stack section kinds (click-stack-model.js ORDER) → diagnostics entity.
    const INSPECT_ENTITIES = Object.freeze({ agreements: 'artifact', plans: 'plan', designs: 'design', built: 'building',
        permitted: 'parcel', formed: 'parcel', parcels: 'parcel', ground: 'parcel' });
    const ROUTE_PATTERNS = [[/^\/(index\.html)?$/, 'map'], [/^\/proposals\/?$/, 'proposals'], [/^\/designs(\/|$)/, 'designs'],
        [/^\/agreements\//, 'agreements'], [/^\/plans\//, 'plans'], [/^\/parcel\//, 'parcel'], [/^\/bets\//, 'bets']];

    function routeOf(pathname) {
        const path = String(pathname || '/').replace(/\/monitors\/\d+\/?$/, '') || '/';
        return ROUTE_PATTERNS.find(([pattern]) => pattern.test(path))?.[1] || null;
    }

    // Clarity commands for one wire entry. Event names are the closed vocabulary only, e.g.
    // "inspect-parcel-success" or "error-plan-save-failed"; errors also tag and keep the recording.
    function clarityCommands(entry) {
        if (entry.kind === 'error') {
            return [['event', `error-${entry.code}`], ['set', 'error', entry.code], ['upgrade', entry.code]];
        }
        const commands = [['event', `${entry.operation}-${entry.entity}-${entry.outcome}`]];
        if (entry.outcome === 'failure') commands.push(['set', 'failed', `${entry.operation}-${entry.entity}`], ['upgrade', `${entry.operation}-failure`]);
        if (entry.operation === 'open' && entry.entity === 'workspace' && entry.context.route) commands.push(['set', 'entry', entry.context.route]);
        return commands;
    }

    // Automated and local sessions are kept out of both sinks.
    function isRecordedVisitor(win) {
        const host = win.location?.hostname;
        return !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) && win.navigator?.webdriver !== true;
    }

    function readConsent(win) {
        try { const value = win.localStorage?.getItem(CONSENT_KEY); return value === 'yes' || value === 'no' ? value : null; }
        catch { return null; }
    }

    function writeConsent(win, value) {
        try { win.localStorage?.setItem(CONSENT_KEY, value); } catch { /* remembered for this tab only */ }
    }

    // A problem the visitor just met is the moment to ask whether to share it.
    const asksOn = entry => entry.kind === 'error' || entry.outcome === 'failure';

    function install(win, client, { delayMs = UPLOAD_DELAY_MS } = {}) {
        const recorded = isRecordedVisitor(win);
        const doc = win.document;
        const text = (key, fallback) => client.text(`diagnostics.ui.${key}`, fallback);
        let consent = readConsent(win);
        let timer = null, city = null, banner = null, checkbox = null;
        // First occurrences seen before the choice; sent to Clarity only after a yes. The private
        // store needs no copy: upload() sends every first occurrence still held in this tab.
        const held = [];
        const endpoint = () => (typeof win.getBackendBase === 'function' ? win.getBackendBase() : 'https://api.urbangametheory.xyz')
            .replace(/\/$/, '') + '/diagnostics/reports';
        const flush = (keepalive = false) => {
            if (timer) { win.clearTimeout(timer); timer = null; }
            return client.upload({ fetch: win.fetch.bind(win), endpoint: endpoint(), keepalive });
        };
        const forward = entry => {
            for (const command of clarityCommands(entry)) win.clarity?.(...command);
            // Batches observations instead of one request each; hiding the tab sends at once.
            if (!timer) timer = win.setTimeout(() => { timer = null; void flush(); }, delayMs);
        };
        const tagCity = () => { if (city) win.clarity?.('set', 'city', city); };

        function choose(value) {
            consent = value;
            writeConsent(win, value);
            banner?.remove(); banner = null;
            if (checkbox) checkbox.checked = value === 'yes';
            if (value === 'yes' && recorded) { tagCity(); held.splice(0).forEach(forward); }
            else held.length = 0;
        }

        // One section of the shared banner card (js/ui/banner-stack.js).
        function ask() {
            if (banner || !doc.createElement) return;
            banner = doc.createElement('aside');
            banner.className = 'cb-banner'; banner.setAttribute('role', 'status'); banner.setAttribute('data-diagnostics-ask', '');
            const title = doc.createElement('h3'); title.className = 'cb-banner__title';
            title.textContent = text('askTitle', 'Help fix this problem?');
            const body = doc.createElement('p');
            body.textContent = text('askText', 'Share anonymous counts of the steps taken and the error codes met in this tab, without plan content. The choice is remembered in this browser and can be changed in the Status log.');
            banner.append(title, body);
            for (const [key, fallback, value] of [['askYes', 'Share', 'yes'], ['askNo', 'No thanks', 'no']]) {
                const button = doc.createElement('button'); button.type = 'button'; button.className = 'btn';
                button.textContent = text(key, fallback); button.setAttribute(`data-diagnostics-${value}`, '');
                button.addEventListener('click', () => choose(value)); banner.append(button);
            }
            if (!win.__BannerStack?.mount(banner)) doc.body?.append(banner);
        }

        // The lasting control, beside the diagnostics download in the Status log footer.
        function control() {
            const host = doc.querySelector?.('#status-log-modal .cb-dialog__footer');
            if (!host || host.querySelector('[data-diagnostics-share]')) return;
            const label = doc.createElement('label'); label.className = 'checkbox-label';
            checkbox = doc.createElement('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('data-diagnostics-share', '');
            checkbox.checked = consent === 'yes';
            checkbox.addEventListener('change', () => choose(checkbox.checked ? 'yes' : 'no'));
            const span = doc.createElement('span'); span.setAttribute('data-i18n-key', 'diagnostics.ui.share');
            span.textContent = text('share', 'Share anonymous step and error counts');
            label.append(checkbox, span);
            host.insertBefore(label, host.querySelector('[data-diagnostics-export]'));
        }

        client.subscribe((entry, { first }) => {
            if (!recorded || !first || consent === 'no') return;
            if (consent === 'yes') return forward(entry);
            held.push(entry);
            if (asksOn(entry)) ask();
        });
        doc.addEventListener('visibilitychange', () => {
            if (recorded && consent === 'yes' && doc.visibilityState === 'hidden') void flush(true);
        });
        doc.addEventListener('parcelBasedModalOpened', () => {
            client.event('start', 'success', { entity: 'design', context: { surface: 'draft-editor' } });
        });
        if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', control, { once: true });
        else control();
        return {
            // Called once by js/boot-ready.js when the shell becomes usable.
            ready() {
                const code = win.resolveCurrentCityCode?.();
                city = typeof code === 'string' && code ? code : null;
                if (recorded && consent === 'yes') tagCity();
                client.event('open', 'success', { entity: 'workspace', context: { surface: 'runtime', route: routeOf(win.location.pathname) } });
            },
            inspect(kind) {
                const entity = INSPECT_ENTITIES[kind];
                if (entity) client.event('inspect', 'success', { entity, context: { surface: 'click-stack' } });
            },
            // Shows the opt-in banner now (it otherwise waits for the first error).
            ask,
            choose,
            flush
        };
    }

    return { install, clarityCommands, routeOf, isRecordedVisitor, readConsent, CONSENT_KEY, INSPECT_ENTITIES, UPLOAD_DELAY_MS };
});
