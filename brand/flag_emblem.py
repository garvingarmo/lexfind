"""Chaldean flag emblem, reconstructed from the official flag artwork.

All dimensions are in flag units, where the outer star tip radius is 141.
Measured from the reference: three homothetic 8-point stars (red / white / red),
a yellow sun ring, a white ring, a blue disc, and eight bundles of three wavy blue lines.
"""
import math

FLAG_RED = "#DE0000"
FLAG_YELLOW = "#FFF000"
FLAG_BLUE = "#0241AB"
FLAG_WHITE = "#FFFFFF"

STAR_TIPS = (141.0, 129.4, 117.7)  # red outline, white gap, red star
INNER_RATIO = 0.4087                # inner vertex radius / tip radius (edges at 14.1 deg to the axis)
DISC = 31.2                         # blue disc
WHITE_RING = 35.9
SUN = 59.2                          # yellow ring outer radius
WAVE_OFFSETS = (-9.0, 0.0, 9.0)     # lateral line positions
WAVE_AMP = 1.75
WAVE_PERIOD = 20.0
WAVE_PHASE_U = 81.0
WAVE_HALF_W = 3.1
WAVE_U0, WAVE_U1 = 45.0, 117.3


def _f(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def _poly(pts):
    return "M" + " L".join(f"{_f(x)},{_f(y)}" for x, y in pts) + " Z"


def _star(cx, cy, tip, k):
    pts = []
    inner = tip * INNER_RATIO
    for i in range(16):
        a = math.radians(-90 + 22.5 * i)
        r = (tip if i % 2 == 0 else inner) * k
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return _poly(pts)


def _wave(cx, cy, bis_deg, off, k):
    a = math.radians(bis_deg)
    ux, uy = math.cos(a), math.sin(a)
    vx, vy = -uy, ux
    w = 2 * math.pi / WAVE_PERIOD
    left, right = [], []
    n = 120
    for i in range(n + 1):
        u = WAVE_U0 + (WAVE_U1 - WAVE_U0) * i / n
        v = off - WAVE_AMP * math.sin(w * (u - WAVE_PHASE_U))
        dv = -WAVE_AMP * w * math.cos(w * (u - WAVE_PHASE_U))
        hw = WAVE_HALF_W * math.sqrt(1 + dv * dv)
        for side, lst in ((1, left), (-1, right)):
            vv = v + side * hw
            lst.append((cx + (u * ux + vv * vx) * k, cy + (u * uy + vv * vy) * k))
    return _poly(left + right[::-1])


def flag_emblem(cx, cy, R):
    """Emblem centred at (cx, cy) with outer star tip radius R."""
    k = R / STAR_TIPS[0]
    waves = "".join(
        _wave(cx, cy, 22.5 + 45 * b, off, k) for b in range(8) for off in WAVE_OFFSETS
    )
    out = [f'<path d="{waves}" fill="{FLAG_BLUE}"/>']
    for tip, col in zip(STAR_TIPS, (FLAG_RED, FLAG_WHITE, FLAG_RED)):
        out.append(f'<path d="{_star(cx, cy, tip, k)}" fill="{col}"/>')
    for r, col in ((SUN, FLAG_YELLOW), (WHITE_RING, FLAG_WHITE), (DISC, FLAG_BLUE)):
        out.append(f'<circle cx="{_f(cx)}" cy="{_f(cy)}" r="{_f(r * k)}" fill="{col}"/>')
    return "".join(out)
