"""Mesh helpers for the Dafeiyu character build (Blender 5.x, headless).

Conventions
-----------
* Blender space: Z up, character faces -Y, viewer's right = +X.
* Everything is built from verts/faces + a per-vertex colour callback, so the
  final export can stay a single untextured mesh with baked vertex colours.
"""
import math
from mathutils import Vector, geometry

import bpy


# ---------------------------------------------------------------- scene utils
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    return sc


def new_obj(name, verts, faces, colors, smooth=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    me.validate(clean_customdata=False)
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    attr = me.color_attributes.new(name="Col", type='FLOAT_COLOR', domain='POINT')
    for i, c in enumerate(colors):
        attr.data[i].color = (c[0], c[1], c[2], c[3] if len(c) > 3 else 1.0)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def shade_smooth(ob, angle=math.radians(50)):
    """Smooth shading everywhere; hard creases come from geometry, not this."""
    for p in ob.data.polygons:
        p.use_smooth = True


# ------------------------------------------------------------------- geometry
def ellipsoid(center, radii, segs=48, rings=32, color_fn=None, v_from=0.0, v_to=1.0,
              phi_from=0.0, phi_to=2 * math.pi):
    """UV ellipsoid. color_fn(p, u, v) -> rgb tuple. v measured from -Z pole."""
    cx, cy, cz = center
    rx, ry, rz = radii
    verts, faces, cols = [], [], []
    nv = rings + 1
    for i in range(rings + 1):
        v = v_from + (v_to - v_from) * i / rings
        theta = math.pi * v                     # 0 at +Z pole
        sz = math.cos(theta)
        sr = math.sin(theta)
        for j in range(segs):
            u = j / segs
            phi = phi_from + (phi_to - phi_from) * u
            p = Vector((cx + rx * sr * math.cos(phi),
                        cy + ry * sr * math.sin(phi),
                        cz + rz * sz))
            verts.append(p)
            cols.append(color_fn(p, u, v) if color_fn else (1, 1, 1))
    for i in range(rings):
        for j in range(segs):
            a = i * segs + j
            b = i * segs + (j + 1) % segs
            c = (i + 1) * segs + (j + 1) % segs
            d = (i + 1) * segs + j
            faces.append((a, b, c, d))
    return verts, faces, cols


def lathe(profile, segs=48, color_fn=None, close_bottom=True, close_top=True,
          z_offset_fn=None):
    """Revolve a (radius, z) profile around Z. Points with r==0 become poles."""
    verts, faces, cols = [], [], []
    rings = []
    for (r, z) in profile:
        if r <= 1e-6:
            idx = len(verts)
            verts.append(Vector((0, 0, z)))
            cols.append(color_fn(Vector((0, 0, z)), 0.0, 0.0) if color_fn else (1, 1, 1))
            rings.append(('pole', idx))
        else:
            start = len(verts)
            for j in range(segs):
                a = 2 * math.pi * j / segs
                zz = z + (z_offset_fn(a) if z_offset_fn else 0.0)
                p = Vector((r * math.cos(a), r * math.sin(a), zz))
                verts.append(p)
                cols.append(color_fn(p, j / segs, 0.0) if color_fn else (1, 1, 1))
            rings.append(('ring', start))
    for i in range(len(rings) - 1):
        t0, a0 = rings[i]
        t1, a1 = rings[i + 1]
        if t0 == 'ring' and t1 == 'ring':
            for j in range(segs):
                j2 = (j + 1) % segs
                faces.append((a0 + j, a0 + j2, a1 + j2, a1 + j))
        elif t0 == 'pole' and t1 == 'ring':
            for j in range(segs):
                j2 = (j + 1) % segs
                faces.append((a0, a1 + j, a1 + j2))
        elif t0 == 'ring' and t1 == 'pole':
            for j in range(segs):
                j2 = (j + 1) % segs
                faces.append((a0 + j, a0 + j2, a1))
    if close_bottom and rings[0][0] == 'ring':
        pass
    if close_top and rings[-1][0] == 'ring':
        pass
    return verts, faces, cols


def _frames(pts):
    """Parallel-transport frames along a polyline."""
    n = len(pts)
    tans = []
    for i in range(n):
        if i == 0:
            t = pts[1] - pts[0]
        elif i == n - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[i + 1] - pts[i - 1]
        tans.append(t.normalized())
    up = Vector((0, 0, 1))
    ref = up if abs(tans[0].dot(up)) < 0.9 else Vector((0, 1, 0))
    n0 = (ref - tans[0] * ref.dot(tans[0])).normalized()
    normals = [n0]
    for i in range(1, n):
        prev_t, cur_t = tans[i - 1], tans[i]
        axis = prev_t.cross(cur_t)
        if axis.length < 1e-8:
            normals.append(normals[-1])
        else:
            ang = math.atan2(axis.length, prev_t.dot(cur_t))
            q = Vector(axis).normalized()
            v = normals[-1]
            v = v * math.cos(ang) + q.cross(v) * math.sin(ang) + q * q.dot(v) * (1 - math.cos(ang))
            normals.append(v.normalized())
    binorm = [tans[i].cross(normals[i]).normalized() for i in range(n)]
    return tans, normals, binorm


def tube(pts, radii, segs=16, flat=(1.0, 1.0), color_fn=None, caps=True, twist=0.0):
    """Sweep an ellipse along a polyline. flat scales the binormal/normal axes."""
    pts = [Vector(p) for p in pts]
    if len(radii) != len(pts):
        src = list(radii)
        n = len(pts)
        radii = []
        for i in range(n):
            t = i / max(1, n - 1) * (len(src) - 1)
            a = int(math.floor(t))
            b = min(a + 1, len(src) - 1)
            f = t - a
            radii.append(src[a] * (1 - f) + src[b] * f)
    tans, norm, bino = _frames(pts)
    verts, faces, cols = [], [], []
    for i, p in enumerate(pts):
        r = radii[i]
        for j in range(segs):
            a = 2 * math.pi * j / segs + twist * i
            off = norm[i] * (math.cos(a) * r * flat[0]) + bino[i] * (math.sin(a) * r * flat[1])
            v = p + off
            verts.append(v)
            cols.append(color_fn(v, j / segs, i / max(1, len(pts) - 1)) if color_fn else (1, 1, 1))
    for i in range(len(pts) - 1):
        for j in range(segs):
            j2 = (j + 1) % segs
            a = i * segs + j
            b = i * segs + j2
            c = (i + 1) * segs + j2
            d = (i + 1) * segs + j
            faces.append((a, b, c, d))
    if caps:
        # fan caps
        for end, rev in ((0, True), (len(pts) - 1, False)):
            idx = len(verts)
            verts.append(pts[end])
            cols.append(color_fn(pts[end], 0, 0) if color_fn else (1, 1, 1))
            base = end * segs
            for j in range(segs):
                j2 = (j + 1) % segs
                if rev:
                    faces.append((idx, base + j2, base + j))
                else:
                    faces.append((idx, base + j, base + j2))
    return verts, faces, cols


def surf_pt(x, z, center, radii, offset=0.006, front=-1.0):
    """Point on the front of an ellipsoid at given local (x, z)."""
    cx, cy, cz = center
    rx, ry, rz = radii
    q = 1.0 - (x / rx) ** 2 - (z / rz) ** 2
    if q < 0.0:
        q = 0.0
    y = front * ry * math.sqrt(q)
    p = Vector((x, y, z))
    n = Vector((x / rx ** 2, y / ry ** 2, z / rz ** 2)).normalized()
    p = p + n * offset
    return Vector((cx + p.x, cy + p.y, cz + p.z))


def decal_surf(pts2d, center, radii, offset=0.006, color_fn=None):
    """Flat outline painted onto the front hemisphere of an ellipsoid."""
    verts = [surf_pt(p[0], p[1], center, radii, offset) for p in pts2d]
    tris = geometry.tessellate_polygon([verts])
    cols = [color_fn(v, 0, 0) if color_fn else (1, 1, 1) for v in verts]
    return verts, tris, cols


def poly_flat(pts2d, axis='z', offset_axis=0.0, color_fn=None):
    """Triangulate a 2D outline lying in a plane; returns (verts, faces)."""
    pts3 = []
    for (a, b) in pts2d:
        if axis == 'z':       # outline in XZ plane, at y = offset
            pts3.append(Vector((a, offset_axis, b)))
        elif axis == 'y':     # outline in XY plane, at z = offset
            pts3.append(Vector((a, b, offset_axis)))
        else:                 # outline in YZ plane, at x = offset
            pts3.append(Vector((offset_axis, a, b)))
    tris = geometry.tessellate_polygon([pts3])
    cols = [color_fn(v, 0, 0) if color_fn else (1, 1, 1) for v in pts3]
    return pts3, tris, cols


def solid_outline(pts2d, thickness=0.03, axis='z', offset_axis=0.0, color_fn=None,
                  color_side=None):
    """Extrude a 2D outline into a closed solid (front cap, back cap, side wall)."""
    t = thickness * 0.5
    front, back, side = [], [], []
    for (a, b) in pts2d:
        if axis == 'z':            # outline in XZ, thickness along Y
            front.append(Vector((a, offset_axis + t, b)))
            back.append(Vector((a, offset_axis - t, b)))
            side.append(Vector((a, offset_axis, b)))
        elif axis == 'y':          # outline in XY, thickness along Z
            front.append(Vector((a, b, offset_axis + t)))
            back.append(Vector((a, b, offset_axis - t)))
            side.append(Vector((a, b, offset_axis)))
        else:                      # outline in YZ, thickness along X
            front.append(Vector((offset_axis + t, a, b)))
            back.append(Vector((offset_axis - t, a, b)))
            side.append(Vector((offset_axis, a, b)))
    tris = geometry.tessellate_polygon([side])
    n = len(pts2d)
    verts = front + back
    faces = []
    for (i0, i1, i2) in tris:
        faces.append((i0, i1, i2))
        faces.append((n + i2, n + i1, n + i0))
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, n + i, n + j, j))
    cols = [color_fn(v, 0, 0) if color_fn else (1, 1, 1) for v in front + back]
    return verts, faces, cols


def project_ellipsoid(p2d, center, radii, front=-1.0, offset=0.006, plane='xz'):
    """Project a 2D point onto an ellipsoid surface along the view direction."""
    cx, cy, cz = center
    rx, ry, rz = radii
    if plane == 'xz':
        d = Vector((p2d[0], front, p2d[1]))
    elif plane == 'xy':
        d = Vector((p2d[0], p2d[1], front))
    else:
        d = Vector((front, p2d[0], p2d[1]))
    inv = Vector((1.0 / rx, 1.0 / ry, 1.0 / rz))
    k = math.sqrt((d.x * inv.x) ** 2 + (d.y * inv.y) ** 2 + (d.z * inv.z) ** 2)
    t = 1.0 / k
    p = d * t
    n = Vector((p.x / rx ** 2, p.y / ry ** 2, p.z / rz ** 2)).normalized()
    p = p + n * offset
    return Vector((cx + p.x, cy + p.y, cz + p.z))


def decal(pts2d, center, radii, front=-1.0, offset=0.006, color_fn=None, plane='xz'):
    """Flat outline projected onto an ellipsoid (crisp face features)."""
    verts = [project_ellipsoid(p, center, radii, front, offset, plane) for p in pts2d]
    tris = geometry.tessellate_polygon([verts])
    cols = [color_fn(v, 0, 0) if color_fn else (1, 1, 1) for v in verts]
    return verts, tris, cols


def strip(pts2d, width, center, radii, front=-1.0, offset=0.006, color_fn=None,
          taper=(0, 0)):
    """A tapered ribbon along a 2D polyline, projected onto the ellipsoid."""
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
    return decal([(p.x, p.y) for p in poly], center, radii, front, offset, color_fn)


def circle2d(cx, cz, rx, rz, n=40, rot=0.0):
    out = []
    for i in range(n):
        a = 2 * math.pi * i / n + rot
        out.append((cx + rx * math.cos(a), cz + rz * math.sin(a)))
    return out


def ellipse_arc(cx, cz, rx, rz, a0, a1, n=24):
    out = []
    for i in range(n + 1):
        a = a0 + (a1 - a0) * i / n
        out.append((cx + rx * math.cos(a), cz + rz * math.sin(a)))
    return out


def bez(p0, p1, p2, p3, n=24):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
                    u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]))
    return out


def bez3(p0, p1, p2, p3, n=24):
    p0, p1, p2, p3 = Vector(p0), Vector(p1), Vector(p2), Vector(p3)
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append(u ** 3 * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t ** 3 * p3)
    return out


def mix(c0, c1, t):
    t = max(0.0, min(1.0, t))
    return (c0[0] + (c1[0] - c0[0]) * t,
            c0[1] + (c1[1] - c0[1]) * t,
            c0[2] + (c1[2] - c0[2]) * t)


def hexc(s):
    s = s.lstrip('#')
    return (int(s[0:2], 16) / 255.0, int(s[2:4], 16) / 255.0, int(s[4:6], 16) / 255.0)


def srgb(s):
    """hex -> linear (Blender colours are linear)."""
    c = hexc(s)
    return tuple((v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in c)
