#!/usr/bin/env python3
"""Generate DME brand assets from the source logo.

Pure python3 standard library only (zlib + struct). No PIL / numpy / any
third-party dependency.

Reads  : dme-client/public/logo.png            (512x512 RGBA source)
Writes : dme-client/assets/images/
           icon-1024.png                  1024x1024 opaque #87CEEB background
           adaptive-foreground-1024.png   1024x1024 transparent, content in 66% safe zone
           splash-icon-512.png            byte-identical copy of source
           favicon-48.png                 48x48 transparent bilinear downscale
           logo.png                       byte-identical copy of source
         dme-client/public/icons/
           icon-192.png                   192x192 opaque #87CEEB background
           icon-512.png                   512x512 opaque #87CEEB background
           icon-maskable-512.png          512x512 #87CEEB background, logo in 66% safe zone
           apple-touch-icon-180.png       180x180 opaque #87CEEB background (iOS)
           favicon-48.png                 48x48 transparent bilinear downscale

Usage (from repo root, or any cwd - paths are derived from __file__):
    python3 dme-client/scripts/generate-brand-assets.py

Exits 0 and prints "PASS" when all round-trip self-checks pass.
"""

import os
import struct
import sys
import zlib

# ---------------------------------------------------------------------------
# CONSTANTS (paths resolved relative to this script -> repo root)
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CLIENT_DIR = os.path.dirname(SCRIPT_DIR)              # dme-client/
REPO_ROOT = os.path.dirname(CLIENT_DIR)               # dme/

SRC_LOGO = os.path.join(CLIENT_DIR, "public", "logo.png")
OUT_DIR = os.path.join(CLIENT_DIR, "assets", "images")
PWA_DIR = os.path.join(CLIENT_DIR, "public", "icons")

ICON_OUT = os.path.join(OUT_DIR, "icon-1024.png")
ADAPTIVE_OUT = os.path.join(OUT_DIR, "adaptive-foreground-1024.png")
SPLASH_OUT = os.path.join(OUT_DIR, "splash-icon-512.png")
FAVICON_OUT = os.path.join(OUT_DIR, "favicon-48.png")
LOGO_OUT = os.path.join(OUT_DIR, "logo.png")

PWA_ICON_192_OUT = os.path.join(PWA_DIR, "icon-192.png")
PWA_ICON_512_OUT = os.path.join(PWA_DIR, "icon-512.png")
PWA_ICON_MASKABLE_OUT = os.path.join(PWA_DIR, "icon-maskable-512.png")
PWA_APPLE_180_OUT = os.path.join(PWA_DIR, "apple-touch-icon-180.png")
PWA_FAVICON_48_OUT = os.path.join(PWA_DIR, "favicon-48.png")

# iOS icon background: standard skyblue
BG_R, BG_G, BG_B = 135, 206, 235            # #87CEEB (135,206,235)

# Source content bounding box (non-transparent pixels), inclusive.
SRC_BBOX_X0, SRC_BBOX_X1 = 61, 450
SRC_BBOX_Y0, SRC_BBOX_Y1 = 16, 496
SRC_BBOX_LONG = max(SRC_BBOX_X1 - SRC_BBOX_X0 + 1,
                    SRC_BBOX_Y1 - SRC_BBOX_Y0 + 1)   # 481

# Android adaptive icon safe zone: content longest edge <= 66% of 1024
SAFE_EDGE = 676

# PWA maskable icon safe zone: 512 * 0.66 ~= 338px max logo dimension
PWA_MASKABLE_EDGE = 338

PNG_SIG = b"\x89PNG\r\n\x1a\n"


# ---------------------------------------------------------------------------
# PNG decode
# ---------------------------------------------------------------------------
def _paeth(a, b, c):
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def decode_png(data):
    """Decode an 8-bit RGBA non-interlaced PNG into (width, height, bytearray)."""
    if len(data) < 8 or data[:8] != PNG_SIG:
        raise ValueError("not a PNG file (bad signature)")
    pos = 8
    width = height = None
    idat = bytearray()
    seen_ihdr = False
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length  # len(4) + type(4) + data + crc(4)
        if ctype == b"IHDR":
            w, h, bd, ct, comp, filt, inter = struct.unpack(">IIBBBBB", chunk)
            if bd != 8:
                raise ValueError("unsupported bit depth %d (need 8)" % bd)
            if ct != 6:
                raise ValueError("unsupported color type %d (need 6 RGBA)" % ct)
            if inter != 0:
                raise ValueError("interlaced PNG not supported")
            width, height = w, h
            seen_ihdr = True
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break
    if not seen_ihdr or width is None:
        raise ValueError("missing IHDR")
    raw = zlib.decompress(bytes(idat))
    return width, height, _unfilter(raw, width, height)


def _unfilter(raw, width, height):
    bpp = 4  # RGBA 8-bit
    stride = width * bpp
    out = bytearray(width * height * bpp)
    prev = bytearray(stride)
    rp = 0
    for y in range(height):
        ftype = raw[rp]
        rp += 1
        line = bytearray(raw[rp:rp + stride])
        rp += stride
        if ftype == 0:      # None
            pass
        elif ftype == 1:    # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ftype == 2:    # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:    # Average
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:    # Paeth
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                c = prev[i - bpp] if i >= bpp else 0
                b = prev[i]
                line[i] = (line[i] + _paeth(a, b, c)) & 0xFF
        else:
            raise ValueError("unknown filter type %d at row %d" % (ftype, y))
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return out


# ---------------------------------------------------------------------------
# PNG encode (RGBA 8-bit, filter byte 0 per row, zlib.compress)
# ---------------------------------------------------------------------------
def _chunk(ctype, payload):
    body = ctype + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def encode_png(width, height, pixels):
    """pixels: bytearray len width*height*4 already unfiltered rows."""
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw += pixels[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (PNG_SIG
            + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + _chunk(b"IEND", b""))


# ---------------------------------------------------------------------------
# Bilinear resampling
# ---------------------------------------------------------------------------
def bilinear_resize(src, sw, sh, dw, dh):
    """Bilinear-resize an RGBA buffer. Premultiplies alpha to avoid halos on
    transparent edges, then un-premultiplies."""
    dst = bytearray(dw * dh * 4)
    if dw <= 1:
        xscale = 0.0
    else:
        xscale = sw / float(dw)
    if dh <= 1:
        yscale = 0.0
    else:
        yscale = sh / float(dh)
    for dy in range(dh):
        sy = (dy + 0.5) * yscale - 0.5
        if sy < 0:
            sy = 0.0
        y0 = int(sy)
        if y0 > sh - 1:
            y0 = sh - 1
        y1 = y0 + 1 if y0 + 1 < sh else y0
        wy = sy - y0
        row0 = y0 * sw * 4
        row1 = y1 * sw * 4
        drow = dy * dw * 4
        for dx in range(dw):
            sx = (dx + 0.5) * xscale - 0.5
            if sx < 0:
                sx = 0.0
            x0 = int(sx)
            if x0 > sw - 1:
                x0 = sw - 1
            x1 = x0 + 1 if x0 + 1 < sw else x0
            wx = sx - x0
            i00 = row0 + x0 * 4
            i10 = row0 + x1 * 4
            i01 = row1 + x0 * 4
            i11 = row1 + x1 * 4
            # premultiplied bilinear over 4 channels
            a00 = src[i00 + 3]
            a10 = src[i10 + 3]
            a01 = src[i01 + 3]
            a11 = src[i11 + 3]
            w00 = (1 - wx) * (1 - wy)
            w10 = wx * (1 - wy)
            w01 = (1 - wx) * wy
            w11 = wx * wy
            # interpolate premultiplied color + alpha
            pr = src[i00] * a00 * w00 + src[i10] * a10 * w10 + src[i01] * a01 * w01 + src[i11] * a11 * w11
            pg = src[i00 + 1] * a00 * w00 + src[i10 + 1] * a10 * w10 + src[i01 + 1] * a01 * w01 + src[i11 + 1] * a11 * w11
            pb = src[i00 + 2] * a00 * w00 + src[i10 + 2] * a10 * w10 + src[i01 + 2] * a01 * w01 + src[i11 + 2] * a11 * w11
            pa = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11
            an = int(pa + 0.5)
            o = drow + dx * 4
            if pa <= 0.0:
                dst[o] = 0
                dst[o + 1] = 0
                dst[o + 2] = 0
            else:
                dst[o] = min(255, int(pr / pa + 0.5))
                dst[o + 1] = min(255, int(pg / pa + 0.5))
                dst[o + 2] = min(255, int(pb / pa + 0.5))
            dst[o + 3] = 0 if an < 0 else (255 if an > 255 else an)
    return dst


def compose_over_bg(src, w, h, br, bg, bb):
    """out = src*a + bg*(1-a); output alpha forced to 255."""
    out = bytearray(w * h * 4)
    for i in range(w * h):
        o = i * 4
        a = src[o + 3] / 255.0
        ia = 1.0 - a
        out[o] = min(255, int(src[o] * a + br * ia + 0.5))
        out[o + 1] = min(255, int(src[o + 1] * a + bg * ia + 0.5))
        out[o + 2] = min(255, int(src[o + 2] * a + bb * ia + 0.5))
        out[o + 3] = 255
    return out


def blit_center(dst, dw, dh, src, sw, sh, ox, oy):
    """Copy src into dst at (ox, oy). Alpha-composites when both have alpha."""
    for y in range(sh):
        dy = oy + y
        if dy < 0 or dy >= dh:
            continue
        srow = y * sw * 4
        drow = dy * dw * 4
        for x in range(sw):
            dx = ox + x
            if dx < 0 or dx >= dw:
                continue
            so = srow + x * 4
            do = drow + dx * 4
            sa = src[so + 3]
            if sa == 255:
                dst[do] = src[so]
                dst[do + 1] = src[so + 1]
                dst[do + 2] = src[so + 2]
                dst[do + 3] = 255
            elif sa > 0:
                da = dst[do + 3]
                a = sa / 255.0
                dst[do] = min(255, int(src[so] * a + dst[do] * (1 - a) + 0.5))
                dst[do + 1] = min(255, int(src[so + 1] * a + dst[do + 1] * (1 - a) + 0.5))
                dst[do + 2] = min(255, int(src[so + 2] * a + dst[do + 2] * (1 - a) + 0.5))
                dst[do + 3] = min(255, int(sa + da * (1 - a) + 0.5))


# ---------------------------------------------------------------------------
# Self-check helpers
# ---------------------------------------------------------------------------
def px(buf, w, x, y):
    o = (y * w + x) * 4
    return buf[o], buf[o + 1], buf[o + 2], buf[o + 3]


def check(cond, msg):
    if not cond:
        raise AssertionError("SELF-CHECK FAILED: " + msg)


def assert_roundtrip(path, exp_w, exp_h, corner_bg=None, corner_alpha=None):
    with open(path, "rb") as fp:
        data = fp.read()
    w, h, buf = decode_png(data)
    check(w == exp_w and h == exp_h, "%s size %dx%d != %dx%d" % (path, w, h, exp_w, exp_h))
    for (cx, cy) in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        r, g, b, a = px(buf, w, cx, cy)
        if corner_bg is not None:
            check((r, g, b, a) == (corner_bg[0], corner_bg[1], corner_bg[2], corner_bg[3]),
                  "%s corner(%d,%d)=%s != %s" % (path, cx, cy, (r, g, b, a), corner_bg))
        if corner_alpha is not None:
            check(a == corner_alpha,
                  "%s corner(%d,%d) alpha=%d != %d" % (path, cx, cy, a, corner_alpha))
    return buf


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    if not os.path.isfile(SRC_LOGO):
        sys.stderr.write("ERROR: source logo not found: %s\n" % SRC_LOGO)
        return 1

    with open(SRC_LOGO, "rb") as fp:
        src_bytes = fp.read()

    try:
        sw, sh, src = decode_png(src_bytes)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("ERROR: failed to decode source PNG %s: %s\n" % (SRC_LOGO, exc))
        return 1

    if (sw, sh) != (512, 512):
        sys.stderr.write("ERROR: unexpected source size %dx%d (expected 512x512)\n" % (sw, sh))
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(PWA_DIR, exist_ok=True)

    outputs = []

    # (a) icon-1024.png : 2x bilinear upscale, centered on opaque #87CEEB
    icon2x = bilinear_resize(src, sw, sh, sw * 2, sh * 2)         # 1024x1024
    icon_buf = compose_over_bg(icon2x, sw * 2, sh * 2, BG_R, BG_G, BG_B)
    with open(ICON_OUT, "wb") as fp:
        fp.write(encode_png(1024, 1024, icon_buf))
    outputs.append(ICON_OUT)

    # (b) adaptive-foreground-1024.png : content longest edge <= 676 in safe zone
    # scale = 676 / 481 ~= 1.4054
    scale = SAFE_EDGE / float(SRC_BBOX_LONG)
    new_w = int(round(sw * scale))
    new_h = int(round(sh * scale))
    fg = bilinear_resize(src, sw, sh, new_w, new_h)
    canvas = bytearray(1024 * 1024 * 4)   # transparent
    ox = (1024 - new_w) // 2
    oy = (1024 - new_h) // 2
    blit_center(canvas, 1024, 1024, fg, new_w, new_h, ox, oy)
    with open(ADAPTIVE_OUT, "wb") as fp:
        fp.write(encode_png(1024, 1024, canvas))
    outputs.append(ADAPTIVE_OUT)

    # (c) splash-icon-512.png : byte-identical copy of source
    with open(SPLASH_OUT, "wb") as fp:
        fp.write(src_bytes)
    outputs.append(SPLASH_OUT)

    # (d) favicon-48.png : bilinear downscale, keep alpha
    fav = bilinear_resize(src, sw, sh, 48, 48)
    with open(FAVICON_OUT, "wb") as fp:
        fp.write(encode_png(48, 48, fav))
    outputs.append(FAVICON_OUT)

    # (e) logo.png : byte-identical copy of source
    with open(LOGO_OUT, "wb") as fp:
        fp.write(src_bytes)
    outputs.append(LOGO_OUT)

    # ---- PWA icons (dme-client/public/icons/) ----
    pwa_outputs = []

    # (f) icon-192.png / icon-512.png / apple-touch-icon-180.png :
    #     bilinear resize + opaque #87CEEB background
    for out_path, size in ((PWA_ICON_192_OUT, 192),
                           (PWA_ICON_512_OUT, 512),
                           (PWA_APPLE_180_OUT, 180)):
        resized = bilinear_resize(src, sw, sh, size, size)
        buf = compose_over_bg(resized, size, size, BG_R, BG_G, BG_B)
        with open(out_path, "wb") as fp:
            fp.write(encode_png(size, size, buf))
        pwa_outputs.append(out_path)

    # (g) icon-maskable-512.png : full-bleed #87CEEB bg, logo in 66% safe zone
    mask_scale = PWA_MASKABLE_EDGE / float(SRC_BBOX_LONG)
    mask_w = int(round(sw * mask_scale))
    mask_h = int(round(sh * mask_scale))
    mask_fg = bilinear_resize(src, sw, sh, mask_w, mask_h)
    mask_buf = compose_over_bg(bytearray(512 * 512 * 4), 512, 512, BG_R, BG_G, BG_B)
    blit_center(mask_buf, 512, 512, mask_fg, mask_w, mask_h, (512 - mask_w) // 2, (512 - mask_h) // 2)
    with open(PWA_ICON_MASKABLE_OUT, "wb") as fp:
        fp.write(encode_png(512, 512, mask_buf))
    pwa_outputs.append(PWA_ICON_MASKABLE_OUT)

    # (h) favicon-48.png : transparent bilinear downscale (same as existing)
    pwa_fav = bilinear_resize(src, sw, sh, 48, 48)
    with open(PWA_FAVICON_48_OUT, "wb") as fp:
        fp.write(encode_png(48, 48, pwa_fav))
    pwa_outputs.append(PWA_FAVICON_48_OUT)

    # ---- self-checks ----
    icon_buf_rt = assert_roundtrip(
        ICON_OUT, 1024, 1024,
        corner_bg=(BG_R, BG_G, BG_B, 255))
    cr, cg, cb, ca = px(icon_buf_rt, 1024, 512, 512)
    check(ca == 255, "icon-1024 center alpha=%d != 255" % ca)

    assert_roundtrip(ADAPTIVE_OUT, 1024, 1024, corner_alpha=0)

    assert_roundtrip(FAVICON_OUT, 48, 48)

    for path in (SPLASH_OUT, LOGO_OUT):
        with open(path, "rb") as fp:
            out_bytes = fp.read()
        check(out_bytes == src_bytes, "%s not byte-identical to source" % path)

    for path, size in ((PWA_ICON_192_OUT, 192),
                       (PWA_ICON_512_OUT, 512),
                       (PWA_APPLE_180_OUT, 180),
                       (PWA_ICON_MASKABLE_OUT, 512)):
        buf_rt = assert_roundtrip(path, size, size,
                                  corner_bg=(BG_R, BG_G, BG_B, 255))
        cr, cg, cb, ca = px(buf_rt, size, size // 2, size // 2)
        check(ca == 255, "%s center alpha=%d != 255" % (path, ca))

    mask_buf_rt = assert_roundtrip(PWA_ICON_MASKABLE_OUT, 512, 512,
                                   corner_bg=(BG_R, BG_G, BG_B, 255))
    mr, mg, mb, ma = px(mask_buf_rt, 512, 256, 256)
    check((mr, mg, mb, ma) != (BG_R, BG_G, BG_B, 255),
          "icon-maskable-512 center is pure background (logo missing?)")

    assert_roundtrip(PWA_FAVICON_48_OUT, 48, 48, corner_alpha=0)

    print("wrote:")
    for p in outputs:
        print("  %s (%d bytes)" % (p, os.path.getsize(p)))
    for p in pwa_outputs:
        print("  %s (%d bytes)" % (p, os.path.getsize(p)))
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
