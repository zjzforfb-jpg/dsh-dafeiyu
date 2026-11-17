import bpy, time, math
t=time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0,0,0))
o=bpy.context.object
m=bpy.data.materials.new("m"); m.use_nodes=True
m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value=(0.2,0.4,1,1)
o.data.materials.append(m)
for p in o.data.polygons: p.use_smooth=True
cam_data=bpy.data.cameras.new("c"); cam=bpy.data.objects.new("c",cam_data)
bpy.context.scene.collection.objects.link(cam); cam.location=(0,-6,1.2); cam.rotation_euler=(math.radians(80),0,0)
bpy.context.scene.camera=cam
l=bpy.data.lights.new("l",'SUN'); lo=bpy.data.objects.new("l",l); bpy.context.scene.collection.objects.link(lo); lo.rotation_euler=(math.radians(50),0,math.radians(30)); l.energy=4
sc=bpy.context.scene
sc.render.engine='BLENDER_WORKBENCH'
sc.render.resolution_x=400; sc.render.resolution_y=400
sc.render.filepath='/tmp/bl_smoke.png'
bpy.ops.render.render(write_still=True)
print("RENDER_OK", round(time.time()-t,2))
