// proposals/server-sync.js — extracted from proposals.js (behavior-preserving relocation).

const serverSyncLifecycleOf = (typeof getLifecycleStatus === 'function')
    ? getLifecycleStatus
    : (typeof require === 'function' ? require('./status.js').getLifecycleStatus : null);

function getServerSyncGroundService() {
    if (typeof CadastralParcelRepository !== 'undefined' && CadastralParcelRepository) return CadastralParcelRepository;
    const root = (typeof window !== 'undefined') ? window : globalThis;
    if (root && root.CadastralParcelRepository) return root.CadastralParcelRepository;
    if (typeof require === 'function') return require('../parcels/ground-service.js').CadastralParcelRepository;
    return null;
}

function resolveCurrentCityCode() {
    try {
        const mgr = typeof window !== 'undefined' ? window.CityConfigManager : null;
        if (mgr && typeof mgr.getCurrentCityConfig === 'function' && typeof mgr.getCityCodeForCityId === 'function') {
            const cfg = mgr.getCurrentCityConfig();
            if (cfg && cfg.id) {
                const code = mgr.getCityCodeForCityId(cfg.id);
                if (code) return code;
            }
        }
    } catch (_) { /* best effort */ }
    try {
        if (typeof getCurrentCityId === 'function') {
            const id = getCurrentCityId();
            if (id) return id;
        }
    } catch (_) { /* ignore */ }
    return 'city';
}

function normalizeServerProposalSummary(raw, cityCode) {
    if (!raw || typeof raw !== 'object') return null;
    const city = raw.city || cityCode || resolveCurrentCityCode();
    const serverId = raw.id !== undefined && raw.id !== null ? String(raw.id) : null;
    const proposalId = raw.proposalId !== undefined && raw.proposalId !== null
        ? String(raw.proposalId)
        : (serverId || null);
    const titleCandidate = raw.title || raw.name || `Proposal ${proposalId || serverId || ''}`;
    const goalKey = normalizeProposalGoalKey(raw.goal || raw.type || '');

    return {
        id: serverId || proposalId,
        proposalId: proposalId || serverId,
        serverProposalId: serverId || proposalId,
        city,
        name: raw.name || raw.title || null,
        title: titleCandidate || '',
        author: raw.author || '',
        type: raw.type || raw.goal || 'parcel',
        goal: goalKey || 'parcel',
        lifecycleStatus: serverSyncLifecycleOf(raw),
        createdAt: raw.createdAt || raw.created_at || null,
        updatedAt: raw.updatedAt || raw.updated_at || null,
        // The summary endpoint serves the server-rendered thumbnail (COALESCE(screenshot_url,
        // onchain_data->>'imageUrl')). Dropping it here is what made the server tab fall back to
        // the goal emoji for every row, even though almost all of them have a picture.
        screenshotUrl: raw.screenshotUrl || raw.screenshot_url || null,
        epochYear: raw.epochYear ?? raw.epoch_year ?? null,
        // The single proposal-to-land relationship used by claims and dossiers.
        cadastreParcelIds: Array.isArray(raw.cadastreParcelIds) ? raw.cadastreParcelIds : [],
        acceptedParcelIds: Array.isArray(raw.acceptedParcelIds) ? raw.acceptedParcelIds : [],
        isMinted: false
    };
}

function isServerProposalDownloaded(summary) {
    if (!summary || typeof proposalStorage === 'undefined' || typeof proposalStorage.getProposal !== 'function') {
        return false;
    }
    const candidates = [summary.serverProposalId, summary.proposalId, summary.id];
    return candidates.some(key => key && proposalStorage.getProposal(key));
}

function resetServerProposalCache(cityCode) {
    serverProposalCache.proposals = [];
    serverProposalCache.count = null;
    serverProposalCache.error = null;
    serverProposalCache.loading = false;
    serverProposalCache.lastCity = cityCode || null;
    // The "have we asked the server yet?" sentinel must be cleared with the rest, or the new city
    // would inherit the previous one's answer and never fetch.
    serverProposalCache.lastFetchedAt = 0;
    serverProposalCache.lastQuery = null;
    serverProposalCache.countRefreshedAt = 0;
    serverProposalCache.countLoading = false;
}

// How long the sidebar's server count may be reused before the section coming into view re-asks.
const SERVER_COUNT_MAX_AGE_MS = 15000;

/** Refresh only the NUMBER behind the sidebar button. One COUNT(*) — /proposals/summary would drag
    250 summaries along for a single integer. Never touches lastFetchedAt or the cached rows, so
    opening the list still fetches the summaries it needs. A failure keeps the previous number: a
    stale count is better than a button that empties itself because the network blinked. */
async function refreshServerProposalCount(cityCode) {
    const city = normalizeCityCodeForApi(cityCode || resolveCurrentCityCode());
    if (serverProposalCache.lastCity && serverProposalCache.lastCity !== city) {
        resetServerProposalCache(city);
    }
    // A summary fetch in flight is about to set the same number.
    if (serverProposalCache.countLoading || serverProposalCache.loading) return serverProposalCache.count;

    const counts = (typeof window !== 'undefined') ? window.__proposalCounts : null;
    const stale = !counts || counts.serverCountIsStale(
        serverProposalCache.countRefreshedAt, Date.now(), SERVER_COUNT_MAX_AGE_MS);
    if (!stale) return serverProposalCache.count;

    serverProposalCache.countLoading = true;
    try {
        const url = `${resolveBackendBaseUrl()}/proposals/count`
            + (city ? `?city=${encodeURIComponent(city)}` : '');
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const payload = await resp.json();
        if (Number.isFinite(payload?.count)) {
            serverProposalCache.count = Number(payload.count);
            serverProposalCache.lastCity = city;
            serverProposalCache.countRefreshedAt = Date.now();
        }
    } catch (error) {
        console.warn('[proposals] osvježavanje serverskog broja nije uspjelo:', error?.message || error);
    } finally {
        serverProposalCache.countLoading = false;
        if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton();
    }
    return serverProposalCache.count;
}

// The sort keys the SERVER can order by (DB-derivable). The rest (acceptance/parcels/area) are
// computed client-side, so they keep the server default and are sorted over the fetched window.
const SERVER_SORT_KEYS = ['created-desc', 'created-asc', 'author-asc', 'author-desc', 'value-desc', 'value-asc'];

// The active list query, as the server understands it: free-text search and a DB-derivable sort.
// Sending these means search/sort span ALL rows, not just the newest SERVER_PROPOSAL_SUMMARY_LIMIT.
// (goal is NOT sent — the client filterType vocabulary and the stored goal string can differ, so
// goal filtering stays client-side.)
function serverListQuery() {
    const state = (typeof proposalListState !== 'undefined' && proposalListState) ? proposalListState : {};
    const q = (state.searchText || '').toString().trim();
    const sort = SERVER_SORT_KEYS.includes(state.sortKey) ? state.sortKey : '';
    return { q, sort };
}

function serverListQuerySignature() {
    const { q, sort } = serverListQuery();
    return `${q}\u0000${sort}`;
}

function isServerListTab() {
    return (typeof proposalListState !== 'undefined' && proposalListState && proposalListState.source === 'server');
}

async function fetchServerProposalSummaries(cityCode) {
    const city = normalizeCityCodeForApi(cityCode || resolveCurrentCityCode());
    serverProposalCache.loading = true;
    serverProposalCache.error = null;
    serverProposalCache.lastCity = city;
    // Record the query this fetch answers, BEFORE the await, so the render→ensure loop below sees a
    // matching signature and does not refetch in a cycle.
    serverProposalCache.lastQuery = serverListQuerySignature();
    renderProposalListModal();

    const backendBase = resolveBackendBaseUrl();
    const { q, sort } = serverListQuery();
    // The summary already returns the full total via COUNT(*) OVER(), so the separate
    // /proposals/count round-trip was redundant — one request, not two.
    const summaryUrl = `${backendBase}/proposals/summary?limit=${SERVER_PROPOSAL_SUMMARY_LIMIT}&offset=0`
        + (city ? `&city=${encodeURIComponent(city)}` : '')
        + (q ? `&q=${encodeURIComponent(q)}` : '')
        + (sort ? `&sort=${encodeURIComponent(sort)}` : '');

    try {
        const summaryResp = await fetch(summaryUrl);

        if (!summaryResp.ok) {
            const text = await summaryResp.text();
            throw new Error(text || 'Failed to fetch proposal summaries');
        }

        const summaryPayload = await summaryResp.json();

        const summaries = Array.isArray(summaryPayload?.proposals)
            ? summaryPayload.proposals
            : [];

        serverProposalCache.proposals = summaries
            .map(item => normalizeServerProposalSummary(item, city))
            .filter(Boolean);

        serverProposalCache.count = Number.isFinite(summaryPayload?.count)
            ? Number(summaryPayload.count)
            : serverProposalCache.proposals.length;
    } catch (error) {
        serverProposalCache.error = error?.message || 'Unable to load server proposals';
    } finally {
        serverProposalCache.loading = false;
        // Record the attempt, not just the success. This is what stops the re-render below from
        // being mistaken for "we have never asked" — renderProposalListModal() calls back into
        // ensureServerProposals(), so a city with no server proposals (or an unreachable backend)
        // would otherwise refetch forever and sit on "Loading server proposals…".
        serverProposalCache.lastFetchedAt = Date.now();
        renderProposalListModal();
    }
}

function ensureServerProposals(cityCode) {
    const city = normalizeCityCodeForApi(cityCode || resolveCurrentCityCode());
    const cacheCity = serverProposalCache.lastCity;
    const cityChanged = cacheCity && cacheCity !== city;

    if (cityChanged) {
        resetServerProposalCache(city);
    }

    if (serverProposalCache.loading) return;
    // "No proposals" is an answer, not a missing one — testing proposals.length here made a city
    // with an empty server list refetch on every render, forever.
    const alreadyAsked = serverProposalCache.lastFetchedAt > 0;
    // On the server tab, a changed search/sort re-queries the server so results span all rows, not
    // just the fetched window. Debounced naturally: the search input schedules a debounced render,
    // and this runs from that render.
    const queryChanged = isServerListTab()
        && serverListQuerySignature() !== (serverProposalCache.lastQuery || '');
    if (!alreadyAsked || cityChanged || queryChanged) {
        fetchServerProposalSummaries(city);
    }
}

async function fetchServerProposalById(serverId, cityCode) {
    if (!serverId) {
        throw new Error('proposal id is required');
    }

    const backendBase = resolveBackendBaseUrl();
    const url = `${backendBase}/proposals/${encodeURIComponent(serverId)}`;

    const resp = await fetch(url);
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `Failed to download proposal ${serverId}`);
    }
    const payload = await resp.json();
    const normalized = { ...payload };
    // `serverProposalId` must be the server's serial id — the numeric `id` column. The payload's
    // `proposalId` is the uploader's *local* id (e.g. "p-1lo0n6ope6h"), and using it here left the
    // downloaded proposal without a shareable id: share links require /^\d+$/, so the share dialog
    // decided the proposal had never been uploaded and offered to upload it again.
    const serialId = (payload && payload.id !== undefined && payload.id !== null) ? String(payload.id) : null;
    const numericFallback = /^\d+$/.test(String(serverId || '')) ? String(serverId) : null;
    normalized.serverProposalId = serialId || numericFallback || normalized.serverProposalId || serverId;
    normalized.proposalId = payload.proposalId || payload.proposal_id || serverId;
    return normalized;
}

function syncProposalsIndicator() {
    // Proposals are always shown now, no checkbox to sync
    // Reset any previously set opacity on the Proposals header to keep it consistent
    const sections = document.querySelectorAll('.accordion-section[data-section="proposals"]');
    sections.forEach(section => {
        const header = section.querySelector('.accordion-header');
        if (header) {
            header.style.opacity = ''; // Clear inline opacity
        }
    });
}

function getServerProposalId(proposal) {
    if (!proposal) return null;
    const candidates = [proposal.serverProposalId, proposal.proposalId, proposal.id];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const id = String(candidate);
        // Local proposals are not shareable via server links.
        // Example: local-0, local-1
        if (/^local-\d+$/i.test(id)) return null;
        return id;
    }
    return null;
}

function buildCityQueryParam() {
    const mgr = (typeof window !== 'undefined') ? window.CityConfigManager : null;
    if (!mgr) return '';

    // Get current city config
    const cfg = mgr.getCurrentCityConfig && typeof mgr.getCurrentCityConfig === 'function' ? mgr.getCurrentCityConfig() : null;
    if (!cfg || !cfg.id) return '';

    // Get city code from city config manager
    const getCityCode = mgr.getCityCodeForCityId && typeof mgr.getCityCodeForCityId === 'function' ? mgr.getCityCodeForCityId : null;
    if (!getCityCode) return '';

    const code = getCityCode(cfg.id);
    if (!code) return '';

    return `?city=${encodeURIComponent(code)}`;
}

function mapGoalToBackendType(goalKey) {
    switch (goalKey) {
        case 'road-track':
            return 'road';
        case 'buildings':
        case 'single':
        case 'row':
            return 'building';
        case 'parcelbased':
        case 'parcel-based':
        case 'parcel':
            return 'parcel';
        case 'park':
        case 'square':
        case 'lake':
            return 'structure';
        default:
            return null;
    }
}

function syncProposalWithServerId(proposal, serverProposalId) {
    if (!serverProposalId || typeof proposalStorage === 'undefined') return null;
    const oldProposalId = proposal.proposalId;
    const proposalId = proposal.proposalId;
    let storedProposal = oldProposalId ? proposalStorage.getProposal(oldProposalId) : null;
    if (!storedProposal && proposalId) {
        storedProposal = proposalStorage.getProposal(proposalId);
    }
    if (!storedProposal) return null;

    // Preserve local proposalId; store server reference separately
    storedProposal.serverProposalId = String(serverProposalId);
    storedProposal.id = storedProposal.id || storedProposal.proposalId;

    // Older versions indexed the same proposal under the server id key, which caused duplicates in getAllProposals().
    // We resolve server ids via proposalStorage._resolveProposalId now, so ensure any legacy alias entry is removed.
    if (proposalStorage.proposals) {
        const serverKey = String(serverProposalId);
        const canonicalKey = storedProposal.proposalId ? String(storedProposal.proposalId) : null;
        if (serverKey && canonicalKey && serverKey !== canonicalKey) {
            const aliased = proposalStorage.proposals.get(serverKey);
            if (aliased === storedProposal) {
                proposalStorage.proposals.delete(serverKey);
            }
        }
    }

    if (typeof proposalStorage._indexProposal === 'function') {
        proposalStorage._indexProposal(storedProposal);
    }

    if (typeof proposalStorage.save === 'function') {
        proposalStorage.save();
    }

    return storedProposal;
}

// Put the cadastral ground under a proposal's footprint on the map, so the publish gate measures
// against what EXISTS rather than against what happens to be in view. Best-effort: a failed fetch
// leaves the gate to refuse on its own terms, which is the honest outcome — never a reason to
// publish something whose ground could not be established.
async function ensurePublishGroundLoaded(proposal) {
    try {
        const ground = getServerSyncGroundService();
        if (!ground || typeof ground.ensureProposalGround !== 'function') {
            throw new Error('Cadastral ground service is unavailable.');
        }
        await ground.ensureProposalGround([proposal], { purpose: 'publish' });
        return { ok: true };
    } catch (error) {
        console.warn('[uploadProposalToServer] could not load the ground under this proposal', error);
        return { ok: false, error };
    }
}

// How long until the write allowance comes back. The limiter is a FIXED window, not a rolling
// drain — the whole allowance returns at once — so "try again in N minutes" is a real instruction
// rather than an estimate. `RateLimit-Reset` is seconds-remaining (standardHeaders); `Retry-After`
// is the older spelling of the same thing. Neither being present is possible behind a proxy that
// strips them, hence the honest null.
function rateLimitRetrySeconds(response) {
    const read = name => {
        const raw = response && response.headers && response.headers.get ? response.headers.get(name) : null;
        // Number(null) is 0, so converting first turns a MISSING header into "wait zero seconds" —
        // which also swallowed the Retry-After fallback, since Reset always "answered" first.
        if (typeof raw !== 'string' || raw.trim() === '') return null;
        const value = Number(raw);
        return (Number.isFinite(value) && value >= 0) ? value : null;
    };
    const reset = read('RateLimit-Reset');
    if (reset !== null) return reset;
    return read('Retry-After');
}

// i18n.t is translate(key, params) — there is no fallback argument, and a missing key comes back as
// the key itself. So the lookup is done and then checked: a returned key means no translation, and
// the English sentence built here is used instead.
function uploadRateLimitMessage(retryAfterSeconds) {
    const known = retryAfterSeconds !== null && retryAfterSeconds !== undefined;
    const minutes = known ? Math.max(1, Math.ceil(retryAfterSeconds / 60)) : null;
    // A CLOCK TIME, not only a duration. "In about 5 minutes" starts counting from whenever you
    // happened to read it, so after stepping away it says nothing; a time of day is still true ten
    // minutes later. Both are given, because a duration is what you want when it is seconds away.
    let at = null;
    if (known) {
        try {
            const when = new Date(Date.now() + retryAfterSeconds * 1000);
            at = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        } catch (_) { at = null; }
    }
    const key = at
        ? 'proposalDrafts.uploadRateLimitedAt'
        : (known ? 'proposalDrafts.uploadRateLimitedIn' : 'proposalDrafts.uploadRateLimited');
    const fallback = at
        ? `Too many uploads for now. You can upload the rest at ${at}, in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
        : (known
            ? `Too many uploads for now. Try the rest in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
            : 'Too many uploads for now. Wait a few minutes and upload the rest.');
    try {
        if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function') {
            const translated = window.i18n.t(key, known ? { minutes, count: minutes, at: at || '' } : {});
            if (translated && translated !== key) return translated;
        }
    } catch (_) { /* fall through to English */ }
    return fallback;
}

async function uploadProposalToServer(proposal) {
    // Publish measures the footprint against the cadastre the browser has LOADED, and refuses below
    // 95%. That is the right question and the wrong source: pan away from a road and its parcels
    // are no longer on the map, so a perfectly publishable proposal was refused for having been
    // scrolled past. Apply stopped depending on that when it started asking CadastralParcelRepository
    // for the ground under a footprint; publish asks the same service here before the gate runs.
    //
    // Ground that is genuinely absent — an existing street with no cadastral parcel under it — is
    // still absent after the fetch, and the gate still refuses it. That refusal is correct.
    const ground = await ensurePublishGroundLoaded(proposal);

    let uploadProposal;
    try {
        uploadProposal = buildUploadReadyProposal(proposal);
    } catch (gateError) {
        // The §15a publish gate refused — a non-flat record is the author's error to see, not
        // something to heal into shape.
        //
        // But "the cadastre covers only N% of this footprint" has two very different causes, and
        // the number alone cannot tell them apart: ground that is genuinely absent, or ground the
        // browser failed to FETCH. A swallowed fetch failure reads as the first and sends the
        // author looking for a hole in their road that is not there.
        if (gateError && gateError.code === 'cadastre-coverage-insufficient') {
            if (ground && !ground.ok) {
                const detail = (ground.error && ground.error.message) ? ` (${ground.error.message})` : '';
                return {
                    ok: false,
                    message: `${gateError.message} The cadastre under this proposal could not be loaded${detail}`
                        + ', so this is a loading failure rather than missing ground. Try again.'
                };
            }
            // A percentage cannot be argued with. Name the command that paints the missing ground.
            const id = proposal && (proposal.proposalId || proposal.id);
            return {
                ok: false,
                message: `${gateError.message} Run whereIsThePublishGap('${id}') in the console to see the holes on the map.`
            };
        }
        return { ok: false, message: gateError.message || 'This proposal cannot be published.' };
    }
    if (!uploadProposal) {
        return { ok: false, message: 'Invalid proposal.' };
    }

    const backendBase = resolveBackendBaseUrl();
    try {
        const response = await fetch(`${backendBase}/proposals/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(uploadProposal)
        });

        let errorBody = null;
        if (!response.ok) {
            try { errorBody = await response.json(); } catch (_) { }

            if (response.status === 409 && errorBody && errorBody.id) {
                const serverProposalId = errorBody.id ? String(errorBody.id) : (errorBody.proposalId ? String(errorBody.proposalId) : null);
                if (serverProposalId) {
                    syncProposalWithServerId(proposal, serverProposalId);
                }
                return { ok: true, id: errorBody.id, proposalId: serverProposalId || errorBody.id };
            }

            // A refused-for-now is not a refused-for-good, and the server says exactly when. Without
            // this the author gets the same red "failed" line as a broken proposal would produce,
            // once per remaining proposal, and nothing tells them waiting is the answer.
            if (response.status === 429) {
                return {
                    ok: false,
                    retryAfterSeconds: rateLimitRetrySeconds(response),
                    message: uploadRateLimitMessage(rateLimitRetrySeconds(response))
                };
            }

            const errorMessage = errorBody && errorBody.error
                ? errorBody.error
                : 'Failed to upload proposal. Please try again.';
            return { ok: false, message: errorMessage };
        }

        const result = await response.json();
        const serverProposalId = result && result.id ? String(result.id) : String(result.proposalId);
        syncProposalWithServerId(proposal, serverProposalId);
        return { ok: true, id: result.id, proposalId: serverProposalId };
    } catch (error) {
        console.error('uploadProposalToServer failed', error);
        return { ok: false, message: error.message || 'Upload failed.' };
    }
}

async function headProposalExists(proposalId, _city, proposalForSync) {
    if (!proposalId) return false;
    const backendBase = resolveBackendBaseUrl();
    const id = String(proposalId).trim();
    const isNumericId = /^\d+$/.test(id);

    const url = `${backendBase}/proposals/${encodeURIComponent(id)}`;

    try {
        const response = await fetch(url, { method: isNumericId ? 'HEAD' : 'GET' });
        if (response.ok) {
            if (!isNumericId && proposalForSync) {
                try {
                    const payload = await response.clone().json();
                    const serverDbId = payload && payload.id ? String(payload.id) : null;
                    if (serverDbId && !isLocalProposalId(serverDbId)) {
                        syncProposalWithServerId(proposalForSync, serverDbId);
                    }
                } catch (_) { /* ignore json parse */ }
            }
            return true;
        }
        if (response.status === 404) return false;
    } catch (error) {
        console.warn('headProposalExists failed', error);
    }
    return false;
}

async function preloadProposalParcelOwners(parcelIds, options = {}) {
    if (!Array.isArray(parcelIds) || parcelIds.length === 0) {
        return;
    }
    if (typeof ensureParcelOwnerSlots !== 'function') {
        return;
    }
    const forceRefresh = options && options.forceRefresh === true;
    const uniqueIds = Array.from(new Set(
        parcelIds
            .map(id => (id && id.toString ? id.toString() : id))
            .filter(Boolean)
    ));
    if (!uniqueIds.length) {
        return;
    }

    await Promise.allSettled(uniqueIds.map(async parcelId => {
        try {
            await ensureParcelOwnerSlots(parcelId, { forceRefresh });
        } catch (error) {
            console.warn('preloadProposalParcelOwners: failed to fetch owners for', parcelId, error);
        }
    }));
}

function prepareProposalForImport(sharedProposal) {
    if (!sharedProposal || typeof sharedProposal !== 'object') return null;
    const inferredGoal = (() => {
        try {
            const explicit = normalizeProposalGoalKey(sharedProposal.goal);
            if (explicit) return explicit;
            if (sharedProposal.decideLaterProposal) return 'decide-later';
            if (sharedProposal.roadProposal) return 'road-track';
            if (sharedProposal.reparcellization) return 'reparcellization';
            if (sharedProposal.structureProposal && sharedProposal.structureProposal.kind) {
                const kind = normalizeProposalGoalKey(sharedProposal.structureProposal.kind);
                if (kind === 'park' || kind === 'square' || kind === 'lake' || kind === 'station') return kind;
            }
            if (sharedProposal.buildingProposal || (sharedProposal.geometry && Array.isArray(sharedProposal.geometry.buildings) && sharedProposal.geometry.buildings.length)) {
                return 'buildings';
            }
            return 'parcel';
        } catch (_) {
            return 'parcel';
        }
    })();
    const depthApi = (typeof window !== 'undefined' && window.__formationDepth)
        ? window.__formationDepth
        : (typeof require === 'function' ? require('./formation-depth.js') : null);
    if (!depthApi || typeof depthApi.stripDerivedRecordData !== 'function'
        || typeof depthApi.conformanceOf !== 'function') {
        throw new Error('Cannot import proposal: the flat-record gate is unavailable.');
    }
    // Import is intentionally boring: the API already serves the canonical authored record.
    // Reconstructing legacy parent/block/child fields here would make transport depend on one
    // browser's materialized parcel ids again. Old rows are handled once by the DB migration.
    const candidate = deepClone(sharedProposal);
    const serverId = sharedProposal.id || sharedProposal.proposalId || sharedProposal.proposal_id;
    candidate.proposalId = sharedProposal.proposalId || sharedProposal.proposal_id || sharedProposal.id || null;
    candidate.serverProposalId = (serverId && /^\d+$/.test(String(serverId)))
        ? String(serverId)
        : (sharedProposal.serverProposalId || null);
    candidate.goal = inferredGoal;
    candidate.lifecycleStatus = getLifecycleStatus(sharedProposal);
    candidate.acceptedParcelIds = ensureArrayOfStrings(sharedProposal.acceptedParcelIds);
    candidate.createdAt = sharedProposal.createdAt || new Date().toISOString();
    candidate.updatedAt = sharedProposal.updatedAt || candidate.createdAt;
    const lensEntries = normalizeLensEntries(
        sharedProposal.lens || sharedProposal.lensEntries || sharedProposal.lensAddresses
    );
    if (lensEntries.length) candidate.lens = lensEntries;

    const verdict = depthApi.conformanceOf(candidate);
    const invalid = typeof depthApi.findNonCadastralReference === 'function'
        ? depthApi.findNonCadastralReference(candidate)
        : null;
    if (invalid) {
        verdict.flat = false;
        verdict.violations.push({
            code: 'non-cadastral-reference',
            field: invalid.path,
            id: invalid.id
        });
    }
    if (!verdict.flat) {
        const detail = verdict.violations
            .map(item => item.code + (item.field ? ` (${item.field})` : '') + (item.id ? `: ${item.id}` : ''))
            .join('; ');
        throw new Error(`Cannot import non-conforming proposal; run migrate-tessellation.js first: ${detail}`);
    }
    const stripped = depthApi.stripDerivedRecordData(candidate);
    return parkProposalForImport(stripped);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        buildCityQueryParam,
        normalizeServerProposalSummary,
        prepareProposalForImport,
        rateLimitRetrySeconds,
        uploadRateLimitMessage
    };
}
