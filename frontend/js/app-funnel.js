// Planning funnel wiring (docs/planning-usage-and-diagnostics.md): forwards AppDiagnostics
// observations to Clarity as events/tags and uploads each distinct one to the private store.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.document && root.AppDiagnostics) root.AppFunnel = api.install(root, root.AppDiagnostics);
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const UPLOAD_DELAY_MS = 10000;
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

    function install(win, client, { delayMs = UPLOAD_DELAY_MS } = {}) {
        const recorded = isRecordedVisitor(win);
        let timer = null;
        const endpoint = () => (typeof win.getBackendBase === 'function' ? win.getBackendBase() : 'https://api.urbangametheory.xyz')
            .replace(/\/$/, '') + '/diagnostics/reports';
        const flush = (keepalive = false) => {
            if (timer) { win.clearTimeout(timer); timer = null; }
            return client.upload({ fetch: win.fetch.bind(win), endpoint: endpoint(), keepalive });
        };
        client.subscribe((entry, { first }) => {
            if (!recorded || !first) return;
            for (const command of clarityCommands(entry)) win.clarity?.(...command);
            // Batches observations instead of one request each; hiding the tab sends at once.
            if (!timer) timer = win.setTimeout(() => { timer = null; void flush(); }, delayMs);
        });
        win.document.addEventListener('visibilitychange', () => {
            if (recorded && win.document.visibilityState === 'hidden') void flush(true);
        });
        win.document.addEventListener('parcelBasedModalOpened', () => {
            client.event('start', 'success', { entity: 'design', context: { surface: 'draft-editor' } });
        });
        return {
            // Called once by js/boot-ready.js when the shell becomes usable.
            ready() {
                const city = win.resolveCurrentCityCode?.();
                if (recorded && typeof city === 'string' && city) win.clarity?.('set', 'city', city);
                client.event('open', 'success', { entity: 'workspace', context: { surface: 'runtime', route: routeOf(win.location.pathname) } });
            },
            inspect(kind) {
                const entity = INSPECT_ENTITIES[kind];
                if (entity) client.event('inspect', 'success', { entity, context: { surface: 'click-stack' } });
            },
            flush
        };
    }

    return { install, clarityCommands, routeOf, isRecordedVisitor, INSPECT_ENTITIES, UPLOAD_DELAY_MS };
});
