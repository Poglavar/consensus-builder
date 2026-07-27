// ai-scene-follow.js — the receiving end of a shared AI render. When a page is opened via a
// ?scene=<slug> link, this fetches the saved scene, exposes its camera pose so the 3D entry can
// reproduce the exact shot the image was made from (window.getAiSceneRestoreView, read by the
// proposals route), and shows the AI render inline over the reconstructed 3D world.
(function () {
    'use strict';

    const slug = new URLSearchParams(window.location.search).get('scene');
    if (!slug) return; // ordinary page load — do nothing

    function backendBase() {
        try { return (typeof window.getBackendBase === 'function') ? window.getBackendBase() : ''; }
        catch (_) { return ''; }
    }

    function label(key, fallback) {
        try {
            if (window.i18n && typeof window.i18n.t === 'function') {
                const v = window.i18n.t(key);
                if (v && v !== key) return v;
            }
        } catch (_) { /* fall through */ }
        return fallback;
    }

    let scene = null;
    // Read synchronously by proposals/core.js enterUrlDrivenView. Null until the fetch resolves.
    window.getAiSceneRestoreView = function () { return scene ? scene.view : null; };

    window.__aiScenePromise = fetch(backendBase() + '/ai-scene/scene/' + encodeURIComponent(slug))
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (!data) return null;
            scene = data;
            // Race safety: if 3D was entered before this fetch resolved, apply the pose now so the
            // restore never depends on fetch-vs-entry timing.
            try {
                if (data.view && typeof window.isThreeModeActive === 'function' && window.isThreeModeActive()
                    && typeof window.applyThree3DGeoView === 'function') {
                    window.applyThree3DGeoView(data.view);
                }
            } catch (_) { /* ignore */ }
            showRenderCardWhenReady();
            return data;
        })
        .catch(() => null);

    // The AI render is shown inline once the 3D world is up (it's being reconstructed from the
    // applied proposals, so poll briefly rather than assume it's ready).
    function showRenderCardWhenReady(attempt = 0) {
        if (!scene || !scene.imageUrl) return;
        const active = (typeof window.isThreeModeActive === 'function') && window.isThreeModeActive();
        if (!active) {
            if (attempt < 40) setTimeout(() => showRenderCardWhenReady(attempt + 1), 400); // up to ~16s
            return;
        }
        renderCard();
    }

    let cardEl = null;
    function renderCard() {
        if (cardEl) return;
        cardEl = document.createElement('div');
        cardEl.className = 'ai-scene-follow-card';
        cardEl.innerHTML =
            '<div class="ai-scene-follow-head">'
            + '<span>' + label('threeMode.aiFollow.title', 'AI render') + '</span>'
            + '<button type="button" class="ai-scene-follow-close" aria-label="'
            + label('common.close', 'Close') + '">&times;</button>'
            + '</div>'
            + '<img class="ai-scene-follow-img" alt="AI photorealistic render" />'
            + '<div class="ai-scene-follow-note">'
            + label('threeMode.aiFollow.note', 'You are viewing the real 3D scene this AI image was made from.')
            + '</div>';
        document.body.appendChild(cardEl);

        const img = cardEl.querySelector('.ai-scene-follow-img');
        img.src = scene.imageUrl;
        img.addEventListener('click', () => cardEl.classList.toggle('expanded')); // tap to enlarge/shrink
        cardEl.querySelector('.ai-scene-follow-close').addEventListener('click', () => {
            cardEl.remove();
            cardEl = null;
        });
    }
})();
