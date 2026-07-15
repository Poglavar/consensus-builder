<!-- End-to-end usage and design notes for the satellite parcel recognizer. -->
# Parcel recognition prototype

This prototype takes one satellite/orthophoto image and produces:

- `*-parcels.png`: the source image with inferred parcel boundaries overlaid
- `*-parcels.json`: normalized and pixel-coordinate boundary rings
- `*-parcel-seeds.json`: the LLM output, saved before SAM runs so processing is resumable

The boundaries mean **visually inferred land divisions**, not authoritative legal
cadastre. Aerial imagery cannot reveal an invisible ownership line. Confidence
therefore describes visible boundary evidence, not legal correctness.

## Pipeline

1. Claude or Codex vision inventories likely parcels as center points and tight boxes.
2. Boxes are sent to `facebook/sam3` as batched positive visual prompts (eight per model pass by default).
3. The mask most consistent with the seed point and box is selected.
4. Connected-component cleanup, contour simplification, and duplicate removal are deterministic.
5. Boundaries are exported in image coordinates and painted over the original image.

This combines the useful patterns from `dating-buildings` and
`zagreb-parkiralista`: structured subscription-billed LLM calls with reported
usage, promptable SAM masks, saved intermediate results, and deterministic
geometry. It deliberately does not use free-form LLM polygons as final geometry.

## Setup

SAM 3 is gated and downloads roughly 3.4 GB on its first run. Accept the model
license at `https://huggingface.co/facebook/sam3`, then authenticate:

```bash
cd parcel_recognition
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
hf auth login
```

The default LLM engine is the local Claude CLI and bills the logged-in
subscription. `--engine codex-cli` uses the local Codex CLI and the ChatGPT
subscription. API keys are removed from child environments to prevent accidental
per-token API billing. Each run logs usage; Claude also logs the nominal
API-equivalent cost.

## LLM models and adapters

The parcel prompt and JSON schema live above all model transports. Every adapter
receives the same `LlmRequest.prompt`, `LlmRequest.schema`, and image; `--model`
is passed through unchanged. This makes A/B runs differ by model rather than by
quiet prompt drift:

```bash
python parcel_recognition/recognize_parcels.py satellite.jpg \
  --engine claude-cli --model opus --llm-only

python parcel_recognition/recognize_parcels.py satellite.jpg \
  --engine codex-cli --model your-vision-model --llm-only
```

New providers and local models plug in through `package.module:function`. The
function accepts one `LlmRequest` and returns `LlmResult`, `(payload, usage)`, or
just the schema-valid payload dictionary:

```python
"""Example adapter for a custom vision model."""

from parcel_recognition.llm_adapters import LlmResult


def recognize(request):
    payload, provider_usage = call_your_model(
        image=request.image_path,
        prompt=request.prompt,
        json_schema=request.schema,
        model=request.model,
    )
    return LlmResult(payload, {
        "tokens": provider_usage.tokens,
        "nominal_cost_usd": provider_usage.cost_usd,
        "billing": "your provider",
    })
```

```bash
python parcel_recognition/recognize_parcels.py satellite.jpg \
  --llm-adapter my_models:recognize --model vendor/model-v2
```

Adapters should report token/cost metadata whenever their provider exposes it.

## Run

```bash
python parcel_recognition/recognize_parcels.py satellite.jpg
```

Useful staged runs:

```bash
# Inspect/save semantic seeds without loading SAM
python parcel_recognition/recognize_parcels.py satellite.jpg --llm-only

# Reuse corrected or previously generated seeds without another LLM call
python parcel_recognition/recognize_parcels.py satellite.jpg \
  --seeds satellite-parcel-seeds.json

# Use Codex and retain uncertain parcels for SAM evaluation
python parcel_recognition/recognize_parcels.py satellite.jpg \
  --engine codex-cli --include-low-confidence

# Trade memory for throughput by changing the positive-box batch size
python parcel_recognition/recognize_parcels.py satellite.jpg --sam-batch-size 4

# Verify paths and output names without invoking either model
python parcel_recognition/recognize_parcels.py satellite.jpg --dry-run
```

The seed JSON is intentionally editable. Correcting a center or bounding box and
rerunning with `--seeds` is the first human-review loop.

## Consensus Builder viewport contract

The backend route `GET /parcels/inferred?bbox=west,south,east,north&zoom=18`
turns model output into stable, explicitly provisional parcel features. Set:

```bash
PARCEL_INFERENCE_URL=https://parcel-model.internal/infer
PARCEL_INFERENCE_TOKEN=optional-bearer-token
PARCEL_INFERENCE_MODEL=your-model-version
PARCEL_INFERENCE_LLM_ADAPTER=claude-cli
```

The backend POSTs this provider-neutral request to the configured URL:

```json
{
  "input": { "type": "viewport", "bbox": [15.97, 45.8, 15.98, 45.81], "crs": "EPSG:4326", "zoom": 18 },
  "output": { "format": "geojson", "crs": "EPSG:4326" },
  "model": "your-model-version",
  "llmAdapter": "claude-cli"
}
```

The service is responsible for acquiring licensed aerial imagery and returning
a WGS84 GeoJSON `FeatureCollection` (directly or under `parcels`/`result`). It
should return whole parcel polygons, not polygons clipped at the requested
viewport edge. Optional collection metadata includes `model`, `modelVersion`,
`promptVersion`, `imagery`, and `generatedAt`. The browser never supplies an
imagery URL or provider credential.

The proxy rejects large/low-zoom requests, clamps confidence values, drops
malformed geometry, assigns stable geometry-derived `AI-*` IDs, marks every
feature `authoritative: false`, and caches identical viewports for 15 minutes.
These defaults can be adjusted with `PARCEL_INFERENCE_MIN_ZOOM`,
`PARCEL_INFERENCE_MAX_BBOX_SPAN`, `PARCEL_INFERENCE_TIMEOUT_MS`, and
`PARCEL_INFERENCE_CACHE_TTL_MS`.

## Using paired aerial/cadastral training data

Paired imagery and cadastral polygons are best used to train a dedicated parcel
boundary/instance segmentation model, with SAM as an interactive refiner and an
LLM for seed generation, ambiguity handling, and QA. Split training and
evaluation geographically (not random neighboring tiles), rasterize polygons at
the exact image georeferencing, and include an explicit invisible/uncertain
boundary class. Measure topology as well as pixels: boundary F1, polygon IoU,
gaps/overlaps, complete-parcel recall, and calibration by region/imagery source.

Start with parameter-efficient tuning or a small segmentation head before
attempting full SAM fine-tuning. Preserve source, date, ground resolution,
region, and license metadata so the model and UI can expose provenance and avoid
training/test leakage.

## Tests

The pure validation tests need no ML packages:

```bash
python -m unittest parcel_recognition.test_recognize_parcels
```
