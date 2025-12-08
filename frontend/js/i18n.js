(function () {
    const globalScope = typeof window !== 'undefined' ? window : self;
    const FALLBACK_LANGUAGE = 'en';
    const STORAGE_KEY = 'cb_language';
    const supportedLanguages = new Set(['en', 'es']);
    const listeners = new Set();
    const translations = {
        en: {
            'language.switcher.label': 'Language',
            'language.switcher.aria': 'Language selection',
            'language.english': 'English',
            'language.spanish': 'Spanish',
            'language.switcher.to_en': 'Switch to English',
            'language.switcher.to_es': 'Switch to Spanish'
        },
        es: {
            'language.switcher.label': 'Idioma',
            'language.switcher.aria': 'Selección de idioma',
            'language.english': 'Inglés',
            'language.spanish': 'Español',
            'language.switcher.to_en': 'Cambiar a inglés',
            'language.switcher.to_es': 'Cambiar a español'
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

        try {
            if (globalScope.localStorage) {
                const stored = globalScope.localStorage.getItem(STORAGE_KEY);
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

        try {
            if (globalScope.localStorage) {
                globalScope.localStorage.setItem(STORAGE_KEY, lang);
            }
        } catch (_) { }
    }

    function detectPreferredLanguage() {
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

    function translate(key, params = {}) {
        const safeKey = key != null ? String(key) : '';
        if (!safeKey) return '';

        const languageTable = translations[currentLanguage] || {};
        const fallbackTable = translations[FALLBACK_LANGUAGE] || {};
        const template = languageTable[safeKey] ?? fallbackTable[safeKey] ?? safeKey;
        return interpolate(template, params);
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

