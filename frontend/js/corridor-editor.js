// The cross-section editor: reorder, resize, retype, add and remove the lanes of a road.
//
// Every edit here is a *profile-only* edit, and profile-only edits preserve the corridor's total width.
// The footprint is a function of that total alone, so nothing the user does in this panel can move the
// road, change the parcel split, or invalidate a proposal derived from it. The total is shown, fixed,
// and an edit the traffic lanes cannot absorb is refused rather than quietly widening the road.
//
// Proposals are immutable. Editing a placed road therefore reopens its geometry as a drawing draft;
// the user can keep editing it and explicitly create a replacement proposal later.

let corridorEditorState = null;

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
        setCorridorProfilePreview(corridorEditorState.proposalKey, next);
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

    const total = document.querySelector('.corridor-editor-total');
    if (total) {
        if (total.tagName === 'INPUT') total.value = corridorProfileWidth(profile);
        else total.textContent = `${corridorProfileWidth(profile)} m`;
    }

    const saveButton = document.querySelector('.corridor-editor-save');
    if (saveButton) saveButton.disabled = corridorEditorState.mode !== 'drawing' && !corridorEditorState.dirty;

    const totalInput = document.querySelector('.corridor-editor-total-width');
    if (totalInput) {
        totalInput.onchange = () => corridorEditorApply(profileValue => withCorridorWidth(profileValue, Number(totalInput.value)));
    }

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
    const { source, profile } = corridorEditorState;
    const sourceKey = (typeof getProposalKey === 'function' ? getProposalKey(source) : null) || source.proposalId;
    const sourceName = source.title || source.name || sourceKey;
    corridorEditorClose();
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
    const totalControl = drawing
        ? `<input class="corridor-editor-total corridor-editor-total-width" type="number" min="5" step="0.5" value="${corridorProfileWidth(profile)}" aria-label="Total corridor width in metres">`
        : `<strong class="corridor-editor-total">${corridorProfileWidth(profile)} m</strong>`;
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
            <div class="corridor-editor-meta">
                <span>${corridorEditorI18n('modal.corridor.totalWidth', 'Total width')}</span>
                ${totalControl}
            </div>
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

    overlay.querySelector('.corridor-editor-close').addEventListener('click', corridorEditorCancel);
    overlay.querySelector('.corridor-editor-cancel').addEventListener('click', corridorEditorCancel);
    overlay.querySelector('.corridor-editor-save').addEventListener('click', corridorEditorSave);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) corridorEditorCancel(); });
    document.addEventListener('keydown', corridorEditorKeydown);

    corridorEditorRender();
}

// Entry point, wired to the "Cross-section" button in a road proposal's details panel.
function openCorridorProfileEditor(proposalIdOrHash) {
    if (typeof requirePersonalizedUser === 'function' && requirePersonalizedUser()) return;
    corridorEditorCancel();

    const source = (typeof getProposalByIdOrHash === 'function') ? getProposalByIdOrHash(proposalIdOrHash) : null;
    const definition = source ? corridorProposalDefinition(source) : null;
    const profile = definition ? corridorProfileOf(definition) : null;
    if (!profile) {
        console.warn('[corridorEditor] proposal has no corridor cross-section:', proposalIdOrHash);
        return;
    }

    corridorEditorState = {
        mode: 'proposal',
        source,
        definition,
        proposalKey: String((typeof getProposalKey === 'function' ? getProposalKey(source) : null) || source.proposalId),
        profile,
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
