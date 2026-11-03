// Relay-owned map state is injected after model arguments, then advanced after each successful command.
const siteTools = new Set(['ugt_draft_building', 'ugt_draft_space', 'ugt_draft_parcel_layout', 'ugt_draft_urban_rule']);
const locationTools = new Set(['ugt_find_place', 'ugt_parcel_context', 'ugt_select_parcels', 'ugt_draft_road', 'ugt_draft_track', 'ugt_draft_station', ...siteTools]);
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
