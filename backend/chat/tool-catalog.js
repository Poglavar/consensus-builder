// This module translates the MCP catalogue to the narrow tool contract exposed to the chat model.
export const CHAT_TOOL_ALLOWLIST = Object.freeze([
    'ugt_chat_cost', 'ugt_map_view', 'ugt_select_parcels', 'ugt_find_place', 'ugt_parcel_context', 'ugt_list_designs', 'ugt_get_design', 'ugt_list_sources', 'ugt_explain', 'ugt_help',
    'ugt_draft_road', 'ugt_draft_building', 'ugt_draft_track', 'ugt_draft_station', 'ugt_draft_space', 'ugt_draft_parcel_layout', 'ugt_draft_urban_rule',
    'ugt_modify_design', 'ugt_inspect_design', 'ugt_edit_design', 'ugt_compare', 'ugt_draft_plan', 'ugt_get_plan',
    'ugt_validate_plan', 'ugt_inspect_plan', 'ugt_edit_plan'
]);

const allowed = new Set(CHAT_TOOL_ALLOWLIST);
export const STRIPPED_PARAMS = Object.freeze(['plan', 'expectedCid', 'when', 'buildout']);
const hasPlan = new Set(['ugt_draft_road', 'ugt_draft_building', 'ugt_draft_track', 'ugt_draft_station', 'ugt_draft_space', 'ugt_draft_parcel_layout', 'ugt_draft_urban_rule', 'ugt_modify_design', 'ugt_inspect_design', 'ugt_edit_design', 'ugt_compare', 'ugt_get_plan', 'ugt_inspect_plan', 'ugt_validate_plan', 'ugt_edit_plan']);
const requiresPlan = new Set(['ugt_get_plan', 'ugt_inspect_plan', 'ugt_validate_plan', 'ugt_edit_plan']);

export const RELAY_TOOLS = Object.freeze([
    { name: 'ask_person', description: 'Ask the person a concise clarification question and offer options when useful.', input_schema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, ref: { type: 'string' } }, required: ['label'], additionalProperties: false } } }, required: ['question'], additionalProperties: false } },
    { name: 'undo_last_change', description: 'Undo the last change to the working plan.', input_schema: { type: 'object', properties: {}, additionalProperties: false } }
]);

export function toModelTools(mcpTools = []) {
    const source = Array.isArray(mcpTools) ? mcpTools : mcpTools?.tools || [];
    const tools = source.filter(tool => allowed.has(tool.name)).map(tool => {
        const schema = structuredClone(tool.inputSchema || tool.input_schema || { type: 'object', properties: {} });
        delete schema.$schema;
        schema.type = 'object';
        schema.properties ||= {};
        const hidden = [...STRIPPED_PARAMS, ...(tool.name === 'ugt_map_view' ? ['view'] : tool.name === 'ugt_select_parcels' ? ['selection'] : [])];
        for (const key of hidden) delete schema.properties[key];
        if (Array.isArray(schema.required)) schema.required = schema.required.filter(key => !hidden.includes(key));
        return { name: tool.name, description: tool.description || '', input_schema: schema };
    });
    tools.push(...structuredClone(RELAY_TOOLS));
    if (tools.length) tools.at(-1).cache_control = { type: 'ephemeral' };
    return tools;
}

export function injectPlanArgs(name, input = {}, plan = null) {
    if (!allowed.has(name)) throw Object.assign(new Error(`Tool not available: ${name}`), { code: 'tool-not-available' });
    if (requiresPlan.has(name) && !plan) throw Object.assign(new Error('This action needs a working plan.'), { code: 'no-working-plan' });
    const args = Object.fromEntries(Object.entries(input).filter(([key]) => !STRIPPED_PARAMS.includes(key)));
    if (hasPlan.has(name) && plan?.draftRef) args.plan = plan.draftRef;
    if (name === 'ugt_edit_plan' && plan?.cid) args.expectedCid = plan.cid;
    if (name === 'ugt_edit_design') {
        const cid = typeof input.design === 'string' ? input.design : input.design?.cid;
        if (cid) args.expectedCid = cid;
    }
    if (name === 'ugt_inspect_plan') { args.includeGeometry = false; args.limit = Math.min(50, Math.max(1, Number(args.limit) || 50)); }
    return args;
}

export function restrictHelpTopic(input = {}) {
    const topic = String(input.topic || 'workflow');
    return { ...input, topic: ['workflow', 'editing'].includes(topic) || allowed.has(topic) ? topic : 'workflow' };
}
