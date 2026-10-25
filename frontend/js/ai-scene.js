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
            try { const translated = api.t(key, params || {}); if (translated !== key) return translated; } catch (_) { /* fall through */ }
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
    // The shared link rides the /designs/<cid>,<cid> link (which imports and applies those designs);
    // ?scene=<slug> only adds the AI image + camera restore on top. So sharing needs: the applied
    // designs' published CIDs (for the path), the camera pose, and city/lang.

    let currentShareUrl = null;

    // The published CID of every applied design, in the order storage returns them. A design that
    // is not published (DesignSync.publishedCid is null for it) cannot be linked, so it is left out.
    function collectAppliedDesigns() {
        const storage = window.proposalStorage;
        if (!storage || typeof storage.getAllProposals !== 'function') return [];
        const isApplied = window.isApplied;
        const publishedCid = window.DesignSync && window.DesignSync.publishedCid;
        const seen = new Set();
        const out = [];
        (storage.getAllProposals() || []).forEach(p => {
            if (typeof isApplied === 'function' && !isApplied(p)) return;
            const cid = (typeof publishedCid === 'function') ? publishedCid(p) : null;
            if (!cid || seen.has(cid)) return;
            seen.add(cid);
            out.push({ proposal: p, cid });
        });
        return out;
    }

    // Narrow the applied set to the designs whose footprint was inside the capture camera's view —
    // the picture rarely shows the whole plan, so the link should not re-apply it. Returns the full
    // applied CID list unchanged whenever the frustum can't be built or the filter finds nothing (an
    // empty share link would be worse than an over-broad one), so this only ever narrows on a
    // confident, non-empty result.
    function collectAppliedDesignCids() {
        try {
            const applied = collectAppliedDesigns();
            const allIds = applied.map(a => a.cid);
            const frustum = window.__aiSceneFrustum;
            const internals = (typeof window.getThreeModeInternals === 'function')
                ? window.getThreeModeInternals() : null;
            const camera = internals && internals.camera;
            const project = internals && internals.latLngToXY;
            if (!frustum || !camera || typeof project !== 'function'
                || typeof collectProposalFeatureSets !== 'function' || !window.THREE) {
                return allIds;
            }
            // View-projection matrix of the exact frame the screenshot was taken from. Invert
            // matrixWorld here rather than trust matrixWorldInverse — the latter is only refreshed
            // by a render, and updateMatrixWorld can move matrixWorld without touching it.
            camera.updateMatrixWorld();
            const view = new window.THREE.Matrix4().copy(camera.matrixWorld).invert();
            const viewProj = new window.THREE.Matrix4().multiplyMatrices(
                camera.projectionMatrix, view);
            const proposalsWithFeatures = applied.map(a => {
                let features = [];
                try {
                    const sets = collectProposalFeatureSets(a.proposal) || {};
                    features = Array.isArray(sets.primaryFeatures) ? sets.primaryFeatures : [];
                } catch (_) { features = []; }
                return { id: a.cid, features };
            });
            const inView = frustum.proposalsInView(proposalsWithFeatures, {
                elements: viewProj.elements,
                project
            });
            return (Array.isArray(inView) && inView.length) ? inView : allIds;
        } catch (_) {
            try { return collectAppliedDesigns().map(a => a.cid); } catch (__) { return []; }
        }
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

    // The city the map is in: the address carries only ?at= once booted (location-first.md), and a
    // scene link is a record link, which opens in the city it names.
    function currentCity() {
        return window.CityConfigManager?.getCurrentCityId?.() || null;
    }

    function buildShareUrl(slug, appliedCids) {
        const base = frontendBaseUrl();
        const path = (appliedCids && appliedCids.length) ? window.DesignSync.designsPath(appliedCids) : '/';
        const cur = new URLSearchParams(window.location.search);
        const parts = [];
        const backend = cur.get('backend'); // preserve local-dev backend override so the link works locally
        if (backend) parts.push('backend=' + encodeURIComponent(backend));
        const city = currentCity();
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

    // Confirm ON the button that was pressed. A line of text below the row is easy to miss and
    // leaves the button looking like it did nothing; the label changing IS the receipt.
    let copyLabelTimer = null;
    function flashCopied() {
        const button = overlayEl && overlayEl.querySelector('.ai-scene-copy');
        if (!button) return;
        const original = button.dataset.label || button.textContent;
        button.dataset.label = original;
        button.textContent = t('threeMode.ai.linkCopied', 'Link copied');
        if (copyLabelTimer) clearTimeout(copyLabelTimer);
        copyLabelTimer = setTimeout(() => {
            copyLabelTimer = null;
            const current = overlayEl && overlayEl.querySelector('.ai-scene-copy');
            if (!current) return;
            current.textContent = current.dataset.label || t('threeMode.ai.copyLink', 'Copy link');
        }, 1800);
    }

    function copyToClipboard(text) {
        const done = () => flashCopied();
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
            text: t('threeMode.ai.tweetText', 'Photorealistic view of my urban design'),
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
                    proposalIds: cap.appliedCids || [],
                    view: cap.view || null,
                    city: currentCity(),
                    lang: currentLang(),
                    model: selectedModel() || undefined,
                    prompt: overlayEl.querySelector('.ai-scene-prompt').value
                })
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));

            currentShareUrl = buildShareUrl(data.slug, cap.appliedCids || []);
            tweetBtn.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(t('threeMode.ai.tweetText', 'Photorealistic view of my urban design'))}&url=${encodeURIComponent(currentShareUrl)}`;
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
        // The scene is a PROPOSAL. A model that fills the street with traffic and parks cars on the
        // new pavement is drawing today's street, not the one being proposed — and cars on a footway
        // read as an endorsement of exactly what the redesign removes. Stated exhaustively because a
        // single "no cars" gets applied to the carriageway and quietly ignored everywhere else.
        lines.push('Never generate any cars or other vehicles anywhere in the image: none on the sidewalks, none in parking spaces, none in the traffic lanes, none parked at the kerb, none in the distance. No cars anywhere.');
        lines.push('Natural daylight, clear weather. No text, labels, or watermarks.');
        return lines.join(' ');
    }

    // Session spend accumulates across renders until the page reloads.
    let sessionCostUsd = 0;
    let lastCapture = null; // { image, summary } from the most recent button press
    let overlayEl = null;

    // Amount then code ("0.0390 USD"), four decimals because a render costs cents.
    function fmtUsd(n) { return CbFormat.formatMoney(Number(n) || 0, 'USD', { maxFractionDigits: 4, minFractionDigits: 4 }); }

    // The render dialog keeps its own markup (state lives in it between opens: the capture, the
    // running request, the share row), so it wears the dialog primitive's classes instead of being
    // rebuilt by CbDialog.open on every press.
    function ensureOverlay() {
        if (overlayEl) return overlayEl;
        overlayEl = document.createElement('div');
        overlayEl.id = 'ai-scene-overlay';
        overlayEl.className = 'cb-dialog-overlay ai-scene-overlay';
        overlayEl.hidden = true;
        overlayEl.innerHTML = `
            <div class="cb-dialog cb-dialog--lg ai-scene-modal" role="dialog" aria-modal="true" aria-labelledby="ai-scene-title">
                <div class="cb-dialog__header ai-scene-header">
                    <h2 class="cb-dialog__title" id="ai-scene-title">${t('threeMode.ai.title', 'AI photorealistic render')}</h2>
                    <button type="button" class="close-circle-btn ai-scene-close" aria-label="${t('common.close', 'Close')}">&times;</button>
                </div>
                <div class="cb-dialog__body ai-scene-body">
                    <div class="ai-scene-source">
                        <div class="cb-kicker">${t('threeMode.ai.sourceLabel', 'Captured scene')}</div>
                        <img class="ai-scene-source-img" alt="captured 3D scene" />
                        <button type="button" class="btn btn-quiet btn-sm ai-scene-height-toggle" hidden aria-expanded="false"></button>
                        <img class="ai-scene-height-img" alt="height map" hidden title="${t('threeMode.ai.heightMapTitle', 'Height map (white = tallest) — sent to keep heights faithful')}" />
                    </div>
                    <div class="ai-scene-controls">
                        <label class="cb-kicker" for="ai-scene-model">${t('threeMode.ai.modelLabel', 'Model')}</label>
                        <select id="ai-scene-model" class="ai-scene-model"></select>
                        <label class="cb-kicker" for="ai-scene-prompt">${t('threeMode.ai.promptLabel', 'Prompt (editable)')}</label>
                        <textarea id="ai-scene-prompt" class="ai-scene-prompt" rows="5"></textarea>
                        <div class="ai-scene-actions">
                            <button type="button" class="btn btn-primary btn-block ai-scene-generate"></button>
                            <span class="ai-scene-cost-hint">${t('threeMode.ai.costHint', '~{{c}} per image', { c: fmtUsd(NOMINAL_COST_HINT) })}</span>
                        </div>
                        <div class="ai-scene-status" role="status" aria-live="polite"></div>
                    </div>
                    <div class="ai-scene-result" hidden>
                        <div class="cb-kicker">${t('threeMode.ai.resultLabel', 'Result')}</div>
                        <img class="ai-scene-result-img" alt="AI photorealistic render" />
                        <div class="ai-scene-warning" hidden></div>
                        <!-- Sharing first, saving last: the point of a render is to show someone.
                             Download and Share on X stay ANCHORS on purpose — the download
                             attribute names the file and target=_blank keeps middle-click and
                             "open in new tab" working, neither of which a button can do — and
                             wear the button classes (an <a class="btn">), so the row reads as one
                             set of buttons. -->
                        <div class="ai-scene-result-actions">
                            <button type="button" class="btn btn-block ai-scene-share" hidden>${t('threeMode.ai.share', 'Share')}</button>
                            <button type="button" class="btn btn-block ai-scene-copy" hidden>${t('threeMode.ai.copyLink', 'Copy link')}</button>
                            <a class="btn btn-block ai-scene-tweet" target="_blank" rel="noopener noreferrer" hidden>${t('threeMode.ai.tweet', 'Share on X')}</a>
                            <a class="btn btn-block ai-scene-download" download="ai-scene.png">${t('threeMode.ai.download', 'Download')}</a>
                        </div>
                        <div class="ai-scene-share-status" role="status" aria-live="polite"></div>
                    </div>
                </div>
                <div class="cb-dialog__footer ai-scene-footer">
                    <span class="ai-scene-session-total"></span>
                </div>
            </div>`;
        document.body.appendChild(overlayEl);

        overlayEl.querySelector('.ai-scene-close').addEventListener('click', closeOverlay);
        overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) closeOverlay(); });
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

        // Prod pins the prompt server-side too: make the textarea read-only so it can't suggest an
        // edit that would be silently discarded. (Applied before any early return below.)
        const promptEl = overlayEl.querySelector('.ai-scene-prompt');
        promptEl.readOnly = !!data.forcedPrompt;
        promptEl.classList.toggle('ai-scene-prompt--locked', !!data.forcedPrompt);
        promptEl.title = data.forcedPrompt
            ? t('threeMode.ai.promptLocked', 'The prompt is set by the server and cannot be edited.')
            : '';

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
        if (overlayEl) {
            overlayEl.__unregisterEscape?.();
            overlayEl.__unregisterEscape = null;
            overlayEl.hidden = true;
        }
    }

    // The app's own dialog (js/ui/dialogs.js), never the browser's.
    function sayAlert(message) {
        window.CbDialog.alert(message);
    }

    function openOverlay() {
        if (!window.isThreeModeActive || !window.isThreeModeActive()) {
            sayAlert(t('threeMode.ai.need3d', 'Enter 3D mode first to render the scene.'));
            return;
        }
        const image = (typeof window.captureThreeSceneDataURL === 'function') ? window.captureThreeSceneDataURL() : null;
        if (!image) {
            sayAlert(t('threeMode.ai.captureFailed', 'Could not capture the 3D scene.'));
            return;
        }
        // Height map (grayscale, white = tallest) — the exact-heights signal. Optional: if it fails
        // we still render from the colour screenshot alone.
        const height = (typeof window.captureThreeHeightMapDataURL === 'function') ? window.captureThreeHeightMapDataURL() : null;
        const summary = (typeof window.getThreeSceneSummary === 'function') ? window.getThreeSceneSummary() : {};
        summary.hasHeightMap = !!(height && height.image);
        summary.maxHeightM = height ? height.maxHeightM : null;
        // Camera + applied designs captured HERE, in the same frame as the screenshot, so a
        // follower can be dropped into the exact same world and shot the render was made from.
        const view = (typeof window.getThree3DGeoView === 'function') ? window.getThree3DGeoView() : null;
        const appliedCids = collectAppliedDesignCids();
        lastCapture = {
            image, heightMap: height ? height.image : null, summary,
            view, appliedCids, focusProposalId: appliedCids[0] || null
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
        overlayEl.__unregisterEscape?.();
        overlayEl.__unregisterEscape = window.ModalEscape?.register(overlayEl, closeOverlay);
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
            case 'budget_exhausted':
                return t('threeMode.ai.errBudget', 'The image generation budget has been used up. Please try again another time.');
            case 'budget_check_failed':
                return t('threeMode.ai.errBudgetCheck', 'Image generation is briefly unavailable. Please try again shortly.');
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
                    // Scene facts the server needs to rebuild the canonical prompt itself when it
                    // is configured to ignore ours (prod). All coerced/sanitised server-side.
                    summary: lastCapture.summary,
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
            // The server can discard the submitted prompt and use its own — say so plainly rather
            // than letting the user believe their edit shaped the image.
            const warnEl = overlayEl.querySelector('.ai-scene-warning');
            if (data.warning === 'prompt_overridden') {
                warnEl.textContent = t('threeMode.ai.warnPromptOverridden',
                    'Note: the standard server prompt was used — the prompt sent was ignored.');
                warnEl.hidden = false;
            } else {
                warnEl.hidden = true;
            }
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
