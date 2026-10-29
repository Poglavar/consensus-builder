// Read Bogotá POT (Decreto 555/2021) treatment-map and front-yard-map attributes as dimensional
// constraints in metres for the shared parcel evaluator. Pure: no network, no geometry.
// Every number here is a decree rule or a map value; the citation travels with the constraint.
// Rules: Decreto 555/2021 (arts. 258, 260, 310, 314, 338) and its Anexo 5 "Manual de normas
// comunes" as updated by Decreto 466/2024 (§1.3, §1.5, §1.9, §5.4, §3.1). See docs/bogota-pot-source.md.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clean = value => typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();

// Rear yard by storeys: Consolidación (Anexo 5 §5.4.b) and Mejoramiento integral (§3.1.b).
const consolidacionRearM = [[3, 3], [6, 5], [9, 6], [12, 8], [15, 10], [18, 12], [22, 14], [25, 16], [28, 18], [Infinity, 20]];
const mejoramientoRearM = [[3, 0], [6, 5], [9, 6], [12, 8], [Infinity, 8]];
const tableValue = (table, storeys) => table.find(([upTo]) => storeys <= upTo)[1];

// Decree rules the adapter applies. A change here is a rule change, not a data change.
export const BOGOTA_RULES = Object.freeze({
    decree: 'Decreto Distrital 555 de 2021; Anexo 5 Manual de normas comunes (Decreto 466 de 2024)',
    // A storey counts up to 3.80 m clear (residential; Anexo 5 §1.3/§1.5); slab thickness is not
    // regulated, so the bound assumes one 0.25 m slab per storey.
    clearHeightM: 3.8, slabM: 0.25, storeyHeightM: 4.05,
    storeyHeightCitation: 'Anexo 5 §1.3/§1.5 (Decreto 466/2024): 3,80 m libres por piso residencial, más una placa supuesta de 0,25 m',
    rearSetbackM: (treatment, storeys) => treatment === 'MEJORAMIENTO INTEGRAL' ? tableValue(mejoramientoRearM, storeys) : tableValue(consolidacionRearM, storeys),
    rearSetbackCitation: 'Anexo 5 §5.4.b (consolidación) / §3.1.b (mejoramiento integral): aislamiento posterior por pisos',
    // Side yards: only the detached typology (TA) keeps them, max(H/5, 4 m) (Anexo 5 §1.9.b).
    sideSetbackM: (tipologia, heightM) => tipologia === 'TA' ? Math.max(heightM / 5, 4) : 0,
    sideSetbackCitation: 'Anexo 5 §1.9.b: aislamiento lateral máx(H/5, 4 m) en tipología aislada (TA); sin aislamiento en tipología continua',
    // The front-yard map (CU-5.5) binds Consolidación lots; other treatments take none (arts. 258, 314).
    antejardinTreatments: Object.freeze(['CONSOLIDACION']),
    antejardinCitation: 'Decreto 555/2021 arts. 258 y 314; Anexo 5 §1.7: dimensión mínima del antejardín según el mapa CU-5.5'
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
    RENOVACION: 'Altura resultante (art. 260): índice de construcción máximo 5,0 / 6,0 / 7,0 (arts. 303–304), retroceso 2,5·D y aislamientos; no calculada',
    CONSOLIDACION: 'Altura no asignada en el mapa: polígonos de la convención Equipamientos, con pisos por polígono en el Decreto 253/2026 (Anexo 36.1, fuera de esta capa), o suelo sin altura (parques, cesiones, franja de adecuación)',
    DESARROLLO: 'Altura resultante del rango de edificabilidad (art. 281)',
    'MEJORAMIENTO INTEGRAL': 'Altura no asignada en el mapa; base de 3 pisos y aumentos por área de lote y ancho de vía (art. 338); no calculada',
    CONSERVACION: 'Altura no asignada en el mapa: rige la norma del sector de interés cultural'
});
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
const round = value => Math.round(value * 1000) / 1000;

// One treatment polygon's attributes as the shared record fields: a configurable status with
// metric constraints when the map assigns storeys, otherwise the status the map recorded.
export function interpretTreatment(properties, rules = BOGOTA_RULES) {
    const treatment = clean(properties?.TRATAMIENTO).toUpperCase();
    const altura = parseAltura(properties?.ALTURA_MAXIMA);
    const tipologia = clean(properties?.TIPOLOGIA) || null;
    const treatmentLabel = treatmentLabels[treatment] || treatment || 'Tratamiento';
    const base = { treatment, treatmentLabel, tipologia, altura, constraints: [], uplift: null };
    if (altura.kind === 'storeys' && altura.min > 0 && storeyTreatments.has(treatment)) {
        // The lower number of a range is the base; the upper applies only with enough frontage (art. 310).
        const storeys = altura.min, heightM = round(storeys * rules.storeyHeightM);
        const uplift = altura.max > altura.min ? { storeys: altura.max,
            condition: 'frente de lote ≥ 14 m (tipología continua) o ≥ 24 m y lote ≥ 1.200 m² (TA); art. 310' } : null;
        const sideM = round(rules.sideSetbackM(tipologia, heightM));
        return { ...base, status: 'allowed', reason: null, heightM, storeys, uplift,
            heightLabel: uplift ? `${storeys} pisos (hasta ${uplift.storeys} con frente suficiente)` : `${storeys} pisos`,
            constraints: [
                constraint('storeys', storeys, 'count', 'maximum', 'direct', 'ALTURA_MAXIMA', { range: [altura.min, altura.max] }),
                constraint('height', heightM, 'm', 'maximum', 'direct', 'ALTURA_MAXIMA',
                    { derivation: `${storeys} × (${rules.clearHeightM} m libres + ${rules.slabM} m de placa)`, rule: rules.storeyHeightCitation }),
                constraint('rearSetback', rules.rearSetbackM(treatment, storeys), 'm', 'minimum', 'literal', rules.rearSetbackCitation),
                constraint('sideSetback', sideM, 'm', 'minimum', 'literal', rules.sideSetbackCitation,
                    tipologia === 'TA' ? { derivation: `máx(${heightM} m / 5, 4 m); desde el segundo piso` } : {})
            ] };
    }
    if (altura.kind === 'development-range') return { ...base, status: 'unsupported_calculation',
        reason: developmentRanges[altura.range] || `Rango de edificabilidad ${altura.range}: edificabilidad por índices (art. 281)`,
        heightM: null, storeys: null, heightLabel: `Rango ${altura.range}` };
    if (altura.kind === 'instrument') return { ...base, status: 'instrument_handoff',
        reason: altura.instrument, heightM: null, storeys: null, heightLabel: altura.text };
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
// other treatments the map value is evidence only. Note codes stay evidence.
export function antejardinConstraint(properties, overlap, treatment = 'CONSOLIDACION', rules = BOGOTA_RULES) {
    const dimensionM = parseAntejardin(properties?.DIMENSION);
    const notes = clean(properties?.NOTA).split(',').map(note => note.trim()).filter(Boolean);
    const applies = rules.antejardinTreatments.includes(treatment);
    const evidence = { objectId: properties?.OBJECTID ?? null, dimension: properties?.DIMENSION ?? null, dimensionM, notes,
        observation: properties?.OBSERVACION || null, applies, rule: rules.antejardinCitation, ...overlap };
    if (!finite(dimensionM) || !applies) return { constraint: null, evidence };
    return { constraint: constraint('frontSetback', dimensionM, 'm', 'minimum', 'direct', 'DIMENSION',
        { sourceLayer: 'antejardin', sourceRecordId: evidence.objectId === null ? null : String(evidence.objectId) }), evidence };
}
