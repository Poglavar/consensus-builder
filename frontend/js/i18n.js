(function () {
    const globalScope = typeof window !== 'undefined' ? window : self;
    const FALLBACK_LANGUAGE = 'en';
    const STORAGE_KEY = 'cb_language';
    // This registry is the source for detection, dictionary loading and every locale picker.
    // Native names and flags are picker metadata; translated copy belongs in i18n/<language>.json.
    const LOCALE_CHOICES = Object.freeze([
        { locale: 'en-GB', name: 'English (United Kingdom)', flag: '🇬🇧', key: 'language.switcher.to_en' },
        { locale: 'en-US', name: 'English (United States)', flag: '🇺🇸', key: 'language.switcher.to_en_us' },
        { locale: 'es-ES', name: 'Español', flag: '🇪🇸', key: 'language.switcher.to_es' },
        { locale: 'sr-Latn-RS', name: 'Srpski', flag: '🇷🇸', key: 'language.switcher.to_sr' },
        { locale: 'hr-HR', name: 'Hrvatski', flag: '🇭🇷', key: 'language.switcher.to_hr' }
    ].map(Object.freeze));
    // The viewer picks a locale: a UI language plus the region whose conventions numbers and dates
    // are written in (js/format.js). Money keeps the currency of the place it belongs to
    // (js/city-money.js); a locale never converts it. The first locale of a language is its default.
    // The stored preference (cb_language) holds the locale tag; a bare language reads as its default.
    const SUPPORTED_LOCALES = Object.freeze(LOCALE_CHOICES.map(choice => choice.locale));
    const supportedLanguages = new Set(SUPPORTED_LOCALES.map(locale => locale.split('-')[0]));
    const listeners = new Set();
    const translations = Object.create(null);

    let currentLanguage = FALLBACK_LANGUAGE;
    let currentLocale = SUPPORTED_LOCALES[0];
    // Set once the user picks a language in a switcher. Until then an explicit ?lang= in the URL
    // outranks the saved preference and any city default for the whole page session.
    let userChoseLanguage = false;
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });

    function normalizeLanguage(value) {
        if (!value) return null;
        const normalized = String(value).toLowerCase();
        const primary = normalized.split(/[-_]/)[0];
        return supportedLanguages.has(primary) ? primary : null;
    }

    function defaultLocaleFor(lang) {
        return SUPPORTED_LOCALES.find(locale => locale.split('-')[0] === lang) || SUPPORTED_LOCALES[0];
    }

    // A locale tag or a bare language → a supported locale, or null when its language is not one
    // the UI speaks. A tag names its region ("en-US", "sr-Latn-RS", "en_us"); a bare language keeps
    // `preferred` when that is a locale of the same language, else takes the language's default.
    function normalizeLocale(value, preferred) {
        const lang = normalizeLanguage(value);
        if (!lang) return null;
        const parts = String(value).split(/[-_]/).slice(1);
        const region = parts.map(part => part.toUpperCase()).find(part => /^[A-Z]{2}$/.test(part));
        if (region) {
            const match = SUPPORTED_LOCALES.find(locale => locale.split('-')[0] === lang && locale.endsWith('-' + region));
            return match || defaultLocaleFor(lang);
        }
        if (preferred && SUPPORTED_LOCALES.includes(preferred) && preferred.split('-')[0] === lang) return preferred;
        return defaultLocaleFor(lang);
    }

    function updateDocumentLanguage(lang) {
        if (globalScope.document && globalScope.document.documentElement) {
            globalScope.document.documentElement.setAttribute('lang', lang);
        }
    }

    // The saved preference as a locale ("en-US"), or null.
    function readStoredLocale() {
        try {
            if (globalScope.PersistentStorage && typeof globalScope.PersistentStorage.getItem === 'function') {
                return normalizeLocale(globalScope.PersistentStorage.getItem(STORAGE_KEY));
            }
        } catch (_) { }

        return null;
    }

    function readStoredLanguage() {
        const locale = readStoredLocale();
        return locale ? normalizeLanguage(locale) : null;
    }

    function persistLanguage(lang) {
        try {
            if (globalScope.PersistentStorage && typeof globalScope.PersistentStorage.setItem === 'function') {
                globalScope.PersistentStorage.setItem(STORAGE_KEY, lang);
            }
        } catch (_) { }
    }

    // ?lang= as written ("en-US" or "hr"), when it names a language the UI speaks.
    function readUrlLanguageParam() {
        try {
            if (globalScope.location && globalScope.location.search) {
                const langParam = new URLSearchParams(globalScope.location.search).get('lang');
                if (langParam && normalizeLanguage(langParam)) return langParam;
            }
        } catch (_) { }
        return null;
    }

    function readUrlLanguage() {
        const param = readUrlLanguageParam();
        return param ? normalizeLanguage(param) : null;
    }

    // The browser's own locale tags, best first; they carry the region ("en-US").
    function navigatorLocales() {
        const nav = globalScope.navigator;
        if (!nav) return [];
        const list = Array.isArray(nav.languages) ? nav.languages.slice() : [];
        if (nav.language) list.push(nav.language);
        return list;
    }

    // ?lang= first, then the saved preference, the document language and the browser's. A bare
    // language takes its region from the saved preference, then from the browser, when they speak it.
    function detectPreferredLocale() {
        const stored = readStoredLocale();
        const browser = navigatorLocales().map(tag => normalizeLocale(tag)).filter(Boolean);
        const preferredFor = lang => (stored && normalizeLanguage(stored) === lang ? stored
            : browser.find(locale => normalizeLanguage(locale) === lang) || null);

        const urlParam = readUrlLanguageParam();
        if (urlParam) return normalizeLocale(urlParam, preferredFor(normalizeLanguage(urlParam)));

        if (stored) return stored;

        try {
            if (globalScope.document && globalScope.document.documentElement) {
                const docLang = globalScope.document.documentElement.getAttribute('lang');
                const docLocale = normalizeLocale(docLang, preferredFor(normalizeLanguage(docLang)));
                if (docLocale) return docLocale;
            }
        } catch (_) { }

        return browser[0] || defaultLocaleFor(FALLBACK_LANGUAGE);
    }

    function interpolate(template, params = {}) {
        if (!template) return '';
        const replacer = (match, key1, key2) => {
            const key = key1 || key2;
            return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
        };
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, replacer);
    }

    // CLDR plural category for the active language. Slavic languages need three forms (1 / 2-4 / 5+),
    // which is why a translation may declare its key as an object of `one`/`few`/`other` variants.
    function pluralCategory(count, language = currentLanguage) {
        try {
            return new Intl.PluralRules(language).select(count);
        } catch (_) {
            return count === 1 ? 'one' : 'other';
        }
    }

    // A param value may itself be a translation reference — { key: '...', count: n } — so a phrase that
    // needs its own plural form can be embedded in a sentence and still follow a language change.
    function resolveParams(params, depth) {
        if (!params || typeof params !== 'object') return {};
        const resolved = {};
        Object.keys(params).forEach(name => {
            const value = params[name];
            const isReference = depth < 3 && value && typeof value === 'object' && typeof value.key === 'string';
            resolved[name] = isReference ? translate(value.key, value, depth + 1) : value;
        });
        return resolved;
    }

    function lookupTemplate(key, params) {
        const languageTable = translations[currentLanguage] || {};
        const fallbackTable = translations[FALLBACK_LANGUAGE] || {};
        const count = params ? params.count : undefined;

        if (typeof count === 'number' && isFinite(count)) {
            // Exhaust the selected language before falling back. English has its own plural
            // rules, which may differ from the selected language's categories.
            for (const [table, language] of [[languageTable, currentLanguage], [fallbackTable, FALLBACK_LANGUAGE]]) {
                for (const form of new Set([pluralCategory(count, language), 'other'])) {
                    const template = table[`${key}.${form}`];
                    if (template != null) return template;
                }
            }
        }

        return languageTable[key] ?? fallbackTable[key] ?? key;
    }

    function translate(key, params = {}, depth = 0) {
        const safeKey = key != null ? String(key) : '';
        if (!safeKey) return '';

        const resolved = resolveParams(params, depth);
        return interpolate(lookupTemplate(safeKey, resolved), resolved);
    }

    function parseParams(rawParams) {
        if (!rawParams) return {};
        try {
            return JSON.parse(rawParams);
        } catch (_) {
            return {};
        }
    }

    function applyTranslations(root) {
        const doc = globalScope.document;
        if (!doc || !doc.querySelectorAll) return;

        const isElementScope = typeof Element !== 'undefined' && root instanceof Element;
        const candidates = isElementScope
            ? [root, ...root.querySelectorAll('[data-i18n-key]')]
            : doc.querySelectorAll('[data-i18n-key]');

        candidates.forEach(node => {
            if (!node || typeof node.getAttribute !== 'function') return;
            const key = node.getAttribute('data-i18n-key');
            if (!key) return;

            const params = parseParams(node.getAttribute('data-i18n-params'));
            const attrValue = node.getAttribute('data-i18n-attr') || 'text';
            const targetAttrs = attrValue.split(',').map(part => part.trim()).filter(Boolean);
            if (targetAttrs.length === 0) targetAttrs.push('text');

            const translated = translate(key, params);
            // Keep the readable HTML label/attribute while its dictionary is loading or missing.
            if (translated === key) return;
            targetAttrs.forEach(target => {
                if (target === 'html') {
                    node.innerHTML = translated;
                } else if (target === 'text') {
                    node.textContent = translated;
                } else {
                    node.setAttribute(target, translated);
                }
            });
        });
    }

    // `lang` is a language ("en": keeps the current region when it is English already) or a locale
    // ("en-US"). Listeners hear the language whenever the locale changes, region included, because
    // every formatted number and date depends on both.
    function setLanguage(lang, options = {}) {
        const { persist = true, apply = true, userChoice = false } = options;
        const locale = normalizeLocale(lang, currentLocale) || defaultLocaleFor(FALLBACK_LANGUAGE);
        const normalized = normalizeLanguage(locale);
        if (userChoice) userChoseLanguage = true;
        const changed = locale !== currentLocale;
        currentLanguage = normalized;
        currentLocale = locale;

        updateDocumentLanguage(normalized);
        if (persist) {
            persistLanguage(locale);
        }
        if (apply) {
            applyTranslations();
        }
        if (changed) {
            listeners.forEach(callback => {
                try { callback(normalized); } catch (_) { }
            });
        }
        return currentLanguage;
    }

    // The language a surface should settle on when it is not reacting to a pick: the user's pick
    // this session, else an explicit ?lang=, else the saved preference, else the city default.
    function resolveSessionLanguage(cityDefault) {
        if (userChoseLanguage) return currentLanguage;
        return readUrlLanguage() || readStoredLanguage() || normalizeLanguage(cityDefault) || currentLanguage;
    }

    function getLanguage() {
        return currentLanguage;
    }

    function getLocale() {
        return currentLocale;
    }

    function getSupportedLocales() {
        return SUPPORTED_LOCALES.slice();
    }

    function registerTranslations(lang, entries = {}) {
        const normalized = normalizeLanguage(lang);
        if (!normalized) return;
        translations[normalized] = Object.assign({}, translations[normalized] || {}, entries);
    }

    function onChange(callback) {
        if (typeof callback !== 'function') return () => { };
        listeners.add(callback);
        return () => listeners.delete(callback);
    }

    function offChange(callback) {
        if (typeof callback !== 'function') return;
        listeners.delete(callback);
    }

    function getSupportedLanguages() {
        return Array.from(supportedLanguages);
    }

    // Satellite selects use the same registry as the map's segmented picker. Their native names
    // are metadata, so the selected dictionary never has to contain every other language's copy.
    function populateLocaleSelects() {
        globalScope.document?.querySelectorAll?.('[data-i18n-locale-select]').forEach(select => {
            const languageOnly = select.getAttribute('data-i18n-locale-select') === 'language';
            const seen = new Set();
            const options = LOCALE_CHOICES.filter(choice => {
                const language = choice.locale.split('-')[0];
                if (languageOnly && seen.has(language)) return false;
                seen.add(language);
                return true;
            }).map(choice => {
                const option = select.ownerDocument.createElement('option');
                option.value = languageOnly ? choice.locale.split('-')[0] : choice.locale;
                option.textContent = choice.name;
                return option;
            });
            select.replaceChildren(...options);
            select.value = languageOnly ? currentLanguage : currentLocale;
        });
    }

    // Bootstrap
    currentLocale = detectPreferredLocale();
    currentLanguage = normalizeLanguage(currentLocale);
    updateDocumentLanguage(currentLanguage);

    const storageReady = (() => {
        const stored = globalScope.PersistentStorage?.ready || Promise.resolve();
        // A blocked workspace never opens its map store. Its standalone notice still needs a
        // language, using the URL/browser preference without loading or writing map records.
        return globalScope.BrowserWorkspace
            ? globalScope.BrowserWorkspace.ready.then(owned => owned ? stored : undefined).catch(() => {})
            : stored.catch(() => {});
    })();

    storageReady.then(() => {
        const storedLocale = readStoredLocale();
        // An explicit ?lang= already chose the language; a saved preference must not undo it.
        if (!readUrlLanguage() && storedLocale && storedLocale !== currentLocale) {
            setLanguage(storedLocale, { persist: false });
        } else {
            applyTranslations();
        }
        readyResolve(currentLanguage);
    }).catch(() => {
        applyTranslations();
        readyResolve(currentLanguage);
    });

    if (globalScope.document && typeof globalScope.document.addEventListener === 'function') {
        globalScope.document.addEventListener('DOMContentLoaded', () => { populateLocaleSelects(); applyTranslations(); });
    }

    globalScope.i18n = {
        t: translate,
        setLanguage,
        getLanguage,
        getLocale,
        getSupportedLocales,
        getLocaleChoices: () => LOCALE_CHOICES.map(choice => ({ ...choice })),
        getUrlLanguage: readUrlLanguage,
        resolveSessionLanguage,
        registerTranslations,
        applyTranslations,
        onChange,
        offChange,
        getSupportedLanguages,
        ready
    };
})();

