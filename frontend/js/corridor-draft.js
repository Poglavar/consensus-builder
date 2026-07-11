// Purpose: derive an editable road-drawing seed from an immutable corridor proposal definition.
(function attachCorridorDraft(global) {
    const ACTIVE_DRAFT_KEY = 'consensus-builder.active-corridor-draft.v1';
    let allowNextUnload = false;

    function cloneDraftValue(value) {
        if (value === undefined || value === null) return value;
        return JSON.parse(JSON.stringify(value));
    }

    function buildCorridorDrawingSeed(definition, profileOverride) {
        if (!definition || typeof definition !== 'object') return null;
        const centerline = Array.isArray(definition.points) && definition.points.length
            ? definition.points
            : definition.segments;
        if (!Array.isArray(centerline) || !centerline.length) return null;

        return {
            centerline: cloneDraftValue(centerline),
            width: definition.width,
            sidewalkWidth: definition.sidewalkWidth,
            segmentIds: Array.isArray(definition.segmentIds) ? definition.segmentIds.slice() : [],
            profile: cloneDraftValue(profileOverride || definition.profile) || null
        };
    }

    function resolveCorridorScreenshotGeometry(proposal, fallbackPolygon) {
        const corridor = proposal?.roadProposal?.definition?.polygon
            || proposal?.definition?.polygon
            || null;
        if (corridor && Array.isArray(corridor.coordinates) && corridor.coordinates.length) {
            return { polygon: corridor.coordinates, polygonOrder: 'lnglat', fitToPolygonOnly: true };
        }
        return { polygon: fallbackPolygon, polygonOrder: 'auto', fitToPolygonOnly: false };
    }

    function draftStorage(storage) {
        return storage || global.localStorage || null;
    }

    function saveActiveCorridorDraft(draft, storage) {
        if (!draft || !draft.kind || !draft.seed) return null;
        const record = cloneDraftValue({
            ...draft,
            dirty: true,
            updatedAt: new Date().toISOString()
        });
        const target = draftStorage(storage);
        if (!target || typeof target.setItem !== 'function') return null;
        target.setItem(ACTIVE_DRAFT_KEY, JSON.stringify(record));
        return record;
    }

    function getActiveCorridorDraft(storage) {
        const target = draftStorage(storage);
        if (!target || typeof target.getItem !== 'function') return null;
        try {
            const value = JSON.parse(target.getItem(ACTIVE_DRAFT_KEY) || 'null');
            return value && value.kind && value.seed && value.dirty === true ? value : null;
        } catch (_) {
            return null;
        }
    }

    function clearActiveCorridorDraft(storage) {
        const target = draftStorage(storage);
        if (target && typeof target.removeItem === 'function') target.removeItem(ACTIVE_DRAFT_KEY);
    }

    function corridorDraftT(key, fallback) {
        try {
            if (global.i18n && typeof global.i18n.t === 'function') {
                const translated = global.i18n.t(key, {});
                if (translated && translated !== key) return translated;
            }
        } catch (_) { }
        return fallback;
    }

    function corridorDraftMessage(reason) {
        const messages = {
            cancel: corridorDraftT('modal.corridorDraft.cancelBody', 'This drawing has changes that are not in a proposal yet.'),
            city: corridorDraftT('modal.corridorDraft.cityBody', 'Switching cities will close this drawing. You can keep it and resume it when you return.'),
            replace: corridorDraftT('modal.corridorDraft.replaceBody', 'Starting another drawing will replace the current draft.'),
            wipe: corridorDraftT('modal.corridorDraft.wipeBody', 'Wiping local data will permanently delete this drawing draft.')
        };
        return messages[reason] || messages.cancel;
    }

    function askCorridorDraftDecision(reason, options = {}) {
        const allowKeep = options.allowKeep !== false;
        if (!global.document || !global.document.body) {
            return Promise.resolve('stay');
        }
        return new Promise(resolve => {
            const overlay = global.document.createElement('div');
            overlay.className = 'cb-confirm-overlay corridor-draft-overlay';
            const dialog = global.document.createElement('div');
            dialog.className = 'cb-confirm-dialog corridor-draft-dialog';
            dialog.innerHTML = `
                <h3>${corridorDraftT('modal.corridorDraft.title', 'Unsaved drawing draft')}</h3>
                <div class="cb-confirm-message">${corridorDraftMessage(reason)}</div>
                <div class="cb-confirm-buttons corridor-draft-buttons"></div>`;
            const buttons = dialog.querySelector('.corridor-draft-buttons');

            const addButton = (choice, label, className) => {
                const button = global.document.createElement('button');
                button.type = 'button';
                button.className = className;
                button.textContent = label;
                button.dataset.draftChoice = choice;
                button.addEventListener('click', () => close(choice));
                buttons.appendChild(button);
                return button;
            };
            const close = choice => {
                overlay.remove();
                resolve(choice);
            };

            const stay = addButton('stay', corridorDraftT('modal.corridorDraft.continueEditing', 'Continue editing'), 'btn btn-secondary');
            addButton('discard', reason === 'wipe'
                ? corridorDraftT('modal.corridorDraft.discardAndWipe', 'Discard and wipe')
                : corridorDraftT('modal.corridorDraft.discard', 'Discard draft'), 'btn btn-danger');
            if (allowKeep) {
                addButton('keep', corridorDraftT('modal.corridorDraft.keep', 'Keep draft'), 'btn btn-primary');
            }

            overlay.addEventListener('click', event => {
                if (event.target === overlay) close('stay');
            });
            dialog.addEventListener('keydown', event => {
                if (event.key === 'Escape') close('stay');
            });
            overlay.appendChild(dialog);
            global.document.body.appendChild(overlay);
            stay.focus();
        });
    }

    async function guardActiveCorridorDraft(reason, options = {}) {
        const draft = getActiveCorridorDraft();
        if (!draft) return { proceed: true, choice: 'none', draft: null };
        const choice = await askCorridorDraftDecision(reason, options);
        if (choice === 'discard') clearActiveCorridorDraft();
        return { proceed: choice !== 'stay', choice, draft };
    }

    function allowCorridorDraftUnloadOnce() {
        allowNextUnload = true;
    }

    global.buildCorridorDrawingSeed = buildCorridorDrawingSeed;
    global.resolveCorridorScreenshotGeometry = resolveCorridorScreenshotGeometry;
    global.saveActiveCorridorDraft = saveActiveCorridorDraft;
    global.getActiveCorridorDraft = getActiveCorridorDraft;
    global.clearActiveCorridorDraft = clearActiveCorridorDraft;
    global.askCorridorDraftDecision = askCorridorDraftDecision;
    global.guardActiveCorridorDraft = guardActiveCorridorDraft;
    global.allowCorridorDraftUnloadOnce = allowCorridorDraftUnloadOnce;

    if (global.addEventListener) {
        global.addEventListener('beforeunload', event => {
            if (allowNextUnload) {
                allowNextUnload = false;
                return;
            }
            if (!getActiveCorridorDraft()) return;
            event.preventDefault();
            event.returnValue = '';
        });
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            ACTIVE_DRAFT_KEY,
            buildCorridorDrawingSeed,
            resolveCorridorScreenshotGeometry,
            saveActiveCorridorDraft,
            getActiveCorridorDraft,
            clearActiveCorridorDraft
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
