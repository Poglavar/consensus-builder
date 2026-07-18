// Pure keyboard routing policy for 3D mode. It separates the 3D shortcut context from legacy
// 2D document shortcuts without interfering with text entry or native control activation.
(function attachThreeKeyboardContext(global) {
    'use strict';

    function tagNameOf(target) {
        return String(target?.tagName || '').toUpperCase();
    }

    function isTextEntryTarget(target) {
        const tagName = tagNameOf(target);
        return target?.isContentEditable === true
            || tagName === 'INPUT'
            || tagName === 'TEXTAREA'
            || tagName === 'SELECT'
            || tagName === 'OPTION';
    }

    function isNativeControlActivation(target, key) {
        const tagName = tagNameOf(target);
        if (key !== 'Enter' && key !== ' ') return false;
        return tagName === 'BUTTON' || tagName === 'A';
    }

    function isBrowserNavigationKey(key) {
        return key === 'Tab' || /^F\d{1,2}$/.test(String(key || ''));
    }

    function classifyThreeModeKeydown(input = {}) {
        if (input.active !== true) return 'pass';
        if (isTextEntryTarget(input.target) || isNativeControlActivation(input.target, input.key)) return 'pass';
        // Focus traversal and browser function keys are native navigation, not 2D app shortcuts.
        if (isBrowserNavigationKey(input.key)) return 'pass';
        // Keep the browser/OS default (refresh, location bar, etc.) but do not let application-level
        // 2D listeners observe modifier shortcuts while the 3D context owns the document.
        if (input.ctrlKey || input.metaKey || input.altKey) return 'block-2d-native';
        if (input.key === 'Escape' && input.walkPickActive) return 'cancel-walk';
        if (input.key === 'Escape' && input.hasIsolation) return 'clear-isolation';
        return 'block-2d';
    }

    const api = { classifyThreeModeKeydown, isTextEntryTarget, isNativeControlActivation, isBrowserNavigationKey };
    if (typeof window !== 'undefined') window.__threeKeyboardContext = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
