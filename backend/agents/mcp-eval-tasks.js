// Scripted conversational evaluation cases over a caller-supplied, current devnet/source fixture.
// The fixture supplies identities and points; the model is never asked to invent geometry or hashes.
export function buildEvalTasks(seed) {
    if (!seed.city || !seed.parcelSourceId || !seed.parcelIds?.length || !seed.streetPoints?.length) throw new Error('Eval seed needs city, parcelSourceId, parcelIds and streetPoints');
    const scope = `Use city ${seed.city}, parcel source ${seed.parcelSourceId}, parcels ${JSON.stringify(seed.parcelIds)}. `;
    const street = `Use city ${seed.city}, parcel source ${seed.parcelSourceId}, and this street centreline in WGS84: ${JSON.stringify(seed.streetPoints)}. `;
    const cases = [];
    const add = (id, request, expected) => cases.push({ id, request, expected });
    for (const [id, preset, drivingLanes, cycleLanes] of [['two-lanes', '1+1', 2, 0], ['four-lanes', '2+2', 4, 0], ['cycle-lanes', '1+1 with cycle lanes', 2, 2]])
        add(id, `${street}Draft a ${preset} road and show its preview.`, { goal: 'road-track', drivingLanes, cycleLanes });
    cases.find(task => task.id === 'two-lanes').constructionType = 'road';
    for (const kind of ['park', 'square', 'lake']) { add(kind, `${scope}Draft a ${kind} and show its preview.`, { goal: kind, parcelIds: seed.parcelIds }); cases.at(-1).constructionType = kind; }
    for (const floors of [2, 4, 6, 8]) add(`building-${floors}`, `${scope}Draft a residential building with ${floors} floors and 40% site coverage.`, { goal: 'single', floors, parcelIds: seed.parcelIds });
    cases.find(task => task.id === 'building-2').constructionType = 'freeform';
    add('building-use', `${scope}Draft a three-floor office building.`, { goal: 'single', floors: 3, use: 'office' });
    add('equal-layout', `${scope}Draft four equal-area plots.`, { goal: 'parcel-layout', plots: 4 });
    cases.at(-1).constructionType = 'parcel-layout';
    add('schelling-layout', `${scope}Draft automatic Schelling plots.`, { goal: 'parcel-layout' });
    add('urban-rule', `${scope}Draft an authored urban rule with maximum six floors; show the preview.`, { goal: 'urban-rule' });
    add('fork-road', `${street}Draft a 1+1 road, then fork it and increase its total cross-section width by exactly 2 metres symmetrically on both sides.`, { goal: 'road-track', origin: true, widthIncreaseM: 2 });
    add('add-cycle-lane', `${street}Draft a 1+1 road, then add a cycleway on the north side.`, { goal: 'road-track', cycleLanes: 1, origin: true });
    add('fork-building', `${scope}Draft a four-floor building, then fork it with six floors.`, { goal: 'single', floors: 6, origin: true });
    add('fork-space', `${scope}Draft a park, then fork it into a square titled Civic square.`, { goal: 'square', origin: true, title: 'Civic square' });
    add('compare', `${scope}Draft a park and a four-floor building, compare the two, and return both map links.`, { alternatives: 2 });
    add('agreement', `${scope}Draft a park and a non-binding community agreement over it. Return the agreement preview without publishing.`, { schema: 'agreement/v1', parcelIds: seed.parcelIds });
    for (const [typology, goal] of [['block','buildings'],['row','row'],['detached','parcelBased']]) {
        add(`building-${typology}`, `${scope}Draft a four-floor ${typology} building rule using the app's typed constructor and return its preview. Use supported dimensions that fit these parcels.`, { goal, parcelIds: seed.parcelIds });
        cases.at(-1).constructionType = typology;
    }
    add('track', `${street}Draft a 1000 mm gauge tram track with an 80 km/h design target; return the preview.`, { goal: 'road-track', rail: true, gauge: 1000, trackSpeed: 80 });
    cases.at(-1).constructionType = 'track';
    for (const stationType of ['bus','tram','underground','elevated']) {
        add(`station-${stationType}`, `${street}Draft a compatible ${stationType === 'bus' ? 'road with driving lanes' : 'rail corridor'} and then a ${stationType} station at its midpoint, referencing the returned corridor. Inspect the exact station-tool schema first and return its preview.`, { goal: 'station', stationType });
        cases.at(-1).constructionType = `station-${stationType}`;
    }
    add('named-plan', `${scope}Draft a four-floor building and park, save both in a private named plan titled Riverside plan with a model map view, and return its preview. No agreement terms or publication.`, { schema: 'plan/v1', title: 'Riverside plan', mode: 'model', designCount: 2 });
    add('named-plan-edit', `${scope}Draft a four-floor building and a park, save a named plan containing both, inspect it, then use the exact plan CID and object refs to remove the park, rename it Housing revision, and save the view in 2d mode. Return the revised preview; retain the original snapshot.`, { schema: 'plan/v1', title: 'Housing revision', mode: '2d', designCount: 1, revision: true, removedGoal: 'park', requiredTools: ['ugt_inspect_plan','ugt_edit_plan'] });
    if (seed.agreementAccount) add('bet-approval', `Prepare a YES bet approval link for 0.05 devnet USDC on account ${seed.agreementAccount} in ${seed.city}. Do not sign.`, { action: 'bet', target: seed.agreementAccount, amount: '0.05', side: 'yes' });
    return cases;
}

// No source IDs, parcel IDs or source polygons are seeded into these requests. The model must discover them.
export function buildDiscoveryEvalTasks({ city = 'london', query = 'Trafalgar Square, London' } = {}) {
    const scope = `Find ${query} in city ${city}. No parcel source or parcel ID has been supplied. `;
    return [
        { id: 'unseeded-discovery', request: `${scope}Use tool-accessible help and source discovery, choose a supported parcel at that location, then draft a park and return its private preview. Do not invent identities or treat missing data as empty land.`, expected: { goal: 'park', requiredTools: ['ugt_help','ugt_find_place','ugt_list_sources'] } },
        { id: 'missing-source-recovery', request: `${scope}Find a parcel and first try a park draft with that parcel ID but without parcelSourceId. Follow the tool's correction: discover a real supported parcel source, retry with its explicit identity, and return the successful private preview.`, expected: { goal: 'park', sourceRecovery: true, requiredTools: ['ugt_find_place','ugt_list_sources'] } }
    ];
}
