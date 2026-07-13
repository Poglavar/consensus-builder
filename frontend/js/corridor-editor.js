// The cross-section editor: reorder, resize, retype, add and remove the lanes of a road, and set
// the corridor's total width with the slider at the top (10 cm steps, capped at the widest
// permitted preset — Boulevard, 80 m).
//
// Lane edits are *profile-only* and preserve the total width; the slider is the one control that
// changes it, with the traffic lanes absorbing the difference (an edit or width they cannot absorb
// is refused). For a placed road the widened footprint is checked live: hitting a NEW building
// blocks Apply — tunnels are only made while drawing — while crossing an applied park/square/lake
// merely lights an indicator (the structure is cut at render time).
//
// Local unminted roads take the change in place (footprint + parcel cuts rebuild on Apply); minted
// proposals are immutable and reopen as a drawing draft instead.

let corridorEditorState = null;
let corridorEditorObstacleTimer = null;

// 2 m allows pure pedestrian footpaths (delete every lane except a sidewalk, then narrow it).
const CORRIDOR_EDITOR_MIN_WIDTH = 2;
const CORRIDOR_EDITOR_MAX_WIDTH = 80; // the widest drawing preset (Boulevard)

function corridorEditorI18n(key, fallback) {
    try {
        if (window.i18n && typeof window.i18n.t === 'function') {
            const translated = window.i18n.t(key, {});
            if (translated && translated !== key) return translated;
        }
    } catch (_) { }
    return fallback;
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

// Apply an edit, or refuse it. `edit` returns a new profile or null; null means the traffic lanes had no
// room, and the right answer is to say so, not to grow the road.
function corridorEditorApply(edit) {
    if (!corridorEditorState) return;
    const next = edit(corridorEditorState.profile);
    if (!next) {
        // Redraw from the model so the refused number does not sit in the input pretending to be real.
        corridorEditorRender();
        corridorEditorFlashRefusal();
        return;
    }
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

function corridorEditorFlashRefusal() {
    const total = document.querySelector('.corridor-editor-total');
    if (!total) return;
    total.classList.remove('corridor-editor-total--refused');
    void total.offsetWidth; // restart the animation
    total.classList.add('corridor-editor-total--refused');
}

// Everything the corridor's footprint would collide with at the given total width: buildings the
// road is not already tunnelled through (from the base map AND applied building proposals), and
// applied parks/squares/lakes. Checked per edge, like the finish-time tunnel recheck.
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

// Debounced (the per-building intersection test is too heavy to run on every slider tick).
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
        const percent = (lane.width / total) * 100;
        const selected = index === corridorEditorState.selected ? ' corridor-section-lane--selected' : '';
        return `<button type="button" class="corridor-section-lane${selected}" style="width:${percent}%;background:${laneType.surface}"
                    data-lane-index="${index}" title="${laneType.label} · ${lane.width} m"
                    aria-label="${laneType.label}, ${lane.width} metres"></button>`;
    }).join('');
    return `<div class="corridor-section">${cells}</div>`;
}

function corridorEditorRowsHtml(profile) {
    const options = Object.keys(CORRIDOR_LANE_TYPES)
        .filter(type => type !== 'rail'); // a rail bed belongs to a track, not a road

    return profile.strips.map((lane, index) => {
        const laneType = CORRIDOR_LANE_TYPES[lane.type] || {};
        const selected = index === corridorEditorState.selected ? ' corridor-lane-row--selected' : '';
        const typeOptions = options.map(type => `<option value="${type}"${type === lane.type ? ' selected' : ''}>${CORRIDOR_LANE_TYPES[type].label}</option>`).join('');
        const landscape = (lane.type === 'verge' || lane.type === 'median') ? corridorLandscapeOf(lane) : null;
        const landscapeSelect = landscape ? `
            <select class="corridor-lane-landscape" data-lane-index="${index}" aria-label="Green strip planting">
                <option value="grass"${landscape === 'grass' ? ' selected' : ''}>${corridorEditorI18n('modal.corridor.grass', 'Grass only')}</option>
                <option value="trees"${landscape === 'trees' ? ' selected' : ''}>${corridorEditorI18n('modal.corridor.trees', 'Tree grove')}</option>
            </select>` : '';
        return `
        <div class="corridor-lane-row${selected}" data-lane-index="${index}">
            <span class="corridor-lane-swatch" style="background:${laneType.surface}"></span>
            <select class="corridor-lane-type" data-lane-index="${index}" aria-label="Lane type">${typeOptions}</select>
            <input class="corridor-lane-width" type="number" min="0.5" step="0.25" value="${lane.width}"
                   data-lane-index="${index}" aria-label="Lane width in metres">
            <span class="corridor-lane-unit">m</span>
            <button type="button" class="corridor-lane-btn" data-move-up="${index}" aria-label="Move outward" ${index === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="corridor-lane-btn" data-move-down="${index}" aria-label="Move inward" ${index === profile.strips.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" class="corridor-lane-btn corridor-lane-btn--remove" data-remove="${index}" aria-label="Remove lane">✕</button>
            ${landscapeSelect}
        </div>`;
    }).join('');
}

function corridorEditorRender() {
    const body = document.querySelector('.corridor-editor-body');
    if (!body || !corridorEditorState) return;
    const profile = corridorEditorState.profile;

    body.innerHTML = `
        ${corridorEditorSectionHtml(profile)}
        <div class="corridor-editor-lanes">${corridorEditorRowsHtml(profile)}</div>
        <button type="button" class="btn btn-outline-secondary corridor-add-lane">
            <i class="fas fa-plus"></i> ${corridorEditorI18n('modal.corridor.addLane', 'Add lane')}
        </button>
    `;

    const currentWidth = corridorProfileWidth(profile);
    const total = document.querySelector('.corridor-editor-total');
    if (total) total.textContent = `${Number(currentWidth.toFixed(1))} m`;
    const slider = document.querySelector('.corridor-editor-width-slider');
    // Do not fight the user's drag: mid-drag the slider already holds the value being applied.
    if (slider && document.activeElement !== slider) slider.value = currentWidth;

    const saveButton = document.querySelector('.corridor-editor-save');
    if (saveButton) {
        saveButton.disabled = corridorEditorState.mode !== 'drawing'
            && (!corridorEditorState.dirty || corridorEditorState.widthBlocked === true);
    }

    corridorEditorScheduleObstacleCheck();
    corridorEditorBindBody(body);
}

function corridorEditorBindBody(body) {
    body.querySelectorAll('.corridor-section-lane').forEach(cell => {
        cell.addEventListener('click', () => {
            corridorEditorState.selected = Number(cell.dataset.laneIndex);
            corridorEditorRender();
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

    const addLane = body.querySelector('.corridor-add-lane');
    if (addLane) {
        addLane.addEventListener('click', () => {
            const at = corridorEditorState.selected + 1;
            corridorEditorApply(profile => withLaneInserted(profile, at, { type: 'parking', width: 2 }));
        });
    }
}

// Apply returns a placed road to the normal drawing tool with its edited profile. No proposal exists
// until the user explicitly presses Create there; cancelling the drawing leaves the source untouched.
async function corridorEditorSave() {
    if (!corridorEditorState) return;
    if (corridorEditorState.mode === 'drawing') {
        corridorEditorClose();
        if (typeof updateStatus === 'function') {
            updateStatus('Cross-section applied. Keep drawing or press C to create the proposal.');
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
    const totalControl = `
        <span class="corridor-editor-width-control">
            <input class="corridor-editor-width-slider" type="range"
                   min="${CORRIDOR_EDITOR_MIN_WIDTH}" max="${CORRIDOR_EDITOR_MAX_WIDTH}" step="0.1"
                   value="${totalWidth}" aria-label="Total corridor width in metres">
            <strong class="corridor-editor-total">${Number(totalWidth.toFixed(1))} m</strong>
        </span>`;
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
            if (typeof setCorridorProfilePreview === 'function') {
                setCorridorProfilePreview(state.proposalKey, state.profile, state.scope === 'segment' ? state.segmentId : null);
            }
            const slider = document.querySelector('.corridor-editor-width-slider');
            const totalEl = document.querySelector('.corridor-editor-total');
            const widthNow = corridorProfileWidth(state.profile);
            if (slider) slider.value = widthNow;
            if (totalEl) totalEl.textContent = `${Number(widthNow.toFixed(1))} m`;
            corridorEditorRender();
            corridorEditorScheduleObstacleCheck();
        });
    });

    overlay.querySelector('.corridor-editor-close').addEventListener('click', corridorEditorCancel);
    overlay.querySelector('.corridor-editor-cancel').addEventListener('click', corridorEditorCancel);
    overlay.querySelector('.corridor-editor-save').addEventListener('click', corridorEditorSave);
    const widthSlider = overlay.querySelector('.corridor-editor-width-slider');
    if (widthSlider) {
        // Live: every tick re-fits the traffic lanes to the new total and repaints the preview
        // strips on the map; the obstacle indicators follow (debounced).
        widthSlider.addEventListener('input', () => {
            const target = Math.round(Number(widthSlider.value) * 10) / 10;
            corridorEditorApply(profileValue => withCorridorWidth(profileValue, target));
        });
    }
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
        dirty: false
    };
    corridorEditorOpenOverlay();
}

// The same editor while the road is still geometry-in-progress. Every change is previewed immediately;
// Cancel restores the opening profile, while Apply keeps the live profile and returns to drawing.
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
        dirty: false
    };
    corridorEditorOpenOverlay();
}

// Only a road with a cross-section can be edited this way; a track has no lanes to shuffle.
function proposalHasEditableCorridor(proposal) {
    const definition = (typeof corridorProposalDefinition === 'function') ? corridorProposalDefinition(proposal) : null;
    if (!definition || (definition.metadata && definition.metadata.isTrack)) return false;
    return !!corridorProfileOf(definition);
}

if (typeof window !== 'undefined') {
    window.openCorridorProfileEditor = openCorridorProfileEditor;
    window.openRoadDrawingCrossSectionEditor = openRoadDrawingCrossSectionEditor;
    window.proposalHasEditableCorridor = proposalHasEditableCorridor;
}
