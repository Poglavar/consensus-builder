// Read Bogotá POT (Decreto 555/2021) treatment-map and front-yard-map attributes as dimensional
// constraints in metres for the shared parcel evaluator. Pure: no network, no geometry of its own;
// a parcel's floor areas come in through a caller-supplied measure.
// Every number here is a decree rule or a map value; the citation travels with the constraint.
// Rules: Decreto 555/2021 (arts. 258, 260, 303–304, 310, 314, 338) and its Anexo 5 "Manual de
// normas comunes" as updated by Decreto 466/2024 (§1.3, §1.5, §1.9, §1.11, §3.1, §4.2, §5.4),
// Decreto 676/2025 (§5.7, sustainability storeys) and Decreto 253/2026 (Anexo 36.1, equipamiento
// storeys). See docs/bogota-pot-source.md.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const EQUIPAMIENTOS = require('./bogota-pot-equipamientos.json');

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clean = value => typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
const round = value => Math.round(value * 1000) / 1000;

// Rear yard by storeys: Consolidación (Anexo 5 §5.4.b) and Mejoramiento integral (§3.1.b); by
// building height in metres in Renovación (§4.2.b).
const consolidacionRearM = [[3, 3], [6, 5], [9, 6], [12, 8], [15, 10], [18, 12], [22, 14], [25, 16], [28, 18], [Infinity, 20]];
const mejoramientoRearM = [[3, 0], [6, 5], [9, 6], [12, 8], [Infinity, 8]];
const renovacionRearM = [[12, 4], [18, 5], [27, 6], [36, 8], [45, 10], [54, 12], [66, 14], [75, 16], [84, 18], [Infinity, 20]];
const tableValue = (table, measure) => table.find(([upTo]) => measure <= upTo)[1];

// Decree rules the adapter applies. A change here is a rule change, not a data change.
export const BOGOTA_RULES = Object.freeze({
    decree: 'Decreto Distrital 555 de 2021; Anexo 5 Manual de normas comunes (Decreto 466 de 2024); Decreto 676 de 2025; Decreto 253 de 2026',
    // A storey counts up to 3.80 m clear (residential; Anexo 5 §1.3/§1.5); slab thickness is not
    // regulated, so the bound assumes one 0.25 m slab per storey. Dotacional storeys total 4.60 m.
    clearHeightM: 3.8, slabM: 0.25, storeyHeightM: 4.05, dotacionalStoreyHeightM: 4.6,
    storeyHeightCitation: 'Anexo 5 §1.3/§1.5 (Decreto 466/2024): 3,80 m libres por piso residencial, más una placa supuesta de 0,25 m',
    dotacionalStoreyCitation: 'Anexo 5 §1.5: en uso dotacional la altura total no supera pisos × 4,60 m',
    rearSetbackM: (treatment, storeys, heightM) => treatment === 'RENOVACION' ? tableValue(renovacionRearM, heightM)
        : treatment === 'MEJORAMIENTO INTEGRAL' ? tableValue(mejoramientoRearM, storeys) : tableValue(consolidacionRearM, storeys),
    rearSetbackCitation: 'Anexo 5 §5.4.b (consolidación, por pisos) / §3.1.b (mejoramiento integral) / §4.2.b (renovación urbana, por altura en metros): aislamiento posterior',
    // Side yards: the detached typology (TA) keeps them from the second floor, Renovación from
    // 11.40 m, which is three storeys of 3.80 m clear and is read as the third storey's top here;
    // width max(H/5, 4 m) with H counted above the level where the yard starts (§1.9.b).
    sideSetbackFromM: (treatment, tipologia, storeyHeightM = 4.05) => treatment === 'RENOVACION' ? round(3 * storeyHeightM) : tipologia === 'TA' ? storeyHeightM : null,
    sideSetbackM: (heightM, fromM) => Math.max((heightM - fromM) / 5, 4),
    sideSetbackCitation: 'Anexo 5 §1.9.b: aislamiento lateral máx(H/5, 4 m) desde el segundo piso en tipología aislada (TA) y desde 11,40 m (tres pisos) en renovación; sin aislamiento en tipología continua',
    // The front-yard map (CU-5.5) binds Consolidación lots; other treatments take none (arts. 258, 314).
    antejardinTreatments: Object.freeze(['CONSOLIDACION']),
    antejardinCitation: 'Decreto 555/2021 arts. 258 y 314; Anexo 5 §1.7: dimensión mínima del antejardín según el mapa CU-5.5',
    equipamientoAntejardinM: 3.5,
    equipamientoAntejardinCitation: 'Decreto 253/2026 art. 249.8: antejardín mínimo de 3,50 m en los polígonos de equipamientos',
    // Street wall (§1.11): the facade rises to ratio × D, D being the distance from the building
    // line across the public space to the lot line opposite; above it one setback of at least
    // max(4 m, (H − A)/5). No rule where D exceeds 30 m.
    streetWall: Object.freeze({ ratio: Object.freeze({ CONSOLIDACION: 2.5, RENOVACION: 2.5 }), maxDistanceM: 30,
        setbackM: (heightM, facadeM) => Math.max(4, (heightM - facadeM) / 5) }),
    streetWallCitation: 'Anexo 5 §1.11: altura del paramento A = 2,5·D (consolidación y renovación); retroceso mínimo máx(4 m, (H − A)/5); sin regla con D > 30 m',
    // Renovación (arts. 303–304): a single lot builds up to an effective construction index of 5.0;
    // its height is whatever the yards, the street wall and that index leave (art. 260).
    renovacion: Object.freeze({ constructionIndex: 5, maxStoreys: 40 }),
    renovacionCitation: 'Decreto 555/2021 arts. 260, 303–304: altura resultante; índice de construcción efectivo máximo 5,0 en predio individual',
    // Decreto 676/2025 (Anexo 5 §5.7): sustainable-construction storeys in Consolidación, a
    // project's choice: +2 on lots of 300–800 m², +3 from 800 m², never above 12 storeys, in
    // Proximidad or Estructurante activity areas, not on lots with a storey range.
    sustainability: Object.freeze({ treatments: Object.freeze(['CONSOLIDACION']), capStoreys: 12, minimumLotM2: 300,
        bonusStoreys: lotM2 => lotM2 >= 800 ? 3 : lotM2 >= 300 ? 2 : 0, activityAreas: Object.freeze(['AAP', 'AAE']) }),
    sustainabilityCitation: 'Decreto 676/2025 (Anexo 5 §5.7): +2 pisos en lotes de 300–800 m², +3 desde 800 m², máximo 12 pisos, en áreas de actividad de proximidad o estructurante, adoptando todas las medidas de ecourbanismo'
});

const treatmentLabels = Object.freeze({
    CONSOLIDACION: 'Consolidación', RENOVACION: 'Renovación urbana', DESARROLLO: 'Desarrollo',
    'MEJORAMIENTO INTEGRAL': 'Mejoramiento integral', CONSERVACION: 'Conservación'
});
// Treatments whose storey count the map assigns directly (art. 260); Desarrollo ranges and
// Renovación have a resulting height instead.
const storeyTreatments = new Set(['CONSOLIDACION', 'CONSERVACION', 'MEJORAMIENTO INTEGRAL']);
// Height codes that hand the parcel to another instrument or regime instead of a storey count.
const instrumentCodes = Object.freeze({
    PEMP: 'Plan Especial de Manejo y Protección: rige el PEMP',
    'BIC NAL': 'Bien de Interés Cultural del ámbito nacional: rige su PEMP o resolución',
    CHB: 'Centro Histórico de Bogotá (PEMP-CH, Res. Mincultura 088/2021); código fuera de la leyenda, sin verificar',
    UNE: 'Urbanizado no edificado: rige la licencia de urbanización o la ficha C/UNE (Decreto 178/2025, arts. 239–241 Decreto 670/2025)',
    E4: 'Código fuera de la leyenda del mapa CU-5.4 (posible sector normativo E, 4 pisos); sin verificar'
});
const resultingHeight = Object.freeze({
    CONSOLIDACION: 'Altura no asignada en el mapa ni en el Anexo 36.1 del Decreto 253/2026: suelo sin altura (parques, cesiones, franja de adecuación)',
    DESARROLLO: 'Altura resultante del rango de edificabilidad (art. 281)',
    'MEJORAMIENTO INTEGRAL': 'Altura no asignada en el mapa; base de 3 pisos y aumentos por área de lote y ancho de vía (art. 338); no calculada',
    CONSERVACION: 'Altura no asignada en el mapa: rige la norma del sector de interés cultural'
});
const RENOVACION_RESULTANTE = 'Altura resultante (art. 260): índice de construcción 5,0 (arts. 303–304), retroceso 2,5·D y aislamientos; se calcula por predio con su frente de calle en la vista de envolventes';
const developmentRanges = Object.freeze({
    1: 'Rango 1: índice de construcción 2,82 / 2,25 sobre área neta urbanizable, altura resultante',
    2: 'Rango 2: índice de construcción 2,57 / 2,00 sobre área neta urbanizable, altura resultante',
    3: 'Rango 3: índice de construcción 2,32 / 1,75 sobre área neta urbanizable, altura resultante',
    '4A': 'Rango 4A: 3 pisos, índice de ocupación 0,10',
    '4B': 'Rango 4B: 6 pisos (8 con VIS/VIP en sitio), índice de ocupación 0,15',
    '4C': 'Rango 4C: índice de construcción 1,75 / 1,2 / 0,9, ocupación 0,15, altura resultante',
    '4D': 'Rango 4D: índice de construcción 1,75 / 1,2 / 0,9, ocupación 0,28, altura resultante'
});

// `ALTURA_MAXIMA` is text: whole storeys ("5"), a storey range ("3-5": the base, rising only with
// enough frontage), a development range ("Rg 4B"), an instrument code ("PEMP") or blank.
export function parseAltura(value) {
    const text = clean(value);
    if (!text) return { kind: 'blank', text };
    const storeys = /^(\d{1,2})$/.exec(text);
    if (storeys) return { kind: 'storeys', text, min: Number(storeys[1]), max: Number(storeys[1]) };
    const range = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(text);
    if (range && Number(range[1]) <= Number(range[2])) return { kind: 'storeys', text, min: Number(range[1]), max: Number(range[2]) };
    const qualified = /^(\d{1,2})\s+(.+)$/.exec(text);
    if (qualified) return { kind: 'storeys', text, min: Number(qualified[1]), max: Number(qualified[1]), qualifier: qualified[2] };
    const development = /^Rg\s*(\w+)$/i.exec(text);
    if (development) return { kind: 'development-range', text, range: development[1].toUpperCase() };
    if (Object.hasOwn(instrumentCodes, text)) return { kind: 'instrument', text, instrument: instrumentCodes[text] };
    return { kind: 'unparsed', text };
}

// `DIMENSION` is the front yard depth in metres as text ("3.50"); "0.00" is a recorded zero
// and a blank is no recorded value.
export function parseAntejardin(value) {
    const text = clean(value);
    if (!text) return null;
    const metres = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text);
    return metres ? Number(`${metres[1]}.${metres[2] || '0'}`) : null;
}

function constraint(quantity, value, unit, bound, evidence, sourceField, extra = {}) {
    return { quantity, value, unit, bound, evidence, evaluation: 'not-evaluated', sourceField, ...extra };
}

// The street-wall tier for a lot whose street width is known: a deeper front setback that starts
// at the facade height. Null, with the reason, where the rule does not reach the lot.
export function streetWallConstraint({ treatment, heightM, antejardinM = null, streetWidthM = null }, rules = BOGOTA_RULES) {
    const ratio = rules.streetWall.ratio[treatment];
    const base = { rule: rules.streetWallCitation, ratio: ratio ?? null, streetWidthM, antejardinM };
    if (!ratio) return { constraint: null, evidence: { ...base, applies: false, reason: 'treatment-without-street-wall-rule' } };
    if (!finite(streetWidthM)) return { constraint: null, evidence: { ...base, applies: false, reason: 'street-width-unknown' } };
    const distanceM = round(streetWidthM + (finite(antejardinM) ? antejardinM : 0));
    if (distanceM > rules.streetWall.maxDistanceM) return { constraint: null, evidence: { ...base, applies: false, distanceM, reason: 'street-wider-than-rule' } };
    const facadeM = round(ratio * distanceM);
    if (!finite(heightM) || heightM <= facadeM) return { constraint: null, evidence: { ...base, applies: false, distanceM, facadeHeightM: facadeM, reason: 'building-below-facade-height' } };
    const setbackM = round(rules.streetWall.setbackM(heightM, facadeM));
    const value = round(setbackM + (finite(antejardinM) ? antejardinM : 0));
    return { evidence: { ...base, applies: true, distanceM, facadeHeightM: facadeM, setbackM },
        constraint: constraint('frontSetback', value, 'm', 'minimum', 'literal', rules.streetWallCitation, { fromHeightM: facadeM,
            derivation: `paramento hasta A = ${ratio} × ${distanceM} m = ${facadeM} m; encima, retroceso máx(4 m, (${heightM} − ${facadeM})/5) = ${setbackM} m${finite(antejardinM) ? ` más antejardín ${antejardinM} m` : ''}` }) };
}

// The metric constraints of a storey count under one treatment, for the shared evaluator. A
// yard that starts above the ground carries `fromHeightM`; the evaluator's tiers apply it there.
export function dimensionalConstraints({ treatment, tipologia = null, storeys, storeyHeightM = BOGOTA_RULES.storeyHeightM, storeyCitation = BOGOTA_RULES.storeyHeightCitation,
    altura = null, antejardinM = null, streetWidthM = null }, rules = BOGOTA_RULES) {
    const heightM = round(storeys * storeyHeightM);
    const constraints = [
        constraint('storeys', storeys, 'count', 'maximum', 'direct', 'ALTURA_MAXIMA', altura ? { range: [altura.min, altura.max] } : {}),
        constraint('height', heightM, 'm', 'maximum', 'direct', 'ALTURA_MAXIMA',
            { derivation: `${storeys} × ${storeyHeightM} m por piso`, rule: storeyCitation }),
        constraint('rearSetback', rules.rearSetbackM(treatment, storeys, heightM), 'm', 'minimum', 'literal', rules.rearSetbackCitation)
    ];
    const sideFromM = rules.sideSetbackFromM(treatment, tipologia, storeyHeightM);
    if (sideFromM === null) constraints.push(constraint('sideSetback', 0, 'm', 'minimum', 'literal', rules.sideSetbackCitation));
    else if (sideFromM < heightM) constraints.push(constraint('sideSetback', round(rules.sideSetbackM(heightM, sideFromM)), 'm', 'minimum', 'literal', rules.sideSetbackCitation,
        { fromHeightM: sideFromM, derivation: `máx((${heightM} − ${sideFromM}) m / 5, 4 m) desde ${sideFromM} m` }));
    const streetWall = streetWallConstraint({ treatment, heightM, antejardinM, streetWidthM }, rules);
    if (streetWall.constraint) constraints.push(streetWall.constraint);
    return { heightM, constraints, streetWall: streetWall.evidence };
}

// One treatment polygon's attributes as the shared record fields: a configurable status with
// metric constraints when the map (or the Decreto 253/2026 annex, for equipamiento polygons)
// assigns storeys, otherwise the status the map recorded.
export function interpretTreatment(properties, rules = BOGOTA_RULES, equipamientos = EQUIPAMIENTOS) {
    const treatment = clean(properties?.TRATAMIENTO).toUpperCase();
    const altura = parseAltura(properties?.ALTURA_MAXIMA);
    const tipologia = clean(properties?.TIPOLOGIA) || null;
    const treatmentLabel = treatmentLabels[treatment] || treatment || 'Tratamiento';
    const base = { treatment, treatmentLabel, tipologia, altura, constraints: [], uplift: null, equipamiento: null,
        storeyHeightM: rules.storeyHeightM, resultante: false };
    if (altura.kind === 'storeys' && altura.min > 0 && storeyTreatments.has(treatment)) {
        // The lower number of a range is the base; the upper applies only with enough frontage (art. 310).
        const storeys = altura.min;
        const uplift = altura.max > altura.min ? { storeys: altura.max,
            condition: 'frente de lote ≥ 14 m (tipología continua) o ≥ 24 m y lote ≥ 1.200 m² (TA); art. 310' } : null;
        const { heightM, constraints } = dimensionalConstraints({ treatment, tipologia, storeys, altura }, rules);
        return { ...base, status: 'allowed', reason: null, heightM, storeys, uplift, constraints,
            heightLabel: uplift ? `${storeys} pisos (hasta ${uplift.storeys} con frente suficiente)` : `${storeys} pisos` };
    }
    if (altura.kind === 'development-range') return { ...base, status: 'unsupported_calculation',
        reason: developmentRanges[altura.range] || `Rango de edificabilidad ${altura.range}: edificabilidad por índices (art. 281)`,
        heightM: null, storeys: null, heightLabel: `Rango ${altura.range}` };
    if (altura.kind === 'instrument') return { ...base, status: 'instrument_handoff',
        reason: altura.instrument, heightM: null, storeys: null, heightLabel: altura.text };
    if (treatment === 'RENOVACION' && ['blank', 'storeys'].includes(altura.kind)) {
        // A storey count the map writes in Renovación caps the resulting height (one polygon).
        const storeyCap = altura.kind === 'storeys' ? altura.min : null;
        return { ...base, status: 'unsupported_calculation', reason: RENOVACION_RESULTANTE, resultante: true, storeyCap,
            heightM: null, storeys: null, heightLabel: storeyCap ? `altura resultante (máx. ${storeyCap} pisos)` : 'altura resultante' };
    }
    if (altura.kind === 'blank' && treatment === 'CONSOLIDACION') {
        const annex = equipamientos?.polygons?.[String(properties?.OBJECTID)] || null;
        if (annex) {
            const equipamiento = { annexId: annex.id, legend: annex.legend, decision: annex.decision, lots: annex.lots, condition: annex.condition,
                decree: equipamientos.decree, rule: rules.dotacionalStoreyCitation };
            if (annex.storeys > 0) {
                const { heightM, constraints } = dimensionalConstraints({ treatment, tipologia, storeys: annex.storeys,
                    storeyHeightM: rules.dotacionalStoreyHeightM, storeyCitation: rules.dotacionalStoreyCitation }, rules);
                return { ...base, status: 'allowed', reason: null, heightM, storeys: annex.storeys, equipamiento, constraints,
                    storeyHeightM: rules.dotacionalStoreyHeightM,
                    heightLabel: `${annex.storeys} pisos (equipamiento, Decreto 253/2026${annex.condition ? `: ${annex.condition}` : ''})` };
            }
            return { ...base, status: 'instrument_handoff', equipamiento, heightM: null, storeys: null, heightLabel: 'equipamiento sin altura asignada',
                reason: `Decreto 253/2026 Anexo 36.1, polígono ${annex.id}: ${annex.condition || 'no aplica; la altura la determinan otros instrumentos'}` };
        }
    }
    if (altura.kind === 'blank') return { ...base, status: 'instrument_handoff',
        reason: resultingHeight[treatment] || 'Altura no asignada en el mapa de tratamientos',
        heightM: null, storeys: null, heightLabel: 'altura no asignada' };
    if (altura.kind === 'storeys') return { ...base, status: 'unsupported_calculation',
        reason: `Pisos anotados en ${treatmentLabel}, cuya altura es resultante (art. 260); no calculada`,
        heightM: null, storeys: null, heightLabel: altura.text };
    return { ...base, status: 'unrecorded', reason: `Altura máxima no interpretada: ${altura.text}`,
        heightM: null, storeys: null, heightLabel: altura.text };
}

// The front-yard polygon under a parcel supplies the front setback of a Consolidación lot; for
// other treatments the map value is evidence only. Note codes stay evidence. An equipamiento
// polygon takes at least the Decreto 253/2026 minimum.
export function antejardinConstraint(properties, overlap, treatment = 'CONSOLIDACION', rules = BOGOTA_RULES, { equipamiento = false } = {}) {
    const mapM = parseAntejardin(properties?.DIMENSION);
    const notes = clean(properties?.NOTA).split(',').map(note => note.trim()).filter(Boolean);
    const applies = rules.antejardinTreatments.includes(treatment);
    const dimensionM = applies && equipamiento ? Math.max(finite(mapM) ? mapM : 0, rules.equipamientoAntejardinM) : mapM;
    const evidence = { objectId: properties?.OBJECTID ?? null, dimension: properties?.DIMENSION ?? null, dimensionM, notes,
        observation: properties?.OBSERVACION || null, applies, rule: rules.antejardinCitation, ...overlap,
        ...(applies && equipamiento ? { minimumM: rules.equipamientoAntejardinM, minimumRule: rules.equipamientoAntejardinCitation } : {}) };
    if (!finite(dimensionM) || !applies) return { constraint: null, evidence };
    return { constraint: constraint('frontSetback', dimensionM, 'm', 'minimum', 'direct', 'DIMENSION',
        { sourceLayer: 'antejardin', sourceRecordId: evidence.objectId === null ? null : String(evidence.objectId) }), evidence };
}

// Renovación's resulting height: the storey count whose floors, each bounded by the yards, the
// street wall and the side yards above 11.40 m, hold the most floor area within the lot's
// construction index. Yards deepen with height, so past some count a further storey adds nothing
// or removes more floor below than it adds; the search stops after three such storeys in a row,
// or three in a row over the index. `measure(constraints)` returns the floor area the constraints leave.
export function solveRenovacion({ tipologia = null, lotM2, streetWidthM = null, storeyCap = null }, measure, rules = BOGOTA_RULES) {
    if (!finite(lotM2) || lotM2 <= 0) return null;
    const index = rules.renovacion.constructionIndex, limitM2 = index * lotM2;
    const cap = Math.min(rules.renovacion.maxStoreys, storeyCap ?? Infinity);
    let best = null, previous = 0, declines = 0, over = 0;
    for (let storeys = 1; storeys <= cap; storeys++) {
        const { heightM, constraints, streetWall } = dimensionalConstraints({ treatment: 'RENOVACION', tipologia, storeys, streetWidthM }, rules);
        const measured = measure(constraints);
        const floorAreaM2 = measured && finite(measured.floorAreaM2) ? measured.floorAreaM2 : 0;
        if (floorAreaM2 <= 0) break;
        declines = floorAreaM2 <= previous + 0.01 ? declines + 1 : 0;
        over = floorAreaM2 > limitM2 + 0.01 ? over + 1 : 0;
        previous = floorAreaM2;
        if (declines >= 3 || over >= 3) break;
        if (over === 0 && (!best || floorAreaM2 > best.floorAreaM2)) {
            best = { storeys, heightM, constraints, streetWall, floorAreaM2: round(floorAreaM2), lotM2: round(lotM2), limitM2: round(limitM2), index };
        }
    }
    return best;
}

// Whether a treatment polygon can carry the Decreto 676/2025 storeys at all (the lot decides the rest).
export function incentiveCandidacy(reading, rules = BOGOTA_RULES) {
    if (!rules.sustainability.treatments.includes(reading.treatment)) return { candidate: false, reason: `Incentivo Decreto 676/2025 solo en ${rules.sustainability.treatments.map(t => treatmentLabels[t]).join(', ')}` };
    if (reading.equipamiento) return { candidate: false, reason: 'Incentivo Decreto 676/2025 no previsto para polígonos de equipamientos' };
    if (reading.status !== 'allowed' || !finite(reading.storeys)) return { candidate: false, reason: 'Incentivo Decreto 676/2025 sin pisos base en el mapa' };
    if (reading.uplift) return { candidate: false, reason: 'Incentivo Decreto 676/2025 excluido en sectores con pisos adicionales por frente (rango)' };
    if (reading.storeys >= rules.sustainability.capStoreys) return { candidate: false, reason: `Incentivo Decreto 676/2025 sin efecto: ya ${reading.storeys} pisos, máximo ${rules.sustainability.capStoreys}` };
    return { candidate: true, reason: null };
}

// The incentive on one lot: bonus storeys from its area and activity area, as a configuration the
// project opts into. Null bonus with the reason where the lot does not qualify.
export function incentive(reading, { lotM2, activityCode = null }, rules = BOGOTA_RULES) {
    const candidacy = incentiveCandidacy(reading, rules);
    const base = { rule: rules.sustainabilityCitation, lotM2: finite(lotM2) ? round(lotM2) : null, activityCode };
    if (!candidacy.candidate) return { ...base, applies: false, reason: candidacy.reason };
    if (!finite(lotM2) || lotM2 < rules.sustainability.minimumLotM2) return { ...base, applies: false, reason: `Incentivo Decreto 676/2025 desde ${rules.sustainability.minimumLotM2} m² de lote` };
    const area = clean(activityCode).toUpperCase();
    if (!rules.sustainability.activityAreas.some(prefix => area.startsWith(prefix))) {
        return { ...base, applies: false, reason: area ? `Incentivo Decreto 676/2025 solo en áreas de actividad de proximidad o estructurante (aquí ${area})` : 'Área de actividad no leída bajo el lote' };
    }
    const bonusStoreys = Math.min(rules.sustainability.bonusStoreys(lotM2), rules.sustainability.capStoreys - reading.storeys);
    if (bonusStoreys <= 0) return { ...base, applies: false, reason: 'Incentivo Decreto 676/2025 sin pisos adicionales para este lote' };
    return { ...base, applies: true, bonusStoreys, storeys: reading.storeys + bonusStoreys, reason: null,
        condition: 'Adoptando todas las medidas de ecourbanismo del Decreto 676/2025; se supone fuera de sectores exclusivamente residenciales' };
}

// The record's reading on one lot: the front yard, the street width, the lot area and (for the
// sustainability configuration) the activity area turn the polygon's reading into the lot's
// constraints. `measure` (optional) evaluates candidate constraints on the lot for Renovación.
export function parcelReading(reading, { scenario = 'general', antejardinM = null, streetWidthM = null, lotM2 = null, activityCode = null, measure = null } = {}, rules = BOGOTA_RULES) {
    const evidence = {};
    let { status, reason, storeys, heightM, heightLabel, title = null, constraints = reading.constraints, storeyHeightM = reading.storeyHeightM } = reading;
    if (scenario === 'sustainable') {
        const candidacy = incentiveCandidacy(reading, rules);
        if (!candidacy.candidate) return { status: 'unsupported_calculation', reason: candidacy.reason, storeys: null, heightM: null, heightLabel,
            constraints: [], evidence: { incentive: { ...candidacy, applies: false, rule: rules.sustainabilityCitation } } };
    }
    if (reading.resultante) {
        if (!measure) return { status, reason, storeys, heightM, heightLabel, constraints: [], evidence: { resultante: { solved: false, reason: 'no-parcel-measure' } } };
        const solved = solveRenovacion({ tipologia: reading.tipologia, lotM2, streetWidthM, storeyCap: reading.storeyCap }, measure, rules);
        if (!solved) return { status: 'unsupported_calculation', reason: 'Altura resultante sin solución: ningún piso cabe dentro de los aislamientos', storeys: null, heightM: null, heightLabel,
            constraints: [], evidence: { resultante: { solved: false, reason: 'no-storey-fits', lotM2 } } };
        ({ storeys, heightM, constraints } = solved);
        status = 'allowed'; reason = null;
        heightLabel = `${storeys} pisos (altura resultante, índice ${solved.index.toFixed(1).replace('.', ',')})`;
        evidence.resultante = { solved: true, index: solved.index, floorAreaM2: solved.floorAreaM2, lotM2: solved.lotM2, limitM2: solved.limitM2, rule: rules.renovacionCitation };
        evidence.streetWall = solved.streetWall;
        return { status, reason, storeys, heightM, heightLabel, constraints, evidence };
    }
    if (scenario === 'sustainable') {
        const bonus = incentive(reading, { lotM2, activityCode }, rules);
        evidence.incentive = bonus;
        if (!bonus.applies) return { status: 'unsupported_calculation', reason: bonus.reason, storeys: null, heightM: null, heightLabel, constraints: [], evidence };
        storeys = bonus.storeys;
        heightLabel = `${storeys} pisos (${reading.storeys} + ${bonus.bonusStoreys} sostenibles, Decreto 676/2025)`;
        title = `${reading.treatmentLabel} · ${heightLabel}`;
    }
    if (status !== 'allowed' || !finite(storeys)) return { status, reason, storeys, heightM, heightLabel, constraints, evidence };
    const dimensions = dimensionalConstraints({ treatment: reading.treatment, tipologia: reading.tipologia, storeys, storeyHeightM,
        storeyCitation: reading.equipamiento ? rules.dotacionalStoreyCitation : rules.storeyHeightCitation, altura: reading.altura, antejardinM, streetWidthM }, rules);
    evidence.streetWall = dimensions.streetWall;
    return { status, reason, storeys, heightM: dimensions.heightM, heightLabel, title, constraints: dimensions.constraints, evidence,
        ...(scenario === 'sustainable' ? { condition: evidence.incentive.condition } : {}) };
}
