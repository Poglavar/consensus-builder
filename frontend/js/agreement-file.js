// Portable agreements: an agreement/v1 record together with the plan file of its plan, so another
// device can hold the same terms over the same designs. `designCids` follows each design from the
// CID the agreement names to the CID it has in the plan file (embedding a model changes it).
// Import makes a local draft: the plan's designs arrive as drafts (PlanFile.importInto) and the
// agreement is saved under a new id, pointing at them, with no publication or chain account.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgreementFile = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const SCHEMA = 'ugt-agreement-file/v1';
    const dependency = name => root[name] || (typeof require === 'function' ? require({
        AgreementRecord: './agreement-record.js', PlanFile: './plan-file.js', Cid: './cid.js'
    }[name]) : null);
    const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
    const fail = message => { throw new Error(message); };

    // create(agreement, planFile, designCids) -> the file. planFile is PlanFile.create's output for the
    // agreement's plan members and designCids its cidMap.
    function create(agreement, planFile, designCids) {
        const record = dependency('AgreementRecord').normalize(agreement);
        if (!record.plan) fail('Only an agreement with a plan can be downloaded.');
        return validate({ schema: SCHEMA, agreement: record, designCids: { ...designCids }, planFile });
    }

    function validate(file) {
        if (!object(file) || file.schema !== SCHEMA) fail(`Expected ${SCHEMA}. Unsupported file or version.`);
        const keys = Object.keys(file).sort().join(',');
        if (keys !== 'agreement,designCids,planFile,schema') fail('The agreement file has unexpected members.');
        const agreement = dependency('AgreementRecord').normalize(file.agreement);
        if (!agreement.plan) fail('The agreement in the file has no plan.');
        dependency('PlanFile').validate(file.planFile);
        if (!object(file.designCids)) fail('The agreement file does not map its designs.');
        const inFile = new Set(file.planFile.plan.designCids);
        const named = new Set([...agreement.plan.content.designCids, ...agreement.designs.map(design => design.cid)]);
        named.forEach(cid => { if (!inFile.has(file.designCids[cid])) fail('A design of the agreement is missing from its plan file.'); });
        if (named.size !== inFile.size) fail('The plan file holds designs the agreement does not name.');
        return file;
    }

    function parse(text) {
        if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > dependency('PlanFile').MAX_BYTES) fail('Agreement files are limited to 32 MiB.');
        let file;
        try { file = JSON.parse(text); } catch (_) { fail('The file is not valid JSON.'); }
        return validate(file);
    }

    const stringify = file => JSON.stringify(validate(file), null, 2) + '\n';

    // The agreement as a local draft over the imported plan: `imported` is PlanFile.importInto's answer
    // ({ cid, content, memberIds } in the plan file's design order).
    function localAgreement(file, imported, { id, now = new Date().toISOString() }) {
        validate(file);
        const proposalIdOf = new Map(file.planFile.designs.map((row, index) => [row.cid, imported.memberIds[index]]));
        const { published: _published, onchain: _onchain, ...terms } = dependency('AgreementRecord').normalize(file.agreement);
        return dependency('AgreementRecord').normalize({ ...terms, id, createdAt: now, updatedAt: now,
            plan: { cid: imported.cid, content: imported.content },
            designs: terms.designs.map(design => {
                const cid = file.designCids[design.cid];
                return { ...design, cid, proposalId: proposalIdOf.get(cid) };
            }) });
    }

    return Object.freeze({ SCHEMA, create, validate, parse, stringify, localAgreement });
});
