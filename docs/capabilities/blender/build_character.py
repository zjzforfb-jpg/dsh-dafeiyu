"""大肥鱼 3D 角色：程序化建模（Blender 5.x headless）。

用法:
    blender -b --python build_character.py -- [--render PREFIX] [--blend OUT.blend]

坐标: Z 向上，角色面朝 -Y，观察者右侧 = +X。身高约 2.6。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy
from mathutils import Vector

import lib_mesh as L
from lib_mesh import (bez3, circle2d, decal_surf, ellipsoid, lathe, mix, new_obj, poly_flat,
                      solid_outline, srgb, strip, surf_pt, tube)

# --------------------------------------------------------------------- palette
SKIN      = srgb('#fdeee7')
SKIN_DEEP = srgb('#f3d4c9')
BLUSH     = srgb('#f4b3aa')
HAIR_D    = srgb('#20265a')
HAIR_M    = srgb('#3b4a8e')
HAIR_L    = srgb('#6b90ce')
HAIR_TIP  = srgb('#9cc2ee')
NAVY      = srgb('#191d3d')
NAVY_2    = srgb('#2a3060')
WHITE     = srgb('#f8f5f1')
WHITE_SH  = srgb('#d7d3df')
GOLD      = srgb('#c8a557')
EYE_DARK  = srgb('#0a0f2c')
IRIS_TOP  = srgb('#1b4a9c')
IRIS_MID  = srgb('#4f9dea')
IRIS_LOW  = srgb('#bfe9ff')
FIN       = srgb('#7ba7de')
FIN_D     = srgb('#456eb2')
GEM       = srgb('#5fc8ff')
SCLERA    = srgb('#f2f7ff')

PARTS = []


def add(name, tri, layer=0):
    verts, faces, cols = tri
    ob = new_obj(name, verts, faces, cols)
    PARTS.append((ob, layer))
    return ob


# ------------------------------------------------------------------ dimensions
HEAD_C = (0.0, 0.0, 1.985)
HEAD_R = (0.608, 0.560, 0.560)
HE = (HEAD_R[0] * 1.10, HEAD_R[1] * 1.10, HEAD_R[2] * 1.10)   # 头发贴面


def hair_col(p, u=0, v=0):
    t = max(0.0, min(1.0, (2.66 - p.z) / 2.4))
    if t < 0.40:
        c = mix(HAIR_D, HAIR_M, t / 0.40)
    else:
        c = mix(HAIR_M, HAIR_L, (t - 0.40) / 0.60)
    streak = 0.5 + 0.5 * math.sin(u * 118.0 + math.sin(u * 37.0) * 1.5)
    return mix(c, HAIR_D, 0.26 * streak)


def hair_tip_col(p, u=0, v=0):
    c = hair_col(p)
    return mix(c, HAIR_TIP, max(0.0, (v - 0.5) / 0.5) * 0.65)


def shell(center, radii, segs, rings, v_end_fn, color_fn):
    cx, cy, cz = center
    rx, ry, rz = radii
    verts, faces, cols = [], [], []
    for i in range(rings + 1):
        for j in range(segs):
            u = j / segs
            phi = 2 * math.pi * u
            v = v_end_fn(phi) * i / rings
            th = math.pi * v
            sr, sz = math.sin(th), math.cos(th)
            p = Vector((cx + rx * sr * math.cos(phi),
                        cy + ry * sr * math.sin(phi),
                        cz + rz * sz))
            verts.append(p)
            cols.append(color_fn(p, u, v))
    for i in range(rings):
        for j in range(segs):
            a = i * segs + j
            b = i * segs + (j + 1) % segs
            c = (i + 1) * segs + (j + 1) % segs
            d = (i + 1) * segs + j
            faces.append((a, b, c, d))
    return verts, faces, cols


# ---------------------------------------------------------------------- face
FACE_Y = -0.548          # 扁平脸平面（头部前方被压平）
FACE_X = 0.42
FACE_Z = 0.40


def flat(pts2d, y, color_fn=None, layer=0, name='decal'):
    off = 0.005 + (FACE_Y - y)
    verts = [surf_pt(p[0], p[1] - HEAD_C[2], HEAD_C, HEAD_R, off) for p in pts2d]
    tris = L.geometry.tessellate_polygon([verts])
    cols = [color_fn(p, 0.0, 0.0) if color_fn else WHITE for p in verts]
    add(name, (verts, tris, cols), layer)


def face():
    """五官：投影到头部曲面上，屏幕位置不变。"""
    for sx in (-1, 1):
        ex, ez = sx * 0.192, 1.886
        EX_RX, EX_RZ = 0.118, 0.138          # 眼睛外轮廓
        # 1) 眼睛底色（充当勾线）
        flat(circle2d(ex, ez, EX_RX, EX_RZ, 48), FACE_Y - 0.002,
             lambda p, u, v: EYE_DARK, name='eye_ink%d' % sx)
        # 2) 眼白
        flat(circle2d(ex, ez + 0.002, EX_RX - 0.009, EX_RZ - 0.009, 44), FACE_Y - 0.003,
             lambda p, u, v: SCLERA, name='sclera%d' % sx)
        # 3) 虹膜：几乎填满眼白，底部留一点白
        def iris_col(p, u, v, ez=ez):
            zz = p.z - ez
            tt = max(0.0, min(1.0, (0.150 - zz) / 0.30))
            c = mix(IRIS_TOP, IRIS_MID, min(1.0, tt * 1.9))
            return mix(c, IRIS_LOW, max(0.0, tt - 0.55) / 0.45)
        flat(circle2d(ex, ez + 0.006, EX_RX - 0.013, EX_RZ - 0.008, 44), FACE_Y - 0.004,
             iris_col, name='iris%d' % sx)
        # 4) 瞳孔
        flat(circle2d(ex, ez + 0.002, 0.042, 0.057, 28), FACE_Y - 0.005,
             lambda p, u, v: EYE_DARK, name='pupil%d' % sx)
        # 5) 高光
        flat(circle2d(ex - sx * 0.034, ez + 0.052, 0.027, 0.027, 22), FACE_Y - 0.007,
             lambda p, u, v: (1, 1, 1), layer=1, name='hi1_%d' % sx)
        flat(circle2d(ex + sx * 0.042, ez - 0.044, 0.011, 0.011, 16), FACE_Y - 0.007,
             lambda p, u, v: (1, 1, 1), layer=1, name='hi2_%d' % sx)
        # 6) 上睫毛：贴着眼眶上缘，外端翘起
        lash = []
        for i in range(29):
            a = math.radians(12) + math.radians(158) * i / 28
            lash.append((ex + (EX_RX + 0.004) * math.cos(a), ez + (EX_RZ + 0.004) * math.sin(a)))
        lv, lf, lc = strip_flat(lash, 0.016, FACE_Y - 0.008, EYE_DARK, taper=(0.72, 0.42))
        add('lash%d' % sx, (lv, lf, lc))
        # 7) 外眼角上挑
        spike = [(ex + sx * (EX_RX - 0.006), ez + 0.062), (ex + sx * (EX_RX + 0.034), ez + 0.030),
                 (ex + sx * (EX_RX - 0.004), ez + 0.006)]
        flat(spike, FACE_Y - 0.008, lambda p, u, v: EYE_DARK, name='spike%d' % sx)
        # 8) 眉毛
        brow = []
        for i in range(9):
            t = i / 8
            brow.append((sx * (0.104 + 0.170 * t), 2.050 + 0.022 * math.sin(t * math.pi) - 0.016 * t))
        lv, lf, lc = strip_flat(brow, 0.012, FACE_Y - 0.005, mix(EYE_DARK, HAIR_D, 0.55),
                                taper=(0.55, 0.75))
        add('brow%d' % sx, (lv, lf, lc))
        # 9) 腮红
        flat(circle2d(sx * 0.292, 1.748, 0.054, 0.024, 30), FACE_Y - 0.002,
             lambda p, u, v: mix(SKIN, BLUSH, 0.38), name='blush%d' % sx)

    # 嘴
    mouth = [(x, 1.664 + 0.012 * math.cos(x * 46)) for x in
             (-0.030, -0.020, -0.010, 0.0, 0.010, 0.020, 0.030)]
    lv, lf, lc = strip_flat(mouth, 0.007, FACE_Y - 0.005, mix(EYE_DARK, srgb('#a05a63'), 0.6))
    add('mouth', (lv, lf, lc))
    flat(circle2d(0.0, 1.792, 0.009, 0.005, 10), FACE_Y - 0.002,
         lambda p, u, v: mix(SKIN, SKIN_DEEP, 0.26), name='nose')


def strip_flat(pts2d, width, y, color, taper=(0.0, 0.0)):
    """Flat tapered ribbon along a 2D polyline."""
    pts = [Vector((p[0], p[1])) for p in pts2d]
    n = len(pts)
    left, right = [], []
    for i in range(n):
        if i == 0:
            t = pts[1] - pts[0]
        elif i == n - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[i + 1] - pts[i - 1]
        t.normalize()
        nrm = Vector((-t.y, t.x))
        f = 1.0
        if i == 0:
            f = 1.0 - taper[0]
        elif i == n - 1:
            f = 1.0 - taper[1]
        w = width * f
        left.append(pts[i] + nrm * w)
        right.append(pts[i] - nrm * w)
    poly = left + list(reversed(right))
    off = 0.005 + (FACE_Y - y)
    verts = [surf_pt(p.x, p.y - HEAD_C[2], HEAD_C, HEAD_R, off) for p in poly]
    tris = L.geometry.tessellate_polygon([verts])
    cols = [color for _ in verts]
    return verts, tris, cols


# ---------------------------------------------------------------------- build
def plate(pts3d, nrm, half_t, front_col, back_col=None):
    """Double-sided flat plate with thickness along nrm."""
    n = Vector(nrm).normalized()
    a = [p + n * half_t for p in pts3d]
    b = [p - n * half_t for p in pts3d]
    na = len(a)
    verts = a + b
    faces = []
    for t in L.geometry.tessellate_polygon([a]):
        faces.append(tuple(t))
    for t in L.geometry.tessellate_polygon([list(reversed(b))]):
        faces.append(tuple(i + na for i in t))
    for i in range(na):
        j = (i + 1) % na
        faces.append((i, j, j + na, i + na))
    cols = [front_col] * na + [(back_col or front_col)] * na
    return verts, faces, cols


def build():
    L.reset_scene()
    PARTS.clear()

    hv, hf, hc = ellipsoid(HEAD_C, HEAD_R, 64, 44,
                           lambda p, u, v: mix(SKIN, SKIN_DEEP, max(0.0, (v - 0.78) / 0.22) * 0.5))
    add('head', (hv, hf, hc))
    add('neck', tube([(0, 0.015, 1.28), (0, 0.015, 1.50)], [0.10, 0.118], 24,
                     color_fn=lambda p, u, v: SKIN_DEEP))
    face()

    # ------------------------------------------------ 头发
    def v_end(phi):
        f = math.sin(phi)                      # +1 后, -1 前
        return 0.60 + 0.24 * f

    add('hair_shell', shell(HEAD_C, HE, 64, 26, v_end, hair_col))

    # 后发主体
    for s in (-1, 1):
        pts = bez3((s * 0.24, 0.30, 1.86), (s * 0.56, 0.44, 1.46),
                   (s * 0.52, 0.48, 0.96), (s * 0.36, 0.38, 0.52), 16)
        add('backhair%d' % s, tube(pts, [0.24, 0.28, 0.24, 0.12], 18, flat=(1.0, 0.55),
                                   color_fn=hair_col))

    # 侧发
    for s in (-1, 1):
        pts = bez3((s * 0.50, -0.10, 1.95), (s * 0.56, -0.16, 1.56),
                   (s * 0.48, -0.20, 1.02), (s * 0.37, -0.15, 0.54), 20)
        add('sidehair%d' % s, tube(pts, [0.090, 0.105, 0.085, 0.030], 16, flat=(0.60, 1.0),
                                   color_fn=hair_tip_col))
        pts2 = bez3((s * 0.40, 0.14, 2.00), (s * 0.49, 0.18, 1.52),
                    (s * 0.44, 0.12, 1.00), (s * 0.33, 0.08, 0.60), 18)
        add('sidehair_b%d' % s, tube(pts2, [0.080, 0.095, 0.080, 0.032], 14, flat=(0.66, 1.0),
                                     color_fn=hair_tip_col))

    # 刘海（整片 + 参差下缘）
    def edge_z(x):
        a = abs(x)
        if a < 0.30:
            return 0.085 - 0.030 * (a / 0.30) ** 2 + 0.005 * math.sin(a * 26.0)
        t = min(1.0, (a - 0.30) / 0.25)
        return 0.055 - 0.360 * (t ** 1.5) + 0.004 * math.sin(a * 24.0)

    cols_n, rows_n = 56, 10
    fv, ff, fc = [], [], []
    for i in range(rows_n + 1):
        t = i / rows_n
        for j in range(cols_n + 1):
            u = j / cols_n
            x = -0.545 + 1.09 * u
            z_b = edge_z(x)
            z_t = 0.40 - 0.10 * abs(x)
            z = z_t + (z_b - z_t) * (t ** 0.86)
            p = surf_pt(x * (0.90 + 0.12 * t), z, HEAD_C, HE, 0.004)
            fv.append(p)
            fc.append(hair_col(p, u, t))
    for i in range(rows_n):
        for j in range(cols_n):
            a = i * (cols_n + 1) + j
            ff.append((a, a + 1, a + cols_n + 2, a + cols_n + 1))
    add('fringe', (fv, ff, fc))

    # 刘海分缕
    # 呆毛
    ahoge = bez3((0.02, -0.03, 2.50), (0.06, 0.06, 2.74), (0.20, 0.10, 2.80), (0.28, 0.00, 2.62), 16)
    add('ahoge', tube(ahoge, [0.050, 0.042, 0.030, 0.006], 12, flat=(1.0, 0.8), color_fn=hair_col))

    # ------------------------------------------------ 鲸鱼耳鳍
    for s in (-1, 1):
        sweep = math.radians(36)
        du = Vector((s * math.cos(sweep), math.sin(sweep), 0.0)).normalized()
        dv = Vector((0.0, 0.0, 1.0))
        n = du.cross(dv)
        if n.y > 0:
            n = -n
        base = Vector((s * 0.505, -0.02, 1.862))
        ear2d = [(0.00, -0.030), (0.09, 0.060), (0.21, 0.118), (0.34, 0.118),
                 (0.46, 0.050), (0.43, -0.030), (0.31, -0.098), (0.16, -0.126),
                 (0.03, -0.100)]
        pts = [base + du * u + dv * v for (u, v) in ear2d]
        add('ear%d' % s, plate(pts, n, 0.026, FIN, FIN_D))
        inner2d = [(0.12 + u * 0.27, -0.010 + v * 0.27) for (u, v) in ear2d]
        ipts = [base + n * 0.024 + du * u + dv * v for (u, v) in inner2d]
        add('ear_in%d' % s, plate(ipts, n, 0.004, mix(WHITE, FIN, 0.45), mix(WHITE, FIN, 0.3)))

    # ------------------------------------------------ 身体
    for s in (-1, 1):
        add('leg%d' % s, tube([(s * 0.155, 0.015, 0.14), (s * 0.162, 0.015, 0.38),
                               (s * 0.155, 0.015, 0.66)], [0.085, 0.076, 0.092], 20,
                              color_fn=lambda p, u, v: WHITE))
        add('boot%d' % s, ellipsoid((s * 0.16, -0.025, 0.085), (0.10, 0.14, 0.09), 28, 20,
                                    lambda p, u, v: mix(NAVY, NAVY_2, 0.35)))
        add('sole%d' % s, ellipsoid((s * 0.16, -0.025, 0.018), (0.102, 0.142, 0.024), 28, 10,
                                    lambda p, u, v: NAVY))

    add('skirt', lathe([(0.255, 1.02), (0.30, 0.965), (0.375, 0.90), (0.47, 0.80),
                        (0.55, 0.70), (0.605, 0.63), (0.625, 0.588), (0.607, 0.600),
                        (0.590, 0.604)], 64,
                       color_fn=lambda p, u, v: mix(NAVY_2, NAVY, 0.55)))
    add('petticoat', lathe([(0.604, 0.600), (0.622, 0.578), (0.628, 0.556), (0.612, 0.536)], 64,
                           color_fn=lambda p, u, v: mix(WHITE, WHITE_SH, 0.3)))
    add('bodice', lathe([(0.245, 0.99), (0.258, 1.06), (0.275, 1.14), (0.280, 1.20),
                         (0.262, 1.26), (0.218, 1.315), (0.15, 1.345)], 56,
                        color_fn=lambda p, u, v: mix(NAVY, NAVY_2, 0.15)))

    # 围裙
    apron_profile = [(0.275, 1.03), (0.325, 0.95), (0.395, 0.86), (0.465, 0.78),
                     (0.515, 0.71), (0.528, 0.668)]
    a0, a1 = -math.pi / 2 - 0.98, -math.pi / 2 + 0.98
    seg = 30
    av, af, ac = [], [], []
    for i, (r, z) in enumerate(apron_profile):
        for j in range(seg + 1):
            a = a0 + (a1 - a0) * j / seg
            rr = r + 0.014
            av.append(Vector((rr * math.cos(a), rr * math.sin(a), z)))
            ac.append(mix(WHITE, WHITE_SH, 0.05 + 0.10 * (1 - i / len(apron_profile))))
    for i in range(len(apron_profile) - 1):
        for j in range(seg):
            k = i * (seg + 1) + j
            af.append((k, k + 1, k + seg + 2, k + seg + 1))
    add('apron', (av, af, ac))

    bib_v, bib_f, bib_c = [], [], []
    bz0, bz1 = 1.375, 1.03
    for j in range(seg + 1):
        a = (a0 + 0.32) + (a1 - a0 - 0.64) * j / seg
        for k, z in enumerate((bz1, (bz0 + bz1) / 2, bz0)):
            r = 0.272 + (0.0 if k == 2 else 0.012)
            bib_v.append(Vector((r * math.cos(a), r * math.sin(a), z)))
            bib_c.append(mix(WHITE, WHITE_SH, 0.08 + 0.05 * k))
    for j in range(seg):
        for k in range(2):
            a = j * 3 + k
            bib_f.append((a, a + 3, a + 4, a + 1))
    add('apron_bib', (bib_v, bib_f, bib_c))

    for s in (-1, 1):
        add('strap%d' % s, tube([(s * 0.13, -0.24, 1.34), (s * 0.14, -0.205, 1.20),
                                 (s * 0.125, -0.245, 1.04)], [0.026] * 3, 10,
                                color_fn=lambda p, u, v: WHITE))

    fv2, ff2, fc2 = [], [], []
    for j in range(seg + 1):
        a = a0 + (a1 - a0) * j / seg
        for k, (dz, dr) in enumerate(((0.0, 0.0), (0.032, 0.030), (0.056, 0.012))):
            zz = 0.668 - dz
            rr = 0.532 + dr
            fv2.append(Vector((rr * math.cos(a), rr * math.sin(a), zz)))
            fc2.append(mix(WHITE, WHITE_SH, 0.22 + 0.14 * k))
    for j in range(seg):
        for k in range(2):
            a = j * 3 + k
            ff2.append((a, a + 3, a + 4, a + 1))
    add('apron_frill', (fv2, ff2, fc2))

    # 围裙上的鲸鱼纹
    whale = [(0, 0.0), (0.06, 0.035), (0.13, 0.045), (0.20, 0.03), (0.24, -0.01),
             (0.21, -0.05), (0.13, -0.065), (0.05, -0.055), (-0.01, -0.03)]
    wv, wf, wc = [], [], []
    RB = 0.468
    for (x, z) in whale:
        ang = (0.02 + x * 0.62) / RB
        wv.append(Vector((RB * math.sin(ang), -RB * math.cos(ang), 0.80 + z * 1.6)))
        wc.append(mix(srgb('#4a86c8'), srgb('#7fc4f0'), 0.4))
    tris = L.geometry.tessellate_polygon([wv])
    add('whale_badge', (wv, tris, wc))

    # 领子
    add('collar', lathe([(0.135, 1.352), (0.215, 1.335), (0.272, 1.308), (0.266, 1.288)], 56,
                        color_fn=lambda p, u, v: WHITE))
    add('collar_ruffle', lathe([(0.268, 1.302), (0.288, 1.283), (0.270, 1.262)], 56,
                               color_fn=lambda p, u, v: WHITE,
                               z_offset_fn=lambda a: 0.008 * math.sin(a * 7)))

    for s in (-1, 1):
        bow = bez3((0, -0.258, 1.30), (s * 0.07, -0.282, 1.338),
                   (s * 0.15, -0.272, 1.328), (s * 0.178, -0.248, 1.286), 12)
        add('bow%d' % s, tube(bow, [0.010, 0.05, 0.044, 0.018], 14, flat=(0.35, 1.0),
                              color_fn=lambda p, u, v: NAVY))
    add('bow_knot', ellipsoid((0, -0.272, 1.302), (0.042, 0.028, 0.040), 20, 14,
                              lambda p, u, v: NAVY_2))
    add('gem', ellipsoid((0, -0.298, 1.288), (0.030, 0.020, 0.030), 20, 14,
                         lambda p, u, v: GEM), layer=1)

    for s in (-1, 1):
        add('sleeve%d' % s, ellipsoid((s * 0.285, 0.0, 1.240), (0.115, 0.112, 0.126), 32, 24,
                                      lambda p, u, v: mix(NAVY, NAVY_2, 0.2)))
        add('cuff%d' % s, lathe([(0.100, 1.108), (0.114, 1.093), (0.100, 1.078)], 24,
                                color_fn=lambda p, u, v: WHITE))
        arm = [(s * 0.30, -0.012, 1.19), (s * 0.34, -0.03, 1.07),
               (s * 0.378, -0.05, 0.94), (s * 0.394, -0.058, 0.875)]
        add('arm%d' % s, tube(arm, [0.072, 0.066, 0.061, 0.058], 20,
                              color_fn=lambda p, u, v: SKIN))
        add('hand%d' % s, ellipsoid((s * 0.40, -0.066, 0.835), (0.068, 0.062, 0.072), 24, 18,
                                    lambda p, u, v: SKIN))

    # 尾巴
    tail = bez3((0.06, 0.40, 0.86), (0.26, 0.58, 0.80), (0.46, 0.64, 0.74), (0.58, 0.62, 0.72), 16)
    add('tail', tube(tail, [0.08, 0.075, 0.065, 0.055], 18,
                     color_fn=lambda p, u, v: FIN))
    fluke = [(0.00, 0.00), (0.10, 0.16), (0.26, 0.20), (0.34, 0.08), (0.32, -0.04),
             (0.24, 0.00), (0.26, -0.16), (0.12, -0.14), (0.02, -0.06)]
    add('fluke', solid_outline([(0.52 + x * 0.90, 0.72 + z * 0.90) for (x, z) in fluke],
                               0.042, 'z', 0.615,
                               lambda p, u, v: FIN if p.y < 0.615 else FIN_D))


# ------------------------------------------------------------------ preview
def setup_render(res=(660, 860), engine='EEVEE'):
    from mathutils import Vector as V
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'

    if engine == 'WORKBENCH':
        sc.render.engine = 'BLENDER_WORKBENCH'
        sh = sc.display.shading
        sh.light = 'MATCAP'
        sh.studio_light = 'basic_bright.exr'
        sh.color_type = 'VERTEX'
        sh.show_shadows = False
        sh.show_cavity = False
        sh.background_type = 'VIEWPORT'
        sh.background_color = (0.03, 0.04, 0.09)
    else:
        try:
            sc.render.engine = 'BLENDER_EEVEE_NEXT'
        except Exception:
            sc.render.engine = 'BLENDER_EEVEE'
        sc.eevee.taa_render_samples = 64
        mat = bpy.data.materials.get('toon_v')
        if mat is None:
            mat = bpy.data.materials.new('toon_v')
            mat.use_nodes = True
            nt = mat.node_tree
            nt.nodes.clear()
            out = nt.nodes.new('ShaderNodeOutputMaterial')
            bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
            attr = nt.nodes.new('ShaderNodeVertexColor')
            attr.layer_name = 'Col'
            nt.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
            nt.links.new(attr.outputs['Color'], bsdf.inputs['Emission Color'])
            bsdf.inputs['Emission Strength'].default_value = 0.28
            bsdf.inputs['Roughness'].default_value = 0.88
            bsdf.inputs['Specular IOR Level'].default_value = 0.12
            nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
        for ob in bpy.data.objects:
            if ob.type == 'MESH' and len(ob.data.materials) == 0:
                ob.data.materials.append(mat)
            elif ob.type == 'MESH':
                ob.data.materials.clear()
                ob.data.materials.append(mat)
        w = bpy.data.worlds.get('w') or bpy.data.worlds.new('w')
        sc.world = w
        w.use_nodes = True
        bg = w.node_tree.nodes['Background']
        bg.inputs[0].default_value = (0.025, 0.033, 0.075, 1)
        bg.inputs[1].default_value = 1.0
        for name, loc, en, size, col in (
                ('key', (-2.2, -3.2, 3.4), 340, 3.0, (1.0, 0.97, 0.93)),
                ('fill', (3.0, -2.6, 2.0), 130, 3.5, (0.82, 0.88, 1.0)),
                ('rim', (0.6, 3.4, 2.9), 280, 2.5, (0.75, 0.85, 1.0))):
            if name in bpy.data.objects:
                continue
            d = bpy.data.lights.new(name, 'AREA')
            d.energy, d.size, d.color = en, size, col
            o = bpy.data.objects.new(name, d)
            sc.collection.objects.link(o)
            o.location = loc
            o.rotation_euler = (V((0, 0, 1.35)) - V(loc)).to_track_quat('-Z', 'Y').to_euler()

    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = 68
    cam = bpy.data.objects.new('cam', cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    return cam


def aim(cam, loc, target=(0, 0, 1.32)):
    cam.location = loc
    d = Vector(target) - Vector(loc)
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def render_views(prefix, views=None, res=(660, 860)):
    cam = setup_render(res)
    views = views or [
        ('front', (0.0, -5.6, 1.5)),
        ('3q', (3.5, -4.3, 1.6)),
        ('side', (5.3, 0.0, 1.5)),
        ('head', (0.0, -2.3, 2.0)),
    ]
    for name, loc in views:
        aim(cam, loc, (0, 0, 1.90) if name == 'head' else (0, 0, 1.32))
        bpy.context.scene.render.filepath = '%s_%s.png' % (prefix, name)
        bpy.ops.render.render(write_still=True)
    print('RENDERED', prefix)


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    build()
    if '--render' in argv:
        render_views(argv[argv.index('--render') + 1])
    if '--blend' in argv:
        bpy.ops.wm.save_as_mainfile(filepath=argv[argv.index('--blend') + 1])
