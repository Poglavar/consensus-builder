// Affordabot research policy: real courtyard geometry, explicit evidence gaps, no invented rent or zoning.
import { massingFor } from './housing-massing.js';
import { buildingBaseline } from './building-baseline.js';

export function chooseHousingArea(areas, day) {
    const ranked = [...areas].sort((a,b) => b.medianMultiple-a.medianMultiple);
    if (!ranked.length) throw new Error('Affordabot needs ranked areas');
    const rotation = [...ranked, ...ranked.slice(0,2)];
    return rotation[Math.floor(Date.parse(`${day.slice(0,10)}T00:00:00Z`)/86400000)%rotation.length];
}

export function planHousingCandidates(parcels, persona, { turf, money, limit = 8 } = {}) {
    const candidates = [];
    for (const parcel of parcels) {
        if (!parcel.housingScreen || parcel.housingScreen.excluded || !parcel.housingScreen.complete) continue;
        if (parcel.areaM2 < 1200 || parcel.areaM2 > 20000) continue;
        const rule = { floors: 6, setbackM: 3, coveragePct: 60 };
        const alternatives = ['courtyard','compact'].map(form => ({form, shape: massingFor(parcel,form,rule,turf)})).filter(v=>v.shape);
        const variant = alternatives.find(v=>v.form==='courtyard') || alternatives[0];
        if (!variant) continue;
        const homes = Math.floor(variant.shape.gfaM2 * 0.8 / 50);
        if (homes < 10) continue;
        const distance = parcel.housingScreen.transitDistanceM;
        if (!Number.isFinite(distance) || distance > 800) continue;
        const housing = { status:'research-concept', form:variant.form, homes, unitM2:50, netRatio:0.8,
            assumptions:rule, existingUseVerified:false, currentZoning:null, requiredZoningChanges:null,
            rent:null, localCostEvidence:null, ownerConsent:false, authorityApproval:false,
            delivery:'Public, cooperative or limited-profit rental housing; affordability covenant and funding required.',
            affordability:parcel.housingArea, screening:parcel.housingScreen,
            evidenceGaps:['Current zoning and exact amendments','Ownership and availability','Complete building/road inventory and existing occupants',
                'Heritage, flood, ecology and utilities','Walking routes and transit frequency','Local construction/land/finance costs','Funded long-term affordability covenant'] };
        candidates.push({...parcel, candidateId:`${persona.name}:${parcel.parcelId}`, massing:variant.shape.massing,
            proposedGfaM2:variant.shape.gfaM2, ...buildingBaseline(),
            plannedFloors:6, allowedFloors:6, currency:money?.currency ?? null, gain:null, offer:null,
            rule:{source:'housing-research'}, normalizedRule:null, housing,
            score: (1-distance/1000) + Math.min(homes/100,1) + (variant.form==='courtyard'?0.5:0)});
    }
    return candidates.sort((a,b)=>b.score-a.score || a.parcelId.localeCompare(b.parcelId)).slice(0,limit);
}

export function housingPick(candidate) {
    const h=candidate.housing, a=h.affordability;
    const name=`${h.homes}-home ${h.form} research, ${a.label}`.slice(0,60);
    const rationale=`Affordabot housing research: ${a.label}'s metropolitan market has a ${a.medianMultiple} median house-price/annual-household-income ratio (Demographia 2026, Q3 2025; 96 markets in eight countries, not an exhaustive world ranking). Source: ${a.rankingUrl}\n`+
        `Parcel ${candidate.parcelId}: a schematic ${h.form} of ${Math.round(candidate.proposedGfaM2)} m² gross floor area, 6 floors, approximately ${h.homes} homes at 50 m² net per home and 80% net efficiency. `+
        `Mapped transit stop is ${Math.round(h.screening.transitDistanceM)} m away in a straight line; walking routes and service frequency remain unverified. `+
        `OpenStreetMap screening found no mapped building, transport corridor or protected/public-use feature intersecting the study site (transport corridors are checked against the 3 m setback envelope); this does not establish vacancy or buildability. `+
        `These are design assumptions, not permitted zoning limits. Current zoning and exact amendments are unknown: please assess residential use, height, setbacks, coverage and parking before requesting any specific rule change. `+
        `Delivery requires public/cooperative/limited-profit ownership or management, a funded long-term affordability covenant, and household housing costs targeted at at most 30% of income. No local rent or financial feasibility is claimed. `+
        `Owner consent, existing occupants, heritage/flood/environment and infrastructure require review. No land transfer is requested.\nPlanning authority for this bounded study area: ${a.authority.name}. Contact: ${a.authority.url}`;
    return {candidateId:candidate.candidateId,name,rationale};
}

export function housingOutreach({ candidate, agreementCid, publicBase }) {
    const origin=new URL(publicBase);
    if(origin.protocol!=='https:' || origin.hostname==='localhost') throw new Error('Explicit public HTTPS origin required');
    const a=candidate.housing.affordability;
    if (typeof agreementCid !== 'string' || !/^baf(?:krei|ybei)[a-z2-7]{52}$/.test(agreementCid)) throw new Error('A published agreement is required for outreach');
    const url=new URL(`/agreements/${agreementCid}?city=${encodeURIComponent(a.city)}`,origin).href;
    return {id:agreementCid,status:'pending-review',channel:a.authority.email?'email':'official-contact-form',
        authority:a.authority,agreementUrl:url,subject:`Housing research for planning review — ${a.label}`,
        body:`Hello ${a.authority.name},\n\nAffordabot is an automated housing research project. We prepared an illustrative housing concept for parcel ${candidate.parcelId}:\n${url}\n\n${housingPick(candidate).rationale}\n\nCould your planning team confirm the current controls, identify whether amendments would be needed, and advise the appropriate public process? This is an inquiry, not a planning application or a claim of owner consent. Please let us know if this is the wrong department or you do not want further contact.`,
        x:{status:'disabled',reason:'Unsolicited automated mentions require recipient opt-in.'}};
}
