"""Export the built character to a compact JSON for three.js.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python export_json.py -- out.json
"""
import base64
import json
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib_mesh as L          # noqa: E402
import build_character as bc  # noqa: E402


def quant_positions(co, scale=1.0 / 12000.0):
    q = np.round(co / scale).astype(np.int32)
    return q.astype(np.int16), scale


def main(out_path):
    L.reset_scene()
    bc.build()

    # join every mesh into one object
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    me = ob.data

    # triangulate
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    me.calc_loop_triangles()

    attr = me.color_attributes[0]
    nv = len(me.vertices)
    vcol = np.zeros((nv, 4), dtype=np.float32)
    for i, d in enumerate(attr.data):
        vcol[i] = d.color

    co = np.zeros((nv, 3), dtype=np.float32)
    me.vertices.foreach_get('co', co.ravel())

    # Blender (x, y, z) -> three.js (x, z, -y)  so the character faces +Z
    p = np.stack([co[:, 0], co[:, 2], -co[:, 1]], axis=1)
    # center on origin in X, keep feet at y=0
    p[:, 0] -= 0.0
    p[:, 1] -= 0.0
    p[:, 2] -= 0.0

    S = 12000.0
    qp = np.round(p * S).astype(np.int32).clip(-32767, 32767).astype(np.int16)

    # sRGB encode (uint8 keeps darks well)
    lin = np.clip(vcol[:, :3], 0.0, 1.0)
    srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1.0 / 2.4) - 0.055)
    cq = np.round(np.clip(srgb, 0, 1) * 255).astype(np.uint8)

    idx = np.zeros(len(me.loop_triangles) * 3, dtype=np.int32)
    me.loop_triangles.foreach_get('vertices', idx)
    idx = idx.astype(np.uint16) if nv < 65536 else idx.astype(np.uint32)

    data = {
        'n': int(nv),
        'scale': S,
        'pos': base64.b64encode(qp.astype('<i2').tobytes()).decode('ascii'),
        'col': base64.b64encode(cq.tobytes()).decode('ascii'),
        'idx': base64.b64encode(idx.astype('<u2').tobytes()).decode('ascii'),
        'tris': int(len(idx) // 3),
    }
    with open(out_path, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    print('EXPORTED', out_path, 'verts', nv, 'tris', len(idx) // 3,
          'bytes', os.path.getsize(out_path))


if __name__ == '__main__':
    argv = sys.argv
    out = argv[argv.index('--') + 1] if '--' in argv else '/tmp/dafeiyu_mesh.json'
    main(out)
