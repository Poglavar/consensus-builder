// Apartment rounds: the reservation state of each whole apartment a crowdfunding agreement offers,
// as Solana records it (proposal_pledge ApartmentUnit accounts), and the round's counts. A reserved
// apartment has a paid reservation deposit; it is not sold. The pure model is shared by the funding
// section of the agreement panel and the X-ray apartment panel; the browser part draws the stats
// block, the legend and the state badges, and reads the rounds offering a building's apartments.
// docs/developer-crowdfunding.md, "Apartment reservations".
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && root.document) root.ApartmentRound = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    // ---- pure model --------------------------------------------------------------------------------

    // Display states, strongest first: a unit offered by several rounds shows its strongest.
    const STATES = Object.freeze(['reserved', 'available', 'unavailable']);

    /**
     * A chain listing status ('reserved' | 'available' | 'unavailable' | 'unlisted', from
     * SolanaPledgeClient.readApartmentInventory) as a display state and the reason a unit cannot be
     * reserved: 'closed' (listed, but the round no longer accepts reservations), 'heldElsewhere'
     * (reserved in another round) or 'unlisted' (awaiting the developer's listing).
     */
    function unitState(status, accepting) {
        if (status === 'reserved') return { state: 'reserved', reason: null };
        if (status === 'available') return accepting ? { state: 'available', reason: null } : { state: 'unavailable', reason: 'closed' };
        if (status === 'unavailable') return { state: 'unavailable', reason: 'heldElsewhere' };
        return { state: 'unavailable', reason: 'unlisted' };
    }

    /** The storey level of an X-ray unit address ("level::unit[::proof]"), or null. */
    function levelOf(unitLocator) {
        const level = Number(String(unitLocator || '').split('::')[0]);
        return Number.isSafeInteger(level) ? level : null;
    }

    const tally = () => ({ offered: 0, reserved: 0, available: 0, unavailable: 0 });

    /**
     * One round's apartments and counts. `inventory` is the chain read (null while it is unread: the
     * units then have no state and count only as offered); `accepting` is whether the round still
     * takes reservations (active on chain and before its deadline).
     */
    function roundView({ cid = null, title = null, city = null, funding, inventory = null, accepting = false }) {
        const offered = funding?.apartments?.units || [];
        const read = Array.isArray(inventory);
        const buildings = [...new Set(offered.map(unit => unit.xrayBuilding))];
        const units = offered.map(unit => {
            const row = read ? inventory.find(item => item.unitId === unit.unitId) : null;
            const { state, reason } = read ? unitState(row?.status, accepting) : { state: null, reason: null };
            return {
                unitId: unit.unitId, label: unit.label, xrayBuilding: unit.xrayBuilding, unit: unit.unit,
                building: buildings.indexOf(unit.xrayBuilding) + 1, level: levelOf(unit.unit),
                priceUsdcAtomic: unit.priceUsdcAtomic, depositUsdcAtomic: unit.depositUsdcAtomic,
                state, reason, buyer: state === 'reserved' ? row.buyer || null : null
            };
        });
        const counts = tally();
        const floors = new Map();
        let reservedDeposits = 0n;
        for (const unit of units) {
            const key = `${unit.building}:${unit.level}`;
            if (!floors.has(key)) floors.set(key, { building: unit.building, level: unit.level, ...tally() });
            for (const bucket of [counts, floors.get(key)]) {
                bucket.offered += 1;
                if (unit.state) bucket[unit.state] += 1;
            }
            if (unit.state === 'reserved') reservedDeposits += BigInt(unit.depositUsdcAtomic);
        }
        const target = BigInt(funding?.targetUsdcAtomic || 0);
        return {
            cid, title, city, accepting, read, units, counts, buildings: buildings.length,
            floors: [...floors.values()].sort((a, b) => a.building - b.building || (a.level ?? 0) - (b.level ?? 0)),
            reservedDeposits, target,
            // Whole percent of the target the reserved deposits cover (floored; above 100 when exceeded).
            percent: target > 0n ? Number(reservedDeposits * 100n / target) : null
        };
    }

    /**
     * The state of each apartment of one X-ray building across the rounds offering it, keyed by the
     * unit address: { state, reason, round, unit }. The strongest state wins (reserved, then
     * available); a tie keeps the earlier round (the index lists the newest first). A unit no round
     * offers is absent (not offered).
     */
    function buildingStates(rounds, xrayBuilding) {
        const states = new Map();
        for (const round of rounds) {
            for (const unit of round.units) {
                if (unit.xrayBuilding !== xrayBuilding || !unit.state) continue;
                const previous = states.get(unit.unit);
                if (!previous || STATES.indexOf(unit.state) < STATES.indexOf(previous.state)) {
                    states.set(unit.unit, { state: unit.state, reason: unit.reason, round, unit });
                }
            }
        }
        return states;
    }

    /**
     * Items whose text (textOf) contains the query from the start of a word, case-insensitively and
     * ignoring punctuation between words: "floor 3" finds Floor 3, not apartment 203 on floor 2.
     */
    function filterUnits(items, query, textOf) {
        const words = text => String(text || '').toLocaleLowerCase().split(/[\s·,;()]+/).filter(Boolean).join(' ');
        const phrase = words(query);
        if (!phrase) return items.slice();
        return items.filter(item => ` ${words(textOf(item))}`.includes(` ${phrase}`));
    }

    const floorOf = level => (Number.isSafeInteger(level) ? level : null);

    /**
     * The building overview: one row per floor, the top floor first, then the units without a floor
     * (floor null); within a floor the cells keep their order. Each cell is { key, unitId, label,
     * ordinal, floor, state, reason }: `key` is the X-ray unit address. From a round, `units` are
     * roundView().units (several buildings give rows per building, the first building first). In
     * X-ray, `apartments` ([{ key, level, ordinal }]) lists every apartment of the building in
     * ordinal order and `states` is buildingStates(): an apartment no round offers is 'not-offered',
     * and an offered unit the layout no longer has keeps a cell on its own floor.
     */
    function overviewRows({ units = [], apartments = null, states = null } = {}) {
        let cells;
        if (apartments) {
            const offered = states || new Map();
            const keys = new Set(apartments.map(apartment => apartment.key));
            cells = [...apartments].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)).map(apartment => {
                const known = offered.get(apartment.key);
                return { key: apartment.key, unitId: known?.unit.unitId ?? null, label: known?.unit.label ?? null, ordinal: apartment.ordinal ?? null,
                    building: 1, floor: floorOf(apartment.level), state: known?.state ?? 'not-offered', reason: known?.reason ?? null };
            });
            for (const [key, known] of offered) {
                if (!keys.has(key)) cells.push({ key, unitId: known.unit.unitId, label: known.unit.label, ordinal: null,
                    building: 1, floor: floorOf(known.unit.level), state: known.state, reason: known.reason });
            }
        } else {
            cells = units.map(unit => ({ key: unit.unit ?? null, unitId: unit.unitId, label: unit.label, ordinal: null,
                building: unit.building ?? 1, floor: floorOf(unit.level), state: unit.state ?? null, reason: unit.reason ?? null }));
        }
        const rows = new Map();
        for (const { building, ...cell } of cells) {
            const id = `${building}:${cell.floor}`;
            if (!rows.has(id)) rows.set(id, { building, floor: cell.floor, cells: [] });
            rows.get(id).cells.push(cell);
        }
        return [...rows.values()].sort((a, b) => a.building - b.building
            || (a.floor === null) - (b.floor === null) || (b.floor ?? 0) - (a.floor ?? 0));
    }

    /** The short visible label of an overview cell: its apartment number in X-ray, else the last word of its label. */
    function cellText(cell) {
        if (cell.ordinal !== null && cell.ordinal !== undefined) return String(cell.ordinal);
        return String(cell.label || cell.unitId || '').split(/[\s·]+/).filter(Boolean).pop() || '';
    }

    const model = { STATES, unitState, levelOf, roundView, buildingStates, filterUnits, overviewRows, cellText };
    if (!root || !root.document) return { model };

    // ---- browser -------------------------------------------------------------------------------------

    const doc = root.document;
    const formatUsdc = atomic => root.AgreementRecord.formatUsdc(BigInt(atomic));
    const text = (t, key, fallback, params) => t(`agreement.funding.apartments.${key}`, fallback, params);
    function el(tag, className, content) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (content !== undefined) node.textContent = content;
        return node;
    }

    const BADGE_TONES = { reserved: 'warning', available: 'success', unavailable: 'neutral' };
    // The X-ray paints each state in a map state colour, as the legend swatches do (css/agreement.css);
    // the map roles stay the same in both themes, so they read against the light floor plans.
    const STATE_COLOR_TOKENS = { reserved: '--cb-map-state-application', available: '--cb-map-state-free', unavailable: '--cb-map-state-stopped' };
    function stateColor(state) {
        return root.getComputedStyle(doc.documentElement).getPropertyValue(STATE_COLOR_TOKENS[state]).trim() || null;
    }

    /** The words for a unit's state: "Reserved", "Available", or why it cannot be reserved. */
    function stateLabel(unit, t) {
        if (unit.state === 'reserved') return text(t, 'taken', 'Reserved');
        if (unit.state === 'available') return text(t, 'available', 'Available');
        if (unit.reason === 'closed') return text(t, 'closed', 'Round closed');
        if (unit.reason === 'heldElsewhere') return text(t, 'heldElsewhere', 'Reserved in another round');
        if (unit.reason === 'unlisted') return text(t, 'unlisted', 'Awaiting developer listing');
        return text(t, 'notOffered', 'Not offered');
    }

    function stateBadge(unit, t) {
        const badge = el('span', `cb-badge cb-badge--${BADGE_TONES[unit.state] || 'neutral'}`, stateLabel(unit, t));
        badge.dataset.apartmentState = unit.state || 'not-offered';
        return badge;
    }

    function floorLabel(floor, view, t) {
        return view.buildings > 1 ? text(t, 'buildingFloor', 'Building {{building}} · floor {{level}}', floor)
            : t('threeMode.controls.floorLevel', 'Floor {{level}}', floor);
    }

    function swatch(state) {
        const mark = el('span', `apartment-round-swatch apartment-round-swatch--${state}`);
        mark.setAttribute('aria-hidden', 'true');
        return mark;
    }

    /** The key of the apartment states' colours and marks; `offeredOnly` leaves out Not offered (a round's own list). */
    function legendView(t, { offeredOnly = false } = {}) {
        const list = el('ul', 'apartment-round-legend');
        list.setAttribute('aria-label', text(t, 'legend', 'Apartment states'));
        const states = [['reserved', text(t, 'taken', 'Reserved')], ['available', text(t, 'available', 'Available')],
            ['unavailable', text(t, 'notAvailable', 'Not available')], ['not-offered', text(t, 'notOffered', 'Not offered')]];
        for (const [state, label] of offeredOnly ? states.slice(0, 3) : states) {
            const item = el('li');
            item.append(swatch(state), doc.createTextNode(label));
            list.append(item);
        }
        return list;
    }

    /**
     * The stats block of one round: counts by state, the reserved deposits against the funding
     * target and the per-floor breakdown. `heading` names the round (a node or text) when shown
     * outside its agreement.
     */
    function statsView(view, t, { heading = null } = {}) {
        const section = el('section', 'apartment-round-stats');
        section.dataset.apartmentRoundStats = view.cid || '';
        const title = el('h5', 'apartment-round-stats__title');
        title.append(heading || text(t, 'statsTitle', 'Apartment reservations'));
        title.id = `apartment-round-stats-${Math.random().toString(36).slice(2)}`;
        section.setAttribute('aria-labelledby', title.id);
        section.append(title);
        const counts = el('dl', 'apartment-round-stats__counts');
        const count = (state, label, value) => {
            const row = el('div');
            const term = el('dt');
            if (state) term.append(swatch(state));
            term.append(doc.createTextNode(label));
            row.append(term, el('dd', null, String(value)));
            counts.append(row);
        };
        count(null, text(t, 'offered', 'Offered'), view.counts.offered);
        if (view.read) {
            count('reserved', text(t, 'taken', 'Reserved'), view.counts.reserved);
            count('available', text(t, 'available', 'Available'), view.counts.available);
            count('unavailable', text(t, 'notAvailable', 'Not available'), view.counts.unavailable);
        }
        section.append(counts);
        if (view.read) {
            const target = formatUsdc(view.target), reserved = formatUsdc(view.reservedDeposits);
            // A round's target is always positive (AgreementRecord.fundingError).
            section.append(el('p', 'apartment-round-stats__deposits', text(t, 'depositsReserved',
                'Reserved deposits: {{reserved}} of {{target}} devnet USDC ({{percent}}% of the target)', { reserved, target, percent: view.percent ?? 0 })));
            section.append(el('p', 'agreement-panel-hint', text(t, 'reservedMeaning', 'A reserved apartment has a paid reservation deposit. It is not sold.')));
        }
        if (view.read && view.floors.length > 1) {
            const details = el('details', 'apartment-round-stats__floors');
            details.append(el('summary', 'cb-link', text(t, 'byFloor', 'By floor')));
            const table = el('table', 'apartment-round-stats__table');
            const head = el('tr');
            for (const label of [text(t, 'floorColumn', 'Floor'), text(t, 'offered', 'Offered'), text(t, 'taken', 'Reserved'), text(t, 'available', 'Available')]) {
                const cell = el('th', null, label);
                cell.scope = 'col';
                head.append(cell);
            }
            const body = el('tbody');
            for (const floor of view.floors) {
                const row = el('tr');
                const name = el('th', null, floorLabel(floor, view, t));
                name.scope = 'row';
                row.append(name, el('td', null, String(floor.offered)), el('td', null, String(floor.reserved)), el('td', null, String(floor.available)));
                body.append(row);
            }
            const thead = el('thead');
            thead.append(head);
            table.append(thead, body);
            details.append(table);
            section.append(details);
        }
        return section;
    }

    /**
     * The building overview (overviewRows): one row per floor, the top floor first, and one button
     * per apartment in its state's colour and mark (css/agreement.css), named with its floor,
     * apartment and state. The rows scroll inside the chart. One cell holds the Tab stop (`current`,
     * else `selected`, else the first) and the arrow keys, Home and End move between cells.
     * `selected` is marked as the current apartment; `onPick(cell)` runs when a cell is pressed.
     */
    function overviewView(rows, t, { buildings = 1, selected = null, current = null, onPick }) {
        const section = el('section', 'apartment-round-overview');
        section.dataset.apartmentOverview = '';
        const title = el('h5', 'apartment-round-overview__title', text(t, 'overview', 'Building overview'));
        title.id = `apartment-round-overview-${Math.random().toString(36).slice(2)}`;
        section.setAttribute('aria-labelledby', title.id);
        // Always shown, below the rows: revealing it on focus moved the cells under the pointer between
        // press and release (a lost click). It is also the section's description for screen readers.
        const keys = el('p', 'apartment-round-overview__keys', text(t, 'overviewKeys', 'Arrow keys move between apartments.'));
        keys.id = `${title.id}-keys`;
        section.setAttribute('aria-describedby', keys.id);
        const floors = el('div', 'apartment-round-overview__floors');
        floors.dataset.apartmentOverviewFloors = '';
        // The model view's keyboard routing lets the arrow keys, Home and End through to this chart.
        floors.dataset.arrowKeys = '';
        const grid = [];
        for (const row of rows) {
            const line = el('div', 'apartment-round-overview__floor');
            line.setAttribute('role', 'group');
            const name = el('span', 'apartment-round-overview__level', row.floor === null ? text(t, 'overviewNoFloor', 'Floor unknown')
                : floorLabel({ building: row.building, level: row.floor }, { buildings }, t));
            name.id = `${title.id}-${grid.length}`;
            line.setAttribute('aria-labelledby', name.id);
            const cells = el('div', 'apartment-round-overview__cells');
            const buttons = row.cells.map(cell => {
                const button = el('button', `apartment-round-cell apartment-round-cell--${cell.state || 'unread'}`, model.cellText(cell));
                button.type = 'button';
                button.tabIndex = -1;
                button.dataset.apartmentOverviewCell = cell.key ?? cell.unitId;
                button.dataset.apartmentRoundFocus = `cell-${cell.key ?? cell.unitId}`;
                button.dataset.apartmentState = cell.state || '';
                const place = cell.ordinal !== null ? t('threeMode.controls.apartmentOption', `Floor ${cell.floor} · Apartment ${cell.ordinal}`,
                    { level: cell.floor, number: cell.ordinal }) : name.textContent;
                const label = [place, cell.label, cell.state ? stateLabel(cell, t) : null].filter(Boolean).join(' · ');
                button.setAttribute('aria-label', label);
                button.title = label;
                if (selected !== null && button.dataset.apartmentOverviewCell === selected) button.setAttribute('aria-current', 'true');
                button.addEventListener('click', () => onPick?.(cell));
                return button;
            });
            cells.append(...buttons);
            line.append(name, cells);
            floors.append(line);
            grid.push(buttons);
        }
        const all = grid.flat();
        const stop = all.find(button => button.dataset.apartmentOverviewCell === current)
            || all.find(button => button.hasAttribute('aria-current')) || all[0];
        if (stop) stop.tabIndex = 0;
        // Roving Tab stop: the cell last focused keeps it.
        floors.addEventListener('focusin', event => {
            if (!all.includes(event.target)) return;
            all.forEach(button => { button.tabIndex = button === event.target ? 0 : -1; });
        });
        floors.addEventListener('keydown', event => {
            const at = all.indexOf(event.target);
            if (at < 0) return;
            const rowAt = grid.findIndex(buttons => buttons.includes(event.target));
            const column = grid[rowAt].indexOf(event.target);
            const inRow = offset => grid[rowAt + offset]?.[Math.min(column, grid[rowAt + offset].length - 1)];
            const next = { ArrowRight: all[at + 1], ArrowLeft: all[at - 1], ArrowUp: inRow(-1), ArrowDown: inRow(1),
                Home: grid[rowAt][0], End: grid[rowAt].at(-1) }[event.key];
            if (!(event.key in { ArrowRight: 1, ArrowLeft: 1, ArrowUp: 1, ArrowDown: 1, Home: 1, End: 1 })) return;
            // The chart owns these keys: no page scroll, no map or camera shortcut.
            event.preventDefault();
            event.stopPropagation();
            next?.focus();
        });
        section.append(title, floors, keys);
        return section;
    }

    /** Scrolls the overview's rows (not the page) so `cell` shows, keeping `scrollTop` otherwise. */
    function keepCellInView(section, cell, scrollTop = 0) {
        const floors = section?.querySelector('[data-apartment-overview-floors]');
        if (!floors) return;
        floors.scrollTop = scrollTop;
        if (!cell) return;
        const box = floors.getBoundingClientRect(), place = cell.getBoundingClientRect();
        if (place.top < box.top) floors.scrollTop -= box.top - place.top;
        else if (place.bottom > box.bottom) floors.scrollTop += place.bottom - box.bottom;
    }

    /**
     * A labelled search over `items` ([{ element, text }]): hides the elements that do not match and
     * announces how many are shown. Returns the field to place before the list.
     */
    function searchField(items, t) {
        const field = el('div', 'apartment-round-search');
        const label = el('label', null, text(t, 'search', 'Find an apartment'));
        const input = el('input');
        input.type = 'search';
        input.id = `apartment-round-search-${Math.random().toString(36).slice(2)}`;
        input.autocomplete = 'off';
        input.dataset.apartmentRoundSearch = '';
        label.htmlFor = input.id;
        const status = el('p', 'agreement-panel-hint apartment-round-search__count');
        status.setAttribute('role', 'status');
        input.addEventListener('input', () => {
            const shown = new Set(filterUnits(items, input.value, item => item.text));
            for (const item of items) item.element.hidden = !shown.has(item);
            status.textContent = input.value.trim()
                ? text(t, 'searchCount', '{{shown}} of {{total}} apartments shown', { shown: shown.size, total: items.length }) : '';
        });
        field.append(label, input, status);
        return field;
    }

    /** The words a unit row is found by: its label, unit ID, floor and state. */
    function searchText(unit, view, t) {
        return [unit.label, unit.unitId, floorLabel(unit, view, t), unit.state ? stateLabel(unit, t) : ''].join(' ');
    }

    // ---- the rounds offering one X-ray building's apartments -------------------------------------------

    const MAX_AGE_MS = 60000;
    const buildings = new Map(); // `${city}|${xrayBuilding}` → { status, rounds, failed, error, readAt, promise }

    async function readBuilding(city, xrayBuilding, found) {
        const params = new URLSearchParams({ city, xrayBuilding });
        const response = await root.fetch(`${root.getBackendBase()}/agreements/apartment-offers?${params}`, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const cids = [...new Set(((await response.json()).offers || []).map(row => row.cid))];
        if (!cids.length) return { rounds: [], failed: 0 };
        found();
        // The index only finds the rounds; their terms are checked against the CID and their state is
        // read from Solana (this module loads with the pledge program client: AgreementPanel.loadFundingScripts).
        const settled = await Promise.allSettled(cids.map(async cid => {
            const row = await root.AgreementSync.fetchAgreement(cid);
            const chain = await root.AgreementBridge.apartmentRound(row);
            if (!chain) return null;
            const accepting = chain.status === 'Active' && Math.floor(Date.now() / 1000) <= Number(chain.deadline);
            return roundView({ cid, title: row.content.title, city: row.content.city, funding: row.content.funding, inventory: chain.units, accepting });
        }));
        settled.filter(item => item.status === 'rejected').forEach(item => console.error(
            `[${new Date().toISOString()}] [ApartmentRound] reading an apartment round of ${xrayBuilding} failed`, item.reason));
        return {
            rounds: settled.filter(item => item.status === 'fulfilled' && item.value).map(item => item.value),
            failed: settled.filter(item => item.status === 'rejected').length
        };
    }

    /**
     * The rounds offering apartments of one X-ray building, from a cache read at most a minute ago:
     * { status: 'loading' | 'reading' | 'ready' | 'failed', rounds, failed, error }: 'reading' once
     * the index has named rounds whose state Solana is being asked for. A stale entry starts a new
     * read; each distinct onChange is called when it reaches 'reading' and when it settles.
     */
    function buildingRounds({ city, xrayBuilding, onChange = null }) {
        const key = `${city}|${xrayBuilding}`;
        let entry = buildings.get(key);
        if (!entry) {
            entry = { status: 'loading', rounds: [], failed: 0, error: null, readAt: 0, promise: null, listeners: new Set() };
            buildings.set(key, entry);
        }
        if (onChange && (entry.promise || Date.now() - entry.readAt >= MAX_AGE_MS)) entry.listeners.add(onChange);
        if (entry.promise || Date.now() - entry.readAt < MAX_AGE_MS) return entry;
        const notify = () => [...entry.listeners].forEach(listener => listener(entry));
        entry.promise = readBuilding(city, xrayBuilding, () => {
            if (entry.status !== 'ready') { entry.status = 'reading'; notify(); }
        }).then(result => Object.assign(entry, { status: 'ready', error: null }, result), error => {
            console.error(`[${new Date().toISOString()}] [ApartmentRound] reading the apartment rounds of ${xrayBuilding} failed`, error);
            Object.assign(entry, { status: entry.readAt ? entry.status : 'failed', error: error?.message || String(error) });
        }).finally(() => {
            entry.readAt = Date.now();
            entry.promise = null;
            notify();
            entry.listeners.clear();
        });
        return entry;
    }

    return { model, stateLabel, stateBadge, stateColor, legendView, statsView, overviewView, keepCellInView, searchField, searchText, buildingRounds };
});
