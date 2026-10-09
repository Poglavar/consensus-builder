// Owns the first-visit site explainer and its manual reopen behavior.
(function attachSiteIntro(global) {
    'use strict';

    const STORAGE_KEY = 'cb_site_intro_seen_v1';

    function introPageIndex(current, delta, count) {
        return Math.max(0, Math.min(Math.max(0, count - 1), current + delta));
    }

    function introSwipeDelta(start, end) {
        if (!start || !end) return 0;
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.25) return 0;
        return dx < 0 ? 1 : -1;
    }

    // A link that names what to show (an activity, a proposal, a bet) opens it, never the explainer.
    function shouldShowSiteIntro(search, seenValue, pathname = '') {
        let forced = false;
        try {
            const params = new URLSearchParams(search || '');
            forced = params.has('intro');
            if (!forced && (params.get('activity') || params.get('focusProposal') || params.get('bets'))) return false;
            if (!forced && /^\/bets\/./.test(String(pathname || ''))) return false;
        } catch (_) { /* ignore */ }
        return forced || seenValue !== '1';
    }

    function initSiteIntro() {
        const doc = global.document;
        if (!doc || global.__siteIntroInitialized) return;

        const modal = doc.getElementById('site-intro-modal');
        if (!modal) return;
        global.__siteIntroInitialized = true;

        let previousFocus = null;
        let unregisterEscape = null;
        let page = 0;
        let touchStart = null;
        const slides = Array.from(modal.querySelectorAll('[data-site-intro-slide]'));
        const pageButtons = Array.from(modal.querySelectorAll('[data-site-intro-page]'));
        const card = modal.querySelector('.site-intro-card');
        const next = modal.querySelector('[data-site-intro-next]');
        const back = modal.querySelector('[data-site-intro-back]');
        const progress = modal.querySelector('[data-site-intro-progress]');

        function renderPage(index) {
            if (!slides.length) return;
            page = introPageIndex(index, 0, slides.length);
            slides.forEach((slide, i) => { slide.hidden = i !== page; });
            pageButtons.forEach((button, i) => {
                if (i === page) button.setAttribute('aria-current', 'step');
                else button.removeAttribute('aria-current');
            });
            const key = slides[page].getAttribute('data-site-intro-slide');
            card.setAttribute('aria-labelledby', `site-intro-title-${key}`);
            card.setAttribute('aria-describedby', `site-intro-lead-${key}`);
            back.disabled = page === 0;
            const last = page === slides.length - 1;
            next.setAttribute('data-i18n-key', last ? 'modal.siteIntro.cta' : 'modal.siteIntro.tour.next');
            next.textContent = last ? 'Explore the map' : 'Next feature';
            try { global.i18n?.applyTranslations?.(modal); } catch (_) { /* ignore */ }
            const label = global.i18n?.t?.('modal.siteIntro.tour.progress', { current: page + 1, total: slides.length });
            progress.textContent = label && label !== 'modal.siteIntro.tour.progress' ? label : `${page + 1} / ${slides.length}`;
            const scroller = modal.querySelector('.site-intro-slides');
            if (scroller) scroller.scrollTop = 0;
            // Swiping or using a dot can hide a focused control in the previous slide.
            if (doc.activeElement?.closest?.('[data-site-intro-slide][hidden]') || doc.activeElement === back && back.disabled) {
                next.focus({ preventScroll: true });
            }
        }

        function movePage(delta) {
            renderPage(introPageIndex(page, delta, slides.length));
        }

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
            unregisterEscape?.();
            unregisterEscape = global.ModalEscape?.register(modal, closeSiteIntro);
            modal.classList.add('is-open');
            doc.body.classList.add('site-intro-open');
            if (options.remember !== false) rememberSeen();
            renderPage(0);
            try { global.i18n?.applyTranslations?.(modal); } catch (_) { /* ignore */ }
            const closeButton = modal.querySelector('[data-site-intro-close]');
            closeButton?.focus({ preventScroll: true });
        }

        function closeSiteIntro() {
            if (modal.hidden) return;
            modal.classList.remove('is-open');
            modal.hidden = true;
            unregisterEscape?.();
            unregisterEscape = null;
            touchStart = null;
            doc.body.classList.remove('site-intro-open');
            if (previousFocus && typeof previousFocus.focus === 'function') {
                previousFocus.focus({ preventScroll: true });
            }
            global.dispatchEvent(new CustomEvent('siteintro:closed'));
        }

        doc.querySelectorAll('[data-site-intro-open]').forEach(button => {
            button.addEventListener('click', () => openSiteIntro({ remember: false }));
        });
        modal.querySelectorAll('[data-site-intro-close]').forEach(button => {
            button.addEventListener('click', closeSiteIntro);
        });
        back?.addEventListener('click', () => movePage(-1));
        next?.addEventListener('click', () => {
            if (page === slides.length - 1) closeSiteIntro();
            else movePage(1);
        });
        pageButtons.forEach((button, index) => button.addEventListener('click', () => renderPage(index)));
        const slideArea = modal.querySelector('.site-intro-slides');
        slideArea?.addEventListener('touchstart', event => {
            touchStart = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
        }, { passive: true });
        slideArea?.addEventListener('touchend', event => {
            const touch = event.changedTouches[0];
            if (touch && event.touches.length === 0) {
                const delta = introSwipeDelta(touchStart, { x: touch.clientX, y: touch.clientY });
                if (delta) movePage(delta);
            }
            touchStart = null;
        }, { passive: true });
        slideArea?.addEventListener('touchcancel', () => { touchStart = null; }, { passive: true });
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
            if (slides.length && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                if (event.key === 'Home') renderPage(0);
                else if (event.key === 'End') renderPage(slides.length - 1);
                else movePage(event.key === 'ArrowRight' ? 1 : -1);
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

        const showIfDue = () => {
            if (shouldShowSiteIntro(global.location?.search, readSeen(), global.location?.pathname)) openSiteIntro();
        };
        // A first-visit globe (js/ui/world-entry.js) is up: the intro waits until the visitor lands
        // in a city — after the reload into it, or when the globe closes in place.
        if (global.WorldEntry && typeof global.WorldEntry.ownsBoot === 'function' && global.WorldEntry.ownsBoot()) {
            global.addEventListener('worldview:landed', showIfDue, { once: true });
        } else {
            showIfDue();
        }
    }

    const api = { STORAGE_KEY, shouldShowSiteIntro, introPageIndex, introSwipeDelta, initSiteIntro };
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
