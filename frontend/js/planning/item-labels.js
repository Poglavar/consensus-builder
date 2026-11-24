// How a Permitted item reads in the reader's language: its use, limit and stage translated, the
// source's own wording kept apart (the inspector shows it quoted, never as app text), and the key to
// the colours it is drawn in. Pure: callers pass the i18n `t` (full keys); no DOM.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningItemLabels = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    // Use groups in legend order (css/planning-views.css has a swatch for each). The palette is one
    // for every city (css/tokens.css): housing yellow to brown by height, commercial red, mixed coral,
    // public purple, industry grey-violet, as US land-use maps mostly draw them.
    const ZONE_GROUPS = Object.freeze(['housing', 'housing-low', 'housing-mid', 'housing-high', 'mixed', 'commercial', 'public', 'industry', 'transport', 'green', 'water',
        'agriculture', 'reserve', 'restricted']);
    // The dictionary's text for a key, or null: i18n answers a key it lacks with the key itself.
    function known(t, key) {
        const text = key ? t(key) : '';
        return text && text !== key ? text : null;
    }
    const isZone = item => item?.assessment?.meaning === 'zoning-area';
    function heightOnlyPlot(item) {
        if (!item?.parcelEnvelope || item.landBasis !== 'zone' || item.sourceEvidence?.parts !== 1) return false;
        const drawable = item.configurations?.filter(configuration => configuration.volumes?.length);
        return !!drawable?.length && drawable.every(configuration => configuration.constraints?.length
            && configuration.constraints.every(rule => rule.quantity === 'height' || rule.quantity === 'storeys'));
    }
    // The use group a Permitted item's source states for its land, or null: one of ZONE_GROUPS.
    const useGroup = item => item?.role === 'permitted' && ZONE_GROUPS.includes(item.use?.group) ? item.use.group : null;
    // The colour role an item is drawn in (--cb-planning-<role>): the use of its land where the source
    // states it, on the zoning area and on the massing derived there alike, else the item's own role.
    function colourRole(item) {
        const group = useGroup(item);
        return group ? `zone-${group}` : item?.role;
    }
    function useName(item, t) {
        return known(t, item?.use?.key && `planningViews.use.${item.use.key}`) || item?.use?.label || '';
    }
    // A zone: its use, height class (or what the plan says of building there) and stage. A parcel's
    // envelope: the use and stage of the zone it stands in; the inspector names the parcel apart.
    function title(item, t, statusLabel = '') {
        if (!item?.use || !(isZone(item) || item.parcelEnvelope)) return item?.title || '';
        const stage = known(t, item.use.stage && `planningViews.zoneStage.${item.use.stage}`);
        if (item.parcelEnvelope) return [useName(item, t), stage].filter(Boolean).join(' · ') || item.title || '';
        const storeys = item.constraints?.find(constraint => constraint.quantity === 'storeys')?.value;
        const extra = item.metrics?.conditional?.storeys;
        const limit = typeof storeys === 'number'
            ? t(extra ? 'planningViews.zoneStoreysConditional' : 'planningViews.zoneStoreys', { storeys, conditional: extra }) : statusLabel;
        return [useName(item, t), limit, stage].filter(Boolean).join(' · ');
    }
    // The source's own name for an item shown under a translated one, or null when the name shown is the source's.
    function sourceWording(item, t, statusLabel) {
        return item?.title && title(item, t, statusLabel) !== item.title ? item.title : null;
    }
    // Text the app translates from a code, else the source's own text, flagged so the caller quotes it.
    function coded(t, prefix, code, text) {
        const translated = known(t, code && `${prefix}.${code}`);
        return translated ? { text: translated, source: false } : text ? { text, source: true } : null;
    }
    const reason = (item, t) => coded(t, 'planningViews.zoneReason', item?.assessment?.reasonCode, item?.assessment?.reason);
    const condition = (conditional, t) => coded(t, 'planningViews.condition', conditional?.conditionCode, conditional?.condition);
    // A zone the plan keeps free of buildings, or leaves to another instrument, has a dashed edge.
    const unbuildableZone = item => isZone(item) && !item.overview && item.assessment.status != null && item.assessment.status !== 'allowed';
    // One legend row: the swatch modifier (css/planning-views.css .planning-swatch--<swatch>) and its words.
    const envelopeRow = t => ({ swatch: 'permitted', text: t('planningViews.legend.envelope') });
    const zoneRow = (group, t) => ({ swatch: `zone-${group}`, text: t(`planningViews.useGroup.${group}`) });
    const dashedRow = t => ({ swatch: 'dashed', text: t('planningViews.legend.dashed') });
    // The colours of the items drawn: envelopes whose source states no use, each use group in legend
    // order (zoning areas and the massing on them share it), then the dashed edge.
    function legend(items, t) {
        const groups = new Set(items.map(useGroup).filter(Boolean));
        return [...(items.some(item => item.parcelEnvelope && !useGroup(item)) ? [envelopeRow(t)] : []),
            ...ZONE_GROUPS.filter(group => groups.has(group)).map(group => zoneRow(group, t)),
            ...(items.some(unbuildableZone) ? [dashedRow(t)] : [])];
    }
    // What the colour of one item means: its use group (and a zone's dashed edge); an envelope whose
    // source states no use has the Permitted colour.
    function colourKey(item, t) {
        const group = useGroup(item);
        if (item?.parcelEnvelope) return [group ? zoneRow(group, t) : envelopeRow(t)];
        if (!isZone(item) || !group) return [];
        return [zoneRow(group, t), ...(unbuildableZone(item) ? [dashedRow(t)] : [])];
    }
    return { ZONE_GROUPS, title, sourceWording, reason, condition, heightOnlyPlot, unbuildableZone, colourRole, legend, colourKey };
});
