// MCP's saved-view fields use the same keys, limits and semantic location check as PlanRecord.
import * as z from 'zod/v4';
import { createRequire } from 'node:module';
const PlanRecord = createRequire(import.meta.url)('../../frontend/js/plan-record.js');
export function createNamedPlanViewSchema() {
    const fields = PlanRecord.jsonSchema().properties.view.properties;
    const city = fields.city.anyOf[1], camera = fields.camera.anyOf[1].properties;
    const settings = fields.settings.anyOf[1].properties;
    const number = bounds => {
        let value = z.number();
        if (bounds.minimum != null) value = value.min(bounds.minimum);
        if (bounds.maximum != null) value = value.max(bounds.maximum);
        return value;
    };
    return z.object({
        at: z.string().refine(PlanRecord.semanticRules.location, { message: 'Use a valid saved map location.' }).describe(fields.at.description),
        mode: z.enum(fields.mode.enum),
        city: z.string().min(city.minLength).max(city.maxLength).nullable().optional(),
        language: z.enum(fields.language.anyOf[1].enum).nullable().optional(),
        camera: z.object({ targetLat: number(camera.targetLat), targetLng: number(camera.targetLng),
            headingDeg: number(camera.headingDeg), pitchRad: number(camera.pitchRad), range: number(camera.range) }).strict().nullable().optional(),
        rotate: z.boolean().describe(fields.rotate.description).optional(),
        settings: z.object(Object.fromEntries(Object.entries(settings).map(([key, limits]) =>
            [key, z.string().min(limits.minLength).max(limits.maxLength).optional()]))).strict().nullable().optional()
    }).strict();
}
