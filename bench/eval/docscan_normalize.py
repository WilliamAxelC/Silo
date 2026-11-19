#!/usr/bin/env python3
"""Approximate a phone document scanner (ML Kit Document Scanner / VisionKit) for benchmarking:
find the receipt's outline, crop it and correct perspective. Colour is kept; no binarisation.
Images where no convincing outline is found are copied unchanged.

usage: uv run --with opencv-python-headless --with pillow python -I bench/eval/docscan_normalize.py SRC_DIR OUT_DIR
"""
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps


def order_corners(pts):
    pts = pts.reshape(4, 2).astype(np.float32)
    s, d = pts.sum(1), np.diff(pts, axis=1).ravel()
    return np.array([pts[s.argmin()], pts[d.argmin()], pts[s.argmax()], pts[d.argmax()]], np.float32)


def find_document(img):
    h, w = img.shape[:2]
    scale = 1000.0 / max(h, w)
    small = cv2.resize(img, (int(w * scale), int(h * scale)))
    gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    # Receipts are bright paper: Otsu on brightness, then close gaps left by printed text.
    _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    c = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(c) / (small.shape[0] * small.shape[1])
    if area < 0.12 or area > 0.97:
        return None
    approx = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
    quad = approx if len(approx) == 4 else cv2.boxPoints(cv2.minAreaRect(c))
    return order_corners(np.asarray(quad)) / scale


def warp(img, quad):
    tl, tr, br, bl = quad
    W = int(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))
    H = int(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))
    M = cv2.getPerspectiveTransform(quad, np.array([[0, 0], [W, 0], [W, H], [0, H]], np.float32))
    return cv2.warpPerspective(img, M, (W, H))


def main(src, out):
    out.mkdir(parents=True, exist_ok=True)
    for f in sorted(src.iterdir()):
        im = ImageOps.exif_transpose(Image.open(f)).convert("RGB")
        img = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
        quad = find_document(img)
        res = warp(img, quad) if quad is not None else img
        cv2.imwrite(str(out / f.name), res, [cv2.IMWRITE_JPEG_QUALITY, 90])
        print(f.name, "cropped" if quad is not None else "unchanged", res.shape[1], "x", res.shape[0])


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
