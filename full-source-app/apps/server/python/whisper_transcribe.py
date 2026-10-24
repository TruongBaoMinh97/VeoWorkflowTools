#!/usr/bin/env python3
"""
Whisper Transcription Worker (Doodle Video Pipeline)

Transcribes an uploaded narration audio file into timestamped segments using
faster-whisper (CTranslate2, CPU INT8 by default).

Usage:
    python whisper_transcribe.py <mode> [audio_path] [options_json]

Modes:
    check-install  - report whether faster-whisper is importable
    transcribe     - transcribe <audio_path> → segments

Contract (matches frame_extractor.py):
    stdout = a single JSON object (the result)
    stderr = human logs + "[PROGRESS] <step> (<NN>%)" lines
"""

import sys
import json
import os


def log(message: str):
    print(message, file=sys.stderr, flush=True)


def progress(step: str, percent: float):
    print(f"[PROGRESS] {step} ({int(percent)}%)", file=sys.stderr, flush=True)


def check_install():
    try:
        import faster_whisper  # noqa: F401
        return {"success": True, "installed": True}
    except Exception as e:  # noqa: BLE001
        return {"success": True, "installed": False, "detail": str(e)}


def transcribe(audio_path: str, options: dict):
    if not os.path.isfile(audio_path):
        raise ValueError(f"Audio file not found: {audio_path}")

    from faster_whisper import WhisperModel

    model_size = options.get("model", "small")
    language = options.get("language")  # None → auto-detect

    progress("Đang tải model", 10)
    model = WhisperModel(model_size, device="cpu", compute_type="int8")

    progress("Đang transcribe", 20)
    segments_iter, info = model.transcribe(
        audio_path,
        language=language,
        vad_filter=True,
        word_timestamps=False,
    )

    duration = float(getattr(info, "duration", 0) or 0)
    segments = []
    for seg in segments_iter:
        text = (seg.text or "").strip()
        if text:
            segments.append({
                "start": round(float(seg.start), 3),
                "end": round(float(seg.end), 3),
                "text": text,
            })
        if duration > 0:
            pct = 20 + (float(seg.end) / duration) * 75
            progress("Đang transcribe", min(95, pct))

    progress("Hoàn thành", 100)
    return {
        "success": True,
        "segments": segments,
        "segmentCount": len(segments),
        "duration": duration,
        "language": getattr(info, "language", None),
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "success": False,
            "error": "Usage: whisper_transcribe.py <mode> [audio_path] [options_json]",
        }))
        sys.exit(1)

    mode = sys.argv[1]
    try:
        if mode == "check-install":
            print(json.dumps(check_install()))
            return

        audio_path = sys.argv[2] if len(sys.argv) > 2 else None
        options = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}

        if mode == "transcribe":
            if not audio_path:
                raise ValueError("audio_path is required for transcribe mode")
            result = transcribe(os.path.abspath(audio_path), options)
            print(json.dumps(result))
        else:
            raise ValueError(f"Unknown mode: {mode}")

    except Exception as e:  # noqa: BLE001
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
