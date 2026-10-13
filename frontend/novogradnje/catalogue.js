// Pure catalogue filtering and URL-state helpers for zagreb.lol/novogradnje.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NovogradnjeCatalogue = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const KINDS = new Set(['new_build', 'existing', 'unknown', 'all']);
    const ORIENTATIONS = new Set(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const numeric = value => value === '' || value == null || !Number.isFinite(Number(value)) ? null : Number(value);
    const folded = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
    function normalizeFilters(input = {}) {
        return {
            q: String(input.q || '').trim(), kind: KINDS.has(input.kind) ? input.kind : 'new_build',
            minArea: numeric(input.minArea), maxArea: numeric(input.maxArea), rooms: numeric(input.rooms),
            orientation: ORIENTATIONS.has(input.orientation) ? input.orientation : ''
        };
    }
    function matchesApartment(apartment, filters) {
        if (filters.minArea !== null && (!finite(apartment.areaM2) || apartment.areaM2 < filters.minArea)) return false;
        if (filters.maxArea !== null && (!finite(apartment.areaM2) || apartment.areaM2 > filters.maxArea)) return false;
        if (filters.rooms !== null && (!finite(apartment.rooms) || (filters.rooms >= 5 ? apartment.rooms < 5 : apartment.rooms !== filters.rooms))) return false;
        if (filters.orientation && !(apartment.orientation || []).includes(filters.orientation)) return false;
        return true;
    }
    function placementTransform(best, dimensionsM) {
        if (!best || !Array.isArray(dimensionsM) || !Number.isFinite(dimensionsM[1]) || !Number.isFinite(best.scale) || best.scale<=0
            || ![best.scale,best.rotationDeg,best.tx,best.ty].every(Number.isFinite)) return null;
        const radians=best.rotationDeg*Math.PI/180, depth=dimensionsM[1];
        // buildLocalUnitGroup maps image coordinates to [u*w,(1-v)*h]; site fitting uses [u*w,-v*h].
        return {scale:best.scale,rotation:radians,x:best.tx+best.scale*Math.sin(radians)*depth,
            y:best.ty-best.scale*Math.cos(radians)*depth};
    }
    function filterProjects(projects, input = {}) {
        const filters = normalizeFilters(input), query = folded(filters.q);
        return (projects || []).filter(project => {
            if (filters.kind !== 'all' && project.kind !== filters.kind) return false;
            const apartmentTitles=(project.apartments||[]).map(apartment=>apartment.sourceTitle||'');
            const searchText=[project.name,project.label,project.address,project.slug,...(project.titles||[]),...apartmentTitles].join(' ');
            if (query && !folded(searchText).includes(query)) return false;
            const apartments = (project.apartments || []).filter(apartment => matchesApartment(apartment, filters));
            const hasApartmentFilters=filters.minArea!==null||filters.maxArea!==null||filters.rooms!==null||Boolean(filters.orientation);
            return apartments.length > 0 || (!hasApartmentFilters && (project.apartments||[]).length===0);
        }).map(project => ({ ...project, apartments: (project.apartments || []).filter(apartment => matchesApartment(apartment, filters)) }));
    }
    function encodeFilters(input) {
        const f = normalizeFilters(input), params = new URLSearchParams();
        if (f.q) params.set('q', f.q);
        if (f.kind !== 'new_build') params.set('kind', f.kind);
        if (f.minArea !== null && Number.isFinite(f.minArea)) params.set('min', String(f.minArea));
        if (f.maxArea !== null && Number.isFinite(f.maxArea)) params.set('max', String(f.maxArea));
        if (f.rooms !== null && Number.isFinite(f.rooms)) params.set('rooms', String(f.rooms));
        if (f.orientation) params.set('orientation', f.orientation);
        return params.toString();
    }
    function decodeFilters(search) {
        const p = new URLSearchParams(search || '');
        return normalizeFilters({ q: p.get('q'), kind: p.get('kind'), minArea: p.get('min'), maxArea: p.get('max'), rooms: p.get('rooms'), orientation: p.get('orientation') });
    }
    return { normalizeFilters, matchesApartment, placementTransform, filterProjects, encodeFilters, decodeFilters };
});
