// Relay-owned map state is injected after model arguments, then advanced after each successful command.
const siteTools = new Set(['ugt_draft_building', 'ugt_draft_space', 'ugt_draft_parcel_layout', 'ugt_draft_urban_rule']);
const locationTools = new Set(['ugt_find_place', 'ugt_parcel_context', 'ugt_select_parcels', 'ugt_draft_road', 'ugt_draft_track', 'ugt_draft_station', ...siteTools]);
// The selection the model sees, a page at a time: parcel ids from `offset` while they fit in
// SELECTION_PAGE_BYTES of JSON (a tool result reaches the model cut at 4 KB, tool-results.js), how
// many there are in all, and the offset read_selection reads on from (null once the page reaches
// the end). A selection may hold up to 5000 parcels; the model never sees it cut without knowing.
export const SELECTION_PAGE_BYTES = 3000;
// read_selection answers from the relay, not through that cut, so its pages are larger: about 500
// ids each. A model call holds at most 60,000 input tokens (cost.js) and an id costs about a dozen,
// so no call holds all of 5000: the model pages through what it needs, over more than one turn
// for the largest selections.
export const READ_SELECTION_PAGE_BYTES = 16_000;
export function selectionPage(parcelIds, offset = 0, budget = SELECTION_PAGE_BYTES) {
    const ids = Array.isArray(parcelIds) ? parcelIds.map(id => String(id).slice(0, 250)) : [];
    const start = Math.min(Math.max(0, Math.trunc(Number(offset)) || 0), ids.length);
    const page = [];
    let bytes = 2;
    for (let i = start; i < ids.length; i++) {
        const size = Buffer.byteLength(JSON.stringify(ids[i]), 'utf8') + 1;
        if (page.length && bytes + size > budget) break;
        page.push(ids[i]);
        bytes += size;
    }
    const next = start + page.length;
    return { parcelCount: ids.length, offset: start, parcelIds: page, nextOffset: next < ids.length ? next : null };
}
// The selection's ids as the prompt and tool results carry them: the first page, the count, and
// where to read on when the page does not reach the end.
export function selectionSummary(parcelIds) {
    const page = selectionPage(parcelIds);
    return { parcelCount: page.parcelCount, parcelIds: page.parcelIds, ...(page.nextOffset !== null ? { parcelIdsNextOffset: page.nextOffset } : {}) };
}
export function searchBounds(view) {
    const at = typeof view?.at === 'string' ? view.at.split(',').map(Number) : [];
    if (at.length < 2 || !at.every(Number.isFinite)) return null;
    const [lat, lng] = at;
    if (Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
    return [Math.max(-180, lng - 0.15), Math.max(-85, lat - 0.15), Math.min(180, lng + 0.15), Math.min(85, lat + 0.15)];
}
export function injectMapArgs(name, input, context = {}) {
    const args = { ...input };
    if (name === 'ugt_map_view') args.view = context.view;
    if (name === 'ugt_select_parcels') {
        args.selection = context.selection || {};
        delete args.visibleParcels; delete args.visibleParcelsTruncated;
        if (args.parcelNumber != null && context.mapContext) {
            const mapped = context.mapContext;
            if (mapped.parcelSourceId && mapped.parcelSourceId !== (args.parcelSourceId || context.parcelSourceId))
                throw Object.assign(new Error('Visible parcel labels belong to another source.'), { code: 'parcel-label-source-mismatch' });
            args.visibleParcels = mapped.visibleParcels;
            args.visibleParcelsTruncated = mapped.visibleParcelsTruncated;
            if (mapped.viewBounds) args.bbox = mapped.viewBounds;
        }
        if (args.action === 'random' && args.point == null) {
            const bounds = searchBounds(context.view);
            if (bounds) { const [lat, lng] = context.view.at.split(',').map(Number); args.point = [lng, lat]; }
        }
    }
    if (locationTools.has(name)) {
        if (!args.city && context.city) args.city = context.city;
        if (!args.parcelSourceId && context.parcelSourceId) args.parcelSourceId = context.parcelSourceId;
    }
    if (name === 'ugt_find_place' && !args.bbox) {
        const bounds = searchBounds(context.view);
        if (bounds) args.bbox = bounds;
    }
    if (siteTools.has(name) && !args.outline && !args.parcelIds && context.selection?.parcelIds?.length) {
        args.parcelIds = [...context.selection.parcelIds];
    }
    return args;
}
export function navigationResult(name, result) {
    const data = result?.structuredContent || result;
    if (result?.isError || data?.ok === false) return null;
    if (name === 'ugt_map_view' && data?.view) return { name: 'view', data: { view: data.view,
        ...(typeof data.parcelIdsVisible === 'boolean' ? { parcelIdsVisible: data.parcelIdsVisible } : {}),
        ...(typeof data.roadTracksVisible === 'boolean' ? { roadTracksVisible: data.roadTracksVisible } : {}) } };
    if (name === 'ugt_select_parcels' && data?.selection) return { name: 'selection', data: { selection: data.selection, ...(data.point ? { point: data.point } : {}) } };
    return null;
}
