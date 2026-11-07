// Central tuning for the whole experience.
// Everything visual/physical that we iterate on lives here so the rest
// of the code stays structural. Day/night are presets of the same scene.

// Terrain: the real Reine area of Lofoten, see world/Terrain.js and
// tools/build_terrain.py. The boat starts in open water south-east of Reine.


// Sea states (see world/OceanSpectrum.js). The wind sea follows the JONSWAP
// fetch-limited relations from wind speed (m/s) and fetch (m); the swell is
// given by significant height (m) and peak period (s). Beaufort numbers and
// heights are what you would expect in the open sea; inside the fjord the
// long waves are sheltered.
// Weather: each state sets the sea (index into SEA.states), cloud cover and
// darkness, rain, fog (density multiplier), sunlight (multiplier), wind (m/s)
// and lightning. See world/Weather.js.
export const WEATHER = {
  initial: 1,
  transition: 12,          // seconds for a front to come through
  states: [
    { name: 'clear', sea: 0, clouds: 0.2, dark: 0.0, rain: 0, fog: 0.85, sun: 1.0, wind: 3.5, lightning: 0 },
    { name: 'fair', sea: 1, clouds: 0.5, dark: 0.06, rain: 0, fog: 1.4, sun: 0.95, wind: 7.5, lightning: 0 },
    { name: 'overcast, showers', sea: 2, clouds: 0.93, dark: 0.5, rain: 0.35, fog: 3.2, sun: 0.28, wind: 12.5, lightning: 0 },
    { name: 'storm', sea: 3, clouds: 1.0, dark: 0.82, rain: 1.0, fog: 7.0, sun: 0.1, wind: 19, lightning: 1 },
  ],
};

export const SEA = {
  windDir: [0.3, -1.0],     // direction the wind sea travels (x, z); -z is north
  swellDir: [0.62, -0.78],
  initial: 1,
  transition: 9,           // seconds for the sea to build or calm down
  states: [
    { name: 'calm', bft: 2, wind: 3.5, fetch: 20000, swell: { hs: 0.6, tp: 11 }, chop: 0.75, foamBias: 0.3 },
    { name: 'moderate', bft: 4, wind: 7.5, fetch: 60000, swell: { hs: 0.8, tp: 10 }, chop: 0.9, foamBias: 0.7 },
    { name: 'rough', bft: 6, wind: 12.5, fetch: 150000, swell: { hs: 1.1, tp: 12 }, chop: 1.0, foamBias: 0.8 },
    { name: 'storm', bft: 8, wind: 19, fetch: 300000, swell: { hs: 1.6, tp: 13 }, chop: 1.05, foamBias: 0.87 },
  ],
};

// Visual presets. Colors are linear-ish sRGB triples (0..1).
export const PRESETS = {
  day: {
    label: 'day',
    exposure: 0.55,
    showSkyDome: true,
    envIntensity: 0.55,
    sky: { turbidity: 10, rayleigh: 1.3, mieCoefficient: 0.012, mieDirectionalG: 0.84, elevation: 17, azimuth: 118 },
    sun: { color: [1.0, 0.95, 0.86], intensity: 2.4 },
    ambient: { color: [0.7, 0.78, 0.84], intensity: 1.05 },
    fog: { color: [0.72, 0.78, 0.82], density: 0.00016 },   // clear: the Lofoten wall stands 15-20 km off
    water: {
      deep: [0.02, 0.05, 0.07],
      shallow: [0.1, 0.18, 0.2],
      horizon: [0.82, 0.86, 0.88],
      zenith: [0.55, 0.66, 0.74],
      foam: [0.95, 0.97, 0.98],
      specPower: 220,
      specStrength: 2.6,
    },
    bloom: { strength: 0.4, radius: 0.55, threshold: 0.93 },
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
    fog: { color: [0.05, 0.07, 0.11], density: 0.00034 },
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
  // Principal dimensions of the modelled vessel (Macduff 23.95 m stern trawler).
  length: 23.95,
  beam: 9.2,
  rideHeight: 0.35,      // model lift above the design waterline (light ship)

  // Propulsion & resistance. Data sheet: 1500 hp, 2.7 m propeller in nozzle,
  // 20 t bollard pull. Mass ~ displacement (~410 t) plus surge added mass.
  mass: 450000,          // kg
  bollardPull: 196000,   // N (20 t)
  maxSpeed: 6.2,         // m/s at full ahead (~12 kn)
  asternEfficiency: 0.55,
  rpmMax: 1200,          // engine rpm at full
  rpmLag: 2.2,           // s, engine response to a telegraph order

  // Steering: rudder limits per SOLAS (35 deg, ~2.5 deg/s steering gear),
  // first-order Nomoto yaw model tuned for a ~100 m turning circle at 12 kn.
  rudderMax: 35,         // deg
  rudderRate: 2.5,       // deg/s
  wheelRate: 14,         // deg/s the helmsman winds the wheel order
  yawGain: 0.1,          // rad/s per rad of rudder at refSpeed
  yawTime: 7,            // s
  refSpeed: 6,           // m/s
  heelFactor: 0.18,      // heel (rad) per (m/s x rad/s) in a turn
  // Natural frequencies (rad/s) and damping ratios of the ship's motions:
  // roll period ~8 s, pitch ~5 s, heave ~5.5 s for a 24 m trawler.
  seakeeping: { rollW: 0.785, rollZeta: 0.12, pitchW: 1.25, pitchZeta: 0.45, heaveW: 1.15, heaveZeta: 0.55 },

  // Where the helmsman stands on the bridge (model space: x, y up, z aft).
  helm: [0, 5.4, -4.75],
  bridgeSpawn: [0, 5.4, -2.2],
};

// Engine-order telegraph, astern to ahead.
export const TELEGRAPH = [
  { name: 'FULL ASTERN', power: -1.0 },
  { name: 'HALF ASTERN', power: -0.6 },
  { name: 'SLOW ASTERN', power: -0.35 },
  { name: 'STOP', power: 0 },
  { name: 'DEAD SLOW AHEAD', power: 0.2 },
  { name: 'SLOW AHEAD', power: 0.4 },
  { name: 'HALF AHEAD', power: 0.7 },
  { name: 'FULL AHEAD', power: 1.0 },
];

export const PLAYER = {
  eyeHeight: 1.65,
  radius: 0.3,
  walkSpeed: 1.4,        // m/s
  runSpeed: 2.8,
  stepHeight: 0.45,
  lookSensitivity: 0.0022,
};

export const CAMERA = {
  distance: 34,
  height: 9,
  lookHeight: 5.5,
  damping: 2.2,
  fov: 55,
};
