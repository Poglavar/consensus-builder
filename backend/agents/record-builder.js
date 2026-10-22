// Turns a planned candidate plus the controller's pick into the agent's recipe: the local design record
// of a building on its parcel (published as design/v1 by agreement-objects.js designObject: no terms,
// kind or cadastre ids; the server derives the parcels its footprint binds) and the terms of the
// binding owners' agreement the agent puts that design up under (title, deadline days, escrow lamports
// from the persona's `agreement` block). Pure: nothing here reads the clock or the network; the build
// time is passed in and checkpointed by the runner, so a rerun publishes the same CIDs.
//
// The goal is `buildings` with the single-building typology: the massing stands on its parcel as
// content, so applying the design forms no new pieces and the agreement's outputs are the input
// parcels themselves (a freeform `single` building would carve its footprint into a parcel of its own).

export const DEFAULT_AGREEMENT_TERMS = Object.freeze({ deadlineDays: 7, lamports: '0' });
const MAX_DEADLINE_DAYS = 365;

/**
 * The persona's agreement terms: { deadlineDays, lamports } with lamports a whole-number string.
 * Throws for a value that is not a positive number of days or a whole number of lamports.
 */
export function agreementTerms(persona = {}) {
    const configured = persona.agreement || {};
    const deadlineDays = configured.deadlineDays ?? DEFAULT_AGREEMENT_TERMS.deadlineDays;
    if (typeof deadlineDays !== 'number' || !Number.isFinite(deadlineDays) || deadlineDays <= 0 || deadlineDays > MAX_DEADLINE_DAYS) {
        throw new Error(`${persona.name || 'persona'} agreement.deadlineDays must be a number of days in (0, ${MAX_DEADLINE_DAYS}]`);
    }
    const lamports = String(configured.lamports ?? DEFAULT_AGREEMENT_TERMS.lamports).trim();
    if (!/^\d+$/.test(lamports)) throw new Error(`${persona.name || 'persona'} agreement.lamports must be a whole number of lamports`);
    return { deadlineDays, lamports };
}

/**
 * The local design record of one pick: a building massing on the candidate's parcel.
 * @param {Object} args
 * @param {Object} args.candidate  one entry from planner.js planCandidates() or housing-policy.js
 * @param {Object} args.pick       { name, rationale } from the controller
 * @param {Object} args.persona    the persona that proposes it (its name is the author)
 * @param {string} args.city       city code of the area the candidate came from
 * @param {string} args.authoredAt ISO time the design was built (checkpointed by the runner)
 */
export function buildDesignRecord({ candidate, pick, persona, city, authoredAt }) {
    if (!candidate?.massing?.geometry) throw new Error('buildDesignRecord: candidate.massing must be a geometry-bearing feature');
    if (!pick?.name) throw new Error('buildDesignRecord: the pick needs a name');
    if (!persona?.name) throw new Error('buildDesignRecord: persona.name is required');
    if (!authoredAt || !Number.isFinite(Date.parse(authoredAt))) throw new Error('buildDesignRecord: authoredAt must be an ISO time');
    const massing = candidate.massing.properties || {};
    const height = massing.height ?? null;
    const floors = massing.floors ?? null;
    const blockName = `Parcel ${candidate.parcelId}`;
    const building = {
        type: 'Feature',
        geometry: candidate.massing.geometry,
        properties: { type: 'proposedBuildingSingle', block: blockName, height, floors, title: pick.name, author: persona.name, rotation: 0 }
    };
    return {
        goal: 'buildings',
        title: pick.name,
        description: pick.rationale || null,
        author: persona.name,
        city: city || null,
        site: null,
        toleranceM: null,
        origin: null,
        createdAt: authoredAt,
        buildingProposal: {
            blockName,
            typologyType: 'single',
            parameters: {
                height,
                floors,
                rotation: 0,
                typology: 'single',
                // The rule the envelope was derived from, so the massing can be re-derived from the
                // design rather than only re-read off it.
                rule: candidate.normalizedRule ?? null
            }
        },
        geometry: { buildings: [building] }
    };
}

/**
 * The agent's recipe for one pick: { design: local design record, agreement: { title, deadlineDays, lamports } }.
 */
export function buildRecipe({ candidate, pick, persona, city, authoredAt }) {
    return {
        design: buildDesignRecord({ candidate, pick, persona, city, authoredAt }),
        agreement: { title: pick.name, ...agreementTerms(persona) }
    };
}
