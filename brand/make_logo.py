import math, os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

from flag_emblem import flag_emblem

HERE = os.path.dirname(os.path.abspath(__file__))
# Written straight into the website's public folder (served at /brand/...). LOGO_OUT overrides it.
OUT = os.environ.get("LOGO_OUT", os.path.join(HERE, "..", "public", "brand"))
os.makedirs(OUT, exist_ok=True)

INK = "#14213D"      # wordmark
CREAM = "#F4EFE6"     # reverse versions


# ---------- text to outlines ----------
class Font:
    def __init__(self, path):
        self.f = TTFont(path)
        self.gs = self.f.getGlyphSet()
        self.cmap = self.f.getBestCmap()
        self.upm = self.f["head"].unitsPerEm

    def measure(self, text, size, tracking):
        s = size / self.upm
        w = 0
        for i, ch in enumerate(text):
            w += self.gs[self.cmap[ord(ch)]].width * s
            if i < len(text) - 1:
                w += tracking
        return w

    def path(self, text, size, tracking, x, baseline):
        s = size / self.upm
        pen = SVGPathPen(self.gs)
        cx = x
        for ch in text:
            g = self.gs[self.cmap[ord(ch)]]
            g.draw(TransformPen(pen, (s, 0, 0, -s, cx, baseline)))
            cx += g.width * s + tracking
        return pen.getCommands()

    def centered(self, text, size, tracking, cx, baseline):
        w = self.measure(text, size, tracking)
        return self.path(text, size, tracking, cx - w / 2, baseline), w


CINZEL_SB = Font(os.path.join(HERE, "fonts/Cinzel_wght_600.ttf"))
CINZEL_MD = Font(os.path.join(HERE, "fonts/Cinzel_wght_500.ttf"))


def f(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def poly(pts):
    return "M" + " L".join(f"{f(x)},{f(y)}" for x, y in pts) + " Z"


# Mark geometry at scale 1: the emblem (tip radius 150) centred at (0, 0).
# On dark backgrounds it sits in a white roundel, standing in for the flag's white field.
ROUNDEL_R = 172


def mark_box(reverse):
    """(half width, top, bottom) of the mark at scale 1."""
    r = ROUNDEL_R if reverse else 150
    return r, -r, r


def mark(cx, cy, s, reverse):
    body = f'<circle cx="0" cy="0" r="{ROUNDEL_R}" fill="#FFFFFF"/>' if reverse else ""
    body += flag_emblem(0, 0, 150)
    return f'<g transform="translate({f(cx)},{f(cy)}) scale({f(s)})">{body}</g>'


def svg(w, h, body, bg=None):
    rect = f'<rect width="{f(w)}" height="{f(h)}" fill="{bg}"/>' if bg else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f(w)} {f(h)}" width="{f(w)}" height="{f(h)}">{rect}{body}</svg>\n'


def write(name, content):
    with open(os.path.join(OUT, name), "w") as fh:
        fh.write(content)


def palette(reverse):
    if reverse:
        return dict(bg=INK, ink=CREAM)
    return dict(bg="#FFFFFF", ink=INK)


# ---------- lockups ----------
LINE1, LINE2 = "CHALDEAN LAW", "DIRECTORY"


def cap_height(font, size):
    return font.f["OS/2"].sCapHeight / font.upm * size


def wordmark(x, top, size, ink, align="center"):
    """Two-line name; DIRECTORY is centred beneath CHALDEAN LAW.
    Returns (svg, width, height). x is the centre (align=center) or left edge."""
    track1 = size * 0.08
    w1 = CINZEL_SB.measure(LINE1, size, track1)
    size2 = size * 0.46
    track2 = size2 * 0.32
    w2 = CINZEL_MD.measure(LINE2, size2, track2)
    left = x - w1 / 2 if align == "center" else x
    b1 = top + cap_height(CINZEL_SB, size)
    b2 = b1 + size * 0.36 + cap_height(CINZEL_MD, size2)
    out = f'<path d="{CINZEL_SB.path(LINE1, size, track1, left, b1)}" fill="{ink}"/>'
    out += f'<path d="{CINZEL_MD.path(LINE2, size2, track2, left + (w1 - w2) / 2, b2)}" fill="{ink}"/>'
    return out, w1, b2 - top


def stacked(reverse=False):
    p = palette(reverse)
    size = 84
    _, w1, _ = wordmark(0, 0, size, p["ink"])
    W = math.ceil(max(w1, 300) + 160)
    cx = W / 2
    s = 1.0 if not reverse else 0.87
    top = 50
    _, mt, mb = mark_box(reverse)
    body = mark(cx, top - mt * s, s, reverse)
    text, _, th = wordmark(cx, top + (mb - mt) * s + 56, size, p["ink"])
    body += text
    return svg(W, math.ceil(top + (mb - mt) * s + 56 + th + 50), body, p["bg"] if reverse else None)


def horizontal(reverse=False, background=True):
    p = palette(reverse)
    mx_half, mt, mb = mark_box(reverse)
    s = 0.6 if not reverse else 0.52
    pad = 30
    H = (mb - mt) * s + 2 * pad
    mx = pad + mx_half * s
    body = mark(mx, pad - mt * s, s, reverse)
    tx = mx + mx_half * s + 44
    size = 72
    _, w1, th = wordmark(0, 0, size, p["ink"])
    text, _, _ = wordmark(tx, H / 2 - th / 2, size, p["ink"], align="left")
    body += text
    W = math.ceil(tx + w1 + 40)
    return svg(W, round(H), body, p["bg"] if reverse and background else None)


def mark_only(reverse=False):
    p = palette(reverse)
    pad = 40
    mx_half, mt, mb = mark_box(reverse)
    W = 2 * mx_half + 2 * pad
    H = mb - mt + 2 * pad
    body = mark(W / 2, pad - mt, 1, reverse)
    return svg(W, H, body, p["bg"] if reverse else None)


def emblem_only():
    # the flag emblem alone, unaltered, for favicons and avatars
    return svg(300, 300, flag_emblem(150, 150, 141))


write("chaldeanlaw-logo-stacked.svg", stacked())
write("chaldeanlaw-logo-stacked-reverse.svg", stacked(True))
write("chaldeanlaw-logo-horizontal.svg", horizontal())
write("chaldeanlaw-logo-horizontal-reverse.svg", horizontal(True))
# Reverse colours on a transparent background, for the site's dark footer and the email header band.
write("chaldeanlaw-logo-horizontal-reverse-transparent.svg", horizontal(True, background=False))
write("chaldeanlaw-mark.svg", mark_only())
write("chaldeanlaw-mark-reverse.svg", mark_only(True))
write("chaldeanlaw-emblem.svg", emblem_only())
print("ok")
