// Storey numbering as the reader counts it: a building's storey level (0 = the storey at street level,
// negative below ground) as display words, by the locale's convention (i18n.js LOCALE_CHOICES
// `storeyNumbering`). 'ground-zero' (the default): level 0 is the ground floor and level 1 the 1st
// floor. 'ground-one' (Russian, Kazakh): level 0 is already the 1st floor. Display only: levels,
// unit IDs and links keep the level itself.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && root.document) root.StoreyNumbering = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const CONVENTIONS = Object.freeze(['ground-zero', 'ground-one']);

    // The active locale's convention; 'ground-zero' without the i18n runtime (node tests, agents).
    function current() {
        const convention = root?.i18n?.getStoreyNumbering?.();
        return CONVENTIONS.includes(convention) ? convention : 'ground-zero';
    }

    /**
     * A storey level as { kind: 'ground' | 'storey' | 'basement', number }: the number the reader
     * says ("Floor 2", "Basement 1"); the ground floor has number 0. `convention` defaults to the
     * active locale's.
     */
    function storeyOf(level, convention = current()) {
        if (!Number.isSafeInteger(level)) throw new Error(`storeyOf: level must be an integer, got ${level}`);
        if (!CONVENTIONS.includes(convention)) throw new Error(`storeyOf: unknown convention ${convention}`);
        if (level < 0) return { kind: 'basement', number: -level };
        if (convention === 'ground-one') return { kind: 'storey', number: level + 1 };
        return level === 0 ? { kind: 'ground', number: 0 } : { kind: 'storey', number: level };
    }

    /**
     * The number that stands for the storey in a compact template ("Floor {{level}} · Apartment 3"):
     * a storey's own number; the ground floor and basements keep the level (0, -1).
     */
    function storeyFigure(level, convention = current()) {
        const storey = storeyOf(level, convention);
        return storey.kind === 'storey' ? storey.number : level;
    }

    /** The storey's name ("Ground floor", "Floor 2", "Basement 1") through `t(key, fallback, params)`. */
    function storeyLabel(level, t, convention = current()) {
        const { kind, number } = storeyOf(level, convention);
        if (kind === 'basement') return t('threeMode.controls.floorBasement', `Basement ${number}`, { level: number });
        if (kind === 'ground') return t('threeMode.controls.floorGround', 'Ground floor', {});
        return t('threeMode.controls.floorLevel', `Floor ${number}`, { level: number });
    }

    return { CONVENTIONS, current, storeyOf, storeyFigure, storeyLabel };
});
