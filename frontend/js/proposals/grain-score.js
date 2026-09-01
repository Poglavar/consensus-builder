// Institut za zrnatost — plan-level parcel inspection on the live Leaflet map.
//
// The map already contains the authoritative derived parcel fabric. This module reads that fabric,
// measures each resulting parcel, lets the rooster visit it, and only then reveals the scorecard.
(function (global) {
    'use strict';

    const rules = global.GrainScoreRules;
    const yieldApi = global.__planYield;
    if (!rules || !yieldApi) {
        console.warn('[grain-score] scoring rules or plan-yield did not load');
        return;
    }

    const reduceMotion = (() => {
        try { return global.matchMedia('(prefers-reduced-motion: reduce)').matches; }
        catch (_) { return false; }
    })();
    const AUDIO_PATHS = Object.freeze({
        rejected: '/audio/grain-rooster/rooster-check-fail.wav',
        eaten: '/audio/grain-rooster/rooster-check-success.wav'
    });
    const CRITIC_IMAGE = '/images/grain-rooster-critic.png';
    const HAPPY_IMAGE = '/images/grain-rooster-happy.png';

    const state = {
        ui: null,
        prepared: null,
        namedPlan: null,
        running: false,
        runToken: 0,
        sidebarWasCollapsed: null,
        priorMapView: null,
        disabledMapControls: [],
        routeRestorePath: null
    };

    function formatTemplate(template, values) {
        return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (match, a, b) => {
            const key = a || b;
            return values && Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
        });
    }

    function t(key, fallback, params = {}) {
        const api = global.i18n;
        if (api && typeof api.t === 'function') {
            const translated = api.t(key, params);
            if (translated && translated !== key) return translated;
        }
        return formatTemplate(fallback, params);
    }

    function mapInstance() {
        try {
            if (typeof map !== 'undefined' && map) return map;
        } catch (_) { /* global lexical binding may not exist in a headless test */ }
        return global.map || null;
    }

    function appliedProposals() {
        if (typeof proposalStorage === 'undefined' || !proposalStorage
            || typeof proposalStorage.getAllProposals !== 'function') return [];
        const all = proposalStorage.getAllProposals() || [];
        return all.filter(proposal => {
            if (typeof isProposalCurrentlyApplied === 'function') {
                try { return isProposalCurrentlyApplied(proposal); } catch (_) { /* fall through */ }
            }
            return !!(proposal && proposal.applied === true);
        });
    }

    // A named-plan link may be opened in a browser that already has unrelated proposals applied.
    // Keep those proposals visible on the map, but exclude them from this plan's parcel fabric and
    // score. Replacement snapshots still answer to the server id of the proposal they replaced, so
    // walk the stored replacement chain when matching the plan's ids.
    function appliedProposalsInScope(scopeIds) {
        const applied = appliedProposals();
        const wanted = new Set((Array.isArray(scopeIds) ? scopeIds : [])
            .map(value => value == null ? '' : String(value))
            .filter(Boolean));
        if (!wanted.size) return applied;

        let all = applied;
        try {
            if (typeof proposalStorage !== 'undefined' && proposalStorage
                && typeof proposalStorage.getAllProposals === 'function') {
                all = proposalStorage.getAllProposals() || applied;
            }
        } catch (_) { /* the applied records are still enough for ordinary proposals */ }
        const byKey = new Map();
        all.forEach(proposal => {
            if (proposal && proposal.proposalId != null) {
                byKey.set(String(proposal.proposalId), proposal);
            }
        });

        return applied.filter(proposal => {
            const seen = new Set();
            let current = proposal;
            let hops = 0;
            while (current && hops < 10) {
                const candidates = [current.serverProposalId, current.proposalId, current.id];
                try {
                    if (typeof getSerialProposalId === 'function') {
                        candidates.push(getSerialProposalId(current));
                    }
                } catch (_) { }
                if (candidates.some(value => value != null && wanted.has(String(value)))) return true;

                const previous = current.replacementOfProposalId || current.sourceProposalId || null;
                if (previous == null || seen.has(String(previous))) break;
                if (wanted.has(String(previous))) return true;
                seen.add(String(previous));
                current = byKey.get(String(previous)) || null;
                hops += 1;
            }
            return false;
        });
    }

    function updateButtonState() {
        const button = document.getElementById('roosterScoreButton');
        if (!button) return;
        const count = appliedProposals().length;
        const disabled = count === 0 || state.running;
        button.disabled = disabled;
        button.classList.toggle('grain-score-button--empty', count === 0);
        button.setAttribute('aria-disabled', String(disabled));
    }

    function currentNamedPlan() {
        if (state.namedPlan && state.namedPlan.slug) return state.namedPlan;
        if (global.__currentNamedPlan && rules.normalizePlanSlug(global.__currentNamedPlan.slug)) {
            return global.__currentNamedPlan;
        }
        try {
            const match = global.location.pathname.match(/^\/proposals\/([^/]+)\/?$/i);
            const slug = match ? rules.normalizePlanSlug(decodeURIComponent(match[1])) : null;
            return slug ? { slug, title: null } : null;
        } catch (_) {
            return null;
        }
    }

    function setNodeText(root, role, value) {
        const node = root && root.querySelector(`[data-grain-role="${role}"]`);
        if (node) node.textContent = value == null ? '' : String(value);
        return node;
    }

    function roosterSvg() {
        return `
            <svg viewBox="0 0 180 220" focusable="false" aria-hidden="true">
                <g class="grain-rooster__tail" fill="#17232b" stroke="#17232b" stroke-linejoin="round">
                    <path d="M119 108C146 70 163 54 174 58C163 77 149 98 125 119Z"/>
                    <path d="M120 119C151 91 169 84 177 91C158 105 145 120 123 132Z"/>
                    <path d="M116 97C132 55 145 34 158 34C150 60 139 83 121 108Z"/>
                </g>
                <g class="grain-rooster__leg grain-rooster__leg--far" fill="none" stroke="#9d6d23" stroke-width="6" stroke-linecap="round">
                    <path d="M84 169V204"/><path d="M84 203L70 211M84 203L85 214M84 203L99 210"/>
                </g>
                <ellipse cx="105" cy="132" rx="52" ry="60" fill="#f2dfb8" stroke="#17232b" stroke-width="7"/>
                <path d="M91 125C115 113 139 126 143 154C132 164 116 169 99 162C91 151 88 138 91 125Z" fill="#c9984e" stroke="#17232b" stroke-width="6"/>
                <path d="M100 132C118 132 131 141 136 154" fill="none" stroke="#17232b" stroke-width="4" stroke-linecap="round"/>
                <path d="M62 109C45 91 46 59 65 43C86 27 116 34 125 58C129 70 132 81 143 94C130 104 118 113 105 120Z" fill="#f2dfb8" stroke="#17232b" stroke-width="7"/>
                <g fill="#a3312a" stroke="#17232b" stroke-width="5" stroke-linejoin="round">
                    <path d="M65 46C60 28 65 16 74 10C83 14 84 26 80 36C87 23 96 16 105 18C111 25 105 37 98 44C108 37 118 38 123 45C120 55 108 61 94 63Z"/>
                    <path d="M72 86C64 100 66 115 77 119C87 112 87 97 81 87Z"/>
                </g>
                <path d="M53 66L28 79L57 85Z" fill="#c58a2b" stroke="#17232b" stroke-width="6" stroke-linejoin="round"/>
                <path class="grain-rooster__critical" d="M30 79Q43 80 56 87" fill="none" stroke="#17232b" stroke-width="3.5" stroke-linecap="round"/>
                <circle class="grain-rooster__critical" cx="72" cy="61" r="6" fill="#17232b"/>
                <path class="grain-rooster__critical" d="M55 49L87 43" stroke="#17232b" stroke-width="7" stroke-linecap="round"/>
                <g class="grain-rooster__happy" fill="none" stroke="#17232b" stroke-linecap="round">
                    <path d="M32 77Q43 86 56 79" stroke-width="3.8"/>
                    <path d="M64 61Q72 53 80 61" stroke-width="4.5"/>
                    <path d="M56 46Q71 35 87 45" stroke-width="6"/>
                </g>
                <circle cx="72" cy="61" r="18" fill="none" stroke="#b58a3c" stroke-width="5"/>
                <path d="M84 75C93 93 97 109 95 127" fill="none" stroke="#b58a3c" stroke-width="3.5" stroke-dasharray="2 5" stroke-linecap="round"/>
                <g class="grain-rooster__leg grain-rooster__leg--near" fill="none" stroke="#9d6d23" stroke-width="7" stroke-linecap="round">
                    <path d="M119 173V205"/><path d="M119 204L104 212M119 204L120 215M119 204L135 211"/>
                </g>
            </svg>`;
    }

    function ensureUi() {
        if (state.ui) return state.ui;
        const host = document.getElementById('map-container') || document.body;

        const overlay = document.createElement('div');
        overlay.id = 'grain-score-overlay';
        overlay.className = 'grain-score-overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
            <svg class="grain-score-parcels" data-grain-role="parcelOverlay" aria-hidden="true"></svg>
            <div class="grain-rooster" data-grain-role="rooster" hidden>
                <div class="grain-rooster__speech" data-grain-role="speech"></div>
                <div class="grain-rooster__body">${roosterSvg()}</div>
            </div>
            <div class="grain-score-progress" data-grain-role="progress" hidden aria-live="polite">
                <span class="grain-score-progress__dot" aria-hidden="true"></span>
                <span data-grain-role="progressText"></span>
            </div>`;

        const panel = document.createElement('section');
        panel.id = 'grain-score-panel';
        panel.className = 'grain-score-panel';
        panel.hidden = true;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'false');
        panel.setAttribute('aria-labelledby', 'grain-score-title');
        panel.innerHTML = `
            <header class="grain-score-panel__header">
                <img data-grain-role="portrait" src="${CRITIC_IMAGE}" alt="" width="78" height="78">
                <div>
                    <p class="grain-score-eyebrow" data-grain-role="eyebrow"></p>
                    <h2 id="grain-score-title" data-grain-role="title"></h2>
                    <p class="grain-score-plan-name" data-grain-role="planName"></p>
                </div>
                <button type="button" class="grain-score-close" data-grain-action="close" aria-label="Close">×</button>
            </header>
            <div class="grain-score-route" data-grain-role="route"></div>
            <div class="grain-score-loading" data-grain-role="loading" hidden>
                <i class="fas fa-spinner fa-spin" aria-hidden="true"></i>
                <span data-grain-role="loadingText"></span>
            </div>
            <div class="grain-score-ready" data-grain-role="ready" hidden>
                <p data-grain-role="readyText"></p>
                <button type="button" class="grain-score-start" data-grain-action="start">
                    <span aria-hidden="true">🐓</span><span data-grain-role="startLabel"></span>
                </button>
            </div>
            <div class="grain-score-error" data-grain-role="error" hidden></div>
            <div class="grain-score-result" data-grain-role="result" hidden>
                <div class="grain-score-hero">
                    <div class="grain-score-ring" data-grain-role="scoreRing">
                        <strong data-grain-role="totalScore">—</strong><span>/ 100</span>
                    </div>
                    <div><strong class="grain-score-verdict" data-grain-role="verdict"></strong><p data-grain-role="summary"></p></div>
                </div>
                <div class="grain-score-dimensions">
                    <article>
                        <div><span>01</span><h3 data-grain-role="countTitle"></h3><strong data-grain-role="countScore"></strong></div>
                        <p data-grain-role="countCopy"></p><div class="grain-score-meter"><i data-grain-role="countMeter"></i></div>
                    </article>
                    <article>
                        <div><span>02</span><h3 data-grain-role="fineTitle"></h3><strong data-grain-role="fineScore"></strong></div>
                        <p data-grain-role="fineCopy"></p><div class="grain-score-meter"><i data-grain-role="fineMeter"></i></div>
                    </article>
                </div>
                <p class="grain-score-note" data-grain-role="missingNote" hidden></p>
                <details class="grain-score-methodology">
                    <summary data-grain-role="methodologyTitle"></summary>
                    <p data-grain-role="methodologyBody"></p>
                </details>
                <div class="grain-score-actions">
                    <button type="button" class="btn btn-outline-primary" data-grain-action="repeat"><i class="fas fa-rotate-right" aria-hidden="true"></i> <span data-grain-role="repeatLabel"></span></button>
                    <button type="button" class="btn btn-outline-secondary grain-score-sound" data-grain-action="sound"><i class="fas fa-volume-high" aria-hidden="true"></i> <span data-grain-role="soundLabel"></span></button>
                </div>
            </div>`;

        host.append(overlay, panel);
        state.ui = { host, overlay, panel };
        panel.querySelector('[data-grain-action="close"]').addEventListener('click', closeExperience);
        panel.querySelector('[data-grain-action="start"]').addEventListener('click', () => {
            void runInspection({ soundPreparation: sound.prepare() });
        });
        panel.querySelector('[data-grain-action="repeat"]').addEventListener('click', () => {
            void runInspection({ soundPreparation: sound.prepare() });
        });
        panel.querySelector('[data-grain-action="sound"]').addEventListener('click', () => {
            sound.setEnabled(!sound.enabled);
            renderSoundControl();
            if (sound.enabled) void sound.prepare();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !panel.hidden) closeExperience();
        });
        return state.ui;
    }

    function createSoundController() {
        let context = null;
        let enabled = true;
        let loading = null;
        const buffers = new Map();
        const sources = new Set();

        function getContext() {
            if (context) return context;
            const AudioContextClass = global.AudioContext || global.webkitAudioContext;
            context = AudioContextClass ? new AudioContextClass() : null;
            return context;
        }

        async function prepare() {
            if (!enabled || typeof global.fetch !== 'function') return false;
            try {
                const audioContext = getContext();
                if (!audioContext) return false;
                const resume = audioContext.state === 'suspended' ? audioContext.resume() : Promise.resolve();
                if (!loading) {
                    loading = Promise.all(Object.entries(AUDIO_PATHS).map(async ([name, url]) => {
                        const response = await global.fetch(url);
                        if (!response.ok) throw new Error(`Audio ${response.status}: ${url}`);
                        const buffer = await audioContext.decodeAudioData(await response.arrayBuffer());
                        buffers.set(name, buffer);
                    }));
                }
                await Promise.all([resume, loading]);
                return true;
            } catch (error) {
                loading = null;
                buffers.clear();
                console.warn('[grain-score] recorded rooster audio unavailable', error);
                return false;
            }
        }

        function play(name) {
            if (!enabled || !context || !buffers.has(name)) return false;
            try {
                const source = context.createBufferSource();
                source.buffer = buffers.get(name);
                source.connect(context.destination);
                source.onended = () => sources.delete(source);
                sources.add(source);
                source.start();
                return true;
            } catch (error) {
                console.warn('[grain-score] cue failed', error);
                return false;
            }
        }

        function stopAll() {
            sources.forEach(source => { try { source.stop(); } catch (_) { } });
            sources.clear();
        }

        function setEnabled(next) {
            enabled = !!next;
            if (!enabled) stopAll();
            return enabled;
        }

        return {
            get enabled() { return enabled; },
            prepare,
            play,
            stopAll,
            setEnabled
        };
    }

    const sound = createSoundController();

    function showOnly(name) {
        const { panel } = ensureUi();
        ['loading', 'ready', 'error', 'result'].forEach(role => {
            const node = panel.querySelector(`[data-grain-role="${role}"]`);
            if (node) node.hidden = role !== name;
        });
        panel.hidden = false;
    }

    function renderPanelChrome(plan) {
        const { panel } = ensureUi();
        const slug = plan && plan.slug ? plan.slug : null;
        setNodeText(panel, 'eyebrow', t('sidebar.proposals.grainScore.institute', 'Institut za zrnatost'));
        setNodeText(panel, 'title', t('sidebar.proposals.grainScore.title', 'Urban grain score'));
        setNodeText(panel, 'planName', (plan && plan.title) || t('sidebar.proposals.grainScore.currentPlan', 'Current applied plan'));
        setNodeText(panel, 'route', slug
            ? rules.buildPlanScorePath(slug)
            : t('sidebar.proposals.grainScore.unnamedRoute', 'Unnamed plan · score stays in this browser'));
        const close = panel.querySelector('[data-grain-action="close"]');
        if (close) close.setAttribute('aria-label', t('sidebar.proposals.grainScore.closeAria', 'Close grain score'));
        renderSoundControl();
    }

    function renderLoading(plan, message) {
        renderPanelChrome(plan);
        const { panel } = ensureUi();
        showOnly('loading');
        setNodeText(panel, 'loadingText', message || t('sidebar.proposals.grainScore.loading', 'Preparing the plan for inspection…'));
    }

    function renderReady() {
        const prepared = state.prepared;
        renderPanelChrome(prepared && prepared.plan);
        const { panel } = ensureUi();
        showOnly('ready');
        setNodeText(panel, 'readyText', t(
            'sidebar.proposals.grainScore.ready',
            'The rooster found {{count}} measurable resulting parcels. He will try them one by one.',
            { count: prepared ? prepared.items.length : 0 }
        ));
        setNodeText(panel, 'startLabel', t('sidebar.proposals.grainScore.start', 'Start the inspection'));
    }

    function renderError(message) {
        const { panel } = ensureUi();
        showOnly('error');
        setNodeText(panel, 'error', message || t('sidebar.proposals.grainScore.unavailable', 'The grain score is unavailable for this plan.'));
    }

    function verdictLabel(key) {
        const labels = {
            fine: ['verdictFine', 'Fine grain'],
            good: ['verdictGood', 'A good direction'],
            mixed: ['verdictMixed', 'Mixed grain'],
            coarse: ['verdictCoarse', 'Coarse grain'],
            unavailable: ['verdictUnavailable', 'Not measurable']
        };
        const [suffix, fallback] = labels[key] || labels.unavailable;
        return t(`sidebar.proposals.grainScore.${suffix}`, fallback);
    }

    function countCopy(score, before, after) {
        const delta = score.parcelCount.delta;
        if (score.parcelCount.direction === 'increase') {
            return t('sidebar.proposals.grainScore.countIncrease', 'Parcel count increased: {{before}} → {{after}} (+{{delta}}).', { before, after, delta });
        }
        if (score.parcelCount.direction === 'decrease') {
            return t('sidebar.proposals.grainScore.countDecrease', 'Parcel count decreased: {{before}} → {{after}} ({{delta}}).', { before, after, delta });
        }
        return t('sidebar.proposals.grainScore.countUnchanged', 'Parcel count stayed the same: {{before}} → {{after}}.', { before, after, delta });
    }

    function renderResult() {
        if (!state.prepared) return;
        const { panel } = ensureUi();
        const { score, beforeCount, afterCount, plan } = state.prepared;
        renderPanelChrome(plan);
        showOnly('result');

        const total = score.totalScore;
        const totalText = total == null ? '—' : String(total);
        setNodeText(panel, 'totalScore', totalText);
        setNodeText(panel, 'verdict', verdictLabel(score.verdict));
        setNodeText(panel, 'summary', t(
            'sidebar.proposals.grainScore.summary',
            'The rooster ate {{eaten}} of {{measured}} measured parcels.',
            { count: score.fineGrain.eaten, eaten: score.fineGrain.eaten, measured: score.fineGrain.measured }
        ));
        setNodeText(panel, 'countTitle', t('sidebar.proposals.grainScore.countTitle', 'Number of parcels'));
        setNodeText(panel, 'countScore', String(score.parcelCount.score));
        setNodeText(panel, 'countCopy', countCopy(score, beforeCount, afterCount));
        setNodeText(panel, 'fineTitle', t('sidebar.proposals.grainScore.fineTitle', 'Edible parcels'));
        setNodeText(panel, 'fineScore', score.fineGrain.score == null ? '—' : String(score.fineGrain.score));
        setNodeText(panel, 'fineCopy', t(
            'sidebar.proposals.grainScore.fineCopy',
            '{{eaten}} of {{measured}} measured parcels are smaller than 10 × 10 m.',
            { count: score.fineGrain.eaten, eaten: score.fineGrain.eaten, measured: score.fineGrain.measured }
        ));
        setNodeText(panel, 'methodologyTitle', t('sidebar.proposals.grainScore.methodologyTitle', 'Prototype methodology'));
        setNodeText(panel, 'methodologyBody', t(
            'sidebar.proposals.grainScore.methodologyBody',
            'An increase in parcel count scores 100 points, no change 50, and a decrease 0. Fine grain is the share of measured resulting parcels whose minimum rotated bounding rectangle is under 10 m in both directions. The total is the average of those two dimensions.'
        ));
        setNodeText(panel, 'repeatLabel', t('sidebar.proposals.grainScore.repeat', 'Inspect again'));

        const ring = panel.querySelector('[data-grain-role="scoreRing"]');
        if (ring) {
            ring.style.setProperty('--grain-score', String(total || 0));
            ring.setAttribute('aria-label', t('sidebar.proposals.grainScore.totalAria', 'Overall score: {{score}} out of 100', { score: totalText }));
        }
        const countMeter = panel.querySelector('[data-grain-role="countMeter"]');
        const fineMeter = panel.querySelector('[data-grain-role="fineMeter"]');
        if (countMeter) countMeter.style.width = `${score.parcelCount.score}%`;
        if (fineMeter) fineMeter.style.width = `${score.fineGrain.score || 0}%`;

        const missing = panel.querySelector('[data-grain-role="missingNote"]');
        if (missing) {
            missing.hidden = score.fineGrain.missing === 0;
            missing.textContent = score.fineGrain.missing
                ? t(
                    'sidebar.proposals.grainScore.missingGeometry',
                    '{{missing}} resulting parcel shapes were unavailable and were not included in the fine-grain percentage.',
                    { count: score.fineGrain.missing, missing: score.fineGrain.missing }
                )
                : '';
        }

        const portrait = panel.querySelector('[data-grain-role="portrait"]');
        if (portrait) portrait.src = total != null && total >= rules.HAPPY_SCORE ? HAPPY_IMAGE : CRITIC_IMAGE;
    }

    function renderSoundControl() {
        if (!state.ui) return;
        const button = state.ui.panel.querySelector('[data-grain-action="sound"]');
        if (!button) return;
        const icon = button.querySelector('i');
        if (icon) icon.className = sound.enabled ? 'fas fa-volume-high' : 'fas fa-volume-xmark';
        setNodeText(
            state.ui.panel,
            'soundLabel',
            sound.enabled
                ? t('sidebar.proposals.grainScore.soundOn', 'Sound on')
                : t('sidebar.proposals.grainScore.soundOff', 'Sound off')
        );
        button.setAttribute('aria-pressed', String(sound.enabled));
    }

    function featureForParcel(parcelId, proposals) {
        const id = String(parcelId);
        try {
            if (typeof resolveParcelLayerById === 'function') {
                const layer = resolveParcelLayerById(id);
                if (layer && typeof layer.toGeoJSON === 'function') {
                    const feature = layer.toGeoJSON(false);
                    if (feature && feature.geometry) return feature;
                }
            }
        } catch (_) { /* continue through the other stores */ }
        try {
            if (typeof readPersistedParcelRecord === 'function') {
                const record = readPersistedParcelRecord(id);
                if (record && record.geometry) {
                    return { type: 'Feature', properties: record.properties || {}, geometry: record.geometry };
                }
            }
        } catch (_) { }
        if (typeof getCachedParcelFeature === 'function') {
            for (const proposal of proposals) {
                try {
                    const feature = getCachedParcelFeature(id, proposal);
                    if (feature && feature.geometry) return feature;
                } catch (_) { }
            }
        }
        return null;
    }

    function looksDerivedParcelId(parcelId, produced) {
        const id = String(parcelId || '');
        if (produced && produced.has(id)) return true;
        if (typeof isSyntheticParcelId === 'function') {
            try { if (isSyntheticParcelId(id)) return true; } catch (_) { }
        }
        return id.includes('#') || /^HR-\d+-.+?_[a-z0-9]+_\d+$/i.test(id);
    }

    async function resolvePlanItems(proposals, fabric) {
        const resultingIds = (fabric.resulting || []).map(String);
        let rows = resultingIds.map(id => ({ id, feature: featureForParcel(id, proposals) }));
        const produced = new Set((fabric.produced || []).map(String));
        const cadastralIds = resultingIds.filter(id => !looksDerivedParcelId(id, produced));
        if (cadastralIds.length && global.CadastralGroundService
            && typeof global.CadastralGroundService.ensureIds === 'function') {
            try { await global.CadastralGroundService.ensureIds(cadastralIds); }
            catch (error) { console.warn('[grain-score] could not load cadastral ground', error); }
            rows = resultingIds.map(id => ({ id, feature: featureForParcel(id, proposals) }));
        }
        return rows.map(row => {
            const dimensions = row.feature ? rules.parcelDimensionsMeters(row.feature) : null;
            return dimensions ? { ...row, ...dimensions } : { ...row, widthMeters: null, depthMeters: null };
        });
    }

    async function prepareExperience(plan, scopeIds = null) {
        const proposals = appliedProposalsInScope(scopeIds);
        if (!proposals.length) {
            renderError(t('sidebar.proposals.grainScore.noApplied', 'Apply at least one proposal before summoning the rooster.'));
            return null;
        }
        const fabric = yieldApi.resultingParcels(proposals, { appliedOnly: true });
        const rows = await resolvePlanItems(proposals, fabric);
        const items = rows.filter(row => row.feature && Number.isFinite(row.widthMeters) && Number.isFinite(row.depthMeters));
        if (!items.length) {
            renderError(t('sidebar.proposals.grainScore.noGeometry', 'The resulting parcel shapes could not be measured.'));
            return null;
        }
        const beforeCount = rules.startingParcelIds(fabric).length;
        const afterCount = (fabric.resulting || []).length;
        const score = rules.scorePlan({ beforeParcelCount: beforeCount, afterParcelCount: afterCount, parcels: rows });
        state.prepared = {
            plan: plan || { slug: null, title: null },
            proposals,
            fabric,
            rows,
            items,
            beforeCount,
            afterCount,
            score
        };
        return state.prepared;
    }

    function saveAndSimplifyChrome() {
        const leafletMap = mapInstance();
        if (state.sidebarWasCollapsed === null) {
            const sidebar = document.getElementById('sidebar');
            state.sidebarWasCollapsed = !!(sidebar && sidebar.classList.contains('collapsed'));
            if (sidebar && !state.sidebarWasCollapsed && typeof toggleSidebar === 'function') {
                try { toggleSidebar(); } catch (_) { }
            }
        }
        if (!state.priorMapView && leafletMap && typeof leafletMap.getCenter === 'function') {
            state.priorMapView = { center: leafletMap.getCenter(), zoom: leafletMap.getZoom() };
        }
        try { if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel(false); } catch (_) { }
        try {
            if (typeof global.isThreeModeActive === 'function' && global.isThreeModeActive()
                && typeof global.exitThreeMode === 'function') global.exitThreeMode();
        } catch (_) { }
        document.body.classList.add('grain-score-mode');
    }

    function disableMapInteractions() {
        const leafletMap = mapInstance();
        state.disabledMapControls = [];
        if (!leafletMap) return;
        ['dragging', 'scrollWheelZoom', 'doubleClickZoom', 'boxZoom', 'keyboard', 'touchZoom'].forEach(name => {
            const control = leafletMap[name];
            if (!control || typeof control.disable !== 'function') return;
            const wasEnabled = typeof control.enabled !== 'function' || control.enabled();
            if (wasEnabled) {
                try { control.disable(); state.disabledMapControls.push(control); } catch (_) { }
            }
        });
    }

    function restoreMapInteractions() {
        state.disabledMapControls.forEach(control => { try { control.enable(); } catch (_) { } });
        state.disabledMapControls = [];
    }

    async function fitPlanOnMap(items) {
        const leafletMap = mapInstance();
        if (!leafletMap || typeof turf === 'undefined' || !items.length) return;
        try {
            const collection = turf.featureCollection(items.map(item => item.feature));
            const bounds = turf.bbox(collection);
            if (!bounds || bounds.some(value => !Number.isFinite(value))) return;
            leafletMap.fitBounds([[bounds[1], bounds[0]], [bounds[3], bounds[2]]], {
                padding: [72, 72],
                maxZoom: 20,
                animate: !reduceMotion
            });
            await new Promise(resolve => {
                let settled = false;
                const finish = () => { if (!settled) { settled = true; resolve(); } };
                try { leafletMap.once('moveend', finish); } catch (_) { }
                setTimeout(finish, reduceMotion ? 30 : 700);
            });
        } catch (error) {
            console.warn('[grain-score] could not frame plan', error);
        }
    }

    function polygonPath(rings, leafletMap) {
        if (!Array.isArray(rings)) return '';
        return rings.map(ring => {
            if (!Array.isArray(ring) || ring.length < 3) return '';
            return ring.map((coord, index) => {
                if (!Array.isArray(coord) || coord.length < 2) return '';
                const point = leafletMap.latLngToContainerPoint([Number(coord[1]), Number(coord[0])]);
                return `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
            }).join('') + 'Z';
        }).join('');
    }

    function featurePath(feature, leafletMap) {
        const geometry = feature && feature.type === 'Feature' ? feature.geometry : feature;
        if (!geometry) return '';
        if (geometry.type === 'Polygon') return polygonPath(geometry.coordinates, leafletMap);
        if (geometry.type === 'MultiPolygon') {
            return (geometry.coordinates || []).map(polygon => polygonPath(polygon, leafletMap)).join('');
        }
        return '';
    }

    function buildParcelOverlay(items) {
        const { overlay } = ensureUi();
        const svg = overlay.querySelector('[data-grain-role="parcelOverlay"]');
        const leafletMap = mapInstance();
        if (!svg || !leafletMap) return [];
        svg.replaceChildren();
        const size = leafletMap.getSize();
        svg.setAttribute('viewBox', `0 0 ${size.x} ${size.y}`);
        svg.setAttribute('width', String(size.x));
        svg.setAttribute('height', String(size.y));
        return items.map(item => {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', featurePath(item.feature, leafletMap));
            path.setAttribute('class', 'grain-score-parcel');
            path.setAttribute('fill-rule', 'evenodd');
            path.dataset.parcelId = item.id;
            svg.append(path);
            return { ...item, path };
        }).filter(item => item.path.getAttribute('d'));
    }

    function animationDuration(milliseconds) {
        return reduceMotion ? 1 : Math.max(1, milliseconds);
    }

    async function animate(element, keyframes, options) {
        if (!element || typeof element.animate !== 'function') return null;
        const animation = element.animate(keyframes, { ...options, duration: animationDuration(options.duration) });
        try { await animation.finished; } catch (_) { }
        return animation;
    }

    function targetForPath(path, rooster) {
        const box = path.getBBox();
        const width = rooster.offsetWidth || 96;
        const height = rooster.offsetHeight || 118;
        const host = state.ui.overlay;
        const desiredX = box.x + box.width / 2 - width / 2;
        const desiredY = box.y + box.height / 2 - height * 0.72;
        return {
            x: Math.max(4, Math.min(host.clientWidth - width - 4, desiredX)),
            y: Math.max(36, Math.min(host.clientHeight - height - 18, desiredY))
        };
    }

    function transformFor(position, facing) {
        return `translate3d(${position.x}px, ${position.y}px, 0) scaleX(${facing})`;
    }

    async function walkTo(item, pace) {
        const rooster = state.ui.overlay.querySelector('[data-grain-role="rooster"]');
        const target = targetForPath(item.path, rooster);
        const previous = rooster.__grainPosition || { x: 8, y: state.ui.overlay.clientHeight - (rooster.offsetHeight || 118) - 20 };
        const facing = target.x >= previous.x ? 1 : -1;
        rooster.classList.add('is-walking');
        const animation = await animate(rooster, [
            { transform: transformFor(previous, rooster.__grainFacing || 1) },
            { transform: transformFor(target, facing) }
        ], { duration: pace * 0.48, easing: 'cubic-bezier(.35,.03,.2,1)', fill: 'forwards' });
        rooster.style.transform = transformFor(target, facing);
        if (animation) animation.cancel();
        rooster.classList.remove('is-walking');
        rooster.__grainPosition = target;
        rooster.__grainFacing = facing;
    }

    async function peck(pace) {
        const body = state.ui.overlay.querySelector('.grain-rooster__body');
        await animate(body, [
            { transform: 'rotate(0deg) translateY(0)' },
            { transform: 'rotate(17deg) translateY(7px)', offset: 0.48 },
            { transform: 'rotate(0deg) translateY(0)' }
        ], { duration: pace * 0.22, easing: 'ease-in-out' });
    }

    async function scatterCrumbs(path, pace) {
        const box = path.getBBox();
        const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const offsets = [[-22, -18], [5, -28], [24, -12]];
        await Promise.all(offsets.map(async ([x, y], index) => {
            const crumb = document.createElement('span');
            crumb.className = 'grain-score-crumb';
            crumb.style.left = `${center.x}px`;
            crumb.style.top = `${center.y}px`;
            state.ui.overlay.append(crumb);
            await animate(crumb, [
                { transform: 'translate(0,0) rotate(0)', opacity: 0 },
                { opacity: 1, offset: 0.2 },
                { transform: `translate(${x}px,${y}px) rotate(${index * 35 - 30}deg)`, opacity: 0 }
            ], { duration: pace * 0.34, easing: 'cubic-bezier(.17,.67,.35,1.2)' });
            crumb.remove();
        }));
    }

    async function acceptParcel(item, pace, playCue) {
        if (playCue) sound.play('eaten');
        item.path.classList.add('is-eaten');
        await Promise.all([
            animate(item.path, [
                { transform: 'scale(1)', opacity: 1 },
                { transform: 'scale(.12) rotate(-5deg)', opacity: .1 }
            ], { duration: pace * 0.34, easing: 'cubic-bezier(.52,-.2,.3,1)' }),
            scatterCrumbs(item.path, pace)
        ]);
    }

    async function rejectParcel(item, pace, playCue) {
        if (playCue) sound.play('rejected');
        item.path.classList.add('is-too-large');
        await animate(item.path, [
            { transform: 'translateX(0)' },
            { transform: 'translateX(-7px) rotate(-.5deg)' },
            { transform: 'translateX(7px) rotate(.5deg)' },
            { transform: 'translateX(-5px)' },
            { transform: 'translateX(5px)' },
            { transform: 'translateX(0)' }
        ], { duration: pace * 0.34, easing: 'ease-in-out' });
    }

    function resetOverlay() {
        if (!state.ui) return;
        const svg = state.ui.overlay.querySelector('[data-grain-role="parcelOverlay"]');
        if (svg) svg.replaceChildren();
        state.ui.overlay.querySelectorAll('.grain-score-crumb').forEach(node => node.remove());
        const rooster = state.ui.overlay.querySelector('[data-grain-role="rooster"]');
        if (rooster) {
            rooster.hidden = true;
            rooster.removeAttribute('style');
            rooster.classList.remove('is-happy', 'is-walking');
            delete rooster.__grainPosition;
            delete rooster.__grainFacing;
        }
        const progress = state.ui.overlay.querySelector('[data-grain-role="progress"]');
        if (progress) progress.hidden = true;
    }

    async function runInspection({ soundPreparation } = {}) {
        if (state.running || !state.prepared) return;
        const token = ++state.runToken;
        state.running = true;
        updateButtonState();
        saveAndSimplifyChrome();
        const { overlay, panel } = ensureUi();
        panel.hidden = true;
        overlay.hidden = false;
        resetOverlay();
        await fitPlanOnMap(state.prepared.items);
        if (token !== state.runToken) return;
        const items = buildParcelOverlay(state.prepared.items);
        if (!items.length) {
            state.running = false;
            renderError(t('sidebar.proposals.grainScore.noGeometry', 'The resulting parcel shapes could not be measured.'));
            updateButtonState();
            return;
        }
        disableMapInteractions();
        if (soundPreparation) await soundPreparation;

        const rooster = overlay.querySelector('[data-grain-role="rooster"]');
        const speech = overlay.querySelector('[data-grain-role="speech"]');
        const progress = overlay.querySelector('[data-grain-role="progress"]');
        rooster.hidden = false;
        progress.hidden = false;
        rooster.__grainPosition = { x: 10, y: Math.max(50, overlay.clientHeight - (rooster.offsetHeight || 118) - 24) };
        rooster.__grainFacing = 1;
        rooster.style.transform = transformFor(rooster.__grainPosition, 1);
        speech.textContent = t('sidebar.proposals.grainScore.speechStart', 'Let us see.');

        const pace = reduceMotion ? 1 : Math.max(90, Math.min(720, 18000 / items.length));
        const soundEvery = Math.max(1, Math.ceil(items.length / 28));
        let eaten = 0;
        for (let index = 0; index < items.length; index += 1) {
            if (token !== state.runToken) break;
            const item = items[index];
            const width = item.widthMeters.toFixed(1);
            const depth = item.depthMeters.toFixed(1);
            setNodeText(overlay, 'progressText', t(
                'sidebar.proposals.grainScore.progress',
                'Checking parcel {{current}} of {{total}} · {{width}} × {{depth}} m',
                { current: index + 1, total: items.length, width, depth }
            ));
            speech.textContent = `${width} × ${depth}?`;
            item.path.classList.add('is-active');
            await walkTo(item, pace);
            await peck(pace);
            const fine = rules.isFineGrainParcel(item);
            const playCue = index % soundEvery === 0 || index === items.length - 1;
            if (fine) {
                speech.textContent = t('sidebar.proposals.grainScore.speechEaten', 'Delicious.');
                await acceptParcel(item, pace, playCue);
                eaten += 1;
            } else {
                speech.textContent = t('sidebar.proposals.grainScore.speechRejected', 'Too large a bite.');
                await rejectParcel(item, pace, playCue);
            }
            item.path.classList.remove('is-active');
        }

        if (token !== state.runToken) return;
        rooster.classList.toggle('is-happy', state.prepared.score.totalScore >= rules.HAPPY_SCORE);
        speech.textContent = t('sidebar.proposals.grainScore.speechDone', 'The finding is ready.');
        setNodeText(overlay, 'progressText', t(
            'sidebar.proposals.grainScore.complete',
            'Inspection complete · {{eaten}} of {{total}} parcels eaten',
            { count: eaten, eaten, total: items.length }
        ));
        restoreMapInteractions();
        state.running = false;
        updateButtonState();
        await new Promise(resolve => setTimeout(resolve, reduceMotion ? 10 : 700));
        if (token !== state.runToken) return;
        renderResult();
    }

    function updateRouteForScore(plan) {
        if (!plan || !plan.slug || !global.history || typeof global.history.replaceState !== 'function') return;
        try {
            state.routeRestorePath = `/proposals/${encodeURIComponent(plan.slug)}`;
            global.history.replaceState({ grainScore: true }, '', `${rules.buildPlanScorePath(plan.slug)}${global.location.search || ''}`);
        } catch (_) { }
    }

    async function summonUrbanistRooster() {
        if (state.running) return;
        const plan = currentNamedPlan() || { slug: null, title: null };
        state.namedPlan = plan.slug ? plan : null;
        const soundPreparation = sound.prepare();
        saveAndSimplifyChrome();
        renderLoading(plan);
        if (plan.slug) updateRouteForScore(plan);
        const scopeIds = plan.slug && Array.isArray(plan.proposalIds) ? plan.proposalIds : null;
        const prepared = await prepareExperience(plan, scopeIds);
        if (!prepared) return;
        await runInspection({ soundPreparation });
    }

    async function openPlanGrainScoreRoute(slug) {
        const normalized = rules.normalizePlanSlug(slug);
        if (!normalized) {
            renderError(t('sidebar.proposals.grainScore.planNotFound', 'This named plan could not be found.'));
            return;
        }
        state.namedPlan = { slug: normalized, title: null };
        state.routeRestorePath = `/proposals/${encodeURIComponent(normalized)}`;
        saveAndSimplifyChrome();
        renderLoading(state.namedPlan, t('sidebar.proposals.grainScore.loadingNamed', 'Loading named plan…'));
        try {
            const base = typeof resolveBackendBaseUrl === 'function' ? resolveBackendBaseUrl() : '';
            const response = await global.fetch(`${base}/plans/${encodeURIComponent(normalized)}`);
            if (!response.ok) {
                renderError(response.status === 404
                    ? t('sidebar.proposals.grainScore.planNotFound', 'This named plan could not be found.')
                    : t('sidebar.proposals.grainScore.planLoadFailed', 'The named plan could not be loaded.'));
                return;
            }
            const plan = await response.json();
            const ids = Array.isArray(plan.proposalIds) ? plan.proposalIds.map(String).filter(Boolean) : [];
            if (!ids.length) {
                renderError(t('sidebar.proposals.grainScore.emptyPlan', 'This named plan contains no proposals.'));
                return;
            }
            state.namedPlan = { ...plan, slug: normalized };
            global.__currentNamedPlan = state.namedPlan;
            renderLoading(state.namedPlan, t('sidebar.proposals.grainScore.applyingPlan', 'Rebuilding the plan on the map…'));
            if (typeof handleSharedPlanRoute !== 'function') throw new Error('Shared-plan loader unavailable');
            const loadResult = await handleSharedPlanRoute(ids, 0, { suppressSummary: true, suppressDetails: true });
            if (loadResult && (loadResult.blocked || (Array.isArray(loadResult.failed) && loadResult.failed.length))) {
                renderError(t(
                    'sidebar.proposals.grainScore.incompletePlan',
                    'The plan cannot be scored because not all of its proposals could be applied.'
                ));
                updateButtonState();
                return;
            }
            const prepared = await prepareExperience(state.namedPlan, ids);
            if (prepared) renderReady();
            updateButtonState();
        } catch (error) {
            console.error('[grain-score] named score route failed', error);
            renderError(t('sidebar.proposals.grainScore.planLoadFailed', 'The named plan could not be loaded.'));
        }
    }

    function closeExperience() {
        state.runToken += 1;
        state.running = false;
        sound.stopAll();
        restoreMapInteractions();
        if (state.ui) {
            resetOverlay();
            state.ui.overlay.hidden = true;
            state.ui.panel.hidden = true;
        }
        document.body.classList.remove('grain-score-mode');
        const leafletMap = mapInstance();
        if (leafletMap && state.priorMapView) {
            try { leafletMap.setView(state.priorMapView.center, state.priorMapView.zoom, { animate: false }); } catch (_) { }
        }
        const sidebar = document.getElementById('sidebar');
        if (state.sidebarWasCollapsed === false && sidebar && sidebar.classList.contains('collapsed')
            && typeof toggleSidebar === 'function') {
            try { toggleSidebar(); } catch (_) { }
        }
        if (state.routeRestorePath && global.location.pathname.startsWith('/plans/')
            && global.history && typeof global.history.replaceState === 'function') {
            try { global.history.replaceState(null, '', `${state.routeRestorePath}${global.location.search || ''}`); } catch (_) { }
        }
        state.prepared = null;
        state.priorMapView = null;
        state.sidebarWasCollapsed = null;
        state.routeRestorePath = null;
        updateButtonState();
    }

    function initialize() {
        const button = document.getElementById('roosterScoreButton');
        if (button && !button.dataset.grainScoreBound) {
            button.dataset.grainScoreBound = '1';
            button.addEventListener('click', event => {
                event.preventDefault();
                void summonUrbanistRooster();
            });
        }
        updateButtonState();
    }

    document.addEventListener('DOMContentLoaded', initialize);
    if (global.i18n && typeof global.i18n.onChange === 'function') {
        global.i18n.onChange(() => {
            updateButtonState();
            if (!state.ui || state.ui.panel.hidden) return;
            if (state.running) return;
            if (state.prepared && !state.ui.panel.querySelector('[data-grain-role="result"]').hidden) renderResult();
            else if (state.prepared) renderReady();
            else renderPanelChrome(state.namedPlan);
        });
    }

    global.updateGrainScoreButtonState = updateButtonState;
    global.summonUrbanistRooster = summonUrbanistRooster;
    global.openPlanGrainScoreRoute = openPlanGrainScoreRoute;
    global.closeGrainScore = closeExperience;
})(typeof window !== 'undefined' ? window : globalThis);
