// AI scene render (v1): turns a 3D-mode screenshot into a photorealistic image via Gemini's
// image model ("Nano Banana"). The client posts the captured canvas + a scene-derived caption;
// we forward both to gemini-2.5-flash-image (image-in + text-in -> image-out) and return the PNG.
// Billing is metered per render from usageMetadata and returned so the UI can show the exact cost.

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Only image-capable models are allowed — the client picks a name, so it must not be able to
// point us at an arbitrary model. Rates are USD per 1M tokens (input text/image, output image).
// gemini image output is a flat 1290 tokens/image => ~$0.039 at $30/1M.
const MODELS = {
    'gemini-2.5-flash-image': { in: 0.30, out: 30.0 },
    'gemini-3.1-flash-image': { in: 0.30, out: 30.0 }
};
const DEFAULT_MODEL = 'gemini-2.5-flash-image';

const MAX_PROMPT_CHARS = 8000;
const REQUEST_TIMEOUT_MS = 120_000;

// Pull the raw base64 + mime out of a data URL or a bare base64 string.
function parseImageInput(image) {
    if (typeof image !== 'string' || !image) return null;
    const m = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
    if (m) return { mimeType: m[1], data: m[2] };
    // Bare base64 with no data-URL header — assume PNG (what the canvas capture produces).
    return { mimeType: 'image/png', data: image };
}

function computeCostUsd(model, usage) {
    const rate = MODELS[model] || MODELS[DEFAULT_MODEL];
    const inTokens = usage?.promptTokenCount || 0;
    const outTokens = usage?.candidatesTokenCount || 0;
    return Number(((inTokens * rate.in + outTokens * rate.out) / 1_000_000).toFixed(6));
}

export function setupAiSceneRoute(app) {
    app.post('/ai-scene/render', async (req, res) => {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(501).json({ error: 'AI scene render is not configured: GEMINI_API_KEY is missing.' });
        }

        const { image, prompt } = req.body || {};
        const model = MODELS[req.body?.model] ? req.body.model : DEFAULT_MODEL;

        const parsed = parseImageInput(image);
        if (!parsed) {
            return res.status(400).json({ error: 'Missing or invalid "image" (expected a PNG data URL or base64 string).' });
        }
        if (typeof prompt !== 'string' || !prompt.trim()) {
            return res.status(400).json({ error: 'Missing "prompt".' });
        }
        if (prompt.length > MAX_PROMPT_CHARS) {
            return res.status(400).json({ error: `Prompt too long (max ${MAX_PROMPT_CHARS} chars).` });
        }

        const body = {
            contents: [{
                parts: [
                    { text: prompt },
                    { inlineData: { mimeType: parsed.mimeType, data: parsed.data } }
                ]
            }]
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const startedAt = Date.now();
        try {
            const resp = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
                method: 'POST',
                headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            });

            const data = await resp.json().catch(() => null);
            if (!resp.ok) {
                const msg = data?.error?.message || `Gemini returned HTTP ${resp.status}`;
                console.error(`[${new Date().toISOString()}] ai-scene: Gemini error ${resp.status}: ${msg}`);
                return res.status(502).json({ error: `Image generation failed: ${msg}` });
            }

            const parts = data?.candidates?.[0]?.content?.parts || [];
            const imagePart = parts.find(p => p.inlineData?.data);
            if (!imagePart) {
                // Model can refuse and return only text (safety, or it "described" instead of drawing).
                const textPart = parts.find(p => typeof p.text === 'string');
                const reason = textPart?.text?.slice(0, 300) || 'no image returned';
                console.error(`[${new Date().toISOString()}] ai-scene: no image in response — ${reason}`);
                return res.status(502).json({ error: `Model returned no image: ${reason}` });
            }

            const usage = data.usageMetadata || {};
            const costUsd = computeCostUsd(model, usage);
            const outMime = imagePart.inlineData.mimeType || 'image/png';
            console.log(`[${new Date().toISOString()}] ai-scene: ${model} ok in ${Date.now() - startedAt}ms, ` +
                `in=${usage.promptTokenCount || 0} out=${usage.candidatesTokenCount || 0} tok, cost $${costUsd.toFixed(4)}`);

            return res.json({
                image: `data:${outMime};base64,${imagePart.inlineData.data}`,
                model,
                usage: {
                    input_tokens: usage.promptTokenCount || 0,
                    output_tokens: usage.candidatesTokenCount || 0,
                    total_tokens: usage.totalTokenCount || 0
                },
                cost_usd: costUsd
            });
        } catch (err) {
            const aborted = err?.name === 'AbortError';
            const msg = aborted ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : err.message;
            console.error(`[${new Date().toISOString()}] ai-scene: request failed — ${msg}`);
            return res.status(aborted ? 504 : 500).json({ error: `Image generation failed: ${msg}` });
        } finally {
            clearTimeout(timer);
        }
    });
}
