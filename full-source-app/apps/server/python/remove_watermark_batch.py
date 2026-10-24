#!/usr/bin/env python3
"""
remove_watermark_batch.py - wrapper xoa watermark hang loat, da tien trinh.

Node spawn 1 process nay; no fan-out qua ProcessPoolExecutor (moi worker load
alpha.npy MOT lan). Tien do ghi ra stderr dang `[PROGRESS] N/M (pct%)`; ket qua
cuoi cung la JSON tren stdout.

    python remove_watermark_batch.py <input> <output_dir>
        [--alpha alpha.npy] [--method calib|fsr|telea] [--strength 1.0]
        [--workers N] [--quality 97] [--aspect-ratio 9:16]

stdout JSON: {success, total, done, failed, method, aspectRatio, outputs:[{src,dst,ok,error}]}
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
import sys
import threading
from concurrent.futures import (
    ProcessPoolExecutor,
    ThreadPoolExecutor,
    as_completed,
)
from concurrent.futures.process import BrokenProcessPool

EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp")
SEQUENTIAL_THRESHOLD = 2  # batch nho hon -> chay tuan tu (tranh overhead spawn worker)

_stderr_lock = threading.Lock()


def _emit_progress(done: int, total: int, note: str = "") -> None:
    pct = int(done / total * 100) if total else 100
    tail = f" {note}" if note else ""
    with _stderr_lock:
        print(f"[PROGRESS] {done}/{total} ({pct}%){tail}", file=sys.stderr, flush=True)


# --- worker: load alpha 1 lan / process ---------------------------------------
# Windows dung ThreadPoolExecutor (tranh spawn re-import cv2/numpy trong Python
# nhung -> BrokenProcessPool); giu ProcessPool cho mac/linux. Vi ThreadPool
# chia se global giua cac thread, dung threading.local() cho trang thai worker;
# van cap nhat global de nhanh tuan tu (va ProcessPool) dung duoc.
_tls = threading.local()
_worker_alpha = None
_worker_method = "calib"
_worker_strength = 1.0
_worker_quality = 97


def _init_worker(alpha_path, method, strength, quality):
    """Chay 1 lan / worker (thread hoac process). TUYET DOI khong duoc raise:
    initializer raise -> ProcessPoolExecutor bao BrokenProcessPool ngay."""
    global _worker_alpha, _worker_method, _worker_strength, _worker_quality
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    alpha = None
    if alpha_path and os.path.exists(alpha_path):
        try:
            import numpy as np
            alpha = np.load(alpha_path)
        except Exception as e:  # noqa: BLE001 - degrade thay vi lam chet worker
            method = "telea" if method == "calib" else method
            print(f"[WARN] khong load duoc alpha ({e}) -> method={method}",
                  file=sys.stderr, flush=True)
    _worker_alpha, _worker_method, _worker_strength, _worker_quality = (
        alpha, method, strength, quality
    )
    _tls.alpha, _tls.method, _tls.strength, _tls.quality = (
        alpha, method, strength, quality
    )


def _process_one(src_dst):
    """Chay trong worker (thread/process). Tra ve (src, dst, ok, error)."""
    src_path, dst_path = src_dst
    try:
        alpha = getattr(_tls, "alpha", _worker_alpha)
        method = getattr(_tls, "method", _worker_method)
        strength = getattr(_tls, "strength", _worker_strength)
        quality = getattr(_tls, "quality", _worker_quality)
        from remove_watermark import remove_watermark
        remove_watermark(
            src_path, dst_path,
            method=method,
            alpha=alpha,
            strength=strength,
            quality=quality,
        )
        return (src_path, dst_path, True, None)
    except Exception as e:  # noqa: BLE001 - mot anh loi khong duoc lam hong ca batch
        return (src_path, dst_path, False, str(e))


def _resolve_method(method, alpha_path):
    """calib khong co alpha -> fsr (neu xphoto) hoac telea."""
    if method != "calib":
        return method
    if alpha_path and os.path.exists(alpha_path):
        return "calib"
    try:
        import cv2
        return "fsr" if hasattr(cv2, "xphoto") else "telea"
    except Exception:  # noqa: BLE001
        return "telea"


def _collect_files(input_path):
    if os.path.isdir(input_path):
        return sorted(
            os.path.join(input_path, f)
            for f in os.listdir(input_path)
            if f.lower().endswith(EXTS)
        )
    if os.path.isfile(input_path) and input_path.lower().endswith(EXTS):
        return [input_path]
    return None  # invalid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input_path")
    ap.add_argument("output_dir")
    ap.add_argument("--alpha", default=None)
    ap.add_argument("--method", default="calib", choices=["calib", "fsr", "telea"])
    ap.add_argument("--strength", type=float, default=1.0)
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--quality", type=int, default=97)
    ap.add_argument("--aspect-ratio", default=None, dest="aspect_ratio")  # metadata only
    args = ap.parse_args()

    output_dir = os.path.abspath(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)

    files = _collect_files(args.input_path)
    if files is None:
        print(json.dumps({
            "success": False, "total": 0, "done": 0, "failed": 0,
            "method": args.method, "aspectRatio": args.aspect_ratio,
            "outputs": [], "error": f"Duong dan khong hop le: {args.input_path}",
        }, ensure_ascii=False))
        sys.exit(1)

    total = len(files)
    if total == 0:
        print(json.dumps({
            "success": True, "total": 0, "done": 0, "failed": 0,
            "method": args.method, "aspectRatio": args.aspect_ratio, "outputs": [],
        }, ensure_ascii=False))
        return

    method = _resolve_method(args.method, args.alpha)
    tasks = [(f, os.path.join(output_dir, os.path.basename(f))) for f in files]

    outputs, done, failed = [], 0, 0
    fallback = False
    _emit_progress(0, total, f"method={method}")

    if total <= SEQUENTIAL_THRESHOLD:
        # Batch nho: chay tuan tu ngay trong process nay, khong ton chi phi spawn.
        _init_worker(args.alpha, method, args.strength, args.quality)
        for task in tasks:
            src, dst, ok, err = _process_one(task)
            outputs.append({"src": src, "dst": dst, "ok": ok, "error": err})
            done += 1
            failed += 0 if ok else 1
            _emit_progress(done, total)
    else:
        max_workers = args.workers or min(os.cpu_count() or 4, 4)
        # Windows: ThreadPool tranh spawn re-import (nguon goc BrokenProcessPool).
        # mac/linux: ProcessPool cho cach ly that su.
        use_threads = sys.platform == "win32"
        executor_cls = ThreadPoolExecutor if use_threads else ProcessPoolExecutor
        done_srcs = set()
        pool_broke = False
        try:
            with executor_cls(
                max_workers=max_workers,
                initializer=_init_worker,
                initargs=(args.alpha, method, args.strength, args.quality),
            ) as pool:
                fut_task = {pool.submit(_process_one, t): t for t in tasks}
                for fut in as_completed(fut_task):
                    try:
                        src, dst, ok, err = fut.result()
                    except BrokenProcessPool:
                        pool_broke = True
                        break
                    except Exception as fut_exc:  # noqa: BLE001 - loi ha tang hiem
                        # Loi khong phai vo pool (vd unpickle) -> tinh 1 anh loi,
                        # giu pool song cho cac anh con lai.
                        t = fut_task[fut]
                        outputs.append({"src": t[0], "dst": t[1], "ok": False, "error": str(fut_exc)})
                        done_srcs.add(t[0])
                        done += 1
                        failed += 1
                        _emit_progress(done, total)
                        continue
                    outputs.append({"src": src, "dst": dst, "ok": ok, "error": err})
                    done_srcs.add(src)
                    done += 1
                    failed += 0 if ok else 1
                    _emit_progress(done, total)
        except BrokenProcessPool:
            pool_broke = True

        if pool_broke:
            # Pool vo giua chung: chay tuan tu phan CON LAI (khong mat ket qua da co).
            fallback = True
            print("[WARN] pool bi gian doan -> chay tuan tu phan con lai",
                  file=sys.stderr, flush=True)
            _init_worker(args.alpha, method, args.strength, args.quality)
            for task in tasks:
                if task[0] in done_srcs:
                    continue
                src, dst, ok, err = _process_one(task)
                outputs.append({"src": src, "dst": dst, "ok": ok, "error": err})
                done_srcs.add(src)
                done += 1
                failed += 0 if ok else 1
                _emit_progress(done, total)

    outputs.sort(key=lambda o: o["src"])  # on dinh thu tu (as_completed tra ve loan)
    # Nhanh tuan tu / fallback chay _init_worker o main thread nen _worker_method
    # phan anh method thuc (co the da degrade calib->telea khi alpha loi).
    ran_in_main = total <= SEQUENTIAL_THRESHOLD or fallback
    effective_method = _worker_method if ran_in_main else method
    print(json.dumps({
        "success": failed < total,
        "total": total,
        "done": done - failed,
        "failed": failed,
        "method": effective_method,
        "aspectRatio": args.aspect_ratio,
        "fallback": fallback,
        "outputs": outputs,
    }, ensure_ascii=False))


if __name__ == "__main__":
    # spawn: an toan tren macOS/Windows voi OpenCV (tranh fork-after-import).
    try:
        mp.set_start_method("spawn")
    except RuntimeError:
        pass
    main()
