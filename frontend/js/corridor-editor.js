// The cross-section editor: add, remove, resize, retype and reorder the lanes of a corridor — a road or
// a track, which differ only in the lanes they are made of (a track is a corridor with a rail lane in it).
//
// THE LANE LIST IS THE ROAD. The total width shown at the top is a READOUT — the sum of the lanes —
// not a control: you widen a street by giving it another lane, and narrow it by taking one away. There
// is no width slider, and adding a lane can never fail for want of room (the old model paid for every
// edit out of the traffic lanes, and once they hit their minimum "Add lane" silently did nothing).
// The one hard limit left is CORRIDOR_EDITOR_MAX_WIDTH, and hitting it says so.
//
// Dragging a seam in the schematic is the one gesture that keeps the total: it moves width from one
// lane to its neighbour, so the footprint does not budge.
//
// The presets row stamps a whole standard cross-section (the same road classes the drawing width
// picker offers), which is the fast path: take a correct section, then tweak it.
//
// For a placed road the resulting footprint is checked live: hitting a NEW building blocks Apply —
// tunnels are only made while drawing — while crossing an applied park/square/lake merely lights an
// indicator (the structure is cut at render time).
//
// Local unminted roads take the change in place (footprint + parcel cuts rebuild on Apply); minted
// proposals are immutable and reopen as a drawing draft instead.

let corridorEditorState = null;
let corridorEditorObstacleTimer = null;

const CORRIDOR_EDITOR_MAX_WIDTH = 80; // the widest drawing preset (Boulevard)

function corridorEditorI18n(key, fallback, params = {}) {
    try {
        if (window.i18n && typeof window.i18n.t === 'function') {
            const translated = window.i18n.t(key, params);
            if (translated && translated !== key) return translated;
        }
    } catch (_) { }
    // The fallback carries the same placeholders as the translation, so it interpolates too.
    return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match
    ));
}

// The derived total, as text. Two decimals, trailing zeros dropped: lanes step in 25 cm, and rounding
// 27.25 m to "27.3 m" would show a total that is not the sum of the numbers printed underneath it.
function corridorEditorTotalText(width) {
    return `${Number(Number(width).toFixed(2))} m`;
}

// CORRIDOR_LANE_TYPES carries an English label because the model is shared with the 3D renderers;
// anything the editor shows to a user goes through here so it is translated.
function corridorLaneTypeLabel(type) {
    const laneType = CORRIDOR_LANE_TYPES[type] || {};
    return corridorEditorI18n(`modal.corridor.laneTypes.${type}`, laneType.label || type);
}

function corridorEditorClose() {
    if (typeof clearCorridorProfilePreview === 'function') clearCorridorProfilePreview();
    const overlay = document.getElementById('corridor-editor-overlay');
    if (overlay) overlay.remove();
    document.removeEventListener('keydown', corridorEditorKeydown);
    if (corridorEditorObstacleTimer) {
        clearTimeout(corridorEditorObstacleTimer);
        corridorEditorObstacleTimer = null;
    }
    corridorEditorState = null;
}

function corridorEditorCancel() {
    if (corridorEditorState && corridorEditorState.mode === 'drawing' && corridorEditorState.originalProfile
        && typeof setRoadDrawingProfile === 'function') {
        setRoadDrawingProfile(corridorEditorState.originalProfile);
    }
    corridorEditorClose();
}

function corridorEditorKeydown(event) {
    if (event.key === 'Escape') {
        event.preventDefault();
        corridorEditorCancel();
    }
}

// Apply an edit, or refuse it. `edit` returns a new profile or null; null means the edit was meaningless
// (a lane below its minimum, the last lane, an unknown type) and the right answer is to say so.
//
// The only other refusal is the hard width cap: the total is the sum of the lanes, so a widening edit
// cannot fail on room — it can only run past the widest corridor the app will draw, and then it must SAY
// so. A silent no-op here is the exact bug this editor was rebuilt to remove.
function corridorEditorApply(edit) {
    if (!corridorEditorState) return;
    const next = edit(corridorEditorState.profile);
    if (!next) {
        // Redraw from the model so the refused number does not sit in the input pretending to be real.
        corridorEditorState.notice = null;
        corridorEditorRender();
        corridorEditorFlashRefusal();
        return;
    }
    if (corridorProfileWidth(next) > CORRIDOR_EDITOR_MAX_WIDTH + 1e-6) {
        corridorEditorState.notice = corridorEditorI18n(
            'modal.corridor.maxWidthReached',
            'A corridor cannot be wider than {{max}} m. Remove or narrow a lane first.',
            { max: CORRIDOR_EDITOR_MAX_WIDTH }
        );
        corridorEditorRender();
        corridorEditorFlashRefusal();
        return;
    }
    corridorEditorState.notice = null;
    corridorEditorState.profile = next;
    corridorEditorState.dirty = true;
    if (corridorEditorState.mode === 'drawing' && typeof setRoadDrawingProfile === 'function') {
        setRoadDrawingProfile(next);
    } else if (typeof setCorridorProfilePreview === 'function') {
        setCorridorProfilePreview(
            corridorEditorState.proposalKey,
            next,
            corridorEditorState.scope === 'segment' ? corridorEditorState.segmentId : null
        );
    }
    corridorEditorRender();
}

// The total lives in the header, which a render does not rebuild, so the class has to come off by
// itself — left on, it would dye the number permanently red after the first refusal.
function corridorEditorFlashRefusal() {
    const total = document.querySelector('.corridor-editor-total');
    if (!total) return;
    total.classList.remove('corridor-editor-total--refused');
    void total.offsetWidth; // restart the animation
    total.classList.add('corridor-editor-total--refused');
    total.addEventListener(
        'animationend',
        () => total.classList.remove('corridor-editor-total--refused'),
        { once: true }
    );
}

// Everything the corridor's footprint would collide with at the given total width: buildings the
// road is not already tunnelled through (from the base map AND applied building proposals), and
// applied parks/squares/lakes. Checked per edge, like drawing-time segment validation.
function corridorEditorCollectWidthHits(width) {
    const result = { buildings: [], structures: [] };
    const state = corridorEditorState;
    if (!state || state.mode !== 'proposal' || !state.definition) return result;
    if (typeof calculateRoadPolygon !== 'function') return result;
    let segments = (typeof corridorCenterlineOf === 'function') ? corridorCenterlineOf(state.definition) : [];
    if (state.scope === 'segment' && state.segmentId && Array.isArray(state.definition.segmentIds)) {
        segments = segments.filter((_, index) => String(state.definition.segmentIds[index] || '') === state.segmentId);
    }
    const tunnelled = new Set();
    const tunnelEdgeKeys = new Set();
    (state.definition.tunnels || []).forEach(record => {
        (record?.buildingIds || []).forEach(id => tunnelled.add(String(id)));
        if (record?.edgeKey) tunnelEdgeKeys.add(record.edgeKey);
    });
    // Buildings this road already demolished are gone — a width change cannot "hit" them.
    (state.definition.demolishedBuildings || []).forEach(record => tunnelled.add(String(record?.id)));
    const seenBuildings = new Set();
    const seenStructures = new Set();
    segments.forEach(segment => {
        for (let i = 0; i < segment.length - 1; i++) {
            // A tunnel edge is already underground: nothing under it can be newly "hit".
            if (typeof corridorTunnelEdgeKey === 'function'
                && tunnelEdgeKeys.has(corridorTunnelEdgeKey(segment[i], segment[i + 1]))) continue;
            const polygon = calculateRoadPolygon([segment[i], segment[i + 1]], width);
            if (!polygon) continue;
            if (typeof detectLoadedBuildingTunnelIntersections === 'function') {
                detectLoadedBuildingTunnelIntersections(polygon).forEach(hit => {
                    const id = String(hit.id);
                    if (tunnelled.has(id) || seenBuildings.has(id)) return;
                    seenBuildings.add(id);
                    result.buildings.push(hit);
                });
            }
            if (typeof detectStructureCrossings === 'function') {
                detectStructureCrossings(polygon).forEach(hit => {
                    if (seenStructures.has(hit.id)) return;
                    seenStructures.add(hit.id);
                    result.structures.push(hit);
                });
            }
        }
    });
    return result;
}

function corridorEditorUpdateIndicators(hits, blocked) {
    const buildingsChip = document.querySelector('.corridor-editor-indicator--buildings');
    if (buildingsChip) buildingsChip.hidden = !blocked;
    const structuresChip = document.querySelector('.corridor-editor-indicator--structures');
    if (structuresChip) structuresChip.hidden = !(hits && hits.structures.length);
}

// Widening is blocked only when it hits a building the road did not already touch at its
// opening width — tunnels are made while drawing, never by widening a placed road.
function corridorEditorRunObstacleCheck() {
    const current = corridorEditorState;
    if (!current || current.mode !== 'proposal') return;
    if (!current.baselineBuildingHitIds) {
        const openingWidth = corridorProfileWidth(current.originalProfile || current.profile);
        current.baselineBuildingHitIds = new Set(
            corridorEditorCollectWidthHits(openingWidth).buildings.map(hit => String(hit.id))
        );
    }
    const hits = corridorEditorCollectWidthHits(corridorProfileWidth(current.profile));
    current.widthBlocked = hits.buildings.some(hit => !current.baselineBuildingHitIds.has(String(hit.id)));
    corridorEditorUpdateIndicators(hits, current.widthBlocked);
    const saveButton = document.querySelector('.corridor-editor-save');
    if (saveButton) saveButton.disabled = !current.dirty || current.widthBlocked;
}

// Debounced (the per-building intersection test is too heavy to run on every tick of a seam drag).
function corridorEditorScheduleObstacleCheck() {
    const state = corridorEditorState;
    if (!state || state.mode !== 'proposal') return;
    if (corridorEditorObstacleTimer) clearTimeout(corridorEditorObstacleTimer);
    corridorEditorObstacleTimer = setTimeout(() => {
        corridorEditorObstacleTimer = null;
        corridorEditorRunObstacleCheck();
    }, 150);
}

// A proportional bar of the cross-section, drawn to scale across the panel.
function corridorEditorSectionHtml(profile) {
    const total = corridorProfileWidth(profile);
    const cells = profile.strips.map((lane, index) => {
        const laneType = CORRIDOR_LANE_TYPES[lane.type] || {};
        const laneLabel = corridorLaneTypeLabel(lane.type);
        const percent = (lane.width / total) * 100;
        const selected = index === corridorEditorState.selected ? ' corridor-section-lane--selected' : '';
        return `<button type="button" class="corridor-section-lane${selected}" style="width:${percent}%;background:${laneType.surface}"
                    data-lane-index="${index}" title="${laneLabel} · ${lane.width} m"
                    aria-label="${laneLabel}, ${lane.width} metres"></button>`;
    }).join('');
    // Drag handles on the seams between lanes: dragging moves width from one side to the
    // other (total unchanged) — the schematic IS the editor, not just a picture.
    let cumulative = 0;
    const seams = profile.strips.slice(0, -1).map((lane, index) => {
        cumulative += (lane.width / total) * 100;
        return `<span class="corridor-section-seam" data-seam-index="${index}" style="left:${cumulative}%"
                    title="${corridorEditorI18n('modal.corridor.dragSeam', 'Drag to resize the lanes on both sides')}"></span>`;
    }).join('');
    return `<div class="corridor-section">${cells}${seams}</div>`;
}

// Cheap in-place width sync used DURING a seam drag: a full corridorEditorRender would replace
// the seam element mid-drag and kill the pointer capture, so only widths/labels move here.
function corridorEditorSyncWidthsInPlace(profile) {
    const total = corridorProfileWidth(profile);
    const section = document.querySelector('.corridor-section');
    if (!section) return;
    const cells = section.querySelectorAll('.corridor-section-lane');
    let cumulative = 0;
    profile.strips.forEach((lane, index) => {
        const percent = (lane.width / total) * 100;
        const cell = cells[index];
        if (cell) cell.style.width = `${percent}%`;
        if (index < profile.strips.length - 1) {
            cumulative += percent;
            const seam = section.querySelector(`.corridor-section-seam[data-seam-index="${index}"]`);
            if (seam) seam.style.left = `${cumulative}%`;
        }
    });
    document.querySelectorAll('.corridor-lane-width').forEach(input => {
        const lane = profile.strips[Number(input.dataset.laneIndex)];
        if (lane) input.value = lane.width;
    });
    const totalEl = document.querySelector('.corridor-editor-total');
    if (totalEl) totalEl.textContent = corridorEditorTotalText(total);
}

// Every lane type is on offer in every corridor. A tram track running down a street is a normal street
// (this is Zagreb), and a track can have a platform, a verge or a service lane beside it — the corridor
// is the cross-section, and nothing about a rail lane makes it belong to only one kind of corridor.
function corridorEditorLaneTypes() {
    return Object.keys(CORRIDOR_LANE_TYPES);
}

// The standard width for a lane's type, and — only when the lane deviates from it — the one-click way
// back. A permanent reset button on every row would be clutter for something the user rarely wants.
// A track's standard is ITS GAUGE's standard, so the reset takes the lane's gauge, not just its type.
function corridorEditorStandardHtml(lane, index) {
    const standard = corridorStandardWidth(lane.type, lane.gauge);
    const label = `${Number(standard)} m`;
    if (Math.abs(lane.width - standard) < 1e-6) {
        return `<span class="corridor-lane-standard" title="${corridorEditorI18n('modal.corridor.standardWidth', 'Standard width: {{width}} m', { width: Number(standard) })}">${label}</span>`;
    }
    return `<button type="button" class="corridor-lane-standard corridor-lane-standard--reset" data-reset-standard="${index}"
                title="${corridorEditorI18n('modal.corridor.resetStandard', 'Reset to the standard width ({{width}} m)', { width: Number(standard) })}"
                aria-label="${corridorEditorI18n('modal.corridor.resetStandard', 'Reset to the standard width ({{width}} m)', { width: Number(standard) })}">↺ ${label}</button>`;
}

function corridorEditorRowsHtml(profile) {
    const options = corridorEditorLaneTypes();
    const dragHint = corridorEditorI18n('modal.corridor.dragReorder', 'Drag to reorder the lanes');

    return profile.strips.map((lane, index) => {
        const laneType = CORRIDOR_LANE_TYPES[lane.type] || {};
        const selected = index === corridorEditorState.selected ? ' corridor-lane-row--selected' : '';
        const typeOptions = options.map(type => `<option value="${type}"${type === lane.type ? ' selected' : ''}>${corridorLaneTypeLabel(type)}</option>`).join('');
        const landscape = (lane.type === 'verge' || lane.type === 'median') ? corridorLandscapeOf(lane) : null;
        const landscapeSelect = landscape ? `
            <select class="corridor-lane-landscape" data-lane-index="${index}" aria-label="Green strip planting">
                <option value="grass"${landscape === 'grass' ? ' selected' : ''}>${corridorEditorI18n('modal.corridor.grass', 'Grass only')}</option>
                <option value="trees"${landscape === 'trees' ? ' selected' : ''}>${corridorEditorI18n('modal.corridor.trees', 'Tree grove')}</option>
            </select>` : '';
        // A track's gauge, the same shape the green strips' planting takes. Picking a gauge re-widths the
        // lane (a gauge IS a width here), so the selector belongs next to the number it moves.
        const gauge = corridorRailGaugeOf(lane);
        const gaugeSelect = gauge ? `
            <select class="corridor-lane-gauge" data-lane-index="${index}" aria-label="${corridorEditorI18n('modal.corridor.gauge', 'Track gauge')}">
                <option value="1000"${gauge === 1000 ? ' selected' : ''}>${corridorEditorI18n('modal.corridor.gauges.metre', '1000 mm (tram)')}</option>
                <option value="1435"${gauge === 1435 ? ' selected' : ''}>${corridorEditorI18n('modal.corridor.gauges.standard', '1435 mm (railway)')}</option>
            </select>` : '';
        return `
        <div class="corridor-lane-row${selected}" data-lane-index="${index}" tabindex="0">
            <span class="corridor-lane-handle" draggable="true" data-drag-index="${index}" title="${dragHint}" aria-hidden="true">⠿</span>
            <span class="corridor-lane-swatch" style="background:${laneType.surface}"></span>
            <select class="corridor-lane-type" data-lane-index="${index}" aria-label="Lane type">${typeOptions}</select>
            <input class="corridor-lane-width" type="number" min="0.5" step="0.25" value="${lane.width}"
                   data-lane-index="${index}" aria-label="Lane width in metres">
            <span class="corridor-lane-unit">m</span>
            ${corridorEditorStandardHtml(lane, index)}
            <span class="corridor-lane-actions">
                <button type="button" class="corridor-lane-btn" data-move-up="${index}" aria-label="Move outward" ${index === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" class="corridor-lane-btn" data-move-down="${index}" aria-label="Move inward" ${index === profile.strips.length - 1 ? 'disabled' : ''}>↓</button>
                <button type="button" class="corridor-lane-btn corridor-lane-btn--remove" data-remove="${index}" aria-label="Remove lane">✕</button>
            </span>
            ${landscapeSelect}${gaugeSelect}
        </div>`;
    }).join('');
}

// The lane palette: one button per lane type, each inserting that type at its standard width. The road
// grows by exactly that much — this is how a street is widened now that there is no width slider.
function corridorEditorPaletteHtml() {
    const buttons = corridorEditorLaneTypes().map(type => {
        const laneType = CORRIDOR_LANE_TYPES[type] || {};
        const width = Number(corridorStandardWidth(type));
        const label = corridorLaneTypeLabel(type);
        return `<button type="button" class="corridor-palette-btn" data-add-type="${type}"
                    title="${corridorEditorI18n('modal.corridor.addLaneOfType', 'Add: {{lane}} ({{width}} m)', { lane: label, width })}">
                    <span class="corridor-palette-swatch" style="background:${laneType.surface}"></span>
                    <span class="corridor-palette-label">${label}</span>
                    <span class="corridor-palette-width">${width} m</span>
                </button>`;
    }).join('');
    return `
        <div class="corridor-editor-palette">
            <div class="corridor-editor-group-label">${corridorEditorI18n('modal.corridor.addLane', 'Add lane')}</div>
            <div class="corridor-editor-palette-buttons">${buttons}</div>
        </div>`;
}

// The standard cross-sections, keyed by the same totals the road-width picker offers. One click stamps a
// complete, correct section; tweaking it afterwards is what the rest of the editor is for.
const CORRIDOR_EDITOR_PRESETS = [
    { width: 7.5, key: 'alley', fallback: 'Alley ~7.5 m' },
    { width: 10, key: 'local', fallback: 'Local ~10 m' },
    { width: 18, key: 'collector', fallback: 'Collector ~18 m' },
    { width: 26, key: 'mainStreet', fallback: 'Main street ~26 m' },
    { width: 40, key: 'avenue', fallback: 'Avenue ~40 m' },
    { width: 80, key: 'boulevard', fallback: 'Boulevard ~80 m' }
];

function corridorEditorPresetsHtml() {
    const buttons = CORRIDOR_EDITOR_PRESETS
        .filter(preset => CORRIDOR_PROFILE_PRESETS[preset.width])
        .map(preset => `<button type="button" class="corridor-preset-btn" data-preset="${preset.width}">${
            corridorEditorI18n(`modal.corridor.presetWidths.${preset.key}`, preset.fallback)
        }</button>`).join('');
    return `
        <div class="corridor-editor-presets">
            <div class="corridor-editor-group-label">${corridorEditorI18n('modal.corridor.presets', 'Standard cross-sections')}</div>
            <div class="corridor-editor-preset-buttons">${buttons}</div>
        </div>`;
}

// Selection is one thing shown in two places. Both are updated IN PLACE: a full re-render would throw
// away the focus of whatever the user just clicked, and a click on a row is often the start of using it.
function corridorEditorSyncSelection(scrollIntoView) {
    if (!corridorEditorState) return;
    const selected = corridorEditorState.selected;
    document.querySelectorAll('.corridor-section-lane').forEach(cell => {
        cell.classList.toggle('corridor-section-lane--selected', Number(cell.dataset.laneIndex) === selected);
    });
    document.querySelectorAll('.corridor-lane-row').forEach(row => {
        const isSelected = Number(row.dataset.laneIndex) === selected;
        row.classList.toggle('corridor-lane-row--selected', isSelected);
        if (isSelected && scrollIntoView && typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({ block: 'nearest' });
        }
    });
}

function corridorEditorSelect(index, scrollIntoView) {
    if (!corridorEditorState) return;
    corridorEditorState.selected = index;
    corridorEditorSyncSelection(scrollIntoView);
}

function corridorEditorRender() {
    const body = document.querySelector('.corridor-editor-body');
    if (!body || !corridorEditorState) return;
    const profile = corridorEditorState.profile;
    const notice = corridorEditorState.notice
        ? `<div class="corridor-editor-notice" role="status">${corridorEditorState.notice}</div>`
        : '';

    // Presets, then the diagram, then the palette — the two controls that BUILD the road stay at the top,
    // where they cannot be pushed below the fold by a boulevard's fifteen lane rows.
    body.innerHTML = `
        ${corridorEditorPresetsHtml()}
        ${corridorEditorSectionHtml(profile)}
        ${notice}
        ${corridorEditorPaletteHtml()}
        <div class="corridor-editor-hint">${corridorEditorI18n('modal.corridor.dragReorderHint', 'Drag a lane by its handle to reorder it; drag a seam in the diagram to move width from one lane to its neighbour.')}</div>
        <div class="corridor-editor-lanes">${corridorEditorRowsHtml(profile)}</div>
    `;

    const currentWidth = corridorProfileWidth(profile);
    const total = document.querySelector('.corridor-editor-total');
    if (total) {
        total.textContent = corridorEditorTotalText(currentWidth);
        // The refusal flash is a moment, not a state: an edit that lands clears it.
        if (!corridorEditorState.notice) total.classList.remove('corridor-editor-total--refused');
    }

    const saveButton = document.querySelector('.corridor-editor-save');
    if (saveButton) {
        saveButton.disabled = corridorEditorState.saving === true
            || (corridorEditorState.mode !== 'drawing'
                && (!corridorEditorState.dirty || corridorEditorState.widthBlocked === true));
    }

    corridorEditorScheduleObstacleCheck();
    corridorEditorBindBody(body);
}

function corridorEditorBindBody(body) {
    // Clicking a lane in the diagram selects its row below (and brings it into view).
    body.querySelectorAll('.corridor-section-lane').forEach(cell => {
        cell.addEventListener('click', () => corridorEditorSelect(Number(cell.dataset.laneIndex), true));
    });

    // ...and the other way round: touching a row highlights its lane in the diagram.
    body.querySelectorAll('.corridor-lane-row').forEach(row => {
        const select = () => corridorEditorSelect(Number(row.dataset.laneIndex), false);
        row.addEventListener('click', select);
        row.addEventListener('focusin', select);
    });

    body.querySelectorAll('.corridor-section-seam').forEach(seam => {
        seam.addEventListener('pointerdown', event => {
            const state = corridorEditorState;
            const section = seam.closest('.corridor-section');
            if (!state || !section || typeof withSeamMoved !== 'function') return;
            event.preventDefault();
            seam.setPointerCapture(event.pointerId);
            const seamIndex = Number(seam.dataset.seamIndex);
            const startX = event.clientX;
            const sectionWidth = section.getBoundingClientRect().width || 1;
            // Every move re-derives from the drag-start profile, so rounding never compounds.
            const startProfile = JSON.parse(JSON.stringify(state.profile));
            const startTotal = corridorProfileWidth(startProfile);
            let moved = false;

            const onMove = moveEvent => {
                const delta = ((moveEvent.clientX - startX) / sectionWidth) * startTotal;
                const next = withSeamMoved(startProfile, seamIndex, delta);
                if (!next) return; // clamped at the half-metre lane minimum
                state.profile = next;
                moved = true;
                corridorEditorSyncWidthsInPlace(next);
            };
            const onUp = () => {
                seam.removeEventListener('pointermove', onMove);
                seam.removeEventListener('pointerup', onUp);
                seam.removeEventListener('pointercancel', onUp);
                if (!moved) return;
                // Commit like any other edit: map preview, dirty flag, full re-render, checks.
                corridorEditorApply(() => state.profile);
            };
            seam.addEventListener('pointermove', onMove);
            seam.addEventListener('pointerup', onUp);
            seam.addEventListener('pointercancel', onUp);
        });
    });

    body.querySelectorAll('.corridor-lane-type').forEach(select => {
        select.addEventListener('change', () => {
            const index = Number(select.dataset.laneIndex);
            corridorEditorState.selected = index;
            corridorEditorApply(profile => withLaneType(profile, index, select.value));
        });
    });

    body.querySelectorAll('.corridor-lane-width').forEach(input => {
        input.addEventListener('change', () => {
            const index = Number(input.dataset.laneIndex);
            corridorEditorState.selected = index;
            corridorEditorApply(profile => withLaneWidth(profile, index, Number(input.value)));
        });
    });

    body.querySelectorAll('.corridor-lane-landscape').forEach(select => {
        select.addEventListener('change', () => {
            const index = Number(select.dataset.laneIndex);
            corridorEditorState.selected = index;
            corridorEditorApply(profile => withLaneLandscape(profile, index, select.value));
        });
    });

    body.querySelectorAll('.corridor-lane-gauge').forEach(select => {
        select.addEventListener('change', () => {
            const index = Number(select.dataset.laneIndex);
            corridorEditorState.selected = index;
            // withLaneGauge also re-widths the lane to that gauge's standard, so the corridor's total
            // moves with it — the same way any other width edit moves it.
            corridorEditorApply(profile => withLaneGauge(profile, index, select.value));
        });
    });

    body.querySelectorAll('[data-move-up]').forEach(button => {
        const index = Number(button.dataset.moveUp);
        button.addEventListener('click', () => {
            corridorEditorState.selected = index - 1;
            corridorEditorApply(profile => withLaneMoved(profile, index, index - 1));
        });
    });

    body.querySelectorAll('[data-move-down]').forEach(button => {
        const index = Number(button.dataset.moveDown);
        button.addEventListener('click', () => {
            corridorEditorState.selected = index + 1;
            corridorEditorApply(profile => withLaneMoved(profile, index, index + 1));
        });
    });

    body.querySelectorAll('[data-remove]').forEach(button => {
        const index = Number(button.dataset.remove);
        button.addEventListener('click', () => {
            corridorEditorState.selected = Math.max(0, index - 1);
            corridorEditorApply(profile => withLaneRemoved(profile, index));
        });
    });

    body.querySelectorAll('[data-reset-standard]').forEach(button => {
        const index = Number(button.dataset.resetStandard);
        button.addEventListener('click', () => {
            corridorEditorState.selected = index;
            corridorEditorApply(profile => {
                const lane = profile.strips[index];
                return withLaneWidth(profile, index, corridorStandardWidth(lane.type, lane.gauge));
            });
        });
    });

    // The palette. A new lane goes AFTER the selected one — the outermost strips are almost always
    // sidewalks, so appending on the right would put a traffic lane outside the pavement.
    body.querySelectorAll('[data-add-type]').forEach(button => {
        const type = button.dataset.addType;
        button.addEventListener('click', () => {
            const state = corridorEditorState;
            const lanes = state.profile.strips.length;
            const at = (state.selected >= 0 && state.selected < lanes) ? state.selected + 1 : lanes;
            const lane = { type, width: corridorStandardWidth(type) };
            if ((CORRIDOR_LANE_TYPES[type] || {}).directional) lane.direction = 'forward';
            // A fresh track is a standard-gauge one; its row's gauge selector is how it becomes a tram.
            if (type === 'rail') lane.gauge = CORRIDOR_DEFAULT_RAIL_GAUGE;
            state.selected = at; // the new lane lands at `at`, and the render below highlights it
            corridorEditorApply(profile => withLaneInserted(profile, at, lane));
        });
    });

    body.querySelectorAll('[data-preset]').forEach(button => {
        const preset = CORRIDOR_PROFILE_PRESETS[button.dataset.preset];
        if (!preset) return;
        button.addEventListener('click', () => {
            corridorEditorState.selected = 0;
            corridorEditorApply(() => normalizeCorridorProfile(preset.map(strip => ({ ...strip }))));
        });
    });

    corridorEditorBindLaneDrag(body);
}

// Drag a lane row by its handle to reorder it. The ↑/↓ buttons stay: they are the keyboard and touch
// path (HTML5 drag does not exist on a finger), and this is the same withLaneMoved either way.
function corridorEditorBindLaneDrag(body) {
    const rows = [...body.querySelectorAll('.corridor-lane-row')];
    const clearMarks = () => rows.forEach(row => row.classList.remove('corridor-lane-row--dragging', 'corridor-lane-row--drop'));

    body.querySelectorAll('.corridor-lane-handle').forEach(handle => {
        const row = handle.closest('.corridor-lane-row');
        handle.addEventListener('dragstart', event => {
            corridorEditorState.dragIndex = Number(handle.dataset.dragIndex);
            event.dataTransfer.effectAllowed = 'move';
            // Some browsers refuse a drag with no payload.
            event.dataTransfer.setData('text/plain', String(corridorEditorState.dragIndex));
            if (row && typeof event.dataTransfer.setDragImage === 'function') event.dataTransfer.setDragImage(row, 12, 12);
            if (row) row.classList.add('corridor-lane-row--dragging');
        });
        handle.addEventListener('dragend', () => {
            corridorEditorState.dragIndex = null;
            clearMarks();
        });
    });

    rows.forEach(row => {
        row.addEventListener('dragover', event => {
            if (corridorEditorState.dragIndex === null || corridorEditorState.dragIndex === undefined) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            rows.forEach(other => other.classList.remove('corridor-lane-row--drop'));
            if (Number(row.dataset.laneIndex) !== corridorEditorState.dragIndex) row.classList.add('corridor-lane-row--drop');
        });
        row.addEventListener('drop', event => {
            event.preventDefault();
            const from = corridorEditorState.dragIndex;
            const to = Number(row.dataset.laneIndex);
            corridorEditorState.dragIndex = null;
            clearMarks();
            if (from === null || from === undefined || from === to) return;
            corridorEditorState.selected = to;
            corridorEditorApply(profile => withLaneMoved(profile, from, to));
        });
    });
}

// Apply returns a placed road to the normal drawing tool with its edited profile. No proposal exists
// until the user explicitly presses Create there; cancelling the drawing leaves the source untouched.
async function corridorEditorSave() {
    if (!corridorEditorState) return;
    if (corridorEditorState.mode === 'drawing') {
        const state = corridorEditorState;
        if (state.saving) return;
        const openingWidth = corridorProfileWidth(state.originalProfile || state.profile);
        const editedWidth = corridorProfileWidth(state.profile);
        const footprintChanged = Math.abs(editedWidth - openingWidth) > 1e-6;
        if (footprintChanged) {
            state.saving = true;
            corridorEditorRender();
            let accepted = false;
            try {
                accepted = typeof window.validateRoadDrawingProfileImpacts === 'function'
                    && await window.validateRoadDrawingProfileImpacts();
            } finally {
                if (corridorEditorState === state) state.saving = false;
            }
            if (!accepted) {
                if (corridorEditorState === state) {
                    state.notice = corridorEditorI18n(
                        'modal.corridor.unresolvedDrawingImpact',
                        'The cross-section was not applied. Adjust it or resolve its building impacts.'
                    );
                    corridorEditorRender();
                    corridorEditorFlashRefusal();
                }
                return;
            }
        }
        corridorEditorClose();
        if (typeof updateStatus === 'function') {
            updateStatus('Cross-section applied. Keep drawing or press F to finish the road.');
        }
        return;
    }
    // A width that newly hits a building cannot be applied — tunnels are made while drawing.
    // Settle any pending debounced check first so a quick drag-then-Apply cannot slip through.
    if (corridorEditorObstacleTimer) {
        clearTimeout(corridorEditorObstacleTimer);
        corridorEditorObstacleTimer = null;
        corridorEditorRunObstacleCheck();
    }
    if (corridorEditorState.widthBlocked) {
        corridorEditorFlashRefusal();
        return;
    }
    const { source, profile, scope, segmentId: scopedSegmentId } = corridorEditorState;
    const sourceKey = (typeof getProposalKey === 'function' ? getProposalKey(source) : null) || source.proposalId;
    const sourceName = source.title || source.name || sourceKey;
    corridorEditorClose();

    // SimCity object editing: a local, unminted road takes the new cross-section in place —
    // the footprint rebuilds and the road re-applies. Only minted (immutable) proposals fall
    // through to the redraw-as-replacement flow.
    const minted = typeof isProposalMinted === 'function' && isProposalMinted(source);
    if (!minted && typeof window.updateLocalCorridorGeometry === 'function') {
        const updated = await window.updateLocalCorridorGeometry(sourceKey, definition => {
            if (scope === 'segment' && scopedSegmentId) {
                // One segment of the network takes the new cross-section; the rest is untouched.
                definition.segmentProfiles = definition.segmentProfiles || {};
                const defaultProfile = (typeof corridorProfileOf === 'function') ? corridorProfileOf(definition) : null;
                if (defaultProfile && JSON.stringify(defaultProfile) === JSON.stringify(profile)) {
                    delete definition.segmentProfiles[String(scopedSegmentId)];
                } else {
                    definition.segmentProfiles[String(scopedSegmentId)] = JSON.parse(JSON.stringify(profile));
                }
                return;
            }
            // Whole network: the new profile becomes the uniform cross-section again.
            definition.profile = JSON.parse(JSON.stringify(profile));
            delete definition.segmentProfiles;
            if (typeof corridorProfileWidth === 'function') definition.width = corridorProfileWidth(profile);
            const sidewalks = (profile.strips || []).filter(strip => strip.type === 'sidewalk');
            definition.sidewalkWidth = sidewalks.length
                ? sidewalks.reduce((sum, strip) => sum + strip.width, 0) / sidewalks.length
                : 0;
        });
        if (updated) {
            if (typeof updateStatus === 'function') updateStatus('Cross-section updated.');
            return;
        }
    }

    const reopened = typeof copyCorridorIntoNewProposal === 'function'
        && await copyCorridorIntoNewProposal(source, sourceKey, sourceName, { profile });
    if (!reopened) {
        console.warn('[corridorEditor] could not reopen the placed road as a drawing', sourceKey);
        if (typeof showProposalAlertMessage === 'function') {
            showProposalAlertMessage('corridor_drawing_unavailable', "Could not reopen this road's drawing. Switch to the city it was created in, then try again.");
        }
    }
}

function corridorEditorOpenOverlay() {
    if (!corridorEditorState) return;
    const profile = corridorEditorState.profile;
    const drawing = corridorEditorState.mode === 'drawing';
    const totalWidth = corridorProfileWidth(profile);
    // Output, not input: the total IS the sum of the lanes, and the lanes are edited below.
    const totalControl = `
        <strong class="corridor-editor-total" aria-live="polite">${corridorEditorTotalText(totalWidth)}</strong>`;
    const scopeHtml = (!drawing && corridorEditorState.canScopeSegment) ? `
            <div class="corridor-editor-scope" role="radiogroup" aria-label="${corridorEditorI18n('modal.corridor.scopeLabel', 'Applies to')}">
                <label class="corridor-editor-scope-option"><input type="radio" name="corridor-editor-scope" value="segment"${corridorEditorState.scope === 'segment' ? ' checked' : ''}><span>${corridorEditorI18n('modal.corridor.scopeSegment', 'This segment')}</span></label>
                <label class="corridor-editor-scope-option"><input type="radio" name="corridor-editor-scope" value="road"${corridorEditorState.scope === 'road' ? ' checked' : ''}><span>${corridorEditorI18n('modal.corridor.scopeRoad', 'Entire road network')}</span></label>
            </div>` : '';
    const indicatorsHtml = drawing ? '' : `
            <div class="corridor-editor-indicators">
                <span class="corridor-editor-indicator corridor-editor-indicator--buildings" hidden>${corridorEditorI18n('modal.corridor.hitsBuildings', 'Hits buildings (to tunnel through buildings, use drawing mode)')}</span>
                <span class="corridor-editor-indicator corridor-editor-indicator--structures" hidden>${corridorEditorI18n('modal.corridor.cutsStructures', 'Cuts applied parks/squares/lakes')}</span>
            </div>`;
    const overlay = document.createElement('div');
    overlay.id = 'corridor-editor-overlay';
    overlay.className = 'corridor-editor-overlay';
    overlay.innerHTML = `
        <div class="corridor-editor" role="dialog" aria-modal="true" aria-label="Cross-section">
            <div class="corridor-editor-header">
                <div>
                    <div class="corridor-editor-title">${corridorEditorI18n('modal.corridor.title', 'Cross-section')}</div>
                    <div class="corridor-editor-subtitle">${drawing
                        ? corridorEditorI18n('modal.corridor.drawingSubtitle', 'Changes update the road on the map before you create the proposal')
                        : corridorEditorI18n('modal.corridor.proposalSubtitle', 'Preview changes here, then apply them to an editable road drawing')}</div>
                </div>
                <button type="button" class="close-circle-btn corridor-editor-close" aria-label="Close">&times;</button>
            </div>
            ${scopeHtml}
            <div class="corridor-editor-meta">
                <span>${corridorEditorI18n('modal.corridor.totalWidth', 'Total width')}</span>
                ${totalControl}
            </div>${indicatorsHtml}
            <div class="corridor-editor-body"></div>
            <div class="corridor-editor-footer">
                <button type="button" class="btn btn-outline-secondary corridor-editor-cancel">${corridorEditorI18n('modal.corridor.cancel', 'Cancel')}</button>
                <button type="button" class="btn btn-primary corridor-editor-save"${drawing ? '' : ' disabled'}>${drawing
                    ? corridorEditorI18n('modal.corridor.applyDrawing', 'Apply to drawing')
                    : corridorEditorI18n('modal.corridor.applyDrawing', 'Apply to drawing')}</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelectorAll('input[name="corridor-editor-scope"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const state = corridorEditorState;
            if (!state || !radio.checked) return;
            state.scope = radio.value === 'segment' ? 'segment' : 'road';
            state.profile = state.scope === 'segment' && typeof corridorSegmentProfile === 'function'
                ? corridorSegmentProfile(state.definition, state.segmentId)
                : corridorProfileOf(state.definition);
            state.originalProfile = JSON.parse(JSON.stringify(state.profile));
            state.baselineBuildingHitIds = null;
            state.dirty = false;
            state.notice = null;
            if (typeof setCorridorProfilePreview === 'function') {
                setCorridorProfilePreview(state.proposalKey, state.profile, state.scope === 'segment' ? state.segmentId : null);
            }
            corridorEditorRender();
            corridorEditorScheduleObstacleCheck();
        });
    });

    overlay.querySelector('.corridor-editor-close').addEventListener('click', corridorEditorCancel);
    overlay.querySelector('.corridor-editor-cancel').addEventListener('click', corridorEditorCancel);
    overlay.querySelector('.corridor-editor-save').addEventListener('click', corridorEditorSave);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) corridorEditorCancel(); });
    document.addEventListener('keydown', corridorEditorKeydown);

    corridorEditorRender();
}

// Entry point, wired to the "Cross-section" button in a road proposal's details panel.
function openCorridorProfileEditor(proposalIdOrHash) {
    corridorEditorCancel();

    const source = (typeof getProposalByIdOrHash === 'function') ? getProposalByIdOrHash(proposalIdOrHash) : null;
    const definition = source ? corridorProposalDefinition(source) : null;
    if (!definition || !corridorProfileOf(definition)) {
        console.warn('[corridorEditor] proposal has no corridor cross-section:', proposalIdOrHash);
        return;
    }

    const proposalKey = String((typeof getProposalKey === 'function' ? getProposalKey(source) : null) || source.proposalId);
    // The proposal is the whole network; the cross-section is a per-SEGMENT property. When the
    // click that led here landed on a specific segment, the editor opens scoped to it.
    const clicked = window.corridorLastClickedSegment;
    const segmentIds = Array.isArray(definition.segmentIds) ? definition.segmentIds.filter(Boolean).map(String) : [];
    const segmentId = (clicked && clicked.proposalKey === proposalKey && segmentIds.includes(String(clicked.segmentId)))
        ? String(clicked.segmentId)
        : null;
    const scope = (segmentId && segmentIds.length > 1) ? 'segment' : 'road';
    const profile = (scope === 'segment' && typeof corridorSegmentProfile === 'function')
        ? corridorSegmentProfile(definition, segmentId)
        : corridorProfileOf(definition);

    corridorEditorState = {
        mode: 'proposal',
        source,
        definition,
        scope,
        segmentId,
        canScopeSegment: !!segmentId && segmentIds.length > 1,
        proposalKey,
        profile,
        // The opening cross-section: widening is compared against ITS footprint, so a building
        // the road already touched when the editor opened never blocks an unrelated edit.
        originalProfile: JSON.parse(JSON.stringify(profile)),
        baselineBuildingHitIds: null,
        widthBlocked: false,
        selected: 0,
        dragIndex: null,
        notice: null,
        dirty: false
    };
    corridorEditorOpenOverlay();
}

// The same editor while the corridor is still geometry-in-progress — a road OR a track, since a track's
// cross-section is a lane list like any other. Every change is previewed immediately; Cancel restores the
// opening profile, while Apply keeps the live profile and returns to drawing.
function openRoadDrawingCrossSectionEditor() {
    if (!window.roadDrawingMode || typeof getRoadDrawingProfile !== 'function') return;
    corridorEditorCancel();
    const profile = getRoadDrawingProfile();
    if (!profile) return;
    const clone = value => JSON.parse(JSON.stringify(value));
    corridorEditorState = {
        mode: 'drawing',
        source: null,
        definition: null,
        proposalKey: null,
        profile: clone(profile),
        originalProfile: clone(profile),
        selected: 0,
        dragIndex: null,
        notice: null,
        dirty: false
    };
    corridorEditorOpenOverlay();
}

// Any placed corridor can be re-sectioned from its details panel. A track is one of them: its lane list
// is a cross-section like a road's, and the map draws it as one — rails and all — so an edit to it shows.
//
// A DESIGNATION is not: it is parcels declared to be road land, with no centerline and therefore no
// cross-section. corridorProfileOf() returns null for one rather than inventing lanes out of its width,
// which is exactly what makes this check refuse it — there is nothing to re-section.
function proposalHasEditableCorridor(proposal) {
    const definition = (typeof corridorProposalDefinition === 'function') ? corridorProposalDefinition(proposal) : null;
    if (!definition) return false;
    return !!corridorProfileOf(definition);
}

if (typeof window !== 'undefined') {
    window.openCorridorProfileEditor = openCorridorProfileEditor;
    window.openRoadDrawingCrossSectionEditor = openRoadDrawingCrossSectionEditor;
    window.proposalHasEditableCorridor = proposalHasEditableCorridor;
}
