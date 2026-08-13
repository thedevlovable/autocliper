---
name: Face-follow clip reframe
description: How vertical clips follow the speaker's face — detector choice, single-pass crop expression, fallback rules
---
- Vertical (9:16) clips can follow the largest face: UltraFace RFB-320 ONNX (~1.2MB, MIT) committed under api-server assets/models — never fetched at runtime (VPS installs from git).
- onnxruntime-node loads lazily and NEVER blocks boot; any load/detect failure → null → regular center crop. A worse crop must never fail a clip job.
- Reframe happens INSIDE the one main ffmpeg encode as a crop x-expression (piecewise + short pans, commas \,-escaped like the rest of the chain). A second encode over the finished vertical clip would recrop burned subtitles and double CPU — don't reintroduce it. The old mediapipe/python face_track.py was dead code (mediapipe never installed anywhere).
- Path rules: 2fps 320x240 letterboxed samples in CONTENT coords (post active-area crop); largest face wins (never average two faces — the average frames nobody); deadzone + min-dwell + median landing keeps the frame static-per-scene; <40% face coverage → fallback to center.
- The clip cache key carries an ft:2 marker — bump it whenever reframe output changes (stale-cache lesson).

**Why:** double-encode recrops subtitles; per-frame panning looks amateur; silent fallback keeps clipping unbreakable.
**How to apply:** whenever touching the clip vf chain, the faceTrack option, or upgrading the detector model.
