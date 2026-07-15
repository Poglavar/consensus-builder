"""Unit tests for built-in aliases and the custom LLM adapter contract."""

import unittest
from pathlib import Path

from parcel_recognition.llm_adapters import (
    LlmRequest,
    LlmResult,
    available_adapters,
    run_llm,
)


def fake_adapter(request):
    return LlmResult(
        payload={"summary": request.prompt, "image_quality": "good", "parcels": []},
        usage={"tokens": 12, "billing": "test", "received_schema": request.schema},
    )


class LlmAdapterTest(unittest.TestCase):
    def test_builtin_aliases_are_registered(self):
        names = available_adapters()
        self.assertIn("claude-cli", names)
        self.assertIn("codex-cli", names)

    def test_custom_adapter_receives_unchanged_request(self):
        request = LlmRequest(
            image_path=Path("image.png"),
            prompt="one shared prompt",
            schema={"type": "object"},
            model="vendor/model-v2",
        )
        result = run_llm(
            request,
            engine="ignored",
            custom_adapter="parcel_recognition.test_llm_adapters:fake_adapter",
        )
        self.assertEqual(result.payload["summary"], "one shared prompt")
        self.assertEqual(result.usage["received_schema"], {"type": "object"})
        self.assertEqual(result.usage["model"], "vendor/model-v2")
        self.assertEqual(result.usage["engine"], "parcel_recognition.test_llm_adapters:fake_adapter")

    def test_unknown_engine_fails_clearly(self):
        request = LlmRequest(Path("x.png"), "prompt", {})
        with self.assertRaisesRegex(ValueError, "unknown LLM engine"):
            run_llm(request, engine="missing")


if __name__ == "__main__":
    unittest.main()
