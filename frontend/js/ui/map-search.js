// ui/map-search.js — the map search box (omnibox) top-left, with the city chip: one input whose
// grouped, keyboard-navigable results cover cities (configured + the world coverage registry, "Use
// my location"), parcel ids (locateParcelById), proposals (GET /proposals/summary?q=), addresses
// (Photon geocoder) and commands (UiCommands). The decisions live in js/ui/search-model.js; this
// file only renders and wires them. window.MapSearch: initialize, focus, showCities, refreshChip, close.
(function (win) {
    'use strict';
    if (!win || !win.document) return;

    const doc = win.document;
    const Model = win.SearchModel;
    const RECENT_KEY = 'cb_map_search_recent';
    const PHOTON_URL = 'https://photon.komoot.io/api/';
    const PLACE_DEBOUNCE_MS = 350;
    const PROPOSAL_DEBOUNCE_MS = 250;
    const MOBILE_QUERY = '(max-width: 767px)';

    const state = {
        initialized: false,
        root: null,
        input: null,
        list: null,
        chip: null,
        chipIcon: null,
        chipLabel: null,
        chipShortLabel: null,
        query: '',
        mode: 'search',          // 'search' | 'cities' (the chip's city list)
        open: false,
        groups: [],
        selectable: [],
        activeIndex: -1,
        notes: new Map(),        // item key -> { kind: 'pending' | 'error' | 'info', text }
        proposals: { query: '', status: 'idle', items: [], timer: null, abort: null },
        places: { query: '', status: 'idle', items: [], timer: null, abort: null },
        coverage: null,
        coverageRequested: false,
        marker: null
    };

    const t = (key, fallback, params) => {
        const i18n = win.i18n;
        if (i18n && typeof i18n.t === 'function') {
            const value = i18n.t(key, params || {});
            if (value && value !== key) return value;
        }
        if (!params) return fallback;
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => (name in params ? params[name] : m));
    };

    const log = (...args) => console.info(`[${new Date().toISOString()}] [map-search]`, ...args);
    const isMobile = () => !!(win.matchMedia && win.matchMedia(MOBILE_QUERY).matches);
    const isMac = () => /Mac|iPhone|iPad/.test((win.navigator && (win.navigator.platform || win.navigator.userAgent)) || '');
    const paletteShortcut = () => (isMac() ? '⌘K' : 'Ctrl K');

    // ---- city data ----
    const manager = () => win.CityConfigManager || null;
    const currentCityId = () => (manager() ? manager().getCurrentCityId() : null);
    const shortCityLabel = label => String(label || '').split(',')[0].trim();
    const cityLabel = (id, fallback) => (id ? t(`city.labels.${id}`, fallback) : fallback);

    function configuredCities() {
        const m = manager();
        if (!m || typeof m.getAvailableCities !== 'function') return [];
        // The label in the UI language (city.labels.<id>); the configured English label stays an
        // alias, so "Belgrade" still finds Beograd in a Serbian UI.
        return m.getAvailableCities().map(config => ({
            id: config.id,
            label: cityLabel(config.id, config.label || config.id),
            aliases: config.label && cityLabel(config.id, config.label) !== config.label ? [config.label] : [],
            center: typeof m.getCityCenter === 'function' ? m.getCityCenter(config) : null,
            parcelSource: (config.parcels && config.parcels.source) || null
        }));
    }

    function cityCodeMap() {
        const m = manager();
        const out = {};
        if (!m || typeof m.getCityCodeForCityId !== 'function') return out;
        configuredCities().forEach(city => {
            const code = m.getCityCodeForCityId(city.id);
            if (code) out[code] = city.id;
        });
        return out;
    }

    // ---- recent searches (per browser; a convenience, so storage failures are ignored) ----
    function readRecent() {
        try {
            const parsed = JSON.parse(win.localStorage.getItem(RECENT_KEY) || '[]');
            return Model.pushRecent(parsed, '');
        } catch (_) {
            return [];
        }
    }

    function rememberQuery(query) {
        try {
            win.localStorage.setItem(RECENT_KEY, JSON.stringify(Model.pushRecent(readRecent(), query)));
        } catch (_) { /* private mode / blocked storage */ }
    }

    // ---- the temporary place marker ----
    function clearMarker() {
        if (state.marker && win.map && typeof win.map.removeLayer === 'function') win.map.removeLayer(state.marker);
        state.marker = null;
    }

    function dropMarker(lat, lon) {
        clearMarker();
        if (!win.L || !win.map) return;
        state.marker = win.L.circleMarker([lat, lon], {
            radius: 10, color: '#2563eb', weight: 3, fillColor: '#2563eb', fillOpacity: 0.2, interactive: false
        }).addTo(win.map);
    }

    function panTo(lat, lon, zoom) {
        if (!win.map || typeof win.map.setView !== 'function') throw new Error('MapSearch: the map is not ready');
        win.map.setView([lat, lon], zoom);
        dropMarker(lat, lon);
    }

    // ---- world coverage (lazy: only the search box and the globe need it) ----
    function ensureCoverage() {
        if (state.coverageRequested || !win.WorldCoverage || typeof win.WorldCoverage.load !== 'function') return;
        state.coverageRequested = true;
        win.WorldCoverage.load()
            .then(coverage => {
                state.coverage = coverage;
                if (state.open) render();
            })
            .catch(error => console.warn('[map-search] world coverage did not load; world places are left out', error));
    }

    function openWorldView(opts) {
        const shell = win.MapShell;
        if (shell && typeof shell.openWorldView === 'function') {
            close({ blur: true });
            shell.openWorldView(opts);
            return true;
        }
        return false;
    }

    // ---- result groups ----
    function item(spec) {
        const note = state.notes.get(spec.key);
        return Object.assign({ rank: 2, icon: 'fas fa-circle', sublabel: '' }, spec, note ? { note } : {});
    }

    function citiesGroup(query, withLocation) {
        const current = currentCityId();
        const items = Model.rankCities(query, configuredCities(), current).map(city => item({
            key: `city:${city.id}`,
            kind: 'city',
            rank: city.rank,
            icon: city.current ? 'fas fa-location-dot' : 'fas fa-city',
            label: city.label,
            sublabel: city.current
                ? t('mapSearch.currentCity', 'Current city')
                : t('mapSearch.switchCity', 'Opens this city (reloads the map)'),
            current: city.current,
            run: () => runCity(city.id)
        }));
        if (query && state.coverage) {
            state.coverage.searchPlaces(query, { limit: 4 })
                .filter(place => place.kind !== 'live-city')
                .forEach(place => items.push(item({
                    key: `world:${place.placeKey}`,
                    kind: 'world',
                    rank: (Model.matchRank(place.name, query) ?? 3) + 0.5,
                    icon: place.kind === 'country' ? 'fas fa-flag' : 'fas fa-earth-europe',
                    label: place.name,
                    sublabel: [place.kind === 'country' ? '' : place.country, t(`world.tier.${place.tier}.short`, place.tier)]
                        .filter(Boolean).join(' · '),
                    run: () => runWorldPlace(place)
                })));
        }
        if (withLocation) {
            items.unshift(item({
                key: 'city:locate-me',
                kind: 'locate-me',
                rank: 0,
                icon: 'fas fa-crosshairs',
                label: t('mapSearch.useMyLocation', 'Use my location'),
                sublabel: t('mapSearch.useMyLocationHint', 'Opens the city closest to you'),
                run: () => { close({ blur: true }); return manager().detectNearestCity(); }
            }));
        }
        return { id: 'cities', label: t('mapSearch.groups.cities', 'Cities'), items };
    }

    function parcelsGroup(query) {
        const m = manager();
        const config = m && typeof m.getCurrentCityConfig === 'function' ? m.getCurrentCityConfig() : {};
        let loadedIds = [];
        try {
            const snapshot = win.ParcelPresenter && typeof win.ParcelPresenter.snapshot === 'function' ? win.ParcelPresenter.snapshot() : null;
            loadedIds = snapshot && Array.isArray(snapshot.parcelIds) ? snapshot.parcelIds : [];
        } catch (error) {
            console.warn('[map-search] could not read the loaded parcel ids', error);
        }
        const candidates = Model.parcelIdCandidates(query, {
            cityId: currentCityId(),
            parcelSource: config && config.parcels ? config.parcels.source : null,
            loadedIds
        });
        const items = candidates.ids.map(id => item({
            key: `parcel:${id}`,
            kind: 'parcel',
            rank: 0,
            icon: 'fas fa-vector-square',
            label: id,
            sublabel: t('mapSearch.parcelHint', 'Find this parcel on the map'),
            run: () => runParcel(id)
        }));
        if (candidates.needsMunicipality) {
            items.push(item({
                key: 'parcel:needs-ko',
                kind: 'info',
                rank: 0,
                disabled: true,
                icon: 'fas fa-circle-info',
                label: t('mapSearch.parcelNeedsMunicipality', 'Add the cadastral municipality: HR-<number>-{{id}}', { id: query }),
                sublabel: t('mapSearch.parcelNeedsMunicipalityHint', 'Or move the map to where the parcel is, so its ids are loaded')
            }));
        }
        return { id: 'parcels', label: t('mapSearch.groups.parcels', 'Parcels'), items };
    }

    function statusOf(source, query, loadingText, errorText) {
        if (source.query !== query) return { kind: 'pending', text: loadingText };
        if (source.status === 'loading') return { kind: 'pending', text: loadingText };
        if (source.status === 'error') return { kind: 'error', text: errorText };
        return null;
    }

    function proposalsGroup(query) {
        const source = state.proposals;
        const current = currentCityId();
        const cityIds = configuredCities().map(city => city.id);
        const codes = cityCodeMap();
        const fresh = source.query === query ? source.items : [];
        const withCity = fresh.map(raw => Object.assign({}, raw, { cityId: Model.resolveProposalCityId(raw.city, cityIds, codes) }));
        const items = Model.rankProposals(withCity, current).map(raw => {
            const otherCity = raw.cityId && raw.cityId !== current;
            const id = String(raw.id ?? raw.proposalId);
            return item({
                key: `proposal:${id}`,
                kind: 'proposal',
                icon: 'fas fa-file-signature',
                label: raw.title || raw.name || t('mapSearch.untitledProposal', 'Proposal {{id}}', { id }),
                sublabel: [raw.author,
                    otherCity ? t('mapSearch.inCity', 'In {{city}}', { city: shortCityLabel(manager().getCityLabel(raw.cityId)) }) : '']
                    .filter(Boolean).join(' · '),
                run: () => runProposal(raw)
            });
        });
        const status = statusOf(source, query,
            t('mapSearch.proposalsLoading', 'Searching proposals…'),
            t('mapSearch.proposalsError', 'Could not search proposals'));
        return { id: 'proposals', label: t('mapSearch.groups.proposals', 'Proposals'), items, status: items.length ? null : status };
    }

    function placesGroup(query) {
        const source = state.places;
        const cities = configuredCities();
        const current = currentCityId();
        const fresh = source.query === query ? source.items : [];
        const items = fresh.map(place => {
            const coverageTier = state.coverage ? state.coverage.tierAt(place.lat, place.lon) : null;
            const where = Model.classifyPlaceLocation(place, cities, current, { liveCityId: coverageTier && coverageTier.cityId });
            let sublabel = place.context;
            if (where.kind === 'other-city') {
                sublabel = [t('mapSearch.openIn', 'Open in {{city}}', { city: shortCityLabel(where.city.label) }), place.context].filter(Boolean).join(' · ');
            } else if (where.kind === 'world') {
                const tier = coverageTier ? coverageTier.tier : null;
                sublabel = [place.context, t('mapSearch.outsideCities', 'Outside the app\'s cities'),
                    tier ? t(`world.tier.${tier}.short`, tier) : ''].filter(Boolean).join(' · ');
            }
            return item({
                key: `place:${place.key}`,
                kind: 'place',
                icon: where.kind === 'here' ? 'fas fa-location-dot' : (where.kind === 'other-city' ? 'fas fa-city' : 'fas fa-earth-europe'),
                label: place.name,
                sublabel,
                run: () => runPlace(place, where)
            });
        });
        const status = statusOf(source, query,
            t('mapSearch.placesLoading', 'Searching places…'),
            t('mapSearch.placesError', 'Could not reach the address search'));
        return {
            id: 'places',
            label: t('mapSearch.groups.places', 'Places'),
            items,
            status: items.length ? null : status,
            footer: t('mapSearch.attribution', '© OpenStreetMap contributors · Photon')
        };
    }

    function commandsGroup(query) {
        const commands = win.UiCommands;
        if (!commands) return { id: 'commands', items: [] };
        const ctx = commands.createBrowserContext(win);
        const tFn = key => (win.i18n && typeof win.i18n.t === 'function' ? win.i18n.t(key) : key);
        const ranked = commands.rankCommands(query, ctx, tFn).filter(entry => entry.available).slice(0, Model.GROUP_LIMITS.commands);
        const items = ranked.map(entry => item({
            key: `command:${entry.entry.id}`,
            kind: 'command',
            rank: entry.rank,
            icon: entry.entry.icon,
            label: entry.label,
            sublabel: '',
            run: () => runCommand(entry.entry.id)
        }));
        return { id: 'commands', label: t('mapSearch.groups.commands', 'Commands'), items };
    }

    function recentGroup() {
        const items = readRecent().map(text => item({
            key: `recent:${text}`,
            kind: 'recent',
            rank: 0,
            icon: 'fas fa-clock-rotate-left',
            label: text,
            run: () => setQuery(text)
        }));
        return { id: 'recent', label: t('mapSearch.groups.recent', 'Recent searches'), items };
    }

    function hintItem() {
        return item({
            key: 'hint:palette',
            kind: 'hint',
            icon: 'fas fa-terminal',
            label: t('mapSearch.commandsHint', 'Commands…'),
            shortcut: paletteShortcut(),
            run: () => {
                close({ blur: true });
                if (win.CommandPalette) win.CommandPalette.open();
            }
        });
    }

    function buildGroups() {
        const cls = Model.classifyQuery(state.query);
        let groups;
        if (state.mode === 'cities') {
            groups = [citiesGroup('', true)];
        } else if (cls.empty) {
            groups = Model.orderGroups([recentGroup(), citiesGroup('', true)]);
        } else if (cls.commandsOnly) {
            groups = Model.orderGroups([commandsGroup(cls.text)]);
        } else {
            const all = [];
            if (cls.kinds.includes('city')) all.push(citiesGroup(cls.text, false));
            if (cls.kinds.includes('parcel')) all.push(parcelsGroup(cls.text));
            if (cls.kinds.includes('proposal')) all.push(proposalsGroup(cls.text));
            if (cls.kinds.includes('address')) all.push(placesGroup(cls.text));
            if (cls.kinds.includes('command')) all.push(commandsGroup(cls.text));
            groups = Model.orderGroups(all);
        }
        groups.push({ id: 'hint', items: [hintItem()] });
        return groups;
    }

    // ---- fetching (debounced, aborted when superseded) ----
    function scheduleFetches() {
        const cls = Model.classifyQuery(state.query);
        const wantsProposals = state.mode === 'search' && cls.kinds.includes('proposal');
        const wantsPlaces = state.mode === 'search' && cls.kinds.includes('address');
        schedule(state.proposals, wantsProposals ? cls.text : '', PROPOSAL_DEBOUNCE_MS, fetchProposals);
        schedule(state.places, wantsPlaces ? cls.text : '', PLACE_DEBOUNCE_MS, fetchPlaces);
    }

    function schedule(source, query, delay, fetcher) {
        if (source.timer) win.clearTimeout(source.timer);
        source.timer = null;
        if (source.query === query && source.status !== 'idle') return;
        if (source.abort) source.abort.abort();
        source.abort = null;
        if (!query) {
            source.query = '';
            source.status = 'idle';
            source.items = [];
            return;
        }
        // Debounce: wait for typing to pause before asking a remote service.
        source.timer = win.setTimeout(() => {
            source.timer = null;
            const controller = new win.AbortController();
            source.abort = controller;
            source.query = query;
            source.status = 'loading';
            source.items = [];
            render();
            fetcher(query, controller.signal)
                .then(items => {
                    if (controller.signal.aborted) return;
                    source.items = items;
                    source.status = 'done';
                })
                .catch(error => {
                    if (controller.signal.aborted || (error && error.name === 'AbortError')) return;
                    console.warn(`[map-search] ${fetcher.name} failed for "${query}"`, error);
                    source.status = 'error';
                })
                .finally(() => {
                    if (source.abort === controller) source.abort = null;
                    if (!controller.signal.aborted) render();
                });
        }, delay);
    }

    async function fetchProposals(query, signal) {
        if (typeof win.getBackendBase !== 'function') throw new Error('getBackendBase() is not defined');
        const base = String(win.getBackendBase() || '').replace(/\/+$/, '');
        const url = `${base}/proposals/summary?q=${encodeURIComponent(query)}&limit=${Model.GROUP_LIMITS.proposals}`;
        const response = await win.fetch(url, { signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
        const payload = await response.json();
        return Array.isArray(payload && payload.proposals) ? payload.proposals : [];
    }

    async function fetchPlaces(query, signal) {
        const params = new win.URLSearchParams({ q: query, limit: '5' });
        const centre = win.map && typeof win.map.getCenter === 'function' ? win.map.getCenter() : null;
        if (centre) {
            params.set('lat', centre.lat.toFixed(5));
            params.set('lon', centre.lng.toFixed(5));
        }
        const lang = win.i18n && typeof win.i18n.getLanguage === 'function' ? win.i18n.getLanguage() : '';
        // Photon translates names only into a few languages; others get the local names.
        if (['en', 'de', 'fr'].includes(lang)) params.set('lang', lang);
        const response = await win.fetch(`${PHOTON_URL}?${params}`, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status} from Photon`);
        return Model.parsePhoton(await response.json());
    }

    // ---- running results ----
    function setNote(key, note) {
        if (note) state.notes.set(key, note);
        else state.notes.delete(key);
        render();
    }

    function runCity(cityId) {
        const m = manager();
        if (cityId === currentCityId()) {
            const config = m.getCurrentCityConfig();
            const centre = m.getCityCenter(config);
            close({ blur: true });
            if (centre && win.map) win.map.setView(centre, (config.map && config.map.defaultZoom) || win.map.getZoom());
            return;
        }
        // Each city keeps its own local store, so switching only costs a reload (no confirmation —
        // the same as the old city select).
        close({ blur: true });
        return m.switchCity(cityId, { requireConfirmation: false, clearRoute: true });
    }

    function runWorldPlace(place) {
        if (openWorldView({ focus: place })) return;
        setNote(`world:${place.placeKey}`, { kind: 'info', text: t(`world.tier.${place.tier}.text`, '') });
    }

    async function runParcel(id) {
        const key = `parcel:${id}`;
        if (typeof win.locateParcelById !== 'function') throw new Error('MapSearch: locateParcelById() is not defined');
        setNote(key, { kind: 'pending', text: t('sidebar.parcels.locateSearching', 'Searching…') });
        const result = await win.locateParcelById(id);
        if (result.ok) {
            state.notes.delete(key);
            log('located parcel', result.parcelId);
            close({ blur: true });
            return;
        }
        setNote(key, { kind: 'error', text: result.message || t('sidebar.parcels.locateNotFound', 'Parcel not found') });
    }

    // Open a server proposal the way the browse list does: the local copy if this browser holds
    // one, else download (after the same confirmation) and open it. A proposal in another city goes
    // through the shared-link path: /proposals/<id> in the URL and the city-mismatch prompt, which
    // reloads into that city keeping the path (or drops the path when the person stays).
    async function runProposal(raw) {
        const serverId = String(raw.id ?? raw.proposalId);
        const key = `proposal:${serverId}`;
        if (raw.cityId && raw.cityId !== currentCityId()) {
            close({ blur: true });
            const url = new win.URL(win.location.href);
            win.history.pushState(null, '', `/proposals/${encodeURIComponent(serverId)}${url.search}${url.hash}`);
            await win.promptCityMismatchForProposal(raw.cityId);
            return;
        }
        const summary = win.normalizeServerProposalSummary(raw, raw.city);
        let proposal = win.findLocalCopyOfServerProposal(summary);
        if (!proposal) {
            // The confirm takes over: close the box first, so focus leaves the input (a second
            // Enter would stack a second confirm) and the outcome is not written into a list that
            // the click on the confirm has already closed. Progress and failure go to the status.
            close({ blur: true });
            const confirmed = await win.showProposalDownloadConfirm();
            if (!confirmed) return;
            const status = text => { if (typeof win.updateStatus === 'function') win.updateStatus(text); };
            status(t('mapSearch.proposalDownloading', 'Downloading…'));
            try {
                proposal = await win.importServerProposal(summary.serverProposalId);
            } catch (error) {
                console.error('[map-search] could not download proposal', serverId, error);
                status(t('modal.roadWidth.proposalList.downloadError', 'Failed to download proposal'));
                return;
            }
            // A freshly downloaded proposal opens collapsed, as from the list.
            win.__openProposalDetailsCollapsed = true;
        }
        state.notes.delete(key);
        close({ blur: true });
        win.openProposalFromList(win.getProposalKey(proposal) || serverId, { proposal, closeSheets: true });
    }

    function runPlace(place, where) {
        const zoom = Model.placeZoom(place.type);
        if (where.kind === 'other-city') {
            close({ blur: true });
            // ?at= carries the place into the other city (js/map-core.js opens there).
            return manager().switchCity(where.city.id, {
                requireConfirmation: false, clearRoute: true, at: { lat: place.lat, lon: place.lon, zoom }
            });
        }
        // The explore city covers anywhere: a far place just pans, no globe needed.
        const exploring = manager() && typeof manager().isExplore === 'function' && manager().isExplore();
        if (where.kind === 'world' && !exploring && openWorldView({ focus: { lat: place.lat, lon: place.lon, name: place.name, zoom } })) return;
        close({ blur: true, keepMarker: true });
        panTo(place.lat, place.lon, zoom);
    }

    function runCommand(id) {
        close({ blur: true });
        const commands = win.UiCommands;
        commands.runCommand(id, commands.createBrowserContext(win));
    }

    function runItem(entry) {
        if (!entry || entry.disabled || typeof entry.run !== 'function') return;
        const typed = state.mode === 'search' ? state.query.trim() : '';
        if (typed && !['recent', 'hint'].includes(entry.kind)) rememberQuery(typed);
        if (entry.kind !== 'recent') clearMarker();
        Promise.resolve()
            .then(() => entry.run())
            .catch(error => {
                console.error(`[map-search] ${entry.kind} result failed`, entry.key, error);
                setNote(entry.key, { kind: 'error', text: (error && error.message) || String(error) });
                openList();
            });
    }

    // ---- DOM ----
    function el(tag, className, attrs) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (attrs) Object.keys(attrs).forEach(name => node.setAttribute(name, attrs[name]));
        return node;
    }

    function icon(className) {
        return el('i', className, { 'aria-hidden': 'true' });
    }

    function render() {
        if (!state.list) return;
        state.groups = state.open ? buildGroups() : [];
        state.selectable = Model.selectableItems(state.groups);
        if (state.activeIndex >= state.selectable.length) state.activeIndex = state.selectable.length - 1;
        const list = state.list;
        list.textContent = '';
        let optionIndex = 0;
        state.groups.forEach((group, groupIndex) => {
            const section = el('div', `map-search__group map-search__group--${group.id}`, { role: 'group' });
            if (group.label) {
                const headingId = `map-search-group-${groupIndex}`;
                const heading = el('div', 'map-search__group-title', { id: headingId });
                heading.textContent = group.label;
                section.setAttribute('aria-labelledby', headingId);
                section.appendChild(heading);
            }
            group.items.forEach(entry => {
                const selectableIndex = entry.disabled ? -1 : state.selectable.indexOf(entry);
                const option = el('div', `map-search__item map-search__item--${entry.kind}`, {
                    id: `map-search-option-${optionIndex++}`,
                    role: 'option',
                    'aria-selected': selectableIndex >= 0 && selectableIndex === state.activeIndex ? 'true' : 'false'
                });
                if (entry.disabled) option.setAttribute('aria-disabled', 'true');
                if (entry.current) option.classList.add('is-current');
                option.appendChild(icon(`map-search__item-icon ${entry.icon}`));
                const text = el('div', 'map-search__item-text');
                const label = el('div', 'map-search__item-label');
                label.textContent = entry.label;
                text.appendChild(label);
                if (entry.sublabel) {
                    const sub = el('div', 'map-search__item-sub');
                    sub.textContent = entry.sublabel;
                    text.appendChild(sub);
                }
                if (entry.note && entry.note.text) {
                    const note = el('div', `map-search__item-note map-search__item-note--${entry.note.kind}`, { role: entry.note.kind === 'error' ? 'alert' : 'status' });
                    note.textContent = entry.note.text;
                    text.appendChild(note);
                }
                option.appendChild(text);
                if (entry.shortcut) {
                    const kbd = el('kbd', 'map-search__shortcut');
                    kbd.textContent = entry.shortcut;
                    option.appendChild(kbd);
                }
                if (selectableIndex >= 0) {
                    option.addEventListener('mousedown', event => event.preventDefault());
                    option.addEventListener('mousemove', () => {
                        if (state.activeIndex !== selectableIndex) setActive(selectableIndex);
                    });
                    option.addEventListener('click', () => runItem(entry));
                }
                section.appendChild(option);
            });
            if (group.status) {
                const status = el('div', `map-search__status map-search__status--${group.status.kind}`, { role: 'status' });
                status.textContent = group.status.text;
                section.appendChild(status);
            }
            if (group.footer && (group.items.length || group.status)) {
                const footer = el('div', 'map-search__footer');
                footer.textContent = group.footer;
                section.appendChild(footer);
            }
            list.appendChild(section);
        });
        list.hidden = !state.open;
        state.input.setAttribute('aria-expanded', state.open ? 'true' : 'false');
        syncActiveDescendant();
    }

    function syncActiveDescendant() {
        const options = Array.from(state.list.querySelectorAll('[role="option"]:not([aria-disabled="true"])'));
        options.forEach((option, index) => option.setAttribute('aria-selected', index === state.activeIndex ? 'true' : 'false'));
        const active = options[state.activeIndex];
        if (active) {
            state.input.setAttribute('aria-activedescendant', active.id);
            try { active.scrollIntoView({ block: 'nearest' }); } catch (_) { }
        } else {
            state.input.removeAttribute('aria-activedescendant');
        }
    }

    function setActive(index) {
        state.activeIndex = index;
        syncActiveDescendant();
    }

    function openList() {
        state.open = true;
        state.root.classList.add('is-open');
        ensureCoverage();
        render();
    }

    function expand() {
        state.root.classList.add('is-expanded');
        doc.body.classList.add('map-search-expanded');
    }

    function close(options = {}) {
        state.open = false;
        state.mode = 'search';
        state.activeIndex = -1;
        if (!options.keepMarker && options.clearMarker) clearMarker();
        if (state.root) {
            state.root.classList.remove('is-open');
            if (options.blur) {
                state.root.classList.remove('is-expanded');
                doc.body.classList.remove('map-search-expanded');
                if (doc.activeElement === state.input) state.input.blur();
            }
        }
        render();
    }

    function setQuery(text) {
        state.input.value = text;
        onInput();
        state.input.focus();
    }

    function onInput() {
        const next = state.input.value;
        if (next !== state.query) {
            state.query = next;
            state.mode = 'search';
            state.notes.clear();
            clearMarker();
        }
        state.activeIndex = -1;
        state.clear.hidden = !state.query;
        scheduleFetches();
        openList();
    }

    function onKeyDown(event) {
        if (event.isComposing) return;
        if (!state.open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            openList();
            event.preventDefault();
            return;
        }
        const action = Model.keyAction(event.key, state.activeIndex, state.selectable.length);
        if (!action) return;
        if (action.type === 'move') {
            event.preventDefault();
            setActive(action.index);
        } else if (action.type === 'run') {
            event.preventDefault();
            runItem(state.selectable[action.index]);
        } else if (action.type === 'close') {
            event.preventDefault();
            event.stopPropagation();
            if (state.open) close({ clearMarker: true });
            else if (state.query) setQuery('');
            else close({ blur: true, clearMarker: true });
        }
    }

    function isTypingTarget(target) {
        if (!target) return false;
        if (target.isContentEditable) return true;
        const tag = (target.tagName || '').toLowerCase();
        if (tag === 'textarea' || tag === 'select') return true;
        if (tag !== 'input') return false;
        const type = (target.getAttribute('type') || 'text').toLowerCase();
        return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file', 'reset'].includes(type);
    }

    function onDocumentKeyDown(event) {
        if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
        if (isTypingTarget(event.target)) return;
        // Not under a modal, a confirm, the globe or the palette, and not in share-plan mode.
        if (win.sharePlanMode) return;
        if (win.MapShell && typeof win.MapShell.isBlockingDialogOpen === 'function' && win.MapShell.isBlockingDialogOpen()) return;
        event.preventDefault();
        focus();
    }

    function onDocumentPointerDown(event) {
        if (!state.root || state.root.contains(event.target)) return;
        if (state.open) close({ blur: isMobile() });
        else if (state.root.classList.contains('is-expanded') && doc.activeElement !== state.input) close({ blur: true });
    }

    function syncChip() {
        if (!state.chip) return;
        const m = manager();
        let label = m ? shortCityLabel(cityLabel(currentCityId(), m.getCityLabel(currentCityId()))) : '';
        let shortLabel = label;
        // Explore: "Explore · <place>" once the world view's coverage names the place (js/ui/world-entry.js).
        // Phones show only the compass and the place (css/map-search.css), so the name stays readable.
        const exploring = !!(m && typeof m.isExplore === 'function' && m.isExplore());
        if (exploring) {
            const place = win.WorldEntry && typeof win.WorldEntry.explorePlaceName === 'function' ? win.WorldEntry.explorePlaceName() : '';
            label = place ? t('world.explore.chip', 'Explore · {{place}}', { place }) : t('city.labels.explore', 'Explore');
            shortLabel = place || label;
        }
        state.chip.classList.toggle('is-explore', exploring);
        state.chipIcon.className = exploring ? 'fas fa-compass' : 'fas fa-city';
        state.chipLabel.textContent = label;
        state.chipShortLabel.textContent = shortLabel;
        const title = t('mapSearch.cityChip', 'Current city: {{city}}. Choose another', { city: label });
        state.chip.title = title;
        state.chip.setAttribute('aria-label', title);
    }

    function syncTexts() {
        if (!state.input) return;
        // Without a cadastre (explore) there are no parcels to find.
        const config = manager();
        const parcels = !(config && typeof config.hasParcelData === 'function') || config.hasParcelData();
        state.input.placeholder = parcels
            ? t('mapSearch.placeholder', 'Search places, parcels, proposals…')
            : t('mapSearch.placeholderNoParcels', 'Search places, proposals…');
        state.input.setAttribute('aria-label', t('mapSearch.label', 'Search the map'));
        state.searchButton.setAttribute('aria-label', t('mapSearch.open', 'Search'));
        state.searchButton.title = t('mapSearch.open', 'Search');
        state.clear.setAttribute('aria-label', t('mapSearch.clear', 'Clear'));
        state.clear.title = t('mapSearch.clear', 'Clear');
        state.back.setAttribute('aria-label', t('mapSearch.close', 'Close search'));
        state.back.title = t('mapSearch.close', 'Close search');
        syncChip();
        if (state.open) render();
    }

    function build(slot) {
        const root = el('div', 'map-search', { role: 'search' });
        const back = el('button', 'map-search__back', { type: 'button' });
        back.appendChild(icon('fas fa-arrow-left'));
        const chip = el('button', 'map-search__chip', { type: 'button' });
        const chipIcon = icon('fas fa-city');
        chip.appendChild(chipIcon);
        // The full label, and the short one phones show while exploring (the place, no prefix).
        const chipLabel = el('span', 'map-search__chip-label');
        chip.appendChild(chipLabel);
        const chipShortLabel = el('span', 'map-search__chip-label map-search__chip-label--short', { 'aria-hidden': 'true' });
        chip.appendChild(chipShortLabel);
        const field = el('div', 'map-search__field');
        const searchButton = el('button', 'map-search__icon-button', { type: 'button' });
        searchButton.appendChild(icon('fas fa-magnifying-glass'));
        const input = el('input', 'map-search__input', {
            id: 'map-search-input',
            type: 'text',
            role: 'combobox',
            autocomplete: 'off',
            spellcheck: 'false',
            'aria-autocomplete': 'list',
            'aria-expanded': 'false',
            'aria-controls': 'map-search-results'
        });
        const clear = el('button', 'map-search__clear', { type: 'button' });
        clear.appendChild(icon('fas fa-xmark'));
        clear.hidden = true;
        field.appendChild(searchButton);
        field.appendChild(input);
        field.appendChild(clear);
        const list = el('div', 'map-search__results', { id: 'map-search-results', role: 'listbox' });
        list.hidden = true;
        root.appendChild(back);
        root.appendChild(chip);
        root.appendChild(field);
        root.appendChild(list);
        slot.appendChild(root);
        Object.assign(state, { root, input, list, chip, chipIcon, chipLabel, chipShortLabel, clear, back, searchButton });

        input.addEventListener('focus', () => { expand(); openList(); });
        input.addEventListener('input', onInput);
        input.addEventListener('keydown', onKeyDown);
        searchButton.addEventListener('click', () => focus());
        clear.addEventListener('mousedown', event => event.preventDefault());
        clear.addEventListener('click', () => setQuery(''));
        back.addEventListener('click', () => close({ blur: true, clearMarker: true }));
        chip.addEventListener('click', () => {
            if (openWorldView({})) return;
            showCities();
        });
    }

    // ---- public API ----
    function focus() {
        if (!state.input) return;
        expand();
        state.input.focus();
        try { state.input.select(); } catch (_) { }
        openList();
    }

    // The city list, as the chip shows it when there is no world view to open.
    function showCities() {
        if (!state.input) return;
        expand();
        state.mode = 'cities';
        state.activeIndex = -1;
        state.input.focus();
        openList();
    }

    function initialize() {
        if (state.initialized) return;
        if (!Model) throw new Error('MapSearch: js/ui/search-model.js must load first');
        const slot = doc.getElementById('map-search-slot');
        if (!slot) throw new Error('MapSearch: #map-search-slot is missing');
        state.initialized = true;
        build(slot);
        syncTexts();
        doc.addEventListener('keydown', onDocumentKeyDown);
        doc.addEventListener('pointerdown', onDocumentPointerDown, true);
        // Texts follow the translations arriving after boot AND a live language switch (i18n.onChange;
        // translationsLoaded alone fires only once, when the locale files load).
        win.addEventListener('i18n:translationsLoaded', syncTexts);
        if (win.i18n && typeof win.i18n.onChange === 'function') win.i18n.onChange(syncTexts);
        win.addEventListener('cityChanged', syncChip);
    }

    win.MapSearch = { initialize, focus, showCities, refreshChip: () => syncChip(), close: () => close({ blur: true, clearMarker: true }) };
})(typeof window !== 'undefined' ? window : null);
