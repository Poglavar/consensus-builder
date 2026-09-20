(function () {
    'use strict';

    const slides = Array.from(document.querySelectorAll('[data-slide]'));
    const dots = Array.from(document.querySelectorAll('.deck-dots a'));
    const current = document.getElementById('deck-current');
    const prev = document.getElementById('deck-prev');
    const next = document.getElementById('deck-next');
    const fullscreen = document.getElementById('deck-fullscreen');
    let active = 0;

    function setActive(index) {
        active = Math.max(0, Math.min(index, slides.length - 1));
        current.textContent = String(active + 1);
        dots.forEach((dot, dotIndex) => {
            if (dotIndex === active) dot.setAttribute('aria-current', 'true');
            else dot.removeAttribute('aria-current');
        });
        prev.disabled = active === 0;
        next.disabled = active === slides.length - 1;
    }

    function goTo(index) {
        const target = slides[Math.max(0, Math.min(index, slides.length - 1))];
        if (!target) return;
        target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        history.replaceState(null, '', `#${target.id}`);
        setActive(slides.indexOf(target));
    }

    const observer = new IntersectionObserver((entries) => {
        const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActive(slides.indexOf(visible.target));
    }, { threshold: [0.45, 0.7] });
    slides.forEach(slide => observer.observe(slide));

    prev.addEventListener('click', () => goTo(active - 1));
    next.addEventListener('click', () => goTo(active + 1));
    fullscreen.addEventListener('click', async () => {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
    });
    document.addEventListener('fullscreenchange', () => {
        fullscreen.textContent = document.fullscreenElement ? 'Exit' : 'Present';
    });
    document.addEventListener('keydown', (event) => {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.target.matches('input, textarea, select, button, a')) return;
        if (['ArrowDown', 'ArrowRight', 'PageDown', ' '].includes(event.key)) {
            event.preventDefault();
            goTo(active + 1);
        } else if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(event.key)) {
            event.preventDefault();
            goTo(active - 1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            goTo(0);
        } else if (event.key === 'End') {
            event.preventDefault();
            goTo(slides.length - 1);
        }
    });

    const initial = slides.findIndex(slide => `#${slide.id}` === location.hash);
    setActive(initial >= 0 ? initial : 0);
}());
