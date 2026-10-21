#!/usr/bin/env python3
"""Let a city worker exercise real admission and in-app verification before finishing."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from parcel_city_integration import check_integration


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", required=True, type=Path)
    args = parser.parse_args()
    context = json.loads(args.context.read_text())
    root = Path(__file__).resolve().parents[1]
    artifact = args.context.resolve().parent
    artifact.relative_to(root)
    report = check_integration(root, artifact.parents[3], context["city"], context["receipt"], artifact,
                               shared_root=context.get("sharedRoot"))
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
