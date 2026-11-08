# The person aboard: Microsoft Rocketbox avatar Male_Adult_07 (MIT licence,
# https://github.com/microsoft/Microsoft-Rocketbox), with the library's own
# motion-captured animations, converted for the game: one skinned mesh
# (7 600 triangles), the Biped skeleton, 1024 px textures, clips
# idle / look / walk / run / helm. Output: src/assets/person.glb
#
# Run with Blender's Python (bpy), the Rocketbox repository checked out:
#   python build_person.py <rocketbox>/Assets <converted textures dir> <out.glb>
# The textures dir holds the avatar's TGAs resized to 1024 px (JPG; the hair
# and lash opacity map as PNG).
import bpy, sys, os

ASSETS, TEX, OUT = sys.argv[-3:]
AV = os.path.join(ASSETS, 'Avatars/Adults/Male_Adult_07/Export/Male_Adult_07.fbx')
AN = os.path.join(ASSETS, 'Animations')
CLIPS = {
    'idle': 'all_animations_max_motextr_static/m_idle_neutral_01.max.fbx',
    'look': 'all_animations_max_motextr_static/m_idle_look_around_01.max.fbx',
    'helm': 'all_animations_max_motextr_static/m_idle_neutral_02.max.fbx',
    'walk': 'all_animations_max_motextr_xy/m_walk_neutral_01.max.fbx',
    'run': 'all_animations_max_motextr_xy/m_run_slow_01.max.fbx',
}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=AV)
rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
mesh = next(o for o in bpy.data.objects if o.type == 'MESH')
for o in list(bpy.data.objects):
    if o.type == 'EMPTY': bpy.data.objects.remove(o)
for a in list(bpy.data.actions): bpy.data.actions.remove(a)
rig.name = 'person'
mesh.name = 'person_mesh'

# materials: base colour + normal map; the hair and lashes cut out by alpha
def material(name, color, normal=None, alpha=False, rough=0.6):
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    for n in list(nt.nodes): nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    b.inputs['Roughness'].default_value = rough
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = bpy.data.images.load(os.path.join(TEX, color))
    nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    if alpha:
        nt.links.new(t.outputs['Alpha'], b.inputs['Alpha'])
        m.blend_method = 'CLIP' if hasattr(m, 'blend_method') else None
    if normal:
        tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = bpy.data.images.load(os.path.join(TEX, normal))
        tn.image.colorspace_settings.name = 'Non-Color'
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    nt.links.new(b.outputs[0], out.inputs[0])
    return m
mats = {
    'm013_body': material('clothes', 'm013_body_color.jpg', 'm013_body_normal.jpg', rough=0.75),
    'm013_head': material('skin', 'm013_head_color.jpg', 'm013_head_normal.jpg', rough=0.55),
    'm013_opacity': material('hair', 'm013_opacity_color.png', alpha=True, rough=0.7),
}
for i, m in enumerate(mesh.data.materials):
    mesh.data.materials[i] = mats.get(m.name, m)

# the animations: each file brings its own copy of the skeleton with the take.
# Its rest pose (arms level) is not the avatar's (arms down), so the motion
# is retargeted: every bone of the avatar follows the world orientation of the
# same bone in the take (the hips also its position), baked frame by frame.
rig.animation_data_create()
sc = bpy.context.scene
for clip, rel in CLIPS.items():
    before = set(bpy.data.actions)
    objs_before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=os.path.join(AN, rel))
    new_objs = set(bpy.data.objects) - objs_before
    src = next(o for o in new_objs if o.type == 'ARMATURE')
    new_acts = [a for a in bpy.data.actions if a not in before]
    take = src.animation_data.action
    f0, f1 = [int(round(x)) for x in take.frame_range]
    for pb in rig.pose.bones:
        c = pb.constraints.new('COPY_ROTATION'); c.target = src; c.subtarget = pb.name
        if pb.parent is None or pb.name.endswith('Pelvis'):
            c2 = pb.constraints.new('COPY_LOCATION'); c2.target = src; c2.subtarget = pb.name
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True); bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.select_all(action='SELECT')
    sc.frame_start, sc.frame_end = f0, f1
    bpy.ops.nla.bake(frame_start=f0, frame_end=f1, only_selected=False, visual_keying=True,
                     clear_constraints=True, use_current_action=False, bake_types={'POSE'})
    bpy.ops.object.mode_set(mode='OBJECT')
    act = rig.animation_data.action
    act.name = clip
    act.use_fake_user = True
    rig.animation_data.action = None
    for o in new_objs: bpy.data.objects.remove(o)
    for a in new_acts: bpy.data.actions.remove(a)
    tr = rig.animation_data.nla_tracks.new()
    tr.name = clip
    st = tr.strips.new(clip, f0, act)
    if hasattr(st, 'action_slot') and act.slots: st.action_slot = act.slots[0]
    print(clip, (f0, f1))
rig.animation_data.action = None
for pb in rig.pose.bones:
    pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0); pb.rotation_euler = (0, 0, 0)

bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True); mesh.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB', use_selection=True,
    export_animation_mode='NLA_TRACKS', export_anim_single_armature=True,
    export_image_format='AUTO', export_morph=False, export_cameras=False, export_lights=False,
    export_optimize_animation_size=True)
print('wrote', OUT, os.path.getsize(OUT))
