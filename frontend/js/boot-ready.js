// Marks the end of app bootstrap. This is the LAST script in index.html's load list: once it
// runs, every inline onclick handler exists, so the CSS boot gate (body.app-loading keeps the
// always-visible chrome inert) can be lifted. Loaded scripts are independent tags, so an error
// in an earlier file cannot stop this one from running and wedging the UI shut.
Promise.resolve(window.i18n?.translationsReady).finally(() => {
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
