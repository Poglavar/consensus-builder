// One behaviour for every list of map objects beside the map (docs/design-language.md, "Object
// lists"): hovering or focusing an item outlines its object, clicking it keeps that outline (the item
// shows pressed) until it is clicked again, and only the item's own open button goes to the object.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ObjectList = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // Controls inside an item keep their own actions; a click on one neither presses nor releases it.
    const CONTROLS = 'button, a, input, select, textarea, label, summary, [role="button"], [role="tab"]';

    // container: the list's element (items may be re-rendered inside it).
    // item: selector of one item; keyOf(item): its object's key, or null for an item with none.
    // pressed(item): the element that carries aria-pressed (the item itself unless it is not a control).
    // show(key, { pinned, item }): outline one object; pinned is true on the click that presses it.
    // restore(): outline what the list showed before (nothing, or its owner's own highlight).
    function bind(container, { item, keyOf, show, restore, pressed = element => element }) {
        let pinned = null; // { key, element }
        const itemOf = target => {
            const element = target?.closest?.(item);
            return element && container.contains(element) ? element : null;
        };
        const live = () => {
            if (pinned && !pinned.element.isConnected) {
                // Its list was rendered anew: the same object's new item stays pressed.
                const again = [...container.querySelectorAll(item)].find(element => keyOf(element) === pinned.key);
                pinned = again ? { key: pinned.key, element: again } : null;
                if (again) pressed(again).setAttribute('aria-pressed', 'true');
            }
            return pinned;
        };
        const back = () => { if (live()) show(pinned.key, { pinned: false, item: pinned.element }); else restore(); };
        const enter = event => {
            const element = itemOf(event.target);
            if (!element || element.contains(event.relatedTarget)) return;
            const key = keyOf(element);
            if (key != null) show(key, { pinned: false, item: element });
        };
        const leave = event => {
            const element = itemOf(event.target);
            if (element && !element.contains(event.relatedTarget) && keyOf(element) != null) back();
        };
        const click = event => {
            const element = itemOf(event.target);
            if (!element) return;
            const target = pressed(element);
            const control = event.target.closest(CONTROLS);
            if (control && control !== target && element.contains(control)) return;
            const key = keyOf(element);
            if (key == null) return;
            const same = live()?.key === key;
            if (pinned) pressed(pinned.element).setAttribute('aria-pressed', 'false');
            pinned = same ? null : { key, element };
            if (pinned) {
                target.setAttribute('aria-pressed', 'true');
                show(key, { pinned: true, item: element });
            } else restore();
        };
        container.addEventListener('mouseover', enter);
        container.addEventListener('mouseout', leave);
        container.addEventListener('focusin', enter);
        container.addEventListener('focusout', leave);
        container.addEventListener('click', click);
        return {
            // The owner highlighted something else (a selection, a refresh): nothing stays pressed.
            reset() {
                if (pinned?.element.isConnected) pressed(pinned.element).setAttribute('aria-pressed', 'false');
                pinned = null;
            },
            pinnedKey: () => live()?.key ?? null,
            unbind() {
                container.removeEventListener('mouseover', enter);
                container.removeEventListener('mouseout', leave);
                container.removeEventListener('focusin', enter);
                container.removeEventListener('focusout', leave);
                container.removeEventListener('click', click);
            }
        };
    }

    // The item's open button: an arrow named "Open <name>" (lists.openNamed).
    function openButton(doc, name, win, { className = '', onOpen = null } = {}) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = `btn btn-icon object-list__open${className ? ` ${className}` : ''}`;
        const label = win?.i18n?.t?.('lists.openNamed', { title: name }) || `Open ${name}`;
        button.title = label;
        button.setAttribute('aria-label', label);
        const icon = doc.createElement('i');
        icon.className = 'fas fa-arrow-right';
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
        if (onOpen) button.addEventListener('click', event => { event.stopPropagation(); onOpen(event); });
        return button;
    }

    return Object.freeze({ bind, openButton, CONTROLS });
});
