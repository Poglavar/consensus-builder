// Scripted conversational evaluation cases over a caller-supplied, current devnet/source fixture.
// The fixture supplies identities and points; the model is never asked to invent geometry or hashes.
export function buildEvalTasks(seed) {
    if (!seed.city || !seed.parcelSourceId || !seed.parcelIds?.length || !seed.streetPoints?.length) throw new Error('Eval seed needs city, parcelSourceId, parcelIds and streetPoints');
    const scope = `Use city ${seed.city}, parcel source ${seed.parcelSourceId}, parcels ${JSON.stringify(seed.parcelIds)}. `;
    const street = `Use city ${seed.city} and this street centreline in WGS84: ${JSON.stringify(seed.streetPoints)}. `;
    const cases = [];
    const add = (id, request, expected) => cases.push({ id, request, expected });
    for (const [id, preset, drivingLanes, cycleLanes] of [['two-lanes', '1+1', 2, 0], ['four-lanes', '2+2', 4, 0], ['cycle-lanes', '1+1 with cycle lanes', 2, 2]])
        add(id, `${street}Draft a ${preset} road and show its preview.`, { goal: 'road-track', drivingLanes, cycleLanes });
    for (const kind of ['park', 'square', 'lake']) add(kind, `${scope}Draft a ${kind} and show its preview.`, { goal: kind, parcelIds: seed.parcelIds });
    for (const floors of [2, 4, 6, 8]) add(`building-${floors}`, `${scope}Draft a residential building with ${floors} floors and 40% site coverage.`, { goal: 'buildings', floors, parcelIds: seed.parcelIds });
    add('building-use', `${scope}Draft a three-floor office building.`, { goal: 'buildings', floors: 3, use: 'office' });
    add('equal-layout', `${scope}Draft four equal-area plots.`, { goal: 'parcel-layout', plots: 4 });
    add('schelling-layout', `${scope}Draft automatic Schelling plots.`, { goal: 'parcel-layout' });
    add('urban-rule', `${scope}Draft an authored urban rule with maximum six floors; show the preview.`, { goal: 'urban-rule' });
    add('fork-road', `${street}Draft a 1+1 road, then fork it and widen it by 2 metres on both sides.`, { goal: 'road-track', origin: true });
    add('add-cycle-lane', `${street}Draft a 1+1 road, then add a cycleway on the north side.`, { goal: 'road-track', cycleLanes: 1, origin: true });
    add('fork-building', `${scope}Draft a four-floor building, then fork it with six floors.`, { goal: 'buildings', floors: 6, origin: true });
    add('fork-space', `${scope}Draft a park, then fork it into a square titled Civic square.`, { goal: 'square', origin: true, title: 'Civic square' });
    add('compare', `${scope}Draft a park and a four-floor building, compare the two, and return both map links.`, { alternatives: 2 });
    add('agreement', `${scope}Draft a park and a non-binding community agreement over it. Return the agreement preview without publishing.`, { schema: 'agreement/v1', parcelIds: seed.parcelIds });
    if (seed.agreementAccount) add('bet-approval', `Prepare a YES bet approval link for 0.05 devnet USDC on account ${seed.agreementAccount} in ${seed.city}. Do not sign.`, { action: 'bet', target: seed.agreementAccount, amount: '0.05', side: 'yes' });
    return cases;
}
