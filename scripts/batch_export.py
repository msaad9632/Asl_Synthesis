"""Batch export: render schema/signs/*.json -> anim/*.json for the Three.js viewer.

Wraps E:/ASL_Game/tools/schema_to_anim.py to process all (or specified) schema files and
update anim/index.json so the viewer sees them.

Usage:
    E:/ASL_Game/.venv/Scripts/python.exe scripts/batch_export.py --all
    E:/ASL_Game/.venv/Scripts/python.exe scripts/batch_export.py COFFEE PLEASE
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASL_GAME = Path("E:/ASL_Game")

sys.path.insert(0, str(ASL_GAME))
from tools.schema_to_anim import main as schema_to_anim_main  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Batch: schema/signs -> anim/ for the viewer.")
    ap.add_argument("signs", nargs="*", help="Sign IDs to export (default: all schema files)")
    ap.add_argument("--all", action="store_true", help="Export all schema/signs/*.json")
    ap.add_argument("--anim-dir", default=str(ROOT / "anim"), help="Output anim directory")
    ap.add_argument("--fps", type=float, default=30.0)
    args = ap.parse_args(argv)

    schema_dir = ROOT / "schema" / "signs"
    anim_dir = Path(args.anim_dir)
    anim_dir.mkdir(parents=True, exist_ok=True)

    if args.all or not args.signs:
        schemas = sorted(schema_dir.glob("*.json"))
        schemas = [s for s in schemas if s.name != ".gitkeep"]
    else:
        schemas = [schema_dir / f"{s.lower()}.json" for s in args.signs]
        missing = [s for s in schemas if not s.exists()]
        if missing:
            print(f"Missing schema files: {', '.join(str(m) for m in missing)}")
            return 1

    exported = []
    for schema_path in schemas:
        sign_id = schema_path.stem.upper()
        try:
            schema_to_anim_main(["--in", str(schema_path), "--out", str(anim_dir), "--fps", str(args.fps)])
            exported.append(sign_id)
        except Exception as e:
            print(f"  ERROR exporting {sign_id}: {e}")

    # Update anim/index.json to include all exported signs
    existing_anims = sorted(
        f.stem for f in anim_dir.glob("*.json") if f.name != "index.json"
    )
    index_path = anim_dir / "index.json"
    index_path.write_text(json.dumps({"signs": existing_anims}), encoding="utf-8")

    print(f"\nExported {len(exported)} sign(s) -> {anim_dir}")
    print(f"index.json now lists {len(existing_anims)} signs: {', '.join(existing_anims)}")
    print(f"\nReview: npx http-server -p 5188 . -> viewer.html")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
