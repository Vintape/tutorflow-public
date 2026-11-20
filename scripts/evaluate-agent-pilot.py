#!/usr/bin/env python3
"""Evaluate synthetic read-only model answers without executing model output."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ROOT / "tests/fixtures/agent-pilot"

def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"))

def evaluate(oracle, answers):
    return {"accepted": sum(key in answers and canonical(value) == canonical(answers[key]) for key, value in oracle.items()),
            "total": len(oracle),
            "failed": [key for key, value in oracle.items() if key not in answers or canonical(value) != canonical(answers[key])],
            "extra_keys": sorted(set(answers) - set(oracle))}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("answers", type=Path, nargs="*", help="JSON objects containing typed answers")
    parser.add_argument("--oracle", type=Path, default=DEFAULT / "oracle.json")
    args = parser.parse_args()
    oracle = json.loads(args.oracle.read_text())
    for path in args.answers or [DEFAULT / "luna-answers.json", DEFAULT / "terra-answers.json"]:
        answers = json.loads(path.read_text())
        print(json.dumps({"candidate": path.name, **evaluate(oracle, answers), "answer_utf8_bytes": path.stat().st_size}, ensure_ascii=False))
