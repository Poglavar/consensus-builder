// Rough 3D envelope of a posted object (step 2a): a footprint plus a storey stack, every value
// tagged with where it came from. Pure; callers supply the footprint and the textual evidence.

const WORD_NUMBERS = { jedan: 1, jednu: 1, jedna: 1, dva: 2, dvije: 2, tri: 3, cetiri: 4, pet: 5, sest: 6, sedam: 7, osam: 8, devet: 9, deset: 10 };
const fold = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLowerCase();

// Croatian storey formulas as written in ads and permits: "P+4", "Po+Pr+3+Uk", "Su+P+2+Pk",
// "Pr+1k", "prizemlje, dva kata i uvučeni kat", "2 nadzemne etaže", "prizemlje i kat".
// Returns { below, ground, upper, top } where top is 'recessed' (uvučeni kat), 'attic'
// (potkrovlje) or null, or null when the text states no storey count.
export function parseStoreys(raw) {
    const text = fold(raw).replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const formula = text.match(/\b((?:po|pod|su|s)\s*\+\s*)*(p|pr|vp)\s*(?:\+\s*(\d{1,2})\s*k?)?(\s*\+\s*(pk|pot|uk|uvk|uv|k))?\b/);
    if (formula && /\+/.test(formula[0])) {
        const below = (formula[0].match(/\b(?:po|pod|su|s)\s*\+/g) || []).length;
        let upper = formula[3] ? Number(formula[3]) : 0;
        const suffix = formula[5];
        let top = null;
        if (suffix && /^(pk|pot)$/.test(suffix)) top = 'attic';
        else if (suffix && /^(uk|uvk|uv)$/.test(suffix)) top = 'recessed';
        else if (suffix === 'k') upper += 1;
        return { below, ground: 1, upper, top, basis: formula[0].replace(/\s+/g, '') };
    }
    const count = word => /^\d+$/.test(word) ? Number(word) : WORD_NUMBERS[word] ?? null;
    const hasGround = /prizemlj/.test(text);
    let upper = 0;
    const floors = text.match(/(\d{1,2}|jedan|jednu|dva|dvije|tri|cetiri|pet|sest|sedam|osam|devet|deset)\.?\s*(?:kat|kata|katova)\b/);
    if (floors) upper = count(floors[1]) ?? 0;
    else if (/\bi\s+(?:1\.\s*)?kat\b|\bkat\b/.test(text) && hasGround) upper = 1;
    const top = /uvucen\w*\s+kat/.test(text) ? 'recessed' : /potkrovl/.test(text) ? 'attic' : null;
    const above = text.match(/(\d{1,2}|dvije|tri|cetiri|pet)\s+nadzemn\w*\s+etaz/);
    if (above && !hasGround) {
        const n = count(above[1]);
        if (n) return { below: 0, ground: 1, upper: n - 1, top, basis: above[0] };
    }
    if (!hasGround && !floors) return null;
    return { below: /podrum|suteren/.test(text) ? 1 : 0, ground: 1, upper, top, basis: text.slice(0, 80) };
}

export const DEFAULT_STOREY_M = Object.freeze({ ground: 3.2, upper: 3.0, top: 3.0, below: 3.0 });

// Storey heights from printed floor elevations (floor level, metres above the ground floor).
// Elevation of floor f ≈ a + h·f for f ≥ 1, where h is the typical storey and a + h the ground
// storey (taller when it is commercial). One point spreads its height evenly over the floors below.
export function storeyHeightsFromElevations(points = []) {
    const usable = points.filter(p => Number.isInteger(p.level) && p.level >= 1 && typeof p.elevationM === 'number' && Number.isFinite(p.elevationM));
    const byLevel = new Map();
    for (const p of usable) if (!byLevel.has(p.level)) byLevel.set(p.level, p.elevationM);
    const pairs = [...byLevel].sort((x, y) => x[0] - y[0]);
    if (!pairs.length) return null;
    let upper, ground, basis;
    if (pairs.length === 1) {
        const [[level, elevation]] = pairs;
        upper = ground = elevation / level;
        basis = `one printed elevation (${elevation} m at floor ${level})`;
    } else {
        const n = pairs.length, mx = pairs.reduce((s, [x]) => s + x, 0) / n, my = pairs.reduce((s, [, y]) => s + y, 0) / n;
        upper = pairs.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / pairs.reduce((s, [x]) => s + (x - mx) ** 2, 0);
        ground = my - upper * mx + upper;
        basis = `${n} printed elevations (${pairs.map(([x, y]) => `${y} m at floor ${x}`).join(', ')})`;
    }
    const round = v => Math.round(v * 100) / 100;
    const plausible = upper >= 2.4 && upper <= 4.8 && ground >= 2.4 && ground <= 8;
    return { upper: round(upper), ground: round(ground), basis, plausible };
}

// Build the storey stack. Elevations are from the ground floor at 0 m; a recessed top floor is
// marked so the renderer can inset it (its outline is unknown until a plan or render shows it).
export function storeyStack(storeys, { heights = DEFAULT_STOREY_M, heightBasis = 'estimated' } = {}) {
    if (!storeys) return [];
    const stack = [];
    for (let i = storeys.below; i >= 1; i--) stack.push({ level: -i, label: i === 1 ? 'Po' : `Po${i}`, heightM: heights.below, outline: 'footprint' });
    stack.push({ level: 0, label: 'Pr', heightM: heights.ground, outline: 'footprint' });
    for (let i = 1; i <= storeys.upper; i++) stack.push({ level: i, label: `${i}. kat`, heightM: heights.upper, outline: 'footprint' });
    if (storeys.top) stack.push({ level: storeys.upper + 1, label: storeys.top === 'recessed' ? 'Uk' : 'Pk', heightM: heights.top,
        outline: storeys.top === 'recessed' ? 'recessed' : 'footprint' });
    let elevation = 0;
    for (const storey of stack.filter(s => s.level >= 0)) { storey.elevationM = Math.round(elevation * 100) / 100; elevation += storey.heightM; }
    elevation = 0;
    for (const storey of stack.filter(s => s.level < 0).sort((a, b) => b.level - a.level)) { elevation -= storey.heightM; storey.elevationM = Math.round(elevation * 100) / 100; }
    return stack.map(storey => ({ ...storey, heightBasis }));
}

// Pick the storey count the evidence agrees on. Sources in priority order; a later source that
// contradicts an earlier one is kept as a conflict, not silently dropped.
export function chooseStoreys(sources) {
    const readings = sources.map(source => ({ ...source, storeys: parseStoreys(source.text) })).filter(source => source.storeys);
    if (!readings.length) return { storeys: null, source: null, conflicts: [] };
    const [best, ...rest] = readings;
    const total = s => s.ground + s.upper + (s.top ? 1 : 0);
    const conflicts = rest.filter(r => total(r.storeys) !== total(best.storeys)).map(r => ({ source: r.kind, basis: r.storeys.basis }));
    return { storeys: best.storeys, source: best.kind, conflicts };
}

export function buildEnvelope({ footprint, footprintSource, storeySources = [], surveyHeightM = null, elevations = [] }) {
    const choice = chooseStoreys(storeySources);
    const measured = storeyHeightsFromElevations(elevations);
    const conflicts = [...choice.conflicts];
    let heights = DEFAULT_STOREY_M, heightBasis = 'estimated';
    if (measured?.plausible) {
        heights = { ...DEFAULT_STOREY_M, ground: measured.ground, upper: measured.upper, top: measured.upper };
        heightBasis = measured.basis;
    } else if (measured) conflicts.push({ source: 'elevations', basis: `${measured.basis} imply implausible storeys (${measured.ground} m / ${measured.upper} m)` });
    let stack = storeyStack(choice.storeys, { heights, heightBasis });
    // An existing building's surveyed height can stand in for a missing storey count.
    if (!stack.length && typeof surveyHeightM === 'number' && Number.isFinite(surveyHeightM) && surveyHeightM > 2) {
        const above = Math.max(1, Math.round(surveyHeightM / DEFAULT_STOREY_M.upper));
        stack = storeyStack({ below: 0, ground: 1, upper: above - 1, top: null }, { heightBasis: 'survey-height' });
        choice.source = 'survey-height';
    }
    const heightM = stack.filter(s => s.level >= 0).reduce((sum, s) => sum + s.heightM, 0);
    return { schema: 'building-envelope.v1', footprint, footprintSource, storeys: stack, storeySource: choice.source,
        heightBasis, conflicts, heightM: Math.round(heightM * 100) / 100,
        surveyHeightM: typeof surveyHeightM === 'number' ? surveyHeightM : null };
}
