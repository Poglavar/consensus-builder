// Hippodamus's presence in the chat panel, without the DOM: the greeting he opens with, the mood his
// face shows and where his eyes look. js/chat/chat-panel.js applies them to the page.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__chatPersona = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const MOODS = ['idle', 'thinking', 'smile', 'frown'];

    // An open tool comes first (he offers to explain it), then selected parcels, then his general question.
    function greeting({ toolOpen = false, toolTitle = '', parcelCount = 0 } = {}) {
        if (toolOpen) {
            const tool = String(toolTitle || '').trim();
            return tool ? { key: 'chat.greetingTool', params: { tool } } : { key: 'chat.greetingToolUnnamed', params: {} };
        }
        const count = Number.isInteger(parcelCount) && parcelCount > 0 ? parcelCount : 0;
        return count ? { key: 'chat.greetingParcels', params: { count } } : { key: 'chat.greeting', params: {} };
    }

    // What he suggests asking, matching his greeting: about the open tool (chat leaves its draft alone,
    // so only help), about the selected parcels, or a first step anywhere in the city.
    const SUGGESTIONS = Object.freeze({
        tool: ['explain', 'options', 'save'],
        parcels: ['whatAllowed', 'park', 'apartments', 'rowHouses'],
        city: ['whatCanYouDo', 'centre', 'firstBuilding', 'tramLine']
    });
    function suggestions({ toolOpen = false, parcelCount = 0 } = {}) {
        const context = toolOpen ? 'tool' : Number.isInteger(parcelCount) && parcelCount > 0 ? 'parcels' : 'city';
        return SUGGESTIONS[context].map(name => `chat.tips.${context}.${name}`);
    }

    // While a turn runs he thinks; afterwards he shows the turn's reaction (a smile when a plan reached
    // the map, a frown on an error) until its animation ends, and otherwise idles.
    function mood({ pending = false, reaction = null } = {}) {
        if (pending) return 'thinking';
        return reaction === 'smile' || reaction === 'frown' ? reaction : 'idle';
    }

    // How far his pupils turn toward a point on screen, in the portrait's own units: toward the point,
    // growing with its distance up to `reach` pixels, at most `max` units. No point, no turn.
    function gaze(center, point, { max = 0.9, reach = 240 } = {}) {
        const finite = value => typeof value === 'number' && Number.isFinite(value);
        if (!center || !point || ![center.x, center.y, point.x, point.y].every(finite)) return { x: 0, y: 0 };
        const dx = point.x - center.x, dy = point.y - center.y, distance = Math.hypot(dx, dy);
        if (distance === 0) return { x: 0, y: 0 };
        const scale = max * Math.min(1, distance / reach) / distance;
        return { x: dx * scale, y: dy * scale };
    }

    return Object.freeze({ MOODS, greeting, suggestions, mood, gaze });
});
