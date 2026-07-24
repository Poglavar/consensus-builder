// AI scene render: turns a 3D-mode screenshot into a photorealistic image via a user-selectable
// image-editing model. Four providers: Google Gemini (generateContent, token-metered), OpenAI
// GPT Image (images/edits, token-metered), xAI Grok Imagine (images/edits, flat per-image), and
// fal.ai (hosts FLUX.2 / Seedream / Qwen, flat per-image pricing — no usage metadata, so cost
// is the published flat rate). The client posts the captured canvas + a scene-derived caption;
// we forward both (image-in + text-in -> image-out) and return the PNG plus the per-render cost.

import { randomBytes } from 'crypto';
import { decodeImageDataUrl, saveImageBuffer } from '../utils/image-store.js';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENAI_EDITS_ENDPOINT = 'https://api.openai.com/v1/images/edits';
const XAI_EDITS_ENDPOINT = 'https://api.x.ai/v1/images/edits';
const FAL_RUN_ENDPOINT = 'https://fal.run';

// Short URL-safe slug for a shared render: /proposals/:id?scene=<slug>. Lowercase base36 on
// purpose — saveImageBuffer lowercases the on-disk filename, so a mixed-case slug could let two
// distinct scenes collide to the same image file. Lowercase-only keeps slug == filename base.
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function makeSlug(len = 12) {
    const bytes = randomBytes(len);
    let s = '';
    for (let i = 0; i < len; i++) s += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
    return s;
}

// Absolute base for stored image URLs. Prefer the pinned public base (prod ecosystem env) over the
// request Host header — a persisted URL served to browsers/crawlers must never derive from a
// client-controlled Host. Locally PUBLIC_API_BASE_URL is unset, so fall back to the request origin.
function publicApiBase(req) {
    const pinned = process.env.PUBLIC_API_BASE_URL;
    if (pinned) return pinned.replace(/\/$/, '');
    return `${req.protocol}://${req.get('host')}`;
}

// Only allowlisted models are callable — the client picks a name, so it must not be able to
// point us at an arbitrary model. Rates are USD per 1M tokens; estUsd is the ~1MP per-image
// estimate shown in the UI before generating (metered providers return the real cost).
// Pricing researched 2026-07-23; flat fal rates must be kept in sync with fal.ai pricing pages.
const MODELS = {
    'gemini-2.5-flash-image': {
        provider: 'gemini',
        label: 'Nano Banana (Gemini 2.5 Flash)',
        rates: { in: 0.30, out: 30.0 }, // flat 1290 output tokens/image => ~$0.039
        estUsd: 0.039
    },
    'gemini-3.1-flash-image': {
        provider: 'gemini',
        label: 'Nano Banana 2 (Gemini 3.1 Flash)',
        rates: { in: 0.50, out: 60.0 }, // 1120 tok @1K out => ~$0.067 (more at 2K/4K)
        estUsd: 0.067
    },
    'gemini-3-pro-image': {
        provider: 'gemini',
        label: 'Nano Banana Pro (Gemini 3 Pro)',
        rates: { in: 2.00, out: 120.0 }, // ~1120 tok @1K/2K => ~$0.134
        estUsd: 0.134
    },
    'gpt-image-2': {
        provider: 'openai',
        label: 'GPT Image 2 (OpenAI)',
        // $5/1M text-in, $8/1M image-in, $30/1M image-out. Per-image cost depends on the
        // quality knob; we request 'high' (this feature exists to compare best-effort quality),
        // which measured ~8.2k output tokens => ~$0.25/image on a real render.
        rates: { textIn: 5.0, imageIn: 8.0, out: 30.0 },
        estUsd: 0.25
    },
    'flux-2-pro': {
        provider: 'fal',
        falEndpoint: 'fal-ai/flux-2-pro/edit',
        label: 'FLUX.2 [pro] (Black Forest Labs)',
        flatUsd: 0.03, // $0.03 first output MP + $0.015/MP per extra input/output MP
        estUsd: 0.03
    },
    'seedream-4.5': {
        provider: 'fal',
        falEndpoint: 'fal-ai/bytedance/seedream/v4.5/edit',
        label: 'Seedream 4.5 (ByteDance)',
        flatUsd: 0.04,
        estUsd: 0.04
    },
    'qwen-image-2': {
        provider: 'fal',
        falEndpoint: 'fal-ai/qwen-image-2/edit',
        label: 'Qwen Image 2.0 (Alibaba)',
        flatUsd: 0.035,
        estUsd: 0.035
    },
    'grok-imagine-image': {
        provider: 'xai',
        label: 'Grok Imagine (xAI)',
        // $0.02/image, and edits are billed for BOTH the input and the output image => ~2x.
        flatUsd: 0.04,
        estUsd: 0.04
    },
    'grok-imagine-image-quality': {
        provider: 'xai',
        label: 'Grok Imagine Quality (xAI)',
        flatUsd: 0.10, // $0.05/image x2 (input + output, see above)
        estUsd: 0.10
    }
};
const DEFAULT_MODEL = 'gemini-2.5-flash-image';

// Which env var unlocks each provider. Unset => the model is listed as unconfigured and
// rendering with it returns 501 (the UI greys it out but still shows it, with its price).
const PROVIDER_ENV_KEYS = { gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', xai: 'GROK_IMAGINE_API_KEY', fal: 'FAL_AI_API_KEY' };

const MAX_PROMPT_CHARS = 8000;
// Gemini answers within ~30s; gpt-image at quality=high routinely exceeds 120s, and fal
// queue-based endpoints can add cold-start wait — give the slow providers more rope.
const PROVIDER_TIMEOUT_MS = { gemini: 120_000, openai: 300_000, xai: 300_000, fal: 300_000 };

// Pull the raw base64 + mime out of a data URL or a bare base64 string.
function parseImageInput(image) {
    if (typeof image !== 'string' || !image) return null;
    const m = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
    if (m) return { mimeType: m[1], data: m[2] };
    // Bare base64 with no data-URL header — assume PNG (what the canvas capture produces).
    return { mimeType: 'image/png', data: image };
}

function toDataUrl(parsed) {
    return `data:${parsed.mimeType};base64,${parsed.data}`;
}

function computeGeminiCostUsd(rates, usage) {
    const inTokens = usage?.promptTokenCount || 0;
    const outTokens = usage?.candidatesTokenCount || 0;
    return Number(((inTokens * rates.in + outTokens * rates.out) / 1_000_000).toFixed(6));
}

function computeOpenaiCostUsd(rates, usage) {
    // usage.input_tokens_details splits text vs image input tokens (different rates).
    const details = usage?.input_tokens_details || {};
    const textIn = details.text_tokens ?? 0;
    // If the split is missing, bill all input at the (higher) image rate — never under-report.
    const imageIn = details.image_tokens ?? (usage?.input_tokens || 0);
    const out = usage?.output_tokens || 0;
    return Number(((textIn * rates.textIn + imageIn * rates.imageIn + out * rates.out) / 1_000_000).toFixed(6));
}

// --- Provider calls. Each returns { imageDataUrl, usage: {input_tokens, output_tokens, total_tokens}, costUsd }
// and throws Error(message) on provider-side failure (mapped to 502 by the route).

async function callGemini(model, cfg, apiKey, parsed, parsedHeight, prompt, signal) {
    const parts = [
        { text: prompt },
        { inlineData: { mimeType: parsed.mimeType, data: parsed.data } }
    ];
    if (parsedHeight) {
        parts.push({ inlineData: { mimeType: parsedHeight.mimeType, data: parsedHeight.data } });
    }

    const resp = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] }),
        signal
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
        throw new Error(data?.error?.message || `Gemini returned HTTP ${resp.status}`);
    }

    const outParts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = outParts.find(p => p.inlineData?.data);
    if (!imagePart) {
        // Model can refuse and return only text (safety, or it "described" instead of drawing).
        const textPart = outParts.find(p => typeof p.text === 'string');
        throw new Error(`model returned no image: ${textPart?.text?.slice(0, 300) || 'empty response'}`);
    }

    const usage = data.usageMetadata || {};
    return {
        imageDataUrl: `data:${imagePart.inlineData.mimeType || 'image/png'};base64,${imagePart.inlineData.data}`,
        usage: {
            input_tokens: usage.promptTokenCount || 0,
            output_tokens: usage.candidatesTokenCount || 0,
            total_tokens: usage.totalTokenCount || 0
        },
        costUsd: computeGeminiCostUsd(cfg.rates, usage)
    };
}

async function callOpenai(model, cfg, apiKey, parsed, parsedHeight, prompt, signal) {
    // images/edits takes multipart form data; image[] accepts several reference images.
    // quality=high because this feature exists to compare best-effort output. (gpt-image-1's
    // input_fidelity knob is gone in gpt-image-2 — the API rejects it.)
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('quality', 'high');
    form.append('image[]', new Blob([Buffer.from(parsed.data, 'base64')], { type: parsed.mimeType }), 'scene.png');
    if (parsedHeight) {
        form.append('image[]', new Blob([Buffer.from(parsedHeight.data, 'base64')], { type: parsedHeight.mimeType }), 'heightmap.png');
    }

    const resp = await fetch(OPENAI_EDITS_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
        throw new Error(data?.error?.message || `OpenAI returned HTTP ${resp.status}`);
    }

    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error('model returned no image');

    const usage = data.usage || {};
    return {
        imageDataUrl: `data:image/png;base64,${b64}`,
        usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            total_tokens: usage.total_tokens || 0
        },
        costUsd: computeOpenaiCostUsd(cfg.rates, usage)
    };
}

async function callXai(model, cfg, apiKey, parsed, parsedHeight, prompt, signal) {
    // xAI images/edits takes JSON with a single documented `image` object (data URIs accepted).
    // Multi-image edits exist (up to 3 sources) but the array shape is undocumented, so the
    // height map is NOT sent to Grok — the colour screenshot alone carries the scene.
    const resp = await fetch(XAI_EDITS_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            prompt,
            image: { url: toDataUrl(parsed), type: 'image_url' }
        }),
        signal
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
        throw new Error(data?.error?.message || data?.error || `xAI returned HTTP ${resp.status}`);
    }

    const b64 = data?.data?.[0]?.b64_json;
    const url = data?.data?.[0]?.url || data?.url;
    let imageDataUrl = b64 ? `data:image/png;base64,${b64}` : url;
    if (!imageDataUrl) throw new Error('model returned no image');
    if (!imageDataUrl.startsWith('data:')) {
        const imgResp = await fetch(imageDataUrl, { signal });
        if (!imgResp.ok) throw new Error(`failed to fetch result image (HTTP ${imgResp.status})`);
        const mime = imgResp.headers.get('content-type') || 'image/png';
        const buf = Buffer.from(await imgResp.arrayBuffer());
        imageDataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    }

    return {
        imageDataUrl,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, // flat per-image billing, no token usage
        costUsd: cfg.flatUsd
    };
}

async function callFal(model, cfg, apiKey, parsed, parsedHeight, prompt, signal) {
    // SHIM — written from fal.ai's documented schemas but not yet exercised against a live
    // FAL_KEY. The common edit contract is {prompt, image_urls:[...]} (data URIs accepted) and
    // {images:[{url}]} back; verify per-endpoint on the first configured run.
    const imageUrls = [toDataUrl(parsed)];
    if (parsedHeight) imageUrls.push(toDataUrl(parsedHeight));

    const resp = await fetch(`${FAL_RUN_ENDPOINT}/${cfg.falEndpoint}`, {
        method: 'POST',
        headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, image_urls: imageUrls }),
        signal
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
        const msg = data?.detail || data?.error || `fal.ai returned HTTP ${resp.status}`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 300));
    }

    const url = data?.images?.[0]?.url || data?.image?.url;
    if (!url) throw new Error('model returned no image');

    let imageDataUrl = url;
    if (!url.startsWith('data:')) {
        // fal usually returns a CDN URL — inline it so the client gets the same shape as
        // the other providers (and the result survives fal's file retention window).
        const imgResp = await fetch(url, { signal });
        if (!imgResp.ok) throw new Error(`failed to fetch result image (HTTP ${imgResp.status})`);
        const mime = imgResp.headers.get('content-type') || 'image/png';
        const buf = Buffer.from(await imgResp.arrayBuffer());
        imageDataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    }

    return {
        imageDataUrl,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, // fal reports no token usage
        costUsd: cfg.flatUsd // flat published rate — not metered
    };
}

const PROVIDER_CALLS = { gemini: callGemini, openai: callOpenai, xai: callXai, fal: callFal };

const MAX_SAVE_PROMPT_CHARS = 8000;
const MAX_PROPOSAL_IDS = 200;

export function setupAiSceneRoute(app, pool) {
    // Persist a generated render as a shareable "scene": store the PNG, then record the image URL
    // plus everything needed to reconstruct the world + camera for a link-follower. Returns a slug.
    app.post('/ai-scene/save', async (req, res) => {
        if (!pool) return res.status(501).json({ error: 'Scene sharing is not configured (no database).' });
        try {
            const { image, focusProposalId, proposalIds, view, city, lang, model, prompt } = req.body || {};

            const decoded = decodeImageDataUrl(image);
            if (!decoded || !decoded.buffer.length) {
                return res.status(400).json({ error: 'Missing or invalid "image" (expected a PNG data URL).' });
            }
            const ids = Array.isArray(proposalIds)
                ? proposalIds.map(v => String(v)).filter(Boolean).slice(0, MAX_PROPOSAL_IDS)
                : [];
            const safePrompt = typeof prompt === 'string' ? prompt.slice(0, MAX_SAVE_PROMPT_CHARS) : null;

            const slug = makeSlug();
            const { imagePath } = saveImageBuffer(decoded.buffer, `scene-${slug}`, decoded.extension || 'png');
            const imageUrl = `${publicApiBase(req)}${imagePath}`;

            await pool.query(
                `INSERT INTO ai_scene (slug, image_url, focus_proposal_id, proposal_ids, view, city, lang, model, prompt)
                 VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)`,
                [
                    slug, imageUrl,
                    focusProposalId != null ? String(focusProposalId) : null,
                    JSON.stringify(ids),
                    view != null ? JSON.stringify(view) : null,
                    city != null ? String(city).slice(0, 100) : null,
                    lang != null ? String(lang).slice(0, 10) : null,
                    MODELS[model] ? model : (model != null ? String(model).slice(0, 100) : null),
                    safePrompt
                ]
            );

            console.log(`[${new Date().toISOString()}] ai-scene: saved scene ${slug} (focus=${focusProposalId ?? '-'}, ${ids.length} proposals)`);
            return res.json({ slug, imageUrl });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] ai-scene: save failed — ${err.message}`);
            return res.status(500).json({ error: 'Failed to save scene.' });
        }
    });

    // Fetch a saved scene by slug — used by the follower flow to reconstruct the world + camera,
    // and by the OG worker to build the unfurl card.
    app.get('/ai-scene/scene/:slug', async (req, res) => {
        if (!pool) return res.status(501).json({ error: 'Scene sharing is not configured (no database).' });
        try {
            const result = await pool.query(
                `SELECT slug, image_url, focus_proposal_id, proposal_ids, view, city, lang, model, prompt, created_at
                 FROM ai_scene WHERE slug = $1`,
                [req.params.slug]
            );
            if (result.rows.length === 0) return res.status(404).json({ error: 'Scene not found' });
            const r = result.rows[0];
            return res.json({
                slug: r.slug,
                imageUrl: r.image_url,
                focusProposalId: r.focus_proposal_id,
                proposalIds: r.proposal_ids || [],
                view: r.view,
                city: r.city,
                lang: r.lang,
                model: r.model,
                prompt: r.prompt,
                createdAt: r.created_at ? r.created_at.toISOString() : null
            });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] ai-scene: scene fetch failed — ${err.message}`);
            return res.status(500).json({ error: 'Failed to load scene.' });
        }
    });

    // Model list for the UI dropdown: id, label, price estimate, and whether the provider's
    // API key is present (unconfigured models render as disabled options).
    app.get('/ai-scene/models', (_req, res) => {
        const models = Object.entries(MODELS).map(([id, cfg]) => ({
            id,
            label: cfg.label,
            estUsd: cfg.estUsd,
            configured: Boolean(process.env[PROVIDER_ENV_KEYS[cfg.provider]])
        }));
        res.json({ models, default: DEFAULT_MODEL });
    });

    app.post('/ai-scene/render', async (req, res) => {
        const model = MODELS[req.body?.model] ? req.body.model : DEFAULT_MODEL;
        const cfg = MODELS[model];
        const apiKey = process.env[PROVIDER_ENV_KEYS[cfg.provider]];
        if (!apiKey) {
            return res.status(501).json({
                error: `AI scene render via ${cfg.label} is not configured: ${PROVIDER_ENV_KEYS[cfg.provider]} is missing.`
            });
        }

        const { image, heightMap, prompt } = req.body || {};

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

        // Optional second image: a grayscale height map (black = ground, white = tallest) that pins
        // exact building heights. Passed to every provider as a second reference image.
        const parsedHeight = parseImageInput(heightMap);

        const timeoutMs = PROVIDER_TIMEOUT_MS[cfg.provider];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const startedAt = Date.now();
        try {
            const result = await PROVIDER_CALLS[cfg.provider](
                model, cfg, apiKey, parsed, parsedHeight, prompt, controller.signal
            );

            console.log(`[${new Date().toISOString()}] ai-scene: ${model} ok in ${Date.now() - startedAt}ms, ` +
                `in=${result.usage.input_tokens} out=${result.usage.output_tokens} tok, cost $${result.costUsd.toFixed(4)}` +
                (['fal', 'xai'].includes(cfg.provider) ? ' (flat rate)' : ''));

            return res.json({
                image: result.imageDataUrl,
                model,
                usage: result.usage,
                cost_usd: result.costUsd
            });
        } catch (err) {
            const aborted = err?.name === 'AbortError';
            const msg = aborted ? `timed out after ${timeoutMs / 1000}s` : err.message;
            console.error(`[${new Date().toISOString()}] ai-scene: ${model} failed — ${msg}`);
            return res.status(aborted ? 504 : 502).json({ error: `Image generation failed: ${msg}` });
        } finally {
            clearTimeout(timer);
        }
    });
}
