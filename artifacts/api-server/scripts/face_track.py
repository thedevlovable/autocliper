#!/usr/bin/env python3
"""
Face tracking re-crop for podcast/interview clips.

Samples frames from the input clip, detects faces using mediapipe,
computes a stable face-centered crop region, then re-encodes via ffmpeg.

Exit codes:
  0 — success, output file written
  1 — error (see stderr)
  2 — no faces detected (caller should fall back to center crop or skip)
  3 — mediapipe/cv2 not installed (caller should skip silently)
"""

import argparse
import sys
import subprocess
import os
import statistics


def detect_faces(video_path: str, sample_every: int = 8):
    """
    Return (face_list, frame_width, frame_height) or None on import failure.
    face_list is a list of (cx_norm, cy_norm) — normalized 0..1 face centres.
    """
    try:
        import mediapipe as mp
        import cv2
    except ImportError:
        return None

    mp_fd = mp.solutions.face_detection
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None

    fw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    fh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if fw <= 0 or fh <= 0:
        cap.release()
        return None

    faces = []
    frame_idx = 0

    with mp_fd.FaceDetection(model_selection=0, min_detection_confidence=0.45) as detector:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            if frame_idx % sample_every == 0:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                results = detector.process(rgb)
                if results.detections:
                    # Take the largest detected face (by bounding-box area)
                    best = max(
                        results.detections,
                        key=lambda d: (
                            d.location_data.relative_bounding_box.width
                            * d.location_data.relative_bounding_box.height
                        ),
                    )
                    bb = best.location_data.relative_bounding_box
                    cx = bb.xmin + bb.width / 2.0
                    cy = bb.ymin + bb.height / 2.0
                    # Clamp to valid range (occasionally slightly outside due to padding)
                    cx = max(0.05, min(0.95, cx))
                    cy = max(0.05, min(0.95, cy))
                    faces.append((cx, cy))
            frame_idx += 1

    cap.release()
    return faces, fw, fh


def main():
    parser = argparse.ArgumentParser(description="Face-tracking re-crop via mediapipe + ffmpeg")
    parser.add_argument("--input",  required=True,  help="Input clip (mp4)")
    parser.add_argument("--output", required=True,  help="Output clip (mp4)")
    parser.add_argument("--width",  type=int, default=720,  help="Target width  (e.g. 720)")
    parser.add_argument("--height", type=int, default=1280, help="Target height (e.g. 1280)")
    parser.add_argument("--ffmpeg", default="ffmpeg",        help="Path to ffmpeg binary")
    parser.add_argument("--preset", default="ultrafast",     help="libx264 preset")
    parser.add_argument("--crf",    default="25",            help="libx264 CRF")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"[face_track] Input not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    # ── Detect faces ────────────────────────────────────────────────────────────
    result = detect_faces(args.input)

    if result is None:
        # mediapipe / cv2 not installed
        print("[face_track] mediapipe or opencv not available — skipping", file=sys.stderr)
        sys.exit(3)

    faces, fw, fh = result

    if not faces:
        print("[face_track] No faces detected", file=sys.stderr)
        sys.exit(2)

    # ── Compute stable crop centre (median across sampled frames) ────────────────
    cxs = [f[0] for f in faces]
    cys = [f[1] for f in faces]
    cx = statistics.median(cxs)
    cy = statistics.median(cys)

    # ── Work out crop rectangle ──────────────────────────────────────────────────
    target_ar = args.width / args.height
    src_ar    = fw / fh

    if src_ar > target_ar:
        # Source is wider → crop the sides
        crop_h = fh
        crop_w = int(round(fh * target_ar))
    else:
        # Source is taller → crop top/bottom
        crop_w = fw
        crop_h = int(round(fw / target_ar))

    # Centre the crop on the detected face
    crop_x = int(round(cx * fw - crop_w / 2))
    crop_y = int(round(cy * fh - crop_h / 2))

    # Clamp so the crop stays within the frame
    crop_x = max(0, min(crop_x, fw - crop_w))
    crop_y = max(0, min(crop_y, fh - crop_h))

    # Ensure even dimensions (required by libx264)
    crop_w -= crop_w % 2
    crop_h -= crop_h % 2
    crop_x -= crop_x % 2
    crop_y -= crop_y % 2

    vf = f"crop={crop_w}:{crop_h}:{crop_x}:{crop_y},scale={args.width}:{args.height}"

    print(
        f"[face_track] src={fw}x{fh} face_centre=({cx:.2f},{cy:.2f}) "
        f"crop={crop_w}x{crop_h}@({crop_x},{crop_y}) -> {args.width}x{args.height}",
        file=sys.stderr,
    )

    # ── Re-encode with ffmpeg ────────────────────────────────────────────────────
    cmd = [
        args.ffmpeg, "-y",
        "-i", args.input,
        "-vf", vf,
        "-c:v", "libx264", "-preset", args.preset, "-crf", args.crf,
        "-c:a", "copy",
        "-movflags", "+faststart",
        args.output,
    ]

    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        print(proc.stderr.decode(errors="replace"), file=sys.stderr)
        sys.exit(1)

    print("[face_track] Done", file=sys.stderr)
    sys.exit(0)


if __name__ == "__main__":
    main()
