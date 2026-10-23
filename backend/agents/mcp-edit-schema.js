// The generic authoring protocol: RFC 6902 patches plus metric geometry operations at JSON Pointers.
import * as z from 'zod/v4';
const path = z.string().max(1000).describe('RFC 6901 JSON Pointer into canonical authored content; /geometry/buildings/0/properties/height for example.');
const point = z.tuple([z.number().min(-180).max(180), z.number().min(-85).max(85)]);
export const editOperations = z.array(z.discriminatedUnion('op', [
    z.object({ op: z.literal('add'), path, value: z.unknown() }),
    z.object({ op: z.literal('replace'), path, value: z.unknown() }),
    z.object({ op: z.literal('test'), path, value: z.unknown() }),
    z.object({ op: z.literal('remove'), path }),
    z.object({ op: z.literal('copy'), path, from: path }),
    z.object({ op: z.literal('move'), path, from: path }),
    z.object({ op: z.literal('transform'), path, eastM: z.number().min(-100000).max(100000).optional(), northM: z.number().min(-100000).max(100000).optional(),
        degrees: z.number().min(-360).max(360).optional().describe('Counterclockwise degrees; clockwise is negative.'), scale: z.number().min(0.01).max(100).optional(), pivot: point.optional() }),
    z.object({ op: z.literal('union'), path, from: path }),
    z.object({ op: z.literal('difference'), path, from: path }),
    z.object({ op: z.literal('intersection'), path, from: path }),
    z.object({ op: z.literal('buffer'), path, metres: z.number().min(-1000).max(1000) })
])).min(1).max(200);
