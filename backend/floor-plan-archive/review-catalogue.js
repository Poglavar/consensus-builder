// Pure response shaping for the floor-plan review API, independent of database I/O.
export function buildingName(ownerId, floorId) {
    const owner = String(ownerId || '').toLowerCase();
    const site = owner.includes('savica') ? 'Savica' : owner.includes('lovinc') ? 'Lovinčićeva'
        : owner.includes('spansko') ? 'Špansko sjever' : owner.includes('borongaj') ? 'Borongajska – Čavićeva'
        : String(ownerId || 'Building').replaceAll('-', ' ');
    const prefix = String(floorId || '').split('-floor-')[0];
    return prefix ? `${site} · ${prefix}` : site;
}

export function centroid(geometry) {
    const points = [];
    const visit = value => {
        if (!Array.isArray(value)) return;
        if (value.length >= 2 && !Array.isArray(value[0])) {
            if (Number.isFinite(value[0]) && Number.isFinite(value[1]) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90) points.push(value);
        } else value.forEach(visit);
    };
    visit(geometry?.coordinates);
    if (!points.length) return null;
    const longitudes = points.map(p => p[0]), latitudes = points.map(p => p[1]);
    return { longitude: (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
        latitude: (Math.min(...latitudes) + Math.max(...latitudes)) / 2 };
}

export function sourceView(row) {
    const model = row.model || {}, source = model.source || {};
    const sourceUrl = source.url || model.sourceUrl || row.source_url || null;
    let filename = row.sha256.slice(0, 12);
    try {
        const url = new URL(sourceUrl);
        filename = `${decodeURIComponent(url.pathname.split('/').filter(Boolean).slice(-2).join(' / ') || url.hostname)} · ${url.hostname}`;
    } catch { /* A malformed source URL remains inspectable by its content hash. */ }
    return { sha256: row.sha256, status: row.status, mediaType: row.media_type?.split(';')[0].toLowerCase(),
        label: source.label || model.label || row.label || filename, sourceUrl };
}

export function planViews(floorPlans) {
    const layouts = new Map((floorPlans?.layouts || []).map(layout => [layout.id, layout]));
    return (floorPlans?.floors || []).map(floor => {
        const layout = layouts.get(floor.layoutId) || {};
        return { id: floor.id, label: `${String(floor.id).split('-floor-')[0]} · ${floor.level}`, level: floor.level,
            architecture: layout.architecture || null, source: floor.source || layout.source || null,
            rooms: floor.rooms || layout.rooms || undefined };
    });
}

export function buildingSummary(row) {
    const first = row.first_floor ?? row.floor_plans?.floors?.[0]?.id;
    return { id: `registered-${row.id}`, name: buildingName(row.owner_id, first), kind: 'registered',
        planCount: Number(row.floor_count ?? row.floor_plans?.floors?.length ?? 0),
        locationAvailable: row.has_footprint ?? Boolean(centroid(row.footprint)), wholeBuildingAvailable: true };
}

export function buildingView(row) {
    const floorPlans = row.floor_plans || {}, footprint = row.footprint || null, location = centroid(footprint);
    return { ...buildingSummary(row), footprint,
        location: location ? { ...location, basis: 'registered-footprint' } : null,
        floorPlans, plans: planViews(floorPlans), wholeBuilding: { type: 'floor-stack' } };
}

export function catalogueCounts(buildings, sources) {
    return { buildings: buildings.length, sources: sources.length,
        plans: buildings.reduce((n, b) => n + b.planCount, 0), architecture: sources.filter(s => s.architectureAvailable).length };
}
