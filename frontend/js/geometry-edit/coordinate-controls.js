// Native, labelled position fields and nudge buttons for the shared map editors.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GeometryCoordinateControls = api;
})(typeof window !== 'undefined' ? window : globalThis, function (env) {
    'use strict';
    let fieldNumber = 0;

    function text(key, fallback, params = {}) {
        const fullKey = `geometryEditor.${key}`;
        const translated = env.i18n?.t?.(fullKey, params);
        const value = translated && translated !== fullKey ? translated : fallback;
        return value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(params[name] ?? ''));
    }

    function node(doc, tag, className, parent, value) {
        const element = doc.createElement(tag);
        if (className) element.className = className;
        if (value !== undefined) element.textContent = value;
        parent?.appendChild(element);
        return element;
    }

    function button(doc, parent, label, action) {
        const element = node(doc, 'button', 'btn btn-sm', parent, label);
        element.type = 'button';
        element.addEventListener('click', action);
        return element;
    }

    function control(doc, parent, label, tag) {
        const wrapper = node(doc, 'div', 'geometry-controls__field', parent);
        const caption = node(doc, 'label', '', wrapper, label);
        const element = node(doc, tag, 'form-control', wrapper);
        element.id = `geometry-field-${++fieldNumber}`;
        caption.htmlFor = element.id;
        return element;
    }

    function field(doc, parent, label, attributes = {}) {
        const input = control(doc, parent, label, 'input');
        Object.assign(input, { type: 'number', step: 'any', required: true }, attributes);
        return input;
    }

    function select(doc, parent, label) { return control(doc, parent, label, 'select'); }

    function create(options) {
        const doc = options.document || env.document;
        const coordinates = env.GeometryEditCoordinates;
        if (!doc || !coordinates || !options.parent) return null;
        let current = null;
        const root = node(doc, 'fieldset', 'geometry-controls__position', options.parent);
        node(doc, 'legend', '', root, options.label || text('position', 'Position'));
        const fields = node(doc, 'div', 'geometry-controls__fields', root);
        const latitude = field(doc, fields, text('latitude', 'Latitude'), { min: '-90', max: '90' });
        const longitude = field(doc, fields, text('longitude', 'Longitude'), { min: '-180', max: '180' });
        const message = node(doc, 'p', 'geometry-controls__message', root);
        message.setAttribute('role', 'status');
        message.setAttribute('aria-live', 'polite');
        message.setAttribute('aria-atomic', 'true');
        function announce(value, error = false) {
            message.textContent = value;
            message.classList.toggle('is-error', error);
        }
        function setCoordinate(value) {
            current = coordinates.valid(value) ? value.slice(0, 2) : null;
            longitude.value = current ? String(Number(current[0].toFixed(7))) : '';
            latitude.value = current ? String(Number(current[1].toFixed(7))) : '';
            latitude.removeAttribute('aria-invalid');
            longitude.removeAttribute('aria-invalid');
        }
        function apply(point) {
            if (!point) {
                latitude.setAttribute('aria-invalid', String(!latitude.validity.valid));
                longitude.setAttribute('aria-invalid', String(!longitude.validity.valid));
                announce(text('invalidCoordinates', 'Enter a latitude from −90 to 90 and a longitude from −180 to 180.'), true);
                (latitude.validity.valid ? longitude : latitude).reportValidity();
                return;
            }
            const result = options.onChange(point);
            if (!coordinates.valid(result)) {
                announce(text('rejected', 'This change does not fit the allowed boundary or shape.'), true);
                return;
            }
            setCoordinate(result);
            announce(options.successMessage || text('positionUpdatedAt', 'Position updated: latitude {{latitude}}, longitude {{longitude}}.', { latitude: latitude.value, longitude: longitude.value }));
        }
        root.addEventListener('keydown', event => {
            if (event.key !== 'Enter' || ![latitude, longitude].includes(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
            apply(coordinates.parse(longitude.value, latitude.value));
        });
        const applyButton = button(doc, root, options.applyLabel || text('applyCoordinates', 'Apply coordinates'), () => apply(coordinates.parse(longitude.value, latitude.value)));
        const distance = field(doc, root, text('nudgeDistance', 'Move distance (m)'), { min: '0.1', max: '1000', step: '0.1', value: '1' });
        const directions = node(doc, 'div', 'geometry-controls__actions', root);
        const directionButtons = [];
        for (const [direction, fallback] of [['north', 'North'], ['west', 'West'], ['east', 'East'], ['south', 'South']]) {
            const control = button(doc, directions, text(direction, fallback), () => {
                if (!distance.reportValidity()) return;
                if (!current) return;
                apply(coordinates.nudge(current, direction, Number(distance.value), env.turf));
            });
            directionButtons.push({ control, label: text(direction, fallback) });
        }
        function updateDistanceLabels() {
            directionButtons.forEach(({ control, label }) => {
                control.textContent = distance.validity.valid ? `${label} ${distance.value} m` : label;
            });
        }
        if (options.nudges === false) { distance.parentElement.hidden = true; directions.hidden = true; }
        distance.addEventListener('input', updateDistanceLabels);
        updateDistanceLabels();
        return { root, setCoordinate, announce, setApplyLabel: value => { applyButton.textContent = value; }, destroy: () => root.remove() };
    }

    return { create, text, node, button, field, select };
});
