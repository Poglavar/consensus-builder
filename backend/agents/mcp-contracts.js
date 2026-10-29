// Common result fields are typed at the MCP boundary; authored/source-specific payloads stay data.
import * as z from 'zod/v4';

const object = z.record(z.string(), z.unknown());
export const mcpResultSchema = z.object({
    cid: z.string().optional(), previousCid: z.string().optional(),
    draftRef: z.string().url().optional(), previewUrl: z.string().url().nullable().optional(),
    url: z.string().url().optional(), approvalUrl: z.string().url().nullable().optional(),
    previewStatus: z.enum(['private-link', 'private-artifact']).optional(),
    previewExpiresAt: z.string().optional(), publication: z.union([z.enum(['private', 'published']), object]).optional(),
    parcelSourceId: z.string().nullable().optional(),
    total: z.number().int().nonnegative().optional(), offset: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(), items: z.array(object).optional(),
    values: z.array(z.object({ path: z.string(), untrustedValue: z.unknown() })).optional(),
    warnings: z.array(z.union([z.string(), object])).optional(),
    untrusted: object.optional(), next: object.optional(),
    code: z.string().optional(), message: z.string().optional(), field: z.string().optional(),
    constraints: z.unknown().optional(), issues: z.array(object).optional(),
    currentCid: z.string().optional(), expectedCid: z.string().optional(),
    status: z.number().int().optional(), retryable: z.boolean().optional(), retryAfter: z.number().nonnegative().optional(),
    stage: z.string().optional(), pinnedCids: z.array(z.string()).optional(), indexed: z.boolean().optional()
}).passthrough();

// Successful authoring responses have stable envelopes even though their authored records and
// source payloads are extensible. Error results use the common recovery fields: the MCP SDK
// deliberately skips successful-output validation when isError is true.
const cid = z.string().regex(/^baf(?:krei|ybei)[a-z2-7]{52}$/);
const count = z.number().int().nonnegative();
const record = schema => z.object({ schema: z.literal(schema) }).passthrough();
const authored = schema => z.object({ [schema.split('/')[0]]: record(schema) }).passthrough();
const privatePreview = {
    previewStatus: z.enum(['private-link', 'private-artifact']),
    previewUrl: z.string().url().nullable()
};
const designDraft = mcpResultSchema.extend({ cid, untrusted: authored('design/v1'), ...privatePreview });
// Every authored design is placed in the agent's working plan (docs/agent-working-plan.md): the new plan
// revision (or the unchanged one after a refusal), the placement and what it changed in the plan.
const placement = {
    plan: z.object({ cid }).passthrough().nullable(),
    placement: z.object({ status: z.enum(['placed', 'refused']) }).passthrough(),
    consequences: z.object({ removed: z.array(object), junctions: z.array(object), cuts: z.array(object) })
};
const placedDesign = designDraft.extend(placement);
const agreementDraft = mcpResultSchema.extend({ cid, untrusted: authored('agreement/v1'), designs: z.array(object), ...privatePreview });
const planResult = mcpResultSchema.extend({ cid, untrusted: authored('plan/v1'), designs: z.array(z.object({ cid }).passthrough()).min(1), publication: z.enum(['private', 'published']) });
const inventory = mcpResultSchema.extend({ cid, items: z.array(z.object({ ref: z.string(), kind: z.enum(['design', 'building', 'piece']) }).passthrough()), total: count, offset: count, truncated: z.boolean() });
const shapes = new Map();
const assign = (names, schema) => { for (const name of names) shapes.set(name, schema); };
assign(['ugt_draft_building', 'ugt_draft_station', 'ugt_draft_space', 'ugt_draft_parcel_layout', 'ugt_draft_urban_rule',
    'ugt_draft_road', 'ugt_draft_track', 'ugt_modify_design', 'ugt_edit_design'], placedDesign);
assign(['ugt_draft_agreement', 'ugt_edit_agreement'], agreementDraft);
assign(['ugt_draft_plan', 'ugt_get_plan', 'ugt_edit_plan'], planResult);
assign(['ugt_inspect_plan', 'ugt_inspect_agreement'], inventory);
assign(['ugt_inspect_design'], mcpResultSchema.extend({ cid, values: z.array(z.object({ path: z.string(), untrustedValue: z.unknown() })).min(1) }));
assign(['ugt_publish_plan'], mcpResultSchema.extend({ cid, untrusted: authored('plan/v1'), publication: z.literal('published'), url: z.string().url(), publishedDesignCids: z.array(cid) }));
assign(['ugt_validate_plan'], mcpResultSchema.extend({ cid, valid: z.boolean(), issues: z.array(z.object({ code: z.string(), ref: z.string() }).passthrough()), metrics: object, assessmentBasis: z.literal('authored-geometry'), sourceAssessment: object }));
assign(['ugt_capabilities'], mcpResultSchema.extend({ version: z.string(), mode: z.enum(['local', 'hosted']), endpoint: z.string().url(), workflow: z.array(z.string()).min(1), features: z.array(object), tools: z.array(z.object({ name: z.string(), title: z.string(), readOnly: z.boolean() })), drafts: z.object({ retention: z.string(), exportTool: z.literal('ugt_export_draft') }).passthrough() }));
assign(['ugt_help'], mcpResultSchema.extend({ topic: z.string() }));
assign(['ugt_list_sources'], mcpResultSchema.extend({ items: z.array(z.object({ id: z.string(), abstraction: z.string() }).passthrough()), total: count, offset: count, truncated: z.boolean(), abstractions: z.array(object) }));
assign(['ugt_export_draft'], mcpResultSchema.extend({ cid, artifact: object, publication: z.literal('private') }));
assign(['ugt_import_design'], mcpResultSchema.extend({ designs: z.array(designDraft).min(1), ...placement, publication: z.literal('private'), import: z.object({ format: z.enum(['geojson', 'osm', 'opendrive']), placement: z.string(), count: count, parser: z.string() }) }));
// A building or space model returns its private design; a furniture asset returns only the uploaded
// asset (its name arrives as untrusted prose) for a park or square to reference in decorationDesign.models.
const modelAsset = { modelUrl: z.string().url(), public: z.literal(true), durable: z.literal(true) };
const placedModel = designDraft.extend({ publication: z.literal('private'), asset: z.object({ ...modelAsset, footprint: z.literal('projected-model-triangles'), kind: z.enum(['building', 'park', 'square', 'lake']) }) });
const furnitureModel = mcpResultSchema.extend({ asset: z.object({ ...modelAsset, kind: z.literal('furniture'),
    limits: z.object({ maxTriangles: count, maxTextureSize: count, maxBytes: count, maxNameLength: count }) }).passthrough() });
assign(['ugt_import_model'], mcpResultSchema.extend({ cid: cid.optional(), asset: z.object({ ...modelAsset, kind: z.enum(['building', 'park', 'square', 'lake', 'furniture']) }).passthrough() })
    .superRefine((value, context) => {
        for (const issue of (value.asset?.kind === 'furniture' ? furnitureModel : placedModel).safeParse(value).error?.issues || [])
            context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }));
assign(['ugt_render_preview'], mcpResultSchema.extend({ ready: z.literal(true), publication: z.literal('private'), provenance: z.object({ renderer: z.enum(['app-map-preview-2d', 'app-scene-3d']), designCids: z.array(cid).min(1), persisted: z.literal(false) }), metrics: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), designCount: count }).passthrough() }));
assign(['ugt_compare'], mcpResultSchema.extend({ alternatives: z.array(z.object({ cid, areaBasis: z.literal('authored-geometry'), measurementErrors: z.array(object) }).passthrough()).min(2), warnings: z.array(z.union([z.string(), object])) }));

export function resultSchemaFor(name) { return shapes.get(name) || mcpResultSchema; }

export function argumentError(tool, issues = [], message = 'The tool arguments do not match its schema.') {
    return Object.assign(new Error(message), {
        code: 'invalid-arguments',
        field: issues[0]?.path?.join('.') || 'arguments',
        constraints: issues.map(issue => ({ field: issue.path?.join('.') || 'arguments', code: issue.code,
            message: issue.message, ...(issue.values ? { allowedValues: issue.values } : {}),
            ...(issue.minimum != null ? { minimum: issue.minimum } : {}), ...(issue.maximum != null ? { maximum: issue.maximum } : {}) })),
        next: { tool: 'ugt_help', arguments: { topic: tool }, action: 'Use the input schema and examples to correct the indicated fields, then retry.' }
    });
}
