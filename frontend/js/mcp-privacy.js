// Wire the privacy page's shared locale picker after its selected dictionary is ready.
(function attachMcpPrivacy(root) {
    'use strict';
    async function init() {
        await root.i18n.translationsReady;
        const locale = root.document.getElementById('privacy-language');
        locale.value = root.i18n.getLocale();
        locale.addEventListener('change', () => root.i18n.setLanguage(locale.value));
        root.i18n.applyTranslations(root.document);
    }
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})(typeof window !== 'undefined' ? window : null);
