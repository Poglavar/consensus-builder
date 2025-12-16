(function () {
    const SOURCES = [
        { lang: 'en', url: 'i18n/en.json' },
        { lang: 'es', url: 'i18n/es.json' },
        { lang: 'sr', url: 'i18n/sr.json' },
        { lang: 'hr', url: 'i18n/hr.json' }
    ];

    function getCacheBuster() {
        if (typeof window !== 'undefined' && typeof window.getCacheBustToken === 'function') {
            try {
                const token = window.getCacheBustToken();
                if (token) {
                    return token;
                }
            } catch (_) { }
        }
        try {
            if (typeof window !== 'undefined' && Array.isArray(window.APP_VERSIONS) && window.APP_VERSIONS.length > 0) {
                const latest = window.APP_VERSIONS[0];
                if (latest && latest.version_number) {
                    return latest.version_number;
                }
            }
        } catch (_) { }
        return Date.now();
    }

    function flattenTranslations(node, prefix = '', out = {}) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            return out;
        }
        Object.entries(node).forEach(([key, value]) => {
            const path = prefix ? `${prefix}.${key}` : key;
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                flattenTranslations(value, path, out);
            } else {
                out[path] = value;
            }
        });
        return out;
    }

    async function loadJson(url) {
        const cacheBust = getCacheBuster();
        const urlWithBust = `${url}?v=${cacheBust}`;
        const response = await fetch(urlWithBust, { credentials: 'same-origin' });
        if (!response.ok) {
            throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }

    async function loadAndRegisterTranslations() {
        const api = (typeof window !== 'undefined') ? window.i18n : null;
        if (!api || typeof api.registerTranslations !== 'function') {
            return;
        }
        try {
            const loaded = await Promise.all(
                SOURCES.map(async ({ lang, url }) => {
                    const json = await loadJson(url);
                    return { lang, flat: flattenTranslations(json) };
                })
            );
            loaded.forEach(({ lang, flat }) => {
                api.registerTranslations(lang, flat);
            });
            if (typeof api.applyTranslations === 'function') {
                api.applyTranslations();
            }
            try {
                if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                    window.dispatchEvent(new CustomEvent('i18n:translationsLoaded'));
                }
            } catch (_) { }
        } catch (error) {
            console.warn('[i18n] Failed to load translations', error);
        }
    }

    function bootstrap() {
        const api = (typeof window !== 'undefined') ? window.i18n : null;
        const ready = api && api.ready && typeof api.ready.then === 'function' ? api.ready : null;
        if (ready) {
            ready.then(loadAndRegisterTranslations).catch(() => loadAndRegisterTranslations());
        } else {
            loadAndRegisterTranslations();
        }
    }

    bootstrap();
})();

