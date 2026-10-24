#!/usr/bin/env python3
"""
remove_video_watermark_batch.py - wrapper xoa logo video hang loat, co progress.

Node spawn 1 process nay. Xu ly TUAN TU tung video (moi video da bao hoa CPU qua
cv2/numpy nen chay song song se thrash). Moi frame: `[PROGRESS] N/M (pct%) video
k/K | <ten>` ra stderr. Ket qua cuoi la JSON tren stdout.

    python remove_video_watermark_batch.py <input> <output_dir>
        [--logo auto|veo|star|both] [--corner br|bl|tr|tl] [--strength 1.0]
        [--samples 250] [--crf 15] [--preset slow] [--lossless]
        [--no-smooth] [--no-autofit]

An toan khi bi huy: ghi ra "<ten>.part.<ext>" roi rename khi xong; SIGTERM xoa file
dở nen thu muc lưu khong bao gio con file cat doi.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys

import cv2

# Cac ham loi tu script goc (da patch ffmpeg/ffprobe qua env).
import remove_video_watermark as _rvw
from remove_video_watermark import (
    VIDEO_EXTS,
    clean_frame_multi,
    count_frames,
    find_logos,
    probe_video,
    _reader,
    _writer,
)

PROGRESS_EVERY = 30  # frame — ~1 update/giay o 30fps

# File dang ghi (de SIGTERM handler xoa neu bi huy giua chung).
_cleanup_path: str | None = None


def _on_term(_signum, _frame):
    global _cleanup_path
    if _cleanup_path and os.path.exists(_cleanup_path):
        try:
            os.unlink(_cleanup_path)
        except OSError:
            pass
    sys.exit(1)


def _emit(done: int, total: int, k: int, n: int, name: str) -> None:
    pct = int(done / total * 100) if total > 0 else 0
    print(f"[PROGRESS] {done}/{total} ({pct}%) video {k}/{n} | {name}", file=sys.stderr, flush=True)


def _total_frames(src: str, info: dict) -> int:
    """So frame tong: nb_frames -> fallback duration x fps -> 0 (khong biet)."""
    if info.get("n", 0) > 0:
        return int(info["n"])
    try:
        out = subprocess.check_output([
            _rvw._FFPROBE, "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=duration", "-of", "json", src,
        ])
        dur = float(json.loads(out)["streams"][0].get("duration") or 0)
        return max(1, int(dur * info["fps"])) if dur > 0 else 0
    except Exception:  # noqa: BLE001
        return 0


def _collect(input_path: str):
    if os.path.isfile(input_path):
        return [input_path] if input_path.lower().endswith(VIDEO_EXTS) else None
    if os.path.isdir(input_path):
        return sorted(
            os.path.join(input_path, f)
            for f in os.listdir(input_path)
            if f.lower().endswith(VIDEO_EXTS)
        )
    return None


def _process_one(src: str, dst: str, k: int, n: int, opts: dict) -> dict:
    """Xu ly 1 video -> ghi ra file tam roi rename. Tra ve dict ket qua."""
    global _cleanup_path
    name = os.path.basename(src)
    root, ext = os.path.splitext(dst)
    tmp = f"{root}.part{ext or '.mp4'}"
    try:
        info = probe_video(src)
        w, h, fps = info["w"], info["h"], info["fps"]
        total = _total_frames(src, info)

        _emit(0, total, k, n, name)
        logos = find_logos(src, logo=opts["logo"], corner=opts["corner"],
                           samples=min(opts["samples"], 120), verbose=False)

        _cleanup_path = tmp
        proc = _writer(tmp, src, w, h, fps, crf=opts["crf"],
                       preset=opts["preset"], lossless=opts["lossless"])
        sent = 0
        try:
            for fr in _reader(src, w, h):
                proc.stdin.write(
                    clean_frame_multi(fr, logos, strength=opts["strength"],
                                      smooth=opts["smooth"], autofit=opts["autofit"]).tobytes()
                )
                sent += 1
                if sent == 1 or sent % PROGRESS_EVERY == 0:
                    _emit(sent, total, k, n, name)
        finally:
            proc.stdin.close()
            proc.wait()

        got = count_frames(tmp)
        if got != sent:
            if os.path.exists(tmp):
                os.unlink(tmp)
            _cleanup_path = None
            return {"src": src, "dst": dst, "ok": False,
                    "error": f"Thiếu frame: gửi {sent} nhưng file ra có {got}", "frames": 0}

        os.replace(tmp, dst)  # atomic, chi lo file hoan chinh vao thu muc
        _cleanup_path = None
        _emit(sent, max(sent, total), k, n, name)
        return {"src": src, "dst": dst, "ok": True, "error": None, "frames": got}
    except Exception as e:  # noqa: BLE001 — 1 video loi khong lam hong ca batch
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
        _cleanup_path = None
        return {"src": src, "dst": dst, "ok": False, "error": str(e), "frames": 0}


def main() -> None:
    signal.signal(signal.SIGTERM, _on_term)  # xoa file .part neu bi huy giua chung
    ap = argparse.ArgumentParser()
    ap.add_argument("input_path")
    ap.add_argument("output_dir")
    ap.add_argument("--logo", default="auto", choices=["auto", "veo", "star", "both"])
    ap.add_argument("--corner", default="br", choices=["br", "bl", "tr", "tl"])
    ap.add_argument("--strength", type=float, default=1.0)
    ap.add_argument("--samples", type=int, default=250)
    ap.add_argument("--crf", type=int, default=15)
    ap.add_argument("--preset", default="slow")
    ap.add_argument("--lossless", action="store_true")
    ap.add_argument("--no-smooth", action="store_true")
    ap.add_argument("--no-autofit", action="store_true")
    args = ap.parse_args()

    output_dir = os.path.abspath(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)

    files = _collect(args.input_path)
    if files is None:
        print(json.dumps({
            "success": False, "total": 0, "done": 0, "failed": 0, "outputs": [],
            "error": f"Không hợp lệ hoặc không phải video: {args.input_path}",
        }, ensure_ascii=False))
        sys.exit(1)

    total = len(files)
    if total == 0:
        print(json.dumps({"success": True, "total": 0, "done": 0, "failed": 0, "outputs": []},
                         ensure_ascii=False))
        return

    # Cho cv2 dung 1 nua so nhan cho FSR/bilateral, khong lam nghen OS.
    try:
        cv2.setNumThreads(max(2, (os.cpu_count() or 4) // 2))
    except Exception:  # noqa: BLE001
        pass

    opts = dict(
        logo=args.logo, corner=args.corner, strength=args.strength,
        samples=args.samples, crf=args.crf, preset=args.preset,
        lossless=args.lossless, smooth=not args.no_smooth, autofit=not args.no_autofit,
    )

    outputs, done, failed = [], 0, 0
    for k, src in enumerate(files, 1):
        dst = os.path.join(output_dir, os.path.basename(src))
        res = _process_one(src, dst, k, total, opts)
        outputs.append(res)
        done += 1 if res["ok"] else 0
        failed += 0 if res["ok"] else 1

    print(json.dumps({
        "success": failed < total,
        "total": total,
        "done": done,
        "failed": failed,
        "outputs": outputs,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
