// AI photorealistic scene render (v1). Adds the "AI" button (shown only in 3D mode): it captures
// the current 3D canvas, builds a scene-aware caption, and sends both to the backend, which forwards
// them to Gemini's image model and returns a photorealistic image. The panel lets the user edit the
// prompt before spending, shows the exact per-render cost, and keeps a running session total.
(function () {
    'use strict';

    const ENDPOINT = '/ai-scene/render';
    const NOMINAL_COST_HINT = 0.04; // ~$ per image, shown before generating (real cost comes back per render)

    function t(key, fallback, params) {
        const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
        if (api && typeof api.t === 'function') {
            try { return api.t(key, params || {}); } catch (_) { /* fall through */ }
        }
        // Minimal {{param}} interpolation so fallbacks with params still render.
        let s = fallback;
        if (params) for (const k of Object.keys(params)) s = s.replace(new RegExp('{{' + k + '}}', 'g'), params[k]);
        return s;
    }

    function backendBase() {
        try { return (typeof window.getBackendBase === 'function') ? window.getBackendBase() : ''; }
        catch (_) { return ''; }
    }

    // Pure: turn scene semantics into the generation prompt. Exposed for unit testing — the screenshot
    // carries the geometry, so this only adds intent (which building is proposed, where we are, style).
    function buildScenePrompt(summary) {
        const s = summary || {};
        const where = s.cityLabel ? ` in ${s.cityLabel}` : '';
        const subject = s.isolatedProposal
            ? 'Emphasize the highlighted proposed building as the hero of the image.'
            : 'The grey massing blocks are proposed/existing buildings.';
        return [
            `Turn this 3D massing view${where} into a photorealistic architectural visualization.`,
            'Stay faithful to the exact geometry, massing, building positions and camera angle shown — do not add, move, or resize buildings.',
            subject,
            'Render realistic facades, windows, materials, streets, sidewalks, trees and sky. Natural daylight, clear weather, eye-pleasing but believable. No text, labels, or watermarks.'
        ].join(' ');
    }

    // Session spend accumulates across renders until the page reloads.
    let sessionCostUsd = 0;
    let lastCapture = null; // { image, summary } from the most recent button press
    let overlayEl = null;

    function fmtUsd(n) { return '$' + (Number(n) || 0).toFixed(4); }

    function ensureOverlay() {
        if (overlayEl) return overlayEl;
        overlayEl = document.createElement('div');
        overlayEl.id = 'ai-scene-overlay';
        overlayEl.className = 'ai-scene-overlay';
        overlayEl.hidden = true;
        overlayEl.innerHTML = `
            <div class="ai-scene-modal" role="dialog" aria-modal="true" aria-labelledby="ai-scene-title">
                <div class="ai-scene-header">
                    <h3 id="ai-scene-title">${t('threeMode.ai.title', 'AI photorealistic render')}</h3>
                    <button type="button" class="ai-scene-close" aria-label="${t('common.close', 'Close')}">&times;</button>
                </div>
                <div class="ai-scene-body">
                    <div class="ai-scene-source">
                        <div class="ai-scene-label">${t('threeMode.ai.sourceLabel', 'Captured scene')}</div>
                        <img class="ai-scene-source-img" alt="captured 3D scene" />
                    </div>
                    <div class="ai-scene-controls">
                        <label class="ai-scene-label" for="ai-scene-prompt">${t('threeMode.ai.promptLabel', 'Prompt (editable)')}</label>
                        <textarea id="ai-scene-prompt" class="ai-scene-prompt" rows="5"></textarea>
                        <div class="ai-scene-actions">
                            <button type="button" class="btn btn-info ai-scene-generate"></button>
                            <span class="ai-scene-cost-hint">${t('threeMode.ai.costHint', '~{{c}} per image', { c: fmtUsd(NOMINAL_COST_HINT) })}</span>
                        </div>
                        <div class="ai-scene-status" role="status" aria-live="polite"></div>
                    </div>
                    <div class="ai-scene-result" hidden>
                        <div class="ai-scene-label">${t('threeMode.ai.resultLabel', 'Result')}</div>
                        <img class="ai-scene-result-img" alt="AI photorealistic render" />
                        <div class="ai-scene-result-actions">
                            <a class="btn btn-action ai-scene-download" download="ai-scene.png">${t('threeMode.ai.download', 'Download')}</a>
                        </div>
                    </div>
                </div>
                <div class="ai-scene-footer">
                    <span class="ai-scene-session-total"></span>
                </div>
            </div>`;
        document.body.appendChild(overlayEl);

        overlayEl.querySelector('.ai-scene-close').addEventListener('click', closeOverlay);
        overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) closeOverlay(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !overlayEl.hidden) closeOverlay();
        });
        overlayEl.querySelector('.ai-scene-generate').addEventListener('click', generate);
        return overlayEl;
    }

    function setStatus(msg, isError) {
        const el = overlayEl.querySelector('.ai-scene-status');
        el.textContent = msg || '';
        el.classList.toggle('ai-scene-status--error', !!isError);
    }

    function updateSessionTotal() {
        overlayEl.querySelector('.ai-scene-session-total').textContent =
            t('threeMode.ai.sessionTotal', 'Session spend: {{c}}', { c: fmtUsd(sessionCostUsd) });
    }

    function setBusy(busy) {
        const btn = overlayEl.querySelector('.ai-scene-generate');
        btn.disabled = busy;
        btn.textContent = busy
            ? t('threeMode.ai.generating', 'Generating…')
            : t('threeMode.ai.generate', 'Generate');
    }

    function closeOverlay() {
        if (overlayEl) overlayEl.hidden = true;
    }

    function openOverlay() {
        if (!window.isThreeModeActive || !window.isThreeModeActive()) {
            alert(t('threeMode.ai.need3d', 'Enter 3D mode first to render the scene.'));
            return;
        }
        const image = (typeof window.captureThreeSceneDataURL === 'function') ? window.captureThreeSceneDataURL() : null;
        if (!image) {
            alert(t('threeMode.ai.captureFailed', 'Could not capture the 3D scene.'));
            return;
        }
        const summary = (typeof window.getThreeSceneSummary === 'function') ? window.getThreeSceneSummary() : {};
        lastCapture = { image, summary };

        ensureOverlay();
        overlayEl.querySelector('.ai-scene-source-img').src = image;
        overlayEl.querySelector('.ai-scene-prompt').value = buildScenePrompt(summary);
        overlayEl.querySelector('.ai-scene-result').hidden = true;
        setStatus('');
        setBusy(false);
        updateSessionTotal();
        overlayEl.hidden = false;
    }

    async function generate() {
        if (!lastCapture) return;
        const prompt = overlayEl.querySelector('.ai-scene-prompt').value.trim();
        if (!prompt) { setStatus(t('threeMode.ai.emptyPrompt', 'Prompt is empty.'), true); return; }

        setBusy(true);
        setStatus(t('threeMode.ai.working', 'Sending scene to the model…'));
        const startedAt = Date.now();
        try {
            const resp = await fetch(backendBase() + ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: lastCapture.image, prompt })
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));

            sessionCostUsd += Number(data.cost_usd) || 0;
            const resultBox = overlayEl.querySelector('.ai-scene-result');
            const resultImg = overlayEl.querySelector('.ai-scene-result-img');
            const dl = overlayEl.querySelector('.ai-scene-download');
            resultImg.src = data.image;
            dl.href = data.image;
            resultBox.hidden = false;
            updateSessionTotal();
            setStatus(t('threeMode.ai.done', 'Done in {{s}}s — this render cost {{c}}', {
                s: Math.round((Date.now() - startedAt) / 1000),
                c: fmtUsd(data.cost_usd)
            }));
        } catch (err) {
            setStatus(t('threeMode.ai.error', 'Render failed: {{m}}', { m: err.message }), true);
        } finally {
            setBusy(false);
        }
    }

    function init() {
        const btn = document.getElementById('mode-ai-toggle');
        if (btn) btn.addEventListener('click', openOverlay);
    }

    // Browser wiring only — skipped under Node (unit tests require this file with no DOM).
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }
    if (typeof window !== 'undefined') window.AiScene = { buildScenePrompt };

    // Node-visible for headless unit tests of the pure caption logic; the browser loads this
    // file as a classic script and ignores this block.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { buildScenePrompt };
    }
})();
