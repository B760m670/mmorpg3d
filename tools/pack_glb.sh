#!/bin/sh
# Pack a glTF from Blender for the page: roughness maps to 1024 px, geometry
# quantized (KHR_mesh_quantization, read by three.js as it is), then gzip.
# The game gunzips it with fflate: no WebAssembly decoder, which the page's
# host might not allow.
#   tools/pack_glb.sh in.glb out.glb.gz
set -e
npx -y @gltf-transform/cli@4.5.1 resize "$1" /tmp/pack_tmp.glb --width 1024 --height 1024 --pattern "*rough*"
npx -y @gltf-transform/cli@4.5.1 quantize /tmp/pack_tmp.glb /tmp/pack_q.glb
gzip -9 -c /tmp/pack_q.glb > "$2"
rm -f /tmp/pack_tmp.glb /tmp/pack_q.glb
