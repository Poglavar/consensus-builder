// proposals/dialog-share.js — extracted from proposals.js (behavior-preserving relocation).

// The "waiting for transaction" box: a message dialog on the shared chrome (js/ui/dialogs.js) with
// no answers, over any dialog it was opened from; it blocks the map until hideProposalWaitingPopup.
let proposalWaitingDialog = null;

function showProposalWaitingPopup(message = 'Waiting for transaction...') {
    if (proposalWaitingDialog && proposalWaitingDialog.overlay.isConnected) {
        const textEl = proposalWaitingDialog.body.querySelector('.proposal-waiting-text');
        if (textEl) textEl.textContent = message;
        return;
    }
    if (!window.CbDialog) return;
    const card = document.createElement('div');
    card.className = 'proposal-waiting-card';
    const indicator = document.createElement('span');
    indicator.className = 'proposal-waiting-spinner';
    indicator.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'proposal-waiting-text';
    text.textContent = message;
    card.appendChild(indicator);
    card.appendChild(text);
    proposalWaitingDialog = window.CbDialog.open({
        message: true, size: 'sm', top: true, role: 'alertdialog',
        className: 'proposal-waiting-dialog', overlayClassName: 'proposal-waiting-overlay',
        body: card, closeOnBackdrop: false, closeOnEscape: false, autofocus: false,
        onClose: () => { proposalWaitingDialog = null; }
    });
    if (proposalWaitingDialog) proposalWaitingDialog.overlay.id = 'proposal-waiting-popup';
}

function hideProposalWaitingPopup() {
    if (proposalWaitingDialog) proposalWaitingDialog.close(null);
    proposalWaitingDialog = null;
}

function showProposalWaitingPopupTemporary(message = 'Transaction rejected', duration = 2000) {
    showProposalWaitingPopup(message);
    setTimeout(() => {
        hideProposalWaitingPopup();
    }, Math.max(500, duration));
}

function scheduleDebouncedProposalListModalRender() {
    clearProposalListFilterInputDebounce();
    _proposalListFilterInputDebounceTimer = setTimeout(() => {
        _proposalListFilterInputDebounceTimer = null;
        renderProposalListModal();
    }, PROPOSAL_LIST_FILTER_INPUT_DEBOUNCE_MS);
}

function renderProposalListModal() {
    return window.ListsPanel?.refresh();
}

async function showAllProposalsModal() {
    return openDesignsTab('browse');
}

function showSimpleShareModal(options = {}) {
    if (typeof document === 'undefined' || !window.CbDialog) return null;

    const t = getProposalI18nHelper();
    const closeLabel = t('modal.common.close', 'Close');
    const actions = (Array.isArray(options.actions) ? options.actions : []).map(action => ({
        id: action && action.id != null ? action.id : undefined,
        label: (action && action.label) || closeLabel,
        role: action && action.primary ? 'primary' : 'secondary',
        disabled: !!(action && action.disabled),
        keepOpen: !!(action && action.keepOpen),
        onClick: () => { if (action && typeof action.onClick === 'function') action.onClick(modalApi); }
    }));

    // The share dialog on the shared chrome (js/ui/dialogs.js); `share-modal` stays as the identity
    // class its inner rules in css/modals.css are keyed on.
    const api = window.CbDialog.open({
        title: options.title || '',
        size: options.size || 'md',
        className: 'share-modal' + (options.className ? ' ' + options.className : ''),
        // `share-modal-overlay` is a hook for the e2e specs and paints nothing.
        overlayClassName: 'share-modal-overlay',
        bodyClassName: 'share-modal-body',
        body: options.body,
        actions,
        closeLabel,
        closeOnBackdrop: options.closeOnOverlay !== false,
        closeOnEscape: options.closeOnEscape !== false,
        autoCloseActions: options.autoCloseActions !== false,
        // The element the dialog focuses once it has laid out (CbDialog focuses on the next frame,
        // after a caller's own synchronous focus), e.g. a link input to copy by hand.
        initialFocus: options.initialFocus || null,
        onClose: () => { if (typeof options.onClose === 'function') options.onClose(); }
    });
    if (!api) return null;

    const modalApi = {
        close: () => api.close(null),
        overlay: api.overlay,
        modal: api.dialog,
        body: api.body,
        getActionButton: (id) => api.getActionButton(id)
    };
    return modalApi;
}
