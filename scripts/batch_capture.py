"""Batch webcam capture: record multiple signs in one session, run the full pipeline on each.

Opens the webcam once, shows the sign name, waits for SPACE to start recording ~3s, then
automatically runs capture → keyframes → schema for each sign. Single MediaPipe warm-start.

Usage:
    E:/ASL_Game/.venv/Scripts/python.exe scripts/batch_capture.py PLEASE THANK_YOU HELLO
    E:/ASL_Game/.venv/Scripts/python.exe scripts/batch_capture.py --list signs.txt
    E:/ASL_Game/.venv/Scripts/python.exe scripts/batch_capture.py --duration 4 COFFEE

LICENSE RULE: this records YOUR OWN webcam footage. Never feed restricted-dataset clips.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(ROOT / "scripts"))
from capture_landmarks import capture as capture_landmarks  # noqa: E402
from extract_keyframes import main as extract_kf_main       # noqa: E402
from schema_translator import main as translate_main         # noqa: E402


def record_clip(sign_id: str, duration: float, cam_index: int, fps: float = 25.0) -> Path:
    """Open webcam, show sign name, wait for SPACE, record `duration` seconds, save to footage/."""
    out_dir = ROOT / "footage"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"{sign_id}.mp4"

    cap = cv2.VideoCapture(cam_index)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open webcam index {cam_index}")

    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fourcc = cv2.VideoWriter.fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(out_path), fourcc, fps, (w, h))

    print(f"\n  [{sign_id}] Press SPACE to start recording ({duration}s). Press Q to skip.")
    recording = False
    start_t = 0.0

    while True:
        ok, frame = cap.read()
        if not ok:
            break

        display = cv2.flip(frame, 1)       # mirror the preview (selfie-mode) — recording stays raw
        if not recording:
            cv2.putText(display, f"Next: {sign_id}", (30, 60),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 255, 255), 3)
            cv2.putText(display, "SPACE=record  Q=skip", (30, 110),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (200, 200, 200), 2)
        else:
            elapsed = time.time() - start_t
            remaining = max(0, duration - elapsed)
            cv2.putText(display, f"REC {sign_id}  {remaining:.1f}s", (30, 60),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 255), 3)
            writer.write(frame)
            if elapsed >= duration:
                break

        cv2.imshow("Batch Capture", display)
        key = cv2.waitKey(1) & 0xFF
        if key == ord(" ") and not recording:
            recording = True
            start_t = time.time()
            print(f"  Recording {sign_id}...")
        elif key == ord("q"):
            writer.release()
            cap.release()
            cv2.destroyAllWindows()
            if out_path.exists():
                out_path.unlink()
            return None  # skipped

    writer.release()
    cap.release()
    cv2.destroyAllWindows()
    print(f"  Saved {out_path} ({out_path.stat().st_size / 1024:.0f} KB)")
    return out_path


def run_pipeline(sign_id: str, video_path: Path) -> Path | None:
    """Run capture_landmarks → extract_keyframes → schema_translator for one sign."""
    lm_path = ROOT / "landmarks" / f"{sign_id}.json"
    kf_path = ROOT / "keyframes" / f"{sign_id}.json"
    schema_path = ROOT / "schema" / "signs" / f"{sign_id.lower()}.json"

    for d in (lm_path.parent, kf_path.parent, schema_path.parent):
        d.mkdir(parents=True, exist_ok=True)

    print(f"  → capture_landmarks...")
    data = capture_landmarks(
        str(video_path), sign_id,
        hand_model="E:/ASL_Game/models/hand_landmarker.task",
        pose_model="E:/ASL_Game/models/pose_landmarker_lite.task",
        min_cutoff=1.2, beta=0.03)
    lm_path.write_text(json.dumps(data), encoding="utf-8")
    n = len(data["frames"])
    flagged = sum(1 for r in data["frames"] if r["flagged"])
    print(f"     {n} frames ({flagged} flagged)")

    print(f"  → extract_keyframes...")
    extract_kf_main(["--in", str(lm_path), "--out", str(kf_path)])

    print(f"  → schema_translator...")
    translate_main(["--in", str(kf_path), "--out", str(schema_path)])

    if schema_path.exists():
        s = json.loads(schema_path.read_text(encoding="utf-8"))
        print(f"     {sign_id}: {s['handshape']} @ {s['location']['anchor']} / {s['movement']['type']}")
        return schema_path
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Batch: record signs via webcam + run full pipeline.")
    ap.add_argument("signs", nargs="*", help="Sign IDs to record (e.g. PLEASE THANK_YOU)")
    ap.add_argument("--list", dest="listfile", help="Text file with one sign ID per line")
    ap.add_argument("--duration", type=float, default=3.0, help="Seconds per recording (default 3)")
    ap.add_argument("--cam", type=int, default=0, help="Webcam index (default 0)")
    ap.add_argument("--skip-existing", action="store_true",
                    help="Skip signs that already have schema/signs/<id>.json")
    args = ap.parse_args(argv)

    signs = [s.upper() for s in args.signs]
    if args.listfile:
        signs += [line.strip().upper() for line in Path(args.listfile).read_text().splitlines()
                  if line.strip() and not line.strip().startswith("#")]
    if not signs:
        ap.error("no signs specified (pass names or --list file)")

    results = {"recorded": [], "skipped": [], "failed": []}

    for sign_id in signs:
        schema_path = ROOT / "schema" / "signs" / f"{sign_id.lower()}.json"
        if args.skip_existing and schema_path.exists():
            print(f"  [{sign_id}] schema exists, skipping")
            results["skipped"].append(sign_id)
            continue

        clip = record_clip(sign_id, args.duration, args.cam)
        if clip is None:
            results["skipped"].append(sign_id)
            continue

        try:
            schema = run_pipeline(sign_id, clip)
            if schema:
                results["recorded"].append(sign_id)
            else:
                results["failed"].append(sign_id)
        except Exception as e:
            print(f"  ERROR: {e}")
            results["failed"].append(sign_id)

    print(f"\n=== Done ===")
    print(f"  Recorded: {', '.join(results['recorded']) or '(none)'}")
    print(f"  Skipped:  {', '.join(results['skipped']) or '(none)'}")
    print(f"  Failed:   {', '.join(results['failed']) or '(none)'}")
    print(f"\nNext: python scripts/batch_export.py --all")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
