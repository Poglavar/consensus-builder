// The cross-section editor: reorder, resize, retype, add and remove the lanes of a road.
//
// Every edit here is a *profile-only* edit, and profile-only edits preserve the corridor's total width.
// The footprint is a function of that total alone, so nothing the user does in this panel can move the
// road, change the parcel split, or invalidate a proposal derived from it. The total is shown, fixed,
// and an edit the traffic lanes cannot absorb is refused rather than quietly widening the road.
//
// Proposals are immutable, so saving forks: the geometry rides across verbatim and only the cross-section
// differs, recorded against the source with `copiedFromProposalId`.

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

function corridorEditorKeydown(event) {
    if (event.key === 'Escape') {
        event.preventDefault();
        corridorEditorClose();
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
    if (typeof setCorridorProfilePreview === 'function') {
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
    if (total) total.textContent = `${corridorProfileWidth(profile)} m`;

    const saveButton = document.querySelector('.corridor-editor-save');
    if (saveButton) saveButton.disabled = !corridorEditorState.dirty;

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

// showProposalDialog() refuses to open on an empty parcel selection, and the drawing tool normally seeds
// it from the parcels the road crosses; forking from this panel has to do the same.
//
// An applied road has consumed its parents: they are off the map, replaced by the corridor and the
// remainders, and after a reload they are not even in the layer index — so they cannot be selected. Its
// children can. Which parcels the dialog happens to have selected does not matter here: the new
// proposal's parents are read from the stored definition, not from the selection.
async function corridorEditorSelectParcels(source) {
    if (typeof reselectParcelsForCopy !== 'function' || typeof resolveCopyParcelLayer !== 'function') return false;
    const parents = (source.parentParcelIds || []).map(String);
    const children = (source.childParcelIds || []).map(String);

    if (parents.length && typeof hydrateParcelsForCopy === 'function') await hydrateParcelsForCopy(parents);
    const onMap = parents.filter(id => resolveCopyParcelLayer(id)).length ? parents : children;

    return onMap.length ? reselectParcelsForCopy(onMap) > 0 : false;
}

// Saving forks. The geometry is untouched — same centerline, same segment ids, same polygon, same
// parents — so createProposal() sees exactly the road that was drawn, wearing a different cross-section.
async function corridorEditorSave() {
    if (!corridorEditorState) return;
    const { source, profile, definition } = corridorEditorState;
    const clone = (value) => { try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; } };

    const sourceKey = (typeof getProposalKey === 'function' ? getProposalKey(source) : null) || source.proposalId;
    const sourceName = source.title || source.name || sourceKey;

    if (!await corridorEditorSelectParcels(source)) {
        console.warn('[corridorEditor] no parcels of the source road are on the map; cannot open the create dialog');
        if (typeof showProposalAlertMessage === 'function') {
            showProposalAlertMessage('corridor_parcels_unavailable', "Could not load this road's parcels. Switch to the city it was created in, then try again.");
        }
        return;
    }

    window.pendingRoadDrawingProposal = {
        parentParcelIds: (source.parentParcelIds || []).map(String),
        centerline: clone(corridorCenterlineOf(definition)),
        segmentIds: Array.isArray(definition.segmentIds) ? definition.segmentIds.slice() : [],
        profile: clone(profile),
        polygon: clone(definition.polygon),
        polygonOrder: 'lnglat',
        width: corridorProfileWidth(profile),
        sidewalkWidth: definition.sidewalkWidth,
        stats: clone(source.ownershipAndAcquisitionStats) || null,
        metadata: { ...(definition.metadata || {}), mode: 'draw', type: 'road', isTrack: false, isRoad: true, isCorridor: true, source: 'corridor-editor' }
    };

    corridorEditorClose();

    showProposalDialog({
        goal: 'road-track',
        lockGoal: true,
        acquisitionMode: source.acquisitionMode || 'partial-preferred',
        lockAcquisition: true,
        copySource: { proposalId: String(sourceKey), name: sourceName },
        geometryPreset: {
            statusText: `Same corridor as "${sourceName}", new cross-section`,
            submitted: true,
            selectedAction: 'upload',
            disableButtons: true
        },
        prefill: {
            name: `${sourceName} — new cross-section`,
            description: source.description || '',
            offer: Number(source.offer) > 0 ? Number(source.offer) : undefined
        }
    });
}

// Entry point, wired to the "Cross-section" button in a road proposal's details panel.
function openCorridorProfileEditor(proposalIdOrHash) {
    if (typeof requirePersonalizedUser === 'function' && requirePersonalizedUser()) return;
    corridorEditorClose();

    const source = (typeof getProposalByIdOrHash === 'function') ? getProposalByIdOrHash(proposalIdOrHash) : null;
    const definition = source ? corridorProposalDefinition(source) : null;
    const profile = definition ? corridorProfileOf(definition) : null;
    if (!profile) {
        console.warn('[corridorEditor] proposal has no corridor cross-section:', proposalIdOrHash);
        return;
    }

    corridorEditorState = {
        source,
        definition,
        proposalKey: String((typeof getProposalKey === 'function' ? getProposalKey(source) : null) || source.proposalId),
        profile,
        selected: 0,
        dirty: false
    };

    const overlay = document.createElement('div');
    overlay.id = 'corridor-editor-overlay';
    overlay.className = 'corridor-editor-overlay';
    overlay.innerHTML = `
        <div class="corridor-editor" role="dialog" aria-modal="true" aria-label="Cross-section">
            <div class="corridor-editor-header">
                <div>
                    <div class="corridor-editor-title">${corridorEditorI18n('modal.corridor.title', 'Cross-section')}</div>
                    <div class="corridor-editor-subtitle">${corridorEditorI18n('modal.corridor.subtitle', 'The corridor keeps its width, so the road does not move')}</div>
                </div>
                <button type="button" class="close-circle-btn corridor-editor-close" aria-label="Close">&times;</button>
            </div>
            <div class="corridor-editor-meta">
                <span>${corridorEditorI18n('modal.corridor.totalWidth', 'Total width')}</span>
                <strong class="corridor-editor-total">${corridorProfileWidth(profile)} m</strong>
            </div>
            <div class="corridor-editor-body"></div>
            <div class="corridor-editor-footer">
                <button type="button" class="btn btn-outline-secondary corridor-editor-cancel">${corridorEditorI18n('modal.corridor.cancel', 'Cancel')}</button>
                <button type="button" class="btn btn-primary corridor-editor-save" disabled>${corridorEditorI18n('modal.corridor.save', 'Save as new proposal')}</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('.corridor-editor-close').addEventListener('click', corridorEditorClose);
    overlay.querySelector('.corridor-editor-cancel').addEventListener('click', corridorEditorClose);
    overlay.querySelector('.corridor-editor-save').addEventListener('click', corridorEditorSave);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) corridorEditorClose(); });
    document.addEventListener('keydown', corridorEditorKeydown);

    corridorEditorRender();
}

// Only a road with a cross-section can be edited this way; a track has no lanes to shuffle.
function proposalHasEditableCorridor(proposal) {
    const definition = (typeof corridorProposalDefinition === 'function') ? corridorProposalDefinition(proposal) : null;
    if (!definition || (definition.metadata && definition.metadata.isTrack)) return false;
    return !!corridorProfileOf(definition);
}

if (typeof window !== 'undefined') {
    window.openCorridorProfileEditor = openCorridorProfileEditor;
    window.proposalHasEditableCorridor = proposalHasEditableCorridor;
}
