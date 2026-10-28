// Public landing activity: normalization and links shared by the browser and fast tests. Every event
// of GET /activity/recent is about an agreement, named by its CID (plan-design-agreement.md, M3).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldActivityModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    // What the landing feed shows: agreements proposed to the index, their outcomes on chain, and the
    // bets and support on them (backend/routes/agent-activity.js RECENT_CHAIN_ACTIONS).
    const TYPES = ['propose', 'execute', 'cancel', 'expire', 'createMarket', 'stake', 'sell', 'resolve', 'claim', 'donate', 'pledge', 'fulfillPledge'];
    // A bet's own actions open that bet (its dialog, at /bets/<agreement account>), not the agreement.
    const BET_TYPES = ['createMarket', 'stake', 'sell', 'resolve', 'claim'];
    const ACCOUNT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    const CID = /^baf(?:krei|ybei)[a-z2-7]{52}$/;
    // The design type of the agreement's first design (its goal), the key of its label.
    function goalKey(event = {}) {
        const goal = typeof event.designGoal === 'string' ? event.designGoal.trim() : '';
        if (!goal) return 'other';
        if (goal === 'parcelBased') return goal;
        return goal.toLowerCase().replace(/[\s_]+/g, '-');
    }
    const shortCid = cid => `${cid.slice(0, 12)}…${cid.slice(-6)}`;
    function prepare(events, limit = 12) {
        const seen = new Set();
        return (Array.isArray(events) ? events : []).flatMap(event => {
            if (!event || event.ok === false || event.source === 'simulation' || !TYPES.includes(event.action?.type)) return [];
            const agreementCid = event.entity?.type === 'agreement' ? event.entity.id : event.action.agreementCid;
            const date = Date.parse(event.occurredAt);
            if (!CID.test(agreementCid || '') || !Number.isFinite(date) || !event.id || seen.has(event.id)) return [];
            seen.add(event.id);
            const agreementAccount = BET_TYPES.includes(event.action.type) && ACCOUNT.test(event.agreementAccount || '')
                ? event.agreementAccount : null;
            const query = new URLSearchParams();
            if (event.cityId) query.set('city', event.cityId);
            const side = event.action.type === 'stake' && ['yes', 'no'].includes(event.action.side) ? event.action.side : null;
            const amount = typeof event.action.amount === 'string' && Number.isFinite(Number(event.action.amount)) ? event.action.amount : null;
            const location = event.location;
            const point = location && typeof location.lat === 'number' && typeof location.lon === 'number'
                && Number.isFinite(location.lat) && Number.isFinite(location.lon)
                && Math.abs(location.lat) <= 90 && Math.abs(location.lon) <= 180 ? { lat: location.lat, lon: location.lon } : null;
            const path = agreementAccount ? '/bets/' + agreementAccount : '/agreements/' + agreementCid;
            const search = query.toString();
            return [{ cityId: event.cityId || null, location: point, id: String(event.id), type: event.action.type, agreementCid,
                designGoal: typeof event.designGoal === 'string' && event.designGoal.trim() ? event.designGoal.trim() : null,
                subject: typeof event.agreementName === 'string' && event.agreementName.trim() ? event.agreementName.trim() : shortCid(agreementCid),
                date, agreementAccount, side, amount,
                href: path + (search ? '?' + search : '') }];
        }).sort((a, b) => b.date - a.date).slice(0, Math.max(0, Math.min(30, limit)));
    }
    function locationOf(event, { city, coverage } = {}) {
        const point = event.location;
        const known = city && city(event.cityId);
        if (known && (!point || distanceKm(point, known) <= 25)) return { kind: 'city', name: known.name };
        if (point && coverage) {
            const place = coverage.nameAt(point.lat, point.lon, 16);
            if (place.name && ['city', 'country'].includes(place.kind)) return { kind: place.kind === 'city' ? 'near' : 'country', name: place.name, cc: place.cc || null };
        }
        return { kind: 'unknown', name: '' };
    }
    function distanceKm(a, b) {
        const rad = Math.PI / 180;
        const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2
            + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
        return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
    }
    return { TYPES, prepare, locationOf, goalKey };
});
