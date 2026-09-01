// One presentation contract for the proposal details panel's Apply/Unapply button.
//
// The details renderer, apply completion path, and unapply completion path used to each invent their
// own icon and attributes. The same still-applied proposal therefore changed from an archive icon to
// a crossed eye after a failed unapply, which looked like a third "hidden" state. There are only two
// states here: applied and unapplied.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalMapAction = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function presentation(applied, translate) {
        const t = typeof translate === 'function' ? translate : (_key, fallback) => fallback;
        return applied
            ? {
                applied: true,
                className: 'btn btn-warning',
                iconClass: 'fa-box-archive',
                label: t('panel.proposal.actions.remove', 'Unapply'),
                handlerName: 'removeProposalFromMap',
                defaultAction: false
            }
            : {
                applied: false,
                className: 'btn btn-success proposal-action-default',
                iconClass: 'fa-check',
                label: t('panel.proposal.actions.apply', 'Apply to map'),
                handlerName: 'applyProposalToMap',
                defaultAction: true
            };
    }

    function renderButton(button, proposalId, applied, translate) {
        if (!button) return null;
        const view = presentation(applied, translate);
        const safeId = String(proposalId).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        button.disabled = false;
        button.style.opacity = '';
        button.style.cursor = '';
        button.className = view.className;
        button.innerHTML = `<i class="fas ${view.iconClass}"></i> ${view.label}`;
        button.setAttribute('onclick', `${view.handlerName}('${safeId}')`);
        if (view.defaultAction) {
            button.setAttribute('data-default-action', 'true');
            button.setAttribute('aria-keyshortcuts', 'Enter');
        } else {
            button.removeAttribute('data-default-action');
            button.removeAttribute('aria-keyshortcuts');
        }
        return button;
    }

    return Object.freeze({ presentation, renderButton });
});
