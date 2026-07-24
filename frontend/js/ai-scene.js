// AI photorealistic scene render (v1). Adds the "AI" button (shown only in 3D mode): it captures
// the current 3D canvas, builds a scene-aware caption, and sends both to the backend, which forwards
// them to Gemini's image model and returns a photorealistic image. The panel lets the user edit the
// prompt before spending, shows the exact per-render cost, and keeps a running session total.
(function () {
    'use strict';

    const ENDPOINT = '/ai-scene/render';
    const SAVE_ENDPOINT = '/ai-scene/save';
    const MODELS_ENDPOINT = '/ai-scene/models';
    const NOMINAL_COST_HINT = 0.04; // ~$ per image, shown before a model list has loaded (real cost comes back per render)
    const MODEL_STORAGE_KEY = 'ai-scene-model'; // last-used model persists across sessions

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

    // --- Share plumbing -------------------------------------------------------------------------
    // The shared link rides the existing /proposals/<ids> deep-link (which already applies those
    // proposals); ?scene=<slug> only adds the AI image + camera restore on top. So sharing needs:
    // the applied proposals' SERVER serial ids (for the path), the camera pose, and city/lang.

    let currentShareUrl = null;

    function collectAppliedSerialIds() {
        try {
            const storage = window.proposalStorage;
            if (!storage || typeof storage.getAllProposals !== 'function') return [];
            const isApplied = window.isApplied;
            const getSerial = window.getSerialProposalId;
            const seen = new Set();
            const ids = [];
            (storage.getAllProposals() || []).forEach(p => {
                if (typeof isApplied === 'function' && !isApplied(p)) return;
                const sid = (typeof getSerial === 'function') ? getSerial(p) : null;
                if (sid == null) return;
                const s = String(sid);
                if (!seen.has(s)) { seen.add(s); ids.push(s); }
            });
            return ids;
        } catch (_) { return []; }
    }

    // Mirror of the app's resolveFrontendBaseUrl: live origin for localhost, pinned host in prod.
    function frontendBaseUrl() {
        const loc = window.location;
        const host = (loc.hostname || '').toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local')) {
            return `${loc.protocol}//${loc.host}`;
        }
        return 'https://urbangametheory.xyz';
    }

    function currentLang() {
        try {
            const i18n = window.i18n;
            if (i18n) {
                if (typeof i18n.getLanguage === 'function') return i18n.getLanguage();
                if (typeof i18n.language === 'string') return i18n.language;
            }
        } catch (_) { /* fall through */ }
        return new URLSearchParams(window.location.search).get('lang') || null;
    }

    function currentCity() {
        return new URLSearchParams(window.location.search).get('city') || null;
    }

    function buildShareUrl(slug, appliedSerialIds) {
        const base = frontendBaseUrl();
        const path = (appliedSerialIds && appliedSerialIds.length) ? `/proposals/${appliedSerialIds.join(',')}` : '/';
        const cur = new URLSearchParams(window.location.search);
        const parts = [];
        const backend = cur.get('backend'); // preserve local-dev backend override so the link works locally
        if (backend) parts.push('backend=' + encodeURIComponent(backend));
        const city = cur.get('city');
        if (city) parts.push('city=' + encodeURIComponent(city));
        parts.push('model');                 // boolean flag: enter 3D model mode
        parts.push('scene=' + encodeURIComponent(slug));
        const lang = currentLang();
        if (lang) parts.push('lang=' + encodeURIComponent(lang));
        return `${base}${path}?${parts.join('&')}`;
    }

    function setShareStatus(msg, isError) {
        const el = overlayEl && overlayEl.querySelector('.ai-scene-share-status');
        if (!el) return;
        el.textContent = msg || '';
        el.classList.toggle('ai-scene-status--error', !!isError);
    }

    function copyToClipboard(text) {
        const done = () => setShareStatus(t('threeMode.ai.linkCopied', 'Link copied!'));
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
        } else {
            fallbackCopy(text, done);
        }
    }

    function fallbackCopy(text, done) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.focus(); ta.select();
            document.execCommand('copy'); document.body.removeChild(ta);
            done();
        } catch (_) {
            setShareStatus(t('threeMode.ai.copyFailed', 'Copy failed — long-press the link to copy it.'), true);
        }
    }

    async function nativeShare(url) {
        const shareData = {
            title: t('threeMode.ai.shareTitle', 'Urban Game Theory'),
            text: t('threeMode.ai.tweetText', 'Photorealistic view of my urban proposal'),
            url
        };
        // Attach the PNG itself where supported (mobile share sheets) — nicer than a bare link.
        try {
            const img = overlayEl.querySelector('.ai-scene-result-img');
            if (img && img.src && navigator.canShare) {
                const blob = await (await fetch(img.src)).blob();
                const file = new File([blob], 'ai-scene.png', { type: blob.type || 'image/png' });
                if (navigator.canShare({ files: [file] })) shareData.files = [file];
            }
        } catch (_) { /* fall back to url-only share */ }
        try {
            await navigator.share(shareData);
        } catch (err) {
            if (err && err.name !== 'AbortError') {
                setShareStatus(t('threeMode.ai.shareFailed', 'Could not share: {{m}}', { m: err.message }), true);
            }
        }
    }

    // Persist the render as a shareable scene, then reveal the share buttons wired to its link.
    async function saveAndEnableShare(renderDataUrl) {
        currentShareUrl = null;
        const copyBtn = overlayEl.querySelector('.ai-scene-copy');
        const shareBtn = overlayEl.querySelector('.ai-scene-share');
        const tweetBtn = overlayEl.querySelector('.ai-scene-tweet');
        copyBtn.hidden = shareBtn.hidden = tweetBtn.hidden = true;
        setShareStatus(t('threeMode.ai.savingShare', 'Preparing share link…'));
        try {
            const cap = lastCapture || {};
            const resp = await fetch(backendBase() + SAVE_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: renderDataUrl,
                    focusProposalId: cap.focusProposalId || null,
                    proposalIds: cap.appliedSerialIds || [],
                    view: cap.view || null,
                    city: currentCity(),
                    lang: currentLang(),
                    model: selectedModel() || undefined,
                    prompt: overlayEl.querySelector('.ai-scene-prompt').value
                })
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));

            currentShareUrl = buildShareUrl(data.slug, cap.appliedSerialIds || []);
            tweetBtn.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(t('threeMode.ai.tweetText', 'Photorealistic view of my urban proposal'))}&url=${encodeURIComponent(currentShareUrl)}`;
            copyBtn.hidden = tweetBtn.hidden = false;
            shareBtn.hidden = !navigator.share; // native share only where supported
            setShareStatus('');
        } catch (err) {
            setShareStatus(t('threeMode.ai.shareFailed', 'Could not create a share link: {{m}}', { m: err.message }), true);
        }
    }

    // Pure: turn scene semantics into the generation prompt. Exposed for unit testing. The images
    // carry the geometry; this frames the task as a strict structure-preserving EDIT (not a fresh
    // "visualization") and, when a height map is present, tells the model to read exact heights from
    // it — the single biggest lever for making low buildings stay low and tall ones stay tall.
    function buildScenePrompt(summary) {
        const s = summary || {};
        const where = s.cityLabel ? ` in ${s.cityLabel}` : '';
        const lines = [
            `Recreate this scene${where} as a photorealistic architectural visualization.`,
            "The FIRST image is the reference: keep the exact camera angle, and every building's footprint, position and proportions. Do not add, remove, move, or resize any building."
        ];
        if (s.hasHeightMap) {
            lines.push(
                `The SECOND image is a grayscale HEIGHT MAP of the same view: black is ground level and pure white is the tallest structure (about ${s.maxHeightM || 60} m tall). Use it to set each building's height EXACTLY — a dark building must stay low, a bright building must stay tall. Match the relative heights precisely.`
            );
        }
        if (s.isolatedProposal) lines.push('Make the highlighted proposed building the clear focal point.');
        // Enhancement, not invention: the captures come from the photoreal mesh (grainy facades)
        // plus 3D-modelled road lanes — upscale what is there instead of dreaming up a new scene.
        lines.push('The facades are grainy: improve them to a higher, believable resolution — do not invent completely new ones. Probabilistically determine what an unclear patch shows (e.g. a dark window-shaped spot on a light facade becomes a proper window).');
        lines.push('Pay special attention to the street: convert the 3D-modelled lanes into photorealistic lanes, keeping their order, widths and proportions exactly as shown.');
        lines.push('Natural daylight, clear weather. No text, labels, or watermarks.');
        return lines.join(' ');
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
                        <button type="button" class="ai-scene-height-toggle" hidden aria-expanded="false"></button>
                        <img class="ai-scene-height-img" alt="height map" hidden title="${t('threeMode.ai.heightMapTitle', 'Height map (white = tallest) — sent to keep heights faithful')}" />
                    </div>
                    <div class="ai-scene-controls">
                        <label class="ai-scene-label" for="ai-scene-model">${t('threeMode.ai.modelLabel', 'Model')}</label>
                        <select id="ai-scene-model" class="ai-scene-model"></select>
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
                            <button type="button" class="btn btn-action ai-scene-copy" hidden>${t('threeMode.ai.copyLink', 'Copy link')}</button>
                            <button type="button" class="btn btn-action ai-scene-share" hidden>${t('threeMode.ai.share', 'Share')}</button>
                            <a class="btn btn-action ai-scene-tweet" target="_blank" rel="noopener noreferrer" hidden>${t('threeMode.ai.tweet', 'Share on X')}</a>
                        </div>
                        <div class="ai-scene-share-status" role="status" aria-live="polite"></div>
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
        overlayEl.querySelector('.ai-scene-model').addEventListener('change', () => {
            try { localStorage.setItem(MODEL_STORAGE_KEY, selectedModel()); } catch (_) { /* private mode */ }
            updateCostHint();
        });
        overlayEl.querySelector('.ai-scene-height-toggle').addEventListener('click', () => {
            const img = overlayEl.querySelector('.ai-scene-height-img');
            setHeightMapExpanded(img.hidden); // hidden -> expand; visible -> collapse
        });
        overlayEl.querySelector('.ai-scene-copy').addEventListener('click', () => {
            if (currentShareUrl) copyToClipboard(currentShareUrl);
        });
        overlayEl.querySelector('.ai-scene-share').addEventListener('click', () => {
            if (currentShareUrl) nativeShare(currentShareUrl);
        });
        return overlayEl;
    }

    // Show/hide the height map in place and keep the toggle button's label + aria in sync.
    function setHeightMapExpanded(expanded) {
        const btn = overlayEl.querySelector('.ai-scene-height-toggle');
        const img = overlayEl.querySelector('.ai-scene-height-img');
        img.hidden = !expanded;
        btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        btn.textContent = expanded
            ? t('threeMode.ai.hideHeightMap', 'Hide height map')
            : t('threeMode.ai.showHeightMap', 'Show height map');
    }

    // Model picker. The list (ids, labels, price estimates, configured flags) comes from the
    // backend so the allowlist and pricing live in exactly one place; unconfigured models stay
    // visible but disabled, so the dropdown doubles as a "what could I enable" menu.
    let modelsCache = null;

    async function fetchModels() {
        if (modelsCache) return modelsCache;
        try {
            const resp = await fetch(backendBase() + MODELS_ENDPOINT);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            modelsCache = await resp.json();
        } catch (_) {
            modelsCache = { models: [], default: null }; // backend keeps its own default model
        }
        return modelsCache;
    }

    function selectedModel() {
        const sel = overlayEl && overlayEl.querySelector('.ai-scene-model');
        return (sel && sel.value) || null;
    }

    async function populateModelSelect() {
        const sel = overlayEl.querySelector('.ai-scene-model');
        const data = await fetchModels();
        sel.hidden = data.models.length === 0;
        sel.previousElementSibling.hidden = sel.hidden; // the "Model" label
        if (sel.hidden || sel.options.length) { updateCostHint(); return; }

        for (const m of data.models) {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.label + ' — ~' + fmtUsd(m.estUsd)
                + (m.configured ? '' : ' · ' + t('threeMode.ai.keyNeeded', 'API key needed'));
            opt.disabled = !m.configured;
            sel.appendChild(opt);
        }
        // Prod pins the model server-side: preselect it and disable the picker (the server ignores
        // whatever the client sends anyway). Dev leaves the dropdown live for testing.
        if (data.forced) {
            sel.value = data.forced;
            sel.disabled = true;
            updateCostHint();
            return;
        }
        sel.disabled = false;
        let saved = null;
        try { saved = localStorage.getItem(MODEL_STORAGE_KEY); } catch (_) { /* private mode */ }
        const usable = id => id && data.models.some(m => m.id === id && m.configured);
        const firstConfigured = (data.models.find(m => m.configured) || {}).id;
        sel.value = [saved, data.default, firstConfigured].find(usable) || '';
        updateCostHint();
    }

    function updateCostHint() {
        const m = modelsCache && modelsCache.models.find(x => x.id === selectedModel());
        overlayEl.querySelector('.ai-scene-cost-hint').textContent =
            t('threeMode.ai.costHint', '~{{c}} per image', { c: fmtUsd(m ? m.estUsd : NOMINAL_COST_HINT) });
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
        // Height map (grayscale, white = tallest) — the exact-heights signal. Optional: if it fails
        // we still render from the colour screenshot alone.
        const height = (typeof window.captureThreeHeightMapDataURL === 'function') ? window.captureThreeHeightMapDataURL() : null;
        const summary = (typeof window.getThreeSceneSummary === 'function') ? window.getThreeSceneSummary() : {};
        summary.hasHeightMap = !!(height && height.image);
        summary.maxHeightM = height ? height.maxHeightM : null;
        // Camera + applied proposals captured HERE, in the same frame as the screenshot, so a
        // follower can be dropped into the exact same world and shot the render was made from.
        const view = (typeof window.getThree3DGeoView === 'function') ? window.getThree3DGeoView() : null;
        const appliedSerialIds = collectAppliedSerialIds();
        lastCapture = {
            image, heightMap: height ? height.image : null, summary,
            view, appliedSerialIds, focusProposalId: appliedSerialIds[0] || null
        };

        ensureOverlay();
        overlayEl.querySelector('.ai-scene-source-img').src = image;
        // Height map lives behind a toggle, below the scene image. The button only appears when
        // a height map was captured; it starts collapsed so the dialog opens compact.
        const heightImg = overlayEl.querySelector('.ai-scene-height-img');
        const heightToggle = overlayEl.querySelector('.ai-scene-height-toggle');
        heightToggle.hidden = !summary.hasHeightMap;
        if (summary.hasHeightMap) heightImg.src = height.image;
        setHeightMapExpanded(false);
        overlayEl.querySelector('.ai-scene-prompt').value = buildScenePrompt(summary);
        overlayEl.querySelector('.ai-scene-result').hidden = true;
        // Reset the share row — a new capture invalidates the previous render's link.
        currentShareUrl = null;
        overlayEl.querySelector('.ai-scene-copy').hidden = true;
        overlayEl.querySelector('.ai-scene-share').hidden = true;
        overlayEl.querySelector('.ai-scene-tweet').hidden = true;
        setShareStatus('');
        setStatus('');
        setBusy(false);
        updateSessionTotal();
        overlayEl.hidden = false;
        populateModelSelect(); // async — fills the dropdown when the list arrives
    }

    // Map a backend error {code} to a friendly, localised message. The server pins the model and
    // enforces rate limits, so the UI must speak to cooldown / quota / no-funds specifically.
    function messageForError(data) {
        switch (data && data.code) {
            case 'rate_limited_cooldown':
                return t('threeMode.ai.errCooldown', 'Please wait a few seconds before generating another image.');
            case 'rate_limited_quota':
                return t('threeMode.ai.errQuota', 'You have reached your image limit for now. Please try again later.');
            case 'no_funds':
                return t('threeMode.ai.errNoFunds', 'Image generation is temporarily unavailable. Please try again later.');
            case 'timeout':
                return t('threeMode.ai.errTimeout', 'The image took too long to generate. Please try again.');
            case 'not_configured':
                return t('threeMode.ai.errNotConfigured', 'Image generation is not available right now.');
            default:
                return t('threeMode.ai.error', 'Render failed: {{m}}', { m: (data && data.error) || 'unknown error' });
        }
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
                body: JSON.stringify({
                    image: lastCapture.image,
                    heightMap: lastCapture.heightMap,
                    prompt,
                    model: selectedModel() || undefined
                })
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) { setStatus(messageForError(data), true); return; }

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
            // Persist the render + world/camera so it can be shared; reveals the share buttons.
            saveAndEnableShare(data.image);
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
