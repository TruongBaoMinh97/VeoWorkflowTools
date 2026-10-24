#!/usr/bin/env python3
"""
remove_video_watermark - xoa logo Veo trong video: chu "Veo" HOAC ngoi sao sparkle.

HAI KIEU LOGO, CHON LINH HOAT
-----------------------------
    --logo auto   (mac dinh) do thu ca hai vung, cai nao co logo that thi xoa
    --logo veo    chi xoa chu "Veo" o sat goc duoi phai
    --logo star   chi xoa ngoi sao 4 canh (nam thut vao trong hon)
    --logo both   xoa ca hai
    --box x,y,w,h tu chi vung (nhieu vung thi ngan cach bang dau ;)

Vi tri do duoc tren video 720x1280 (chuan hoa theo canh nho cua khung hinh):
    chu "Veo"  : sat goc, tam cach mep phai/duoi ~2% -> o vuong 0.10 canh nho
    ngoi sao   : tam cach mep phai 0.162, mep duoi 0.167 canh nho, to ~0.076

CACH XOA (2 lop, tu do tu chinh video - khong can file calib ben ngoai)
----------------------------------------------------------------------
Lop 1 - GO NEN TRANG. Logo la lop trang ban trong suot:
        I = (1-a)*B + a*255   ->   B = (I - a*255)/(1-a)
    Ban do "a" do bang median theo THOI GIAN tren hang tram khung hinh.
    Chu "Veo": a = 0.50, do lech chuan theo thoi gian 0.006 (rat on dinh).
    Ngoi sao : a = 0.43, to hon nen can cua so uoc luong nen rong hon.

Lop 2 - KHU PHAN DU CO DAU. Logo con vien toi / bong do cho de doc; phan nay
    khong phai lop trang nen lop 1 khong xoa het. Uoc luong ban do bu E (co the
    AM) = median theo thoi gian cua (I - nen), lap 3 vong cho hoi tu roi tru di.

Diem mau chot: NEN uoc luong bang MEDIAN NGANG (cua so 1 x k) chu khong phai
median vuong. Net logo bi xoa sach, con duong bien ngang cua canh vat (mep ban,
mep tuong) duoc giu nguyen tuyet doi -> khong cong veo mep nhu inpaint.
Cua so k tu dong chon theo be ngang logo (chu ~21 px, ngoi sao ~121 px), va nen
duoc do tren DAI NGANG RONG HON o xu ly de median luon co du hang xom that.

Chi vung box quanh logo bi dong vao; phan con lai cua khung hinh copy nguyen xi.

Ba diem da xu ly them:
  * autofit    - logo mo dan o cuoi video (do dam tut 1.02 -> 0.87 o 3 frame cuoi),
                 nen do lai do dam cho tung khung hinh.
  * nen phang  - tren tuong tron khong co chi tiet che, phan du du nho van lo;
                 cho phang thi lay thang nen uoc luong (o do no dung tuyet doi).
  * frame cuoi - KHONG dung "-shortest": voi input raw qua pipe no cat mat frame
                 cuoi (192 -> 132) lam video DUNG HINH. Da bo, them "-vsync 0"
                 va dem lai frame sau khi ma hoa de chac chan khong thieu.

CACH DUNG
---------
    python remove_video_watermark.py video.mp4                 # -> video_clean.mp4
    python remove_video_watermark.py video.mp4 --logo star
    python remove_video_watermark.py ./thu_muc/ -o ./out/
    python remove_video_watermark.py video.mp4 --probe         # xem bat duoc gi
    python remove_video_watermark.py video.mp4 --lossless

    from remove_video_watermark import remove_video_watermark, find_logos
    remove_video_watermark("video.mp4", "sach.mp4", logo="auto")

Yeu cau: ffmpeg trong PATH; pip install opencv-contrib-python numpy
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess

import cv2
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

# Duong dan ffmpeg/ffprobe: uu tien full-path tu env (Electron bundle ten
# platform-prefix nhu win32-x64-ffmpeg.exe -> PATH lookup "ffmpeg" that bai).
_FFMPEG = os.environ.get("FFMPEG_PATH", "ffmpeg")
_FFPROBE = os.environ.get("FFPROBE_PATH", "ffprobe")

VIDEO_EXTS = (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v")

# Vi tri 2 kieu logo, chuan hoa theo min(w, h) cua khung hinh
PRESETS = {
    # chu "Veo": sat goc duoi phai
    "veo": dict(anchor="corner", side=0.10, bgk=21, thr=0.08, span=0.060, cluster=0.045, open_k=0),
    # ngoi sao 4 canh: thut vao trong, to hon -> cua so nen rong hon
    "star": dict(center=(0.162, 0.167), side=0.115, bgk=121, thr=0.10, span=0.080, cluster=0.018, open_k=0),
}


# --------------------------------------------------------------------------- ffmpeg
def probe_video(path):
    out = subprocess.check_output([
        _FFPROBE, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
        "-of", "json", path])
    s = json.loads(out)["streams"][0]
    num, den = (s["r_frame_rate"].split("/") + ["1"])[:2]
    return {"w": int(s["width"]), "h": int(s["height"]),
            "fps": float(num) / float(den or 1), "n": int(s.get("nb_frames") or 0)}


def count_frames(path):
    """Dem chinh xac so frame thuc te trong file (khong tin nb_frames)."""
    out = subprocess.check_output([
        _FFPROBE, "-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path])
    try:
        return int(out.decode().strip().strip(","))
    except ValueError:
        return -1


def _reader(path, w, h):
    p = subprocess.Popen([_FFMPEG, "-v", "error", "-i", path, "-f", "rawvideo",
                          "-pix_fmt", "bgr24", "-"],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=10 ** 8)
    size = w * h * 3
    try:
        while True:
            buf = p.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        p.stdout.close()
        if p.poll() is None:
            p.kill()
        p.wait()


def _writer(dst, src, w, h, fps, crf=15, preset="slow", lossless=False):
    """Ghi frame raw vao ffmpeg, giu nguyen audio cua file goc."""
    v = ["-c:v", "libx264", "-preset", preset, "-pix_fmt", "yuv420p"]
    v += ["-qp", "0"] if lossless else ["-crf", str(crf)]
    cmd = [_FFMPEG, "-v", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
           "-i", src, "-map", "0:v:0", "-map", "1:a:0?", "-c:a", "copy",
           "-vsync", "0", *v, "-movflags", "+faststart", dst]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE, bufsize=10 ** 8)


# --------------------------------------------------------------------------- nen
def bg_hmed(R, k=21):
    """Median NGANG: xoa net logo nhung giu nguyen duong bien ngang cua canh vat."""
    k = max(3, int(k) | 1)
    p = k // 2
    Rp = np.pad(R, ((0, 0), (p, p), (0, 0)), mode="edge")
    return np.median(sliding_window_view(Rp, k, axis=1), axis=-1)


def bg_square(R, k=31):
    """Median vuong: dung khi logo nam tren nen roi rac, khong co duong ngang."""
    return cv2.medianBlur(np.clip(R, 0, 255).astype(np.uint8), int(k) | 1).astype(np.float32)


BGS = {"hmed": bg_hmed, "square": bg_square}


def crop_ctx(frame, box, pad):
    """Cat dai ngang rong hon box de median luon co du hang xom that.

    Tra ve (dai, offset_x_cua_box_trong_dai).
    """
    bx, by, bw, bh = box
    w = frame.shape[1]
    x1, x2 = max(0, bx - pad), min(w, bx + bw + pad)
    return frame[by:by + bh, x1:x2], bx - x1


def bg_of(frame_or_roi, box, bgf, bgk, ctx_frame=None):
    """Uoc luong nen cho dung vung box (co dung context ngang neu co ca frame)."""
    if ctx_frame is None:
        return bgf(frame_or_roi, bgk)
    strip, off = crop_ctx(ctx_frame, box, bgk)
    return bgf(strip.astype(np.float32), bgk)[:, off:off + box[2]]


# --------------------------------------------------------------------------- vung logo
def preset_box(w, h, name, corner="br"):
    """O chua logo theo preset, tinh theo min(w, h)."""
    p = PRESETS[name]
    mn = min(w, h)
    side = max(40, int(round(p["side"] * mn)))
    if p.get("anchor") == "corner":
        x = w - side - 2 if "r" in corner else 2
        y = h - side - 2 if "b" in corner else 2
    else:
        dx, dy = p["center"]
        cx = int(w - dx * mn) if "r" in corner else int(dx * mn)
        cy = int(h - dy * mn) if "b" in corner else int(dy * mn)
        x, y = cx - side // 2, cy - side // 2
    x, y = max(0, min(x, w - side)), max(0, min(y, h - side))
    return (x, y, side, side)


# --------------------------------------------------------------------------- do 2 lop
def estimate_layers(src, box, bgk=21, bg="hmed", thr=0.08, samples=250,
                    rounds=3, dilate=2, span=None, cluster=None, open_k=0,
                    verbose=True, name=""):
    """Do (A, E) cua logo trong `box`, lay tu chinh video."""
    bgf = BGS[bg]
    info = probe_video(src)
    w, h = info["w"], info["h"]
    bx, by, bw, bh = box

    step = max(1, (info["n"] or samples) // samples)
    F, G = [], []
    for i, fr in enumerate(_reader(src, w, h)):
        if i % step:
            continue
        strip, off = crop_ctx(fr, box, bgk)
        F.append(strip[:, off:off + bw].astype(np.float32))
        G.append(strip.astype(np.float32))
    if not F:
        raise RuntimeError("Khong doc duoc khung hinh nao.")
    off = crop_ctx(np.zeros((h, w, 3), np.uint8), box, bgk)[1]

    def bgc(strip):
        return bgf(strip, bgk)[:, off:off + bw]

    # --- lop 1: alpha cua nen trang
    acc = []
    for R, S in zip(F, G):
        B = bgc(S)
        acc.append(((R - B) / np.maximum(255.0 - B, 1.0)).mean(axis=2))
    A0 = np.clip(np.median(np.stack(acc), axis=0), 0, 0.95)

    # chi giu net logo, bo duong bien canh vat lot vao
    m = (A0 > thr).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    # Logo to (ngoi sao) hay dinh vao vien canh vat qua mot cau noi manh.
    # Mo hinh thai hoc cat cau noi do; logo day dan nen khong bi anh huong.
    m_lab = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((open_k, open_k), np.uint8)) \
        if open_k and open_k > 1 else m
    n, lab, st, cen = cv2.connectedComponentsWithStats(m_lab)
    cands = []
    for i in range(1, n):
        x, y, cw, ch, ar = st[i]
        if ar < 6:
            continue
        if cw > 0.7 * bw and ch <= 3:                  # duong ke ngang cua canh vat
            continue
        if ch > 0.7 * bh and cw <= 3:                  # duong ke doc
            continue
        if ar > 0.20 * bw * bh:                        # mang lon = nen, khong phai logo
            continue
        cands.append((float(A0[lab == i].max()), i, cen[i]))

    keep = np.zeros_like(m)
    if cands:
        # bam vao cum sang nhat, chi gom cac manh gan no (cac chu V-e-o, canh sao)
        cands.sort(reverse=True)
        cxy = cands[0][2]
        rad = (cluster * min(w, h)) if cluster else 0.35 * min(bw, bh)
        for _, i, c in cands:
            if abs(c[0] - cxy[0]) <= rad and abs(c[1] - cxy[1]) <= rad:
                keep[lab == i] = 255
    if keep.sum() == 0:
        keep = m

    # Chan cung kich thuoc: logo chi to co chung ay px. Cat bo phan noi lan sang
    # canh vat (vien tui, mep ban) de khong "sua" nham vung khong co logo.
    # Ngoi sao dinh vao vien tui qua mot cau noi manh nen loc theo hinh dang
    # khong an toan; cat theo BAN KINH quanh diem dam nhat la chac an nhat.
    if span and keep.any():
        ys, xs = np.where(keep > 0)
        wgt = A0[ys, xs] + 1e-6
        cx, cy = float((xs * wgt).sum() / wgt.sum()), float((ys * wgt).sum() / wgt.sum())
        r = span * min(info["w"], info["h"]) / 2 + 4
        yy, xx = np.mgrid[0:bh, 0:bw]
        win = (((xx - cx) ** 2 + (yy - cy) ** 2) <= r * r).astype(np.uint8) * 255
        keep = cv2.bitwise_and(cv2.bitwise_or(keep, m), win)

    M = cv2.GaussianBlur(cv2.dilate(keep, np.ones((3, 3), np.uint8), dilate).astype(np.float32) / 255,
                         (0, 0), 0.9)[..., None]
    A = (A0 * M[..., 0]).astype(np.float32)

    # --- lop 2: phan du co dau (vien toi / bong do)
    a3 = A[..., None]
    C = [np.clip((R - 255.0 * a3) / np.maximum(1e-3, 1.0 - a3), 0, 255) for R in F]
    Gs = [S.copy() for S in G]
    E = np.zeros_like(C[0])
    for _ in range(rounds):
        for S, c in zip(Gs, C):
            S[:, off:off + bw] = c
        e = np.median(np.stack([c - bgc(S) for c, S in zip(C, Gs)]), axis=0) * M
        C = [np.clip(c - e, 0, 255) for c in C]
        E += e

    score = float(A.max())
    if verbose:
        ys, xs = np.where(A > 0.02)
        pos = (f"({bx + xs.min()},{by + ys.min()})-({bx + xs.max()},{by + ys.max()})"
               if ys.size else "?")
        print(f"  {name or 'logo':5s}: {len(F)} frame mau | alpha max={score:.3f} | "
              f"|E| max={np.abs(E).max():.1f} | vung={pos}")
    return A, E.astype(np.float32), box, score


def find_logos(src, logo="auto", corner="br", samples=120, min_alpha=0.12, verbose=True):
    """Tra ve danh sach (A, E, box, bgk) cua cac logo can xoa."""
    info = probe_video(src)
    w, h = info["w"], info["h"]
    names = list(PRESETS) if logo in ("auto", "both") else [logo]

    found = []
    for nm in names:
        p = PRESETS[nm]
        box = preset_box(w, h, nm, corner)
        A, E, box, sc = estimate_layers(src, box, p["bgk"], "hmed", p["thr"],
                                        samples, span=p.get("span"), cluster=p.get("cluster"),
                                        open_k=p.get("open_k", 0),
                                        verbose=verbose, name=nm)
        if logo == "auto" and sc < min_alpha:
            if verbose:
                print(f"  {nm:5s}: khong thay logo (alpha {sc:.3f} < {min_alpha})")
            continue
        found.append((A, E, box, p["bgk"]))
    if not found:
        raise RuntimeError("Khong tim thay logo nao. Thu --logo veo / --logo star / --box")
    return found


# --------------------------------------------------------------------------- xu ly frame
def fit_scale(R, B, A, lo=0.5, hi=1.5):
    """Do do dam cua logo RIENG cho khung hinh nay (logo hay mo dan o dau/cuoi)."""
    keep = A > 0.05
    if keep.sum() < 8:
        return 1.0
    obs = ((R - B) / np.maximum(255.0 - B, 1.0)).mean(axis=2)
    s = float((obs[keep] * A[keep]).sum() / max((A[keep] ** 2).sum(), 1e-6))
    return float(np.clip(s, lo, hi))


def clean_frame(frame, A, E, box, bgk=21, strength=1.0, smooth=True, autofit=True,
                core=0.75, bg="hmed"):
    """Go logo khoi mot khung hinh (chi dong vao vung box)."""
    bgf = BGS[bg]
    bx, by, bw, bh = box
    strip, off = crop_ctx(frame, box, bgk)
    strip = strip.astype(np.float32)
    R = strip[:, off:off + bw].copy()
    B = bgf(strip, bgk)[:, off:off + bw]

    if autofit:
        strength = strength * fit_scale(R, B, A)

    a3 = np.clip(A * strength, 0, 0.95)[..., None]
    rec = np.clip((R - 255.0 * a3) / np.maximum(1e-3, 1.0 - a3), 0, 255)
    rec = np.clip(rec - E * strength, 0, 255)

    # Cho alpha qua cao thi thong tin goc gan nhu mat het -> ve lai bang FSR
    mk = ((A * strength) > core).astype(np.uint8) * 255
    if mk.any() and hasattr(cv2, "xphoto"):
        mk = cv2.dilate(mk, np.ones((3, 3), np.uint8), 1)
        dst = np.zeros_like(R, np.uint8)
        cv2.xphoto.inpaint(rec.astype(np.uint8), 255 - mk, dst, cv2.xphoto.INPAINT_FSR_FAST)
        s = cv2.GaussianBlur(mk.astype(np.float32) / 255.0, (0, 0), 1.2)[..., None]
        rec = dst.astype(np.float32) * s + rec * (1 - s)

    if smooth:
        # Tren NEN PHANG (tuong tron, mat ban tron) phan du du nho van lo ra vi
        # khong co chi tiet che -> lay thang nen, o vung phang no dung tuyet doi.
        strip2 = strip.copy()
        strip2[:, off:off + bw] = rec
        B2 = bgf(strip2, bgk)[:, off:off + bw]
        g = B2.mean(axis=2).astype(np.float32)
        mu = cv2.boxFilter(g, -1, (9, 9))
        det = np.sqrt(np.maximum(cv2.boxFilter(g * g, -1, (9, 9)) - mu * mu, 0))
        flat = np.exp(-(det / 2.5) ** 2)
        # nguong theo do dam cua chinh logo -> khong lan sang phan vien mo cua
        # canh vat lot vao ban do alpha (neu khong se de lai mot mang chu nhat)
        t = max(0.05, 0.15 * float(A.max()))
        msk = cv2.GaussianBlur(cv2.dilate((A > t).astype(np.uint8) * 255,
                                          np.ones((3, 3), np.uint8), 2).astype(np.float32) / 255,
                               (0, 0), 1.2)
        w1 = (msk * flat)[..., None]
        rec = B2 * w1 + rec * (1 - w1)

        den = cv2.bilateralFilter(rec.astype(np.uint8), 5, 18, 5).astype(np.float32)
        w2 = cv2.GaussianBlur(np.clip(A / max(A.max(), 1e-6), 0, 1), (0, 0), 1.0)[..., None] * 0.7
        rec = den * w2 + rec * (1 - w2)

    out = frame.copy()
    out[by:by + bh, bx:bx + bw] = np.clip(rec, 0, 255).astype(np.uint8)
    return out


def clean_frame_multi(frame, logos, **kw):
    for A, E, box, bgk in logos:
        frame = clean_frame(frame, A, E, box, bgk, **kw)
    return frame


# --------------------------------------------------------------------------- API chinh
def remove_video_watermark(src, dst=None, *, logo="auto", boxes=None, corner="br",
                           strength=1.0, smooth=True, autofit=True, samples=250,
                           crf=15, preset="slow", lossless=False, verbose=True):
    """
    Xoa logo Veo (chu hoac ngoi sao) khoi video, giu nguyen am thanh.

    logo     : "auto" | "veo" | "star" | "both"
    boxes    : danh sach (x,y,w,h) tu chi, bo qua preset
    strength : he so nhan (1.0 chuan; tang neu con vet mo)
    autofit  : do lai do dam logo cho tung khung hinh
    crf      : chat luong x264 (thap = net hon; 15 rat tot, 12 gan nhu goc)
    """
    info = probe_video(src)
    w, h, fps = info["w"], info["h"], info["fps"]

    if verbose:
        print(f"  [1/2] do logo tu {os.path.basename(src)} ...")
    if boxes:
        logos = []
        for b in boxes:
            k = 21 if max(b[2], b[3]) < 90 else 121
            A, E, b2, _ = estimate_layers(src, tuple(b), k, samples=samples, verbose=verbose)
            logos.append((A, E, b2, k))
    else:
        logos = find_logos(src, logo, corner, min(samples, 120), verbose=verbose)

    if dst is None:
        root, ext = os.path.splitext(src)
        dst = f"{root}_clean{ext or '.mp4'}"
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)

    if verbose:
        print(f"  [2/2] xu ly {info['n'] or '?'} frame ({len(logos)} logo) "
              f"-> {os.path.basename(dst)}")
    proc = _writer(dst, src, w, h, fps, crf, preset, lossless)
    sent = 0
    try:
        for fr in _reader(src, w, h):
            proc.stdin.write(clean_frame_multi(fr, logos, strength=strength,
                                               smooth=smooth, autofit=autofit).tobytes())
            sent += 1
    finally:
        proc.stdin.close()
        proc.wait()

    got = count_frames(dst)
    if got != sent:
        raise RuntimeError(f"Thieu frame: gui {sent} nhung file ra chi co {got}.")
    if verbose:
        print(f"  xong: {got} frame, khop voi ban goc")
    return dst


def probe_image(src, out_png="probe.png", logo="auto", boxes=None, corner="br",
                zoom=4, samples=120):
    """Anh kiem tra: vung logo truoc | ban do alpha | sau khi xoa."""
    info = probe_video(src)
    w, h = info["w"], info["h"]
    if boxes:
        logos = [(*estimate_layers(src, tuple(b), 21 if max(b[2], b[3]) < 90 else 121,
                                   samples=samples)[:3],
                  21 if max(b[2], b[3]) < 90 else 121) for b in boxes]
    else:
        logos = find_logos(src, logo, corner, samples)
    fr = next(_reader(src, w, h))
    out = clean_frame_multi(fr, logos)
    rows = []
    for A, E, box, bgk in logos:
        bx, by, bw, bh = box
        before = fr[by:by + bh, bx:bx + bw]
        after = out[by:by + bh, bx:bx + bw]
        heat = cv2.applyColorMap((A / max(A.max(), 1e-6) * 255).astype(np.uint8),
                                 cv2.COLORMAP_INFERNO)
        s = np.hstack([before, heat, after])
        rows.append(cv2.resize(s, (s.shape[1] * zoom, s.shape[0] * zoom),
                               interpolation=cv2.INTER_NEAREST))
    wmax = max(r.shape[1] for r in rows)
    rows = [cv2.copyMakeBorder(r, 4, 4, 0, wmax - r.shape[1], cv2.BORDER_CONSTANT,
                               value=(20, 20, 20)) for r in rows]
    cv2.imwrite(out_png, np.vstack(rows))
    return out_png


def process_folder(indir, outdir, **kw):
    os.makedirs(outdir, exist_ok=True)
    done = []
    for f in sorted(os.listdir(indir)):
        if f.lower().endswith(VIDEO_EXTS):
            print(f"== {f}")
            done.append(remove_video_watermark(os.path.join(indir, f),
                                               os.path.join(outdir, f), **kw))
    return done


# --------------------------------------------------------------------------- CLI
def main():
    p = argparse.ArgumentParser(description='Xoa logo Veo (chu hoac ngoi sao) trong video')
    p.add_argument("input", help="video hoac thu muc video")
    p.add_argument("-o", "--output", help="file/thu muc dau ra")
    p.add_argument("--logo", default="auto", choices=["auto", "veo", "star", "both"])
    p.add_argument("--box", help="vung logo x,y,w,h (nhieu vung ngan cach bang ';')")
    p.add_argument("--corner", default="br", choices=["br", "bl", "tr", "tl"])
    p.add_argument("--strength", type=float, default=1.0)
    p.add_argument("--samples", type=int, default=250)
    p.add_argument("--crf", type=int, default=15)
    p.add_argument("--preset", default="slow")
    p.add_argument("--lossless", action="store_true")
    p.add_argument("--no-smooth", action="store_true")
    p.add_argument("--no-autofit", action="store_true")
    p.add_argument("--probe", action="store_true", help="chi xuat anh kiem tra")
    a = p.parse_args()

    boxes = ([tuple(int(v) for v in b.split(",")) for b in a.box.split(";")]
             if a.box else None)

    if a.probe:
        print("OK:", probe_image(a.input, a.output or "probe.png", a.logo, boxes,
                                 a.corner, samples=min(a.samples, 120)))
        return

    kw = dict(logo=a.logo, boxes=boxes, corner=a.corner, strength=a.strength,
              smooth=not a.no_smooth, autofit=not a.no_autofit, samples=a.samples,
              crf=a.crf, preset=a.preset, lossless=a.lossless)

    if os.path.isdir(a.input):
        process_folder(a.input, a.output or (a.input.rstrip("/\\") + "_clean"), **kw)
    else:
        print("OK:", remove_video_watermark(a.input, a.output, **kw))


if __name__ == "__main__":
    main()
