// Load English and the selected dictionary, sharing successful and in-flight requests across features.
(function () {
    const api = window.i18n;
    if (!api) return;
    const pending = new Map();
    // One token per page, including retries. A new request must not invent a different cache identity.
    const cacheBust = window.getCacheBustToken?.() || window.APP_VERSIONS?.[0]?.version_number || Date.now();

    function flattenTranslations(node, prefix = '', out = Object.create(null)) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Dictionary must be an object');
        for (const [key, value] of Object.entries(node)) {
            const path = prefix ? `${prefix}.${key}` : key;
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                flattenTranslations(value, path, out);
            } else {
                if (typeof value !== 'string' || Object.hasOwn(out, path)) throw new Error(`Invalid translation: ${path}`);
                out[path] = value;
            }
        }
        return out;
    }

    function loadLanguage(language) {
        const lang = api.getSupportedLanguages().find(candidate => candidate === language);
        if (!lang) return Promise.resolve(false);
        if (!pending.has(lang)) {
            const request = (async () => {
                const url = `i18n/${lang}.json?v=${encodeURIComponent(cacheBust)}`;
                const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
                if (!response.ok) throw new Error(`Failed to load ${lang}: ${response.status} ${response.statusText}`);
                const entries = flattenTranslations(await response.json());
                api.registerTranslations(lang, entries);
                return true;
            })().catch(error => {
                pending.delete(lang);
                console.warn(`[i18n] Failed to load ${lang}`, error);
                return false;
            });
            pending.set(lang, request);
        }
        return pending.get(lang);
    }
    api.loadLanguage = loadLanguage;

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
        // An older request may finish after a later language choice.
        if (lang === api.getLanguage()) apply();
    });
})();
