import * as THREE from 'three';

// GPU side of the ocean: every frame, for each cascade,
//   1. advance the spectrum in time (deep-water dispersion w = sqrt(g k))
//      and form the spectra of displacement and its derivatives;
//   2. inverse 2D FFT (Stockham radix-2, ping-pong render targets), two
//      complex fields per RGBA texture, 4 complex = 8 real fields in total;
//   3. assemble a displacement map (dx, dy, dz, foam) and a derivative map
//      (dy/dx, dy/dz, dx/dx, dz/dz) with mipmaps for the water shader.
// Foam is the folding of the surface (Jacobian of the horizontal
// displacement < threshold) accumulated over time and decaying, so breaking
// crests leave whitewater behind them.

const QUAD_VERT = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const COMMON = /* glsl */ `
  precision highp float;
  vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
`;

const TIME_FRAG = /* glsl */ `
  ${COMMON}
  uniform sampler2D uH0a;
  uniform sampler2D uH0b;
  uniform float uMix;
  uniform float uT;
  uniform float uL;
  uniform float uN;
  uniform float uWhich;
  void main() {
    vec2 id = gl_FragCoord.xy - 0.5;
    vec2 n = vec2(id.x < uN * 0.5 ? id.x : id.x - uN, id.y < uN * 0.5 ? id.y : id.y - uN);
    vec2 k = n * 6.283185307 / uL;
    float kl = max(length(k), 1e-6);
    float w = sqrt(9.81 * kl);
    vec2 uv = (id + 0.5) / uN;
    vec4 h0 = mix(texture2D(uH0a, uv), texture2D(uH0b, uv), uMix);
    float ph = mod(w * uT, 6.283185307);
    vec2 e = vec2(cos(ph), sin(ph));
    vec2 h = cmul(h0.xy, e) + cmul(h0.zw, vec2(e.x, -e.y));
    vec2 ih = vec2(-h.y, h.x);
    vec2 dx = -ih * (k.x / kl);
    vec2 dz = -ih * (k.y / kl);
    vec2 dydx = ih * k.x;
    vec2 dydz = ih * k.y;
    vec2 dxdx = -h * (k.x * k.x / kl);
    vec2 dzdz = -h * (k.y * k.y / kl);
    vec2 dxdz = -h * (k.x * k.y / kl);
    // two real fields per complex signal: f + i g
    vec2 A = dx + vec2(-h.y, h.x);
    vec2 B = dz + vec2(-dxdz.y, dxdz.x);
    vec2 C = dydx + vec2(-dydz.y, dydz.x);
    vec2 D = dxdx + vec2(-dzdz.y, dzdz.x);
    gl_FragColor = uWhich < 0.5 ? vec4(A, B) : vec4(C, D);
  }
`;

const FFT_FRAG = /* glsl */ `
  ${COMMON}
  uniform sampler2D uInput;
  uniform float uN;
  uniform float uSub;
  uniform float uHorizontal;
  void main() {
    vec2 id = gl_FragCoord.xy - 0.5;
    float index = uHorizontal > 0.5 ? id.x : id.y;
    float hs = uSub * 0.5;
    float ev = floor(index / uSub) * hs + mod(index, hs);
    vec2 ea, oa;
    if (uHorizontal > 0.5) {
      ea = vec2(ev, id.y);
      oa = vec2(ev + uN * 0.5, id.y);
    } else {
      ea = vec2(id.x, ev);
      oa = vec2(id.x, ev + uN * 0.5);
    }
    vec4 even = texture2D(uInput, (ea + 0.5) / uN);
    vec4 odd = texture2D(uInput, (oa + 0.5) / uN);
    float a = 6.283185307 * index / uSub;
    vec2 tw = vec2(cos(a), sin(a));
    gl_FragColor = vec4(even.xy + cmul(tw, odd.xy), even.zw + cmul(tw, odd.zw));
  }
`;

const DISP_FRAG = /* glsl */ `
  ${COMMON}
  uniform sampler2D uP;
  uniform sampler2D uQ;
  uniform sampler2D uPrev;
  uniform float uN;
  uniform float uLambda;
  uniform float uDecay;
  uniform float uBias;
  uniform float uGain;
  void main() {
    vec2 uv = gl_FragCoord.xy / uN;
    vec4 p = texture2D(uP, uv);
    vec4 q = texture2D(uQ, uv);
    float jac = (1.0 + uLambda * q.z) * (1.0 + uLambda * q.w) - uLambda * uLambda * p.w * p.w;
    float foam = texture2D(uPrev, uv).w * uDecay;
    foam = max(foam, clamp((uBias - jac) * uGain, 0.0, 1.0));
    gl_FragColor = vec4(p.x * uLambda, p.y, p.z * uLambda, foam);
  }
`;

const COPY_FRAG = /* glsl */ `
  ${COMMON}
  uniform sampler2D uQ;
  uniform float uN;
  void main() { gl_FragColor = texture2D(uQ, gl_FragCoord.xy / uN); }
`;

export class OceanFFT {
  constructor(renderer, cascades) {
    this.renderer = renderer;
    this.cascades = cascades;
    const canFloat = renderer.extensions.has('EXT_color_buffer_float');
    const fftType = canFloat ? THREE.FloatType : THREE.HalfFloatType;
    const rt = (n, type, mips) => new THREE.WebGLRenderTarget(n, n, {
      type,
      format: THREE.RGBAFormat,
      minFilter: mips ? THREE.LinearMipmapLinearFilter : type === fftType && !mips ? THREE.NearestFilter : THREE.LinearFilter,
      magFilter: mips ? THREE.LinearFilter : THREE.NearestFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      generateMipmaps: mips,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.c = cascades.map((c) => ({
      N: c.N,
      L: c.L,
      stages: Math.log2(c.N),
      fft: [[rt(c.N, fftType, false), rt(c.N, fftType, false)], [rt(c.N, fftType, false), rt(c.N, fftType, false)]],
      disp: [rt(c.N, THREE.HalfFloatType, true), rt(c.N, THREE.HalfFloatType, true)],
      deriv: rt(c.N, THREE.HalfFloatType, true),
      cur: 0,
      h0a: null,
      h0b: null,
    }));

    const mat = (frag, uniforms) => new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
    });
    this.timeMat = mat(TIME_FRAG, {
      uH0a: { value: null }, uH0b: { value: null }, uMix: { value: 0 }, uT: { value: 0 },
      uL: { value: 1 }, uN: { value: 1 }, uWhich: { value: 0 },
    });
    this.fftMat = mat(FFT_FRAG, { uInput: { value: null }, uN: { value: 1 }, uSub: { value: 2 }, uHorizontal: { value: 1 } });
    this.dispMat = mat(DISP_FRAG, {
      uP: { value: null }, uQ: { value: null }, uPrev: { value: null }, uN: { value: 1 },
      uLambda: { value: 1 }, uDecay: { value: 0.98 }, uBias: { value: 0.5 }, uGain: { value: 2 },
    });
    this.copyMat = mat(COPY_FRAG, { uQ: { value: null }, uN: { value: 1 } });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.timeMat);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.mix = 0;
    this.lambda = 1;
    this.foam = { bias: 0.5, gain: 2, decayPerSec: 0.5 };
  }

  makeH0Texture(data, n) {
    const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  }

  // Blend from spectrum set a to set b with this.mix (0..1).
  setSpectra(a, b) {
    this.c.forEach((c, i) => {
      if (c.h0a) c.h0a.dispose();
      if (c.h0b && c.h0b !== c.h0a) c.h0b.dispose();
      c.h0a = this.makeH0Texture(a[i], c.N);
      c.h0b = a[i] === b[i] ? c.h0a : this.makeH0Texture(b[i], c.N);
    });
  }

  pass(material, target) {
    this.quad.material = material;
    material.uniformsNeedUpdate = true;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  update(time, dt) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    const decay = Math.exp(-this.foam.decayPerSec * dt);
    for (const c of this.c) {
      if (!c.h0a) continue;
      // 1. spectrum at time t, two packed textures
      const tu = this.timeMat.uniforms;
      tu.uH0a.value = c.h0a; tu.uH0b.value = c.h0b; tu.uMix.value = this.mix;
      tu.uT.value = time; tu.uL.value = c.L; tu.uN.value = c.N;
      const out = [];
      for (let which = 0; which < 2; which++) {
        tu.uWhich.value = which;
        this.pass(this.timeMat, c.fft[which][0]);
        // 2. inverse FFT, rows then columns
        let src = 0;
        const fu = this.fftMat.uniforms;
        fu.uN.value = c.N;
        for (let dir = 1; dir >= 0; dir--) {
          fu.uHorizontal.value = dir;
          for (let s = 0; s < c.stages; s++) {
            fu.uInput.value = c.fft[which][src].texture;
            fu.uSub.value = 2 ** (s + 1);
            this.pass(this.fftMat, c.fft[which][1 - src]);
            src = 1 - src;
          }
        }
        out.push(c.fft[which][src].texture);
      }
      // 3. displacement + foam (ping-pong for foam memory), derivatives
      const next = 1 - c.cur;
      const du = this.dispMat.uniforms;
      du.uP.value = out[0]; du.uQ.value = out[1]; du.uPrev.value = c.disp[c.cur].texture;
      du.uN.value = c.N; du.uLambda.value = this.lambda; du.uDecay.value = decay;
      du.uBias.value = this.foam.bias; du.uGain.value = this.foam.gain;
      this.pass(this.dispMat, c.disp[next]);
      c.cur = next;
      this.copyMat.uniforms.uQ.value = out[1];
      this.copyMat.uniforms.uN.value = c.N;
      this.pass(this.copyMat, c.deriv);
    }
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
  }

  disp(i) { return this.c[i].disp[this.c[i].cur].texture; }
  deriv(i) { return this.c[i].deriv.texture; }
}
