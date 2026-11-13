// Optical constants of the water and the GLSL that applies them; kept free
// of imports so the terrain, the ocean and the underwater effects can all use
// it. See Underwater.js for what they do.

export const WATER = {
  K: [0.4, 0.065, 0.085],      // diffuse attenuation per metre, r g b
  fog: 0.055,                  // exp2 density for the view (about 25-30 m)
  colour: [0.1, 0.3, 0.3],     // light scattered by the water near the surface, noon,
                               // before the depth grade takes the colours out
  temp: 7,                     // deg C, November (coastal current)
};

// GLSL: how much of the daylight is left at a point under water, as the
// camera sees it. Uses the shared terrain uniforms (uTide, uCamUnder,
// uCamDepth). y is the world height of the surface point.
export const WATER_TINT_GLSL = /* glsl */ `
  uniform float uCamUnder;
  uniform float uCamDepth;
  vec3 waterTint(float y) {
    float d = uTide - y;
    if (d <= 0.0) return vec3(1.0);
    const vec3 K = vec3(${WATER.K.map((k) => k.toFixed(3)).join(', ')});
    // camera above: down to the point and up again to the surface (the grey
    // part of the way up is the surface's own transparency)
    if (uCamUnder < 0.5) return exp(-K * d - (K - vec3(0.07)) * d * 1.15);
    // camera below: only the extra depth below the camera here; the rest is
    // the screen grade and the fog
    return exp(-K * max(0.0, d - uCamDepth));
  }
`;

