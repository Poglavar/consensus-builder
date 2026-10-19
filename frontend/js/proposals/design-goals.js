// Design/tool concepts shared by the editor and archive boundary. These describe authored intent,
// not a physical object's existence, a decision kind, or a statutory land-use classification.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalDesignGoals = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const definitions = [
        ['as-is', 'Keep as is', 'Retain the selected ground or existing design while changing ownership or proposal terms.'],
        ['square', 'Square', 'An authored square or paved open-space design.', true],
        ['park', 'Park', 'An authored park or landscaped open-space design.', true],
        ['lake', 'Lake', 'An authored water-body design.', true],
        ['station', 'Station', 'An authored transit-station structure design and its parameters.', true],
        ['single', 'Freeform building', 'Authored freeform building geometry; the tool name does not require exactly one building.'],
        ['buildings', 'Block building rule', 'A parcel-bound block building design and its authored rule parameters.'],
        ['row', 'Row building rule', 'A parcel-bound row building design and its authored rule parameters.'],
        ['parcelBased', 'Detached building rule', 'Buildings generated separately on selected parcels from authored detached-building rules.'],
        ['urban-rule', 'Urban rule', 'An authored urban-rule proposal handled by the generic record editor.'],
        ['road-track', 'Road or track', 'An authored corridor design with route, profile and segment parameters.'],
        ['reparcellization', 'Land readjustment', 'An authored subdivision and allocation arrangement over declared cadastral land.'],
        ['ownership-transfer', 'Ownership transfer', 'Proposed changes to rights or recipients; transfer direction is a separate term.']
    ].map(([key, label, definition, structure = false]) => Object.freeze({ key, label, definition, structure }));
    const byKey = new Map(definitions.map(concept => [concept.key, concept]));
    const get = key => byKey.get(key) || null;
    return Object.freeze({
        concepts: Object.freeze(definitions),
        keys: Object.freeze(definitions.map(concept => concept.key)),
        structureKeys: Object.freeze(definitions.filter(concept => concept.structure).map(concept => concept.key)),
        get
    });
});
