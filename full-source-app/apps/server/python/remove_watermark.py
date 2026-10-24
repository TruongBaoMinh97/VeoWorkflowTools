#!/usr/bin/env python3
"""
remove_watermark - xoa watermark ngoi sao (sparkle) o goc duoi ben phai anh AI.

PHAT HIEN QUAN TRONG
--------------------
Watermark KHONG scale theo ti le anh. Do tren 5 ti le (9:16, 3:4, 1:1, 4:3, 16:9)
deu ra cung mot ngoi sao ~48 px, tam cach canh phai ~97 px va canh duoi ~99 px.
=> Chi can MOT ban do alpha duy nhat dung chung cho tat ca ti le.
Vai anh lech 3-5 px, nen truoc khi xoa co buoc `align` tu dong do lai vi tri
ngoi sao trong pham vi +/- 20 px (lech 3 px la du de lai vien den).

CACH HOAT DONG
--------------
Watermark la lop trang ban trong suot:      I = (1-a)*B + a*255
Biet ban do do mo "a" thi giai nguoc lai:   B = (I - a*255)/(1-a)
-> giu nguyen ket cau anh, khong to lai mot mang mo nhu inpaint.

Do "a" mot lan tu >= 6 anh cung loai watermark:
    python remove_watermark.py calibrate ./anh_co_watermark/ -o alpha.npy

Cai dat: pip install opencv-contrib-python numpy
(Neu chi co opencv-python: van chay duoc, loi ngoi sao dung Telea thay cho FSR.)
"""

from __future__ import annotations

import argparse
import os
import sys
import urllib.request

import cv2
import numpy as np

# --------------------------------------------------------------------------- cau hinh
CENTER = (97, 99)   # (px tu canh PHAI, px tu canh DUOI) toi tam ngoi sao
STAR = 56           # canh o vuong chua ngoi sao (px)
ROI = 160           # canh vung xu ly quanh tam (px) - can rong de uoc luong nen
SEARCH = 20         # bien do do tim vi tri ngoi sao (px) khi can chinh tu dong
EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp")


def detect_scale(shape):
    """Uoc luong he so phong dai so voi do phan giai goc cua generator.

    Watermark 48px @ (97,99) chi dung cho anh NATIVE (~768-1376px). Anh da upscale
    (vd 3072x5504 = 768x1376 x4) co watermark to/lech theo he so do => phai scale
    CENTER/STAR/ROI cho khop. Anh native tra ve 1.0 (khong doi gi).
    """
    h, w = shape[:2]
    long_side, short_side = max(w, h), min(w, h)
    ratio = short_side / max(long_side, 1)
    base_long = 1024 if ratio > 0.93 else (1200 if ratio > 0.70 else 1376)
    return max(1.0, round(long_side / base_long * 4) / 4)  # lam tron 0.25


def roi_box(shape, center=CENTER, roi=ROI):
    """Tra ve (y1, y2, x1, x2) cua vung xu ly, da cat gon trong anh."""
    h, w = shape[:2]
    cx, cy = w - center[0], h - center[1]
    r = roi // 2
    x1, x2 = max(0, cx - r), min(w, cx + r)
    y1, y2 = max(0, cy - r), min(h, cy + r)
    return y1, y2, x1, x2


def load_image(src):
    """Nhan duong dan file, URL http(s), hoac mang numpy BGR."""
    if isinstance(src, np.ndarray):
        return src.copy()
    if str(src).startswith(("http://", "https://")):
        with urllib.request.urlopen(str(src), timeout=30) as r:
            buf = np.frombuffer(r.read(), np.uint8)
        img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    else:
        img = cv2.imread(str(src), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"Khong doc duoc anh: {src}")
    return img


def build_mask(img, center=CENTER, star=STAR, thr=3, dilate=3, force_box=False):
    """Mask bam sat hinh ngoi sao (lop trang -> sang hon nen)."""
    h, w = img.shape[:2]
    cx, cy = w - center[0], h - center[1]
    r = star // 2
    x1, x2 = max(0, cx - r), min(w, cx + r)
    y1, y2 = max(0, cy - r), min(h, cy + r)

    mask = np.zeros((h, w), np.uint8)
    if force_box:
        mask[y1:y2, x1:x2] = 255
        return mask

    g = cv2.cvtColor(img[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY)
    d = cv2.subtract(g, cv2.medianBlur(g, 21))
    _, m = cv2.threshold(d, thr, 255, cv2.THRESH_BINARY)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    m = cv2.dilate(m, np.ones((3, 3), np.uint8), iterations=dilate)
    if m.mean() < 3:
        m[:] = 255
    mask[y1:y2, x1:x2] = m
    return mask


def _blend(img, filled, mask, sigma=1.5):
    s = cv2.GaussianBlur(mask.astype(np.float32) / 255.0, (0, 0), sigma)[..., None]
    return (filled.astype(np.float32) * s + img.astype(np.float32) * (1 - s)).astype(np.uint8)


def _fsr(img, mask, best=True):
    """FSR inpaint (opencv-contrib xphoto). Neu khong co xphoto -> Telea/NS blend
    (base opencv-python) de pipeline khong bao gio crash tren venv thieu contrib."""
    if not hasattr(cv2, "xphoto"):
        a = cv2.inpaint(img, mask, 6, cv2.INPAINT_TELEA)
        b = cv2.inpaint(img, mask, 6, cv2.INPAINT_NS)
        return cv2.addWeighted(a, 0.5, b, 0.5, 0)
    dst = np.zeros_like(img)
    mode = cv2.xphoto.INPAINT_FSR_BEST if best else cv2.xphoto.INPAINT_FSR_FAST
    cv2.xphoto.inpaint(img, 255 - mask, dst, mode)
    return dst


# --------------------------------------------------------------------------- calibrate
def calibrate(folder, out_npy="alpha.npy", center=CENTER, roi=ROI, min_files=6):
    """Do ban do alpha cua watermark tu nhieu anh (moi ti le deu dung duoc)."""
    files = [os.path.join(folder, f) for f in sorted(os.listdir(folder))
             if f.lower().endswith(EXTS)]
    if not files:
        raise SystemExit("Khong tim thay anh nao.")
    if len(files) < min_files:
        print(f"Canh bao: chi co {len(files)} anh, nen dung >= {min_files} anh.")

    alphas = []
    for f in files:
        try:
            im = load_image(f)
        except ValueError:
            continue
        y1, y2, x1, x2 = roi_box(im.shape, center, roi)
        R = im[y1:y2, x1:x2]
        if R.shape[:2] != (roi, roi):
            R = cv2.resize(R, (roi, roi))
        B = cv2.medianBlur(R, 81).astype(np.float32)      # nen (da xoa sach ngoi sao)
        alphas.append(((R.astype(np.float32) - B) / np.maximum(255.0 - B, 1.0)).mean(axis=2))

    a = np.clip(np.median(np.stack(alphas), axis=0), 0, 0.98)   # median -> loai noi dung
    a[a < 0.04] = 0
    np.save(out_npy, a.astype(np.float32))
    cv2.imwrite(os.path.splitext(out_npy)[0] + "_preview.png",
                (a / max(a.max(), 1e-6) * 255).astype(np.uint8))
    print(f"OK: {out_npy}  ({len(alphas)} anh, alpha max={a.max():.3f}, ROI={a.shape})")
    return out_npy


def _load_alpha(alpha):
    if alpha is None:
        return None
    if isinstance(alpha, np.ndarray):
        return alpha
    return np.load(str(alpha)) if os.path.exists(str(alpha)) else None


# --------------------------------------------------------------------------- methods
def _m_fsr(img, mask, **kw):
    return _blend(img, _fsr(img, mask), mask)


def _m_telea(img, mask, radius=6, **kw):
    a = cv2.inpaint(img, mask, radius, cv2.INPAINT_TELEA)
    b = cv2.inpaint(img, mask, radius, cv2.INPAINT_NS)
    return _blend(img, cv2.addWeighted(a, 0.5, b, 0.5, 0), mask)


def align_roi(img, A, center=CENTER, roi=ROI, search=SEARCH):
    """Doi chieu ban do alpha voi anh -> tim dung vi tri ngoi sao (+/- `search` px)."""
    base = roi_box(img.shape, center, roi)
    ay, ax = np.where(A > 0.05)                 # chi lay phan CO ngoi sao lam mau do
    if ay.size < 50:
        return base
    ay0, ay1, ax0, ax1 = ay.min(), ay.max() + 1, ax.min(), ax.max() + 1
    T = A[ay0:ay1, ax0:ax1]
    T = (T - T.mean()).astype(np.float32)

    y1, y2, x1, x2 = roi_box(img.shape, center, roi + 2 * search)
    big = img[y1:y2, x1:x2]
    if big.shape[0] <= T.shape[0] + 2 or big.shape[1] <= T.shape[1] + 2:
        return base
    g = cv2.cvtColor(big, cv2.COLOR_BGR2GRAY)
    d = cv2.subtract(g, cv2.medianBlur(g, 61)).astype(np.float32)
    _, score, _, loc = cv2.minMaxLoc(cv2.matchTemplate(d, T, cv2.TM_CCOEFF_NORMED))
    if score < 0.35:                            # khong chac chan -> giu vi tri mac dinh
        return base

    ox = x1 + loc[0] - ax0                      # goc trai-tren cua ROI sau khi can chinh
    oy = y1 + loc[1] - ay0
    if abs(ox - base[2]) > search or abs(oy - base[0]) > search:
        return base                             # lech qua xa -> nghi ngo bat nham
    ox = int(np.clip(ox, 0, img.shape[1] - A.shape[1]))
    oy = int(np.clip(oy, 0, img.shape[0] - A.shape[0]))
    return oy, oy + A.shape[0], ox, ox + A.shape[1]


def _m_calib(img, mask, alpha=None, center=CENTER, roi=ROI, strength=1.0,
             core=0.60, smooth=True, align=True, **kw):
    """Giai nguoc lop phu bang ban do alpha da do -> giu nguyen ket cau."""
    A = _load_alpha(alpha)
    if A is None:
        raise RuntimeError("Method 'calib' can alpha.npy - chay 'calibrate' truoc.")
    if align:
        y1, y2, x1, x2 = align_roi(img, A, center, roi)
    else:
        y1, y2, x1, x2 = roi_box(img.shape, center, roi)
    R = img[y1:y2, x1:x2].astype(np.float32)
    if A.shape != R.shape[:2]:
        A = cv2.resize(A, (R.shape[1], R.shape[0]), interpolation=cv2.INTER_CUBIC)
    A = np.clip(A * strength, 0, 0.98)

    a = A[..., None]
    rec = np.clip((R - 255.0 * a) / np.maximum(1e-3, 1.0 - a), 0, 255)

    # Loi ngoi sao (alpha ~ 1) mat gan het thong tin -> ve lai bang FSR (hoac Telea)
    m = np.zeros(R.shape[:2], np.uint8)
    m[A > core] = 255
    if m.any():
        m = cv2.dilate(m, np.ones((3, 3), np.uint8), 1)
        s = cv2.GaussianBlur(m.astype(np.float32) / 255.0, (0, 0), 1.5)[..., None]
        rec = _fsr(rec.astype(np.uint8), m).astype(np.float32) * s + rec * (1 - s)

    # Khu nhieu con lai (phep chia khuech dai nhieu JPEG) - chi trong vet watermark
    if smooth:
        den = cv2.bilateralFilter(rec.astype(np.uint8), 5, 22, 5).astype(np.float32)
        wgt = cv2.GaussianBlur(np.clip(A / max(A.max(), 1e-6), 0, 1), (0, 0), 2)[..., None]
        rec = den * wgt + rec * (1 - wgt)

    out = img.copy()
    out[y1:y2, x1:x2] = np.clip(rec, 0, 255).astype(np.uint8)
    return out


METHODS = {"calib": _m_calib, "fsr": _m_fsr, "telea": _m_telea}


# --------------------------------------------------------------------------- API chinh
def remove_watermark(src, dst=None, *, method="calib", alpha="alpha.npy",
                     center=CENTER, star=STAR, roi=ROI, strength=1.0,
                     smooth=True, align=True, force_box=False, radius=6, quality=97,
                     debug=False):
    """Xoa watermark ngoi sao goc duoi phai. Tra ve duong dan da luu."""
    img = load_image(src)
    A = _load_alpha(alpha)
    if method == "calib" and A is None:
        method = "fsr"

    # Anh upscale: watermark to/lech theo he so => scale CENTER/STAR/ROI cho khop.
    # Anh native (s=1.0) giu nguyen 100% hanh vi cu (calib + alpha, pixel-perfect).
    s = detect_scale(img.shape)
    if s > 1.05:
        center = (round(center[0] * s), round(center[1] * s))
        star = max(1, round(star * s))
        roi = max(1, round(roi * s))
        # Alpha do tren watermark NET (native). Anh upscale watermark bi mo, alpha
        # khong khop -> con vet sao. Inpaint (fsr) bam theo watermark THAT, sach hon.
        if method == "calib":
            method = "fsr"

    mask = build_mask(img, center=center, star=star, force_box=force_box)
    out = METHODS[method](img, mask, alpha=A, center=center, roi=roi,
                          strength=strength, smooth=smooth, align=align, radius=radius)

    if dst is None:
        base = src if isinstance(src, str) else "output.jpg"
        root, ext = os.path.splitext(os.path.basename(base.split("?")[0]))
        dst = f"{root}_clean{ext or '.jpg'}"
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    ext = os.path.splitext(dst)[1].lower()
    cv2.imwrite(dst, out, [cv2.IMWRITE_JPEG_QUALITY, quality] if ext in (".jpg", ".jpeg") else [])
    if debug:
        cv2.imwrite(os.path.splitext(dst)[0] + "_mask.png", mask)
    return dst


def process(indir, outdir, **kw):
    """Xu ly ca thu muc (tuan tu). Tra ve danh sach file da luu."""
    os.makedirs(outdir, exist_ok=True)
    files = [f for f in sorted(os.listdir(indir)) if f.lower().endswith(EXTS)]
    done = []
    for f in files:
        d = remove_watermark(os.path.join(indir, f), os.path.join(outdir, f), **kw)
        done.append(d)
        print(f"OK: {f} -> {d}")
    return done


# --------------------------------------------------------------------------- CLI
def main():
    p = argparse.ArgumentParser(description="Xoa watermark ngoi sao goc duoi phai")
    p.add_argument("input", help="anh / thu muc / URL, hoac 'calibrate'")
    p.add_argument("folder", nargs="?", help="thu muc anh (khi input=calibrate)")
    p.add_argument("-o", "--output", help="file hoac thu muc dau ra")
    p.add_argument("-m", "--method", default="calib", choices=list(METHODS))
    p.add_argument("--alpha", default="alpha.npy", help="file alpha.npy")
    p.add_argument("--center", default=f"{CENTER[0]},{CENTER[1]}")
    p.add_argument("--star", type=int, default=STAR)
    p.add_argument("--roi", type=int, default=ROI)
    p.add_argument("--strength", type=float, default=1.0)
    p.add_argument("--box", action="store_true")
    p.add_argument("--no-smooth", action="store_true")
    p.add_argument("--no-align", action="store_true")
    p.add_argument("--debug", action="store_true")
    a = p.parse_args()

    center = tuple(int(v) for v in a.center.split(","))

    if a.input == "calibrate":
        if not a.folder:
            sys.exit("Cu phap: remove_watermark.py calibrate ./thu_muc/ -o alpha.npy")
        calibrate(a.folder, a.output or "alpha.npy", center, a.roi)
        return

    kw = dict(method=a.method, alpha=a.alpha, center=center, star=a.star, roi=a.roi,
              strength=a.strength, smooth=not a.no_smooth, align=not a.no_align,
              force_box=a.box, debug=a.debug)

    if os.path.isdir(a.input):
        process(a.input, a.output or (a.input.rstrip("/\\") + "_clean"), **kw)
    else:
        print("OK:", remove_watermark(a.input, a.output, **kw))


if __name__ == "__main__":
    main()
