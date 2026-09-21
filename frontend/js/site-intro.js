// Owns the first-visit site explainer and its manual reopen behavior.
(function attachSiteIntro(global) {
    'use strict';

    const STORAGE_KEY = 'cb_site_intro_seen_v1';

    function shouldShowSiteIntro(search, seenValue) {
        let forced = false;
        try { forced = new URLSearchParams(search || '').has('intro'); } catch (_) { /* ignore */ }
        return forced || seenValue !== '1';
    }

    function initSiteIntro() {
        const doc = global.document;
        if (!doc || global.__siteIntroInitialized) return;

        const modal = doc.getElementById('site-intro-modal');
        if (!modal) return;
        global.__siteIntroInitialized = true;

        let previousFocus = null;

        function readSeen() {
            try { return global.localStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
        }

        function rememberSeen() {
            try { global.localStorage.setItem(STORAGE_KEY, '1'); } catch (_) { /* ignore */ }
        }

        function focusableElements() {
            return Array.from(modal.querySelectorAll(
                'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )).filter(element => !element.hidden && element.getClientRects().length > 0);
        }

        function openSiteIntro(options = {}) {
            previousFocus = doc.activeElement;
            modal.hidden = false;
            modal.classList.add('is-open');
            doc.body.classList.add('site-intro-open');
            if (options.remember !== false) rememberSeen();
            try { global.i18n?.applyTranslations?.(modal); } catch (_) { /* ignore */ }
            const closeButton = modal.querySelector('[data-site-intro-close]');
            closeButton?.focus({ preventScroll: true });
        }

        function closeSiteIntro() {
            if (modal.hidden) return;
            modal.classList.remove('is-open');
            modal.hidden = true;
            doc.body.classList.remove('site-intro-open');
            if (previousFocus && typeof previousFocus.focus === 'function') {
                previousFocus.focus({ preventScroll: true });
            }
        }

        doc.querySelectorAll('[data-site-intro-open]').forEach(button => {
            button.addEventListener('click', () => openSiteIntro({ remember: false }));
        });
        modal.querySelectorAll('[data-site-intro-close]').forEach(button => {
            button.addEventListener('click', closeSiteIntro);
        });
        modal.addEventListener('click', event => {
            if (event.target === modal) closeSiteIntro();
        });
        doc.addEventListener('keydown', event => {
            if (modal.hidden) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                closeSiteIntro();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = focusableElements();
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && doc.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && doc.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });

        global.openSiteIntro = openSiteIntro;
        global.closeSiteIntro = closeSiteIntro;

        if (shouldShowSiteIntro(global.location?.search, readSeen())) openSiteIntro();
    }

    const api = { STORAGE_KEY, shouldShowSiteIntro, initSiteIntro };
    global.SiteIntro = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;

    if (global.document) {
        if (global.document.readyState === 'loading') {
            global.document.addEventListener('DOMContentLoaded', initSiteIntro, { once: true });
        } else {
            initSiteIntro();
        }
    }
})(typeof window !== 'undefined' ? window : globalThis);
