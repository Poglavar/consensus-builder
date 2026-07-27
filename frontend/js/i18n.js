(function () {
    const globalScope = typeof window !== 'undefined' ? window : self;
    const FALLBACK_LANGUAGE = 'en';
    const STORAGE_KEY = 'cb_language';
    const supportedLanguages = new Set(['en', 'es', 'sr', 'hr']);
    const listeners = new Set();
    const translations = {
        en: {
            'language.switcher.label': 'Language',
            'language.switcher.aria': 'Language selection',
            'language.english': 'English',
            'language.spanish': 'Spanish',
            'language.serbian': 'Serbian',
            'language.croatian': 'Croatian',
            'language.switcher.to_en': 'Switch to English',
            'language.switcher.to_es': 'Switch to Spanish',
            'language.switcher.to_sr': 'Switch to Serbian',
            'language.switcher.to_hr': 'Switch to Croatian'
        },
        es: {
            'language.switcher.label': 'Idioma',
            'language.switcher.aria': 'Selección de idioma',
            'language.english': 'Inglés',
            'language.spanish': 'Español',
            'language.serbian': 'Serbio',
            'language.croatian': 'Croata',
            'language.switcher.to_en': 'Cambiar a inglés',
            'language.switcher.to_es': 'Cambiar a español',
            'language.switcher.to_sr': 'Cambiar a serbio',
            'language.switcher.to_hr': 'Cambiar a croata'
        },
        sr: {
            'language.switcher.label': 'Jezik',
            'language.switcher.aria': 'Izbor jezika',
            'language.english': 'Engleski',
            'language.spanish': 'Španski',
            'language.serbian': 'Srpski',
            'language.croatian': 'Hrvatski',
            'language.switcher.to_en': 'Prebaci na engleski',
            'language.switcher.to_es': 'Prebaci na španski',
            'language.switcher.to_sr': 'Prebaci na srpski',
            'language.switcher.to_hr': 'Prebaci na hrvatski'
        },
        hr: {
            'language.switcher.label': 'Jezik',
            'language.switcher.aria': 'Odabir jezika',
            'language.english': 'Engleski',
            'language.spanish': 'Španjolski',
            'language.serbian': 'Srpski',
            'language.croatian': 'Hrvatski',
            'language.switcher.to_en': 'Prebaci na engleski',
            'language.switcher.to_es': 'Prebaci na španjolski',
            'language.switcher.to_sr': 'Prebaci na srpski',
            'language.switcher.to_hr': 'Prebaci na hrvatski'
        }
    };

    let currentLanguage = FALLBACK_LANGUAGE;
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });

    function normalizeLanguage(value) {
        if (!value) return null;
        const normalized = String(value).toLowerCase();
        const primary = normalized.split(/[-_]/)[0];
        return supportedLanguages.has(primary) ? primary : null;
    }

    function updateDocumentLanguage(lang) {
        if (globalScope.document && globalScope.document.documentElement) {
            globalScope.document.documentElement.setAttribute('lang', lang);
        }
    }

    function readStoredLanguage() {
        try {
            if (globalScope.PersistentStorage && typeof globalScope.PersistentStorage.getItem === 'function') {
                const stored = globalScope.PersistentStorage.getItem(STORAGE_KEY);
                const normalized = normalizeLanguage(stored);
                if (normalized) return normalized;
            }
        } catch (_) { }

        return null;
    }

    function persistLanguage(lang) {
        try {
            if (globalScope.PersistentStorage && typeof globalScope.PersistentStorage.setItem === 'function') {
                globalScope.PersistentStorage.setItem(STORAGE_KEY, lang);
            }
        } catch (_) { }
    }

    function readUrlLanguage() {
        try {
            if (globalScope.location && globalScope.location.search) {
                const params = new URLSearchParams(globalScope.location.search);
                const langParam = params.get('lang');
                if (langParam) {
                    const normalized = normalizeLanguage(langParam);
                    // If the language is supported, return it; otherwise return null to fall back
                    return normalized || null;
                }
            }
        } catch (_) { }
        return null;
    }

    function detectPreferredLanguage() {
        // Check URL parameter first (highest priority when present)
        const urlLang = readUrlLanguage();
        if (urlLang) return urlLang;

        const stored = readStoredLanguage();
        if (stored) return stored;

        // Respect the document language if present
        try {
            if (globalScope.document && globalScope.document.documentElement) {
                const docLang = normalizeLanguage(globalScope.document.documentElement.getAttribute('lang'));
                if (docLang) return docLang;
            }
        } catch (_) { }

        const navigatorLangs = (globalScope.navigator && Array.isArray(globalScope.navigator.languages))
            ? globalScope.navigator.languages
            : [];
        for (const lang of navigatorLangs) {
            const normalized = normalizeLanguage(lang);
            if (normalized) return normalized;
        }

        if (globalScope.navigator && globalScope.navigator.language) {
            const normalized = normalizeLanguage(globalScope.navigator.language);
            if (normalized) return normalized;
        }

        return FALLBACK_LANGUAGE;
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
    function pluralCategory(count) {
        try {
            return new Intl.PluralRules(currentLanguage).select(count);
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
            const forms = [pluralCategory(count), 'other'];
            for (const form of forms) {
                const pluralKey = `${key}.${form}`;
                const template = languageTable[pluralKey] ?? fallbackTable[pluralKey];
                if (template != null) return template;
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

    function setLanguage(lang, options = {}) {
        const { persist = true, apply = true } = options;
        const normalized = normalizeLanguage(lang) || FALLBACK_LANGUAGE;
        const changed = normalized !== currentLanguage;
        currentLanguage = normalized;

        updateDocumentLanguage(normalized);
        if (persist) {
            persistLanguage(normalized);
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

    function getLanguage() {
        return currentLanguage;
    }

    function registerTranslations(lang, entries = {}) {
        const normalized = normalizeLanguage(lang);
        if (!normalized) return;
        supportedLanguages.add(normalized);
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

    // Bootstrap
    currentLanguage = detectPreferredLanguage();
    updateDocumentLanguage(currentLanguage);

    const storageReady = (() => {
        if (globalScope.PersistentStorage && globalScope.PersistentStorage.ready && typeof globalScope.PersistentStorage.ready.then === 'function') {
            return globalScope.PersistentStorage.ready.catch(() => { });
        }
        return Promise.resolve();
    })();

    storageReady.then(() => {
        const storedLanguage = readStoredLanguage();
        if (storedLanguage && storedLanguage !== currentLanguage) {
            setLanguage(storedLanguage, { persist: false });
        } else {
            applyTranslations();
        }
        readyResolve(currentLanguage);
    }).catch(() => {
        applyTranslations();
        readyResolve(currentLanguage);
    });

    if (globalScope.document && typeof globalScope.document.addEventListener === 'function') {
        globalScope.document.addEventListener('DOMContentLoaded', () => applyTranslations());
    }

    globalScope.i18n = {
        t: translate,
        setLanguage,
        getLanguage,
        registerTranslations,
        applyTranslations,
        onChange,
        offChange,
        getSupportedLanguages,
        ready
    };
})();

