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
        const response = await fetch(urlWithBust, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
        if (!response.ok) {
            throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }

    const api = window.i18n;
    if (!api) return;
    const pending = new Map();
    function loadLanguage(lang) {
        if (!pending.has(lang)) pending.set(lang, (async () => {
            const source = SOURCES.find(source => source.lang === lang);
            if (!source) return;
            try {
                api.registerTranslations(lang, flattenTranslations(await loadJson(source.url)));
            } catch (error) {
                pending.delete(lang);
                console.warn('[i18n] Failed to load ' + lang, error);
            }
        })());
        return pending.get(lang);
    }
    function apply() {
        api.applyTranslations();
        window.dispatchEvent(new CustomEvent('i18n:translationsLoaded'));
    }
    // Locale detection includes the saved preference and URL. Only English and the selected
    // dictionary are on the first-paint path; another language cannot delay them or make them fail.
    api.translationsReady = Promise.resolve(api.ready).then(async () => {
        let language;
        do {
            language = api.getLanguage();
            await Promise.all([...new Set(['en', language])].map(loadLanguage));
        } while (language !== api.getLanguage());
        apply();
    }).finally(() => document.body?.classList.remove('i18n-loading'));
    api.onChange(async lang => {
        await loadLanguage(lang);
        apply();
    });
})();
