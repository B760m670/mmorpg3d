// Central tuning for the whole experience.
// Everything visual/physical that we iterate on lives here so the rest
// of the code stays structural. Day/night are presets of the same scene.

// Fjord terrain. The boat starts in open sea at z = 0 facing -Z; the fjord
// mouth opens at mouthZ and a meandering channel runs deep into the land.
export const TERRAIN = {
  minX: -1400, maxX: 1400,
  minZ: -5000, maxZ: 400,
  spacing: 8,          // world units between vertices (desktop)
  mouthZ: -250,        // where the land starts rising
  mouthRamp: 600,      // distance over which headlands grow to full height
  channelHalfWidth: 62,
  channelWidthVar: 35,
  meanderA: 160, meanderF: 0.0011,
  meanderB: 60, meanderG: 0.0029,
  wallWidth: 45,       // horizontal run of the cliff face (smaller = steeper)
  seabed: -40,
  cliffHeight: 230,
  plateauVar: 70,
  cragHeight: 85,
  mountainHeight: 260, // extra rise of the land further from the channel
};

export const OCEAN = {
  size: 2600,       // world units across the water plane
  segments: 400,    // vertex density (segments x segments)
};

// Gerstner wave set. One source of truth: the GLSL is generated from this
// (see world/waves.js) and the JS buoyancy sampler reads the same array,
// so the boat always floats on exactly the surface you see.
// dir: wave travel direction (xz). wavelength/amplitude in world units.
// steepness (0..1): crest sharpness. speed: phase-speed multiplier.
export const WAVES = [
  { dir: [1.0, 0.65], wavelength: 150, amplitude: 1.45, steepness: 0.55, speed: 0.9 },
  { dir: [-0.7, 1.0], wavelength: 86, amplitude: 0.85, steepness: 0.55, speed: 1.0 },
  { dir: [0.45, -1.0], wavelength: 52, amplitude: 0.42, steepness: 0.6, speed: 1.2 },
  { dir: [-1.0, -0.5], wavelength: 31, amplitude: 0.24, steepness: 0.7, speed: 1.45 },
];

// Visual presets. Colors are linear-ish sRGB triples (0..1).
export const PRESETS = {
  day: {
    label: 'day',
    exposure: 0.55,
    showSkyDome: true,
    envIntensity: 0.55,
    sky: { turbidity: 10, rayleigh: 1.3, mieCoefficient: 0.012, mieDirectionalG: 0.84, elevation: 17, azimuth: 118 },
    sun: { color: [1.0, 0.95, 0.86], intensity: 2.4 },
    ambient: { color: [0.7, 0.78, 0.84], intensity: 1.35 },
    fog: { color: [0.72, 0.78, 0.82], density: 0.00062 },
    water: {
      deep: [0.02, 0.05, 0.07],
      shallow: [0.1, 0.18, 0.2],
      horizon: [0.82, 0.86, 0.88],
      zenith: [0.55, 0.66, 0.74],
      foam: [0.95, 0.97, 0.98],
      specPower: 220,
      specStrength: 2.6,
    },
    bloom: { strength: 0.55, radius: 0.6, threshold: 0.75 },
  },
  night: {
    label: 'night',
    exposure: 0.42,
    // three's Sky is a daytime (Preetham) model and can't render night, so
    // night hides the dome and relies on a dark background + fog. A proper
    // moonlit/cloud night sky is a Phase-2 task.
    showSkyDome: false,
    envIntensity: 0.06,
    sky: { turbidity: 6, rayleigh: 0.9, mieCoefficient: 0.004, mieDirectionalG: 0.92, elevation: 11, azimuth: 165 },
    sun: { color: [0.55, 0.62, 0.8], intensity: 0.5 }, // "moon"
    ambient: { color: [0.18, 0.24, 0.35], intensity: 0.5 },
    fog: { color: [0.05, 0.07, 0.11], density: 0.0011 },
    water: {
      deep: [0.004, 0.008, 0.015],
      shallow: [0.02, 0.04, 0.06],
      horizon: [0.1, 0.13, 0.19],
      zenith: [0.02, 0.03, 0.06],
      foam: [0.22, 0.27, 0.34],
      specPower: 320,
      specStrength: 3.2,
    },
    bloom: { strength: 0.9, radius: 0.7, threshold: 0.55 },
  },
};

export const BOAT = {
  // Principal dimensions of the modelled vessel (23.95 m stern trawler).
  length: 23.95,
  beam: 9.2,
  maxSpeed: 11,        // m/s at full throttle (~21 kn; tuned for play)
  acceleration: 1.6,   // m/s^2 of thrust at full throttle
  turnRate: 0.35,      // rad/s at full rudder and speed
  heelFactor: 0.025,   // roll per (rad/s x m/s) in a turn
};

export const CAMERA = {
  distance: 44,
  height: 14,
  lookHeight: 5,
  damping: 2.2,
  fov: 55,
};
