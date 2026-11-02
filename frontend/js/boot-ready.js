// The last script is loaded before DOMContentLoaded. The bootstrap listener registered in
// index.html attaches the shell controls after storage is ready; keep them inert until then.
Promise.all([
    new Promise(resolve => document.readyState === 'loading'
        ? document.addEventListener('DOMContentLoaded', resolve, { once: true }) : resolve()),
    window.PersistentStorage?.ready,
    window.i18n?.translationsReady
]).finally(() => {
    document.body.classList.remove('app-loading', 'i18n-loading');
});

// nginx answers every extensionless path with this app, so an address no router knows is marked
// here: noindex for search engines and one notice for people (js/app-routes.js).
if (window.__AppRoutes) {
    window.__AppRoutes.markUnknownPath({
        doc: document,
        pathname: window.location.pathname,
        notify: () => showEphemeralMessage(window.i18n.t('ephemeral.messages.unknown_path'), 8000, 'warning')
    });
}
