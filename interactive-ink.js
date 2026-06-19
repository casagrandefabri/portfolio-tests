/* ============================================================================
 * InteractiveInkBackground
 * ----------------------------------------------------------------------------
 * A from-scratch, shader-based fluid (Navier–Stokes) ink effect on pure black.
 *
 * Behaviour contract:
 *   • Idle is PURE BLACK. No ambient motion, no idle injection, no residue.
 *   • Ink appears ONLY while the pointer is pressed (down).
 *   • Press = a soft splat. Drag = smooth liquid swirls following the pointer.
 *   • Press-and-hold (no movement) = subtle evolution around that point.
 *   • Release = injection stops immediately, ink dissipates fully back to black.
 *   • Fluid is contained by the viewport (reflective boundaries — invisible walls).
 *
 * Implementation: ping-pong framebuffers, advection, divergence, Jacobi
 * pressure solve, gradient subtraction, vorticity confinement, plus a bloom +
 * glossy-shading display pass for the premium "liquid ribbon" look.
 *
 * No dependencies. WebGL2 (with WebGL1 fallback). Vanilla — usable anywhere.
 *
 *   import InteractiveInkBackground from './interactive-ink.js'
 *   const ink = new InteractiveInkBackground({ palette: 'mixed' })
 *   // ... later: ink.destroy()
 *
 * The Navier–Stokes GPU structure follows the classic GPU Gems Ch.38 /
 * Pavel Dobryakov approach; the gating, palette, idle behaviour, lifecycle and
 * tuning here are purpose-built for this "press-to-reveal" interaction.
 * ==========================================================================*/

/* ─── DEFAULTS ──────────────────────────────────────────────────────────── */
const DEFAULTS = {
  intensity: 1.0,          // force + colour strength while pressing
  radius: 1.0,             // splat size multiplier (large + soft by default)
  dissipation: 1.0,        // dye fade strength (higher → returns to black faster)
  curl: 1.0,               // vorticity / swirl strength
  palette: 'mixed',        // 'violet' | 'amber' | 'mixed'
  className: '',
  container: null,         // defaults to document.body
  target: null,            // pointer-event target; defaults to window
  zIndex: 0,
  logo: null,              // optional fluid-displaced logo (see _initLogo)
};

/* Internal simulation constants (tuned for the premium look). ----------------*/
const SIM_RESOLUTION      = 128;    // velocity / pressure grid
const DYE_RESOLUTION      = 1024;   // colour grid (capped on small/low devices)
const BLOOM_RESOLUTION    = 256;
const PRESSURE_ITERATIONS = 20;
const PRESSURE_DECAY      = 0.8;
const BLOOM_ITERATIONS    = 8;
const BLOOM_THRESHOLD     = 0.22;
const BLOOM_SOFT_KNEE     = 0.7;
const BLOOM_INTENSITY     = 0.70;
const EXPOSURE            = 1.05;

const VELOCITY_DISSIPATION = 0.55;  // how fast motion settles (constant)
const DYE_DISSIPATION_BASE = 1.3;   // scaled by `dissipation` prop
const CURL_BASE            = 20.0;  // scaled by `curl` prop
const FORCE_BASE           = 6200.0;// drag velocity, scaled by `intensity`
const SPLAT_R2_BASE        = 0.0042;// Gaussian radius², scaled by `radius`
const COLOR_SCALE          = 0.18;  // per-splat dye brightness, scaled by intensity
const IDLE_FORCE           = 14.0;  // gentle swirl while pressed + still
const IDLE_COLOR_SCALE     = 0.05;  // tiny dye top-up while pressed + still
const SETTLE_MS            = 4200;  // keep simulating this long after last release

/* Premium dark palette. Restrained: violet / indigo / blue / magenta, with
 * amber used only as a rare highlight. Values are pre-bloom (kept low). ------*/
const PALETTES = {
  violet: [
    [0.45, 0.18, 0.62], // deep violet
    [0.30, 0.23, 0.78], // indigo
    [0.20, 0.32, 0.74], // blue
    [0.62, 0.16, 0.52], // muted magenta
  ],
  amber: [
    [0.95, 0.55, 0.16], // amber
    [0.82, 0.40, 0.12], // deep gold
    [0.62, 0.26, 0.12], // warm rust
    [0.92, 0.72, 0.28], // gold highlight
  ],
  // cool set first; last entry is the rare amber highlight
  mixed: [
    [0.45, 0.18, 0.62],
    [0.29, 0.24, 0.80],
    [0.62, 0.16, 0.52],
    [0.20, 0.34, 0.72],
    [0.94, 0.60, 0.20], // amber highlight (chosen ~16% of the time)
  ],
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function pickColor(palette) {
  const set = PALETTES[palette] || PALETTES.mixed;
  let c;
  if (palette === 'mixed') {
    c = Math.random() < 0.16 ? set[4] : set[Math.floor(Math.random() * 4)];
  } else {
    c = set[Math.floor(Math.random() * set.length)];
  }
  const j = 0.1; // small per-pick jitter so ribbons feel alive, not flat
  return [
    clamp01(c[0] * (1 + (Math.random() * 2 - 1) * j)),
    clamp01(c[1] * (1 + (Math.random() * 2 - 1) * j)),
    clamp01(c[2] * (1 + (Math.random() * 2 - 1) * j)),
  ];
}

/* ─── SHADERS ───────────────────────────────────────────────────────────── */
const baseVertexShader = `
  precision highp float;
  attribute vec2 aPosition;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform vec2 texelSize;
  void main () {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const clearShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float value;
  void main () { gl_FragColor = value * texture2D(uTexture, vUv); }
`;

const splatShader = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTarget;
  uniform float aspectRatio;
  uniform vec3 color;
  uniform vec2 point;
  uniform float radius;
  uniform float clampMax;   // ceiling so dye can't pile up into flat white
  void main () {
    vec2 p = vUv - point.xy;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    vec3 base = texture2D(uTarget, vUv).xyz;
    gl_FragColor = vec4(min(base + splat, vec3(clampMax)), 1.0);
  }
`;

const advectionShader = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform vec2 texelSize;
  uniform vec2 dyeTexelSize;
  uniform float dt;
  uniform float dissipation;

  vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
    vec2 st = uv / tsize - 0.5;
    vec2 iuv = floor(st);
    vec2 fuv = fract(st);
    vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
    vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
    vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
    vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
    return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
  }

  void main () {
  #ifdef MANUAL_FILTERING
    vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
    vec4 result = bilerp(uSource, coord, dyeTexelSize);
  #else
    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
    vec4 result = texture2D(uSource, coord);
  #endif
    float decay = 1.0 + dissipation * dt;
    gl_FragColor = result / decay;
  }
`;

const divergenceShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uVelocity, vL).x;
    float R = texture2D(uVelocity, vR).x;
    float T = texture2D(uVelocity, vT).y;
    float B = texture2D(uVelocity, vB).y;
    vec2 C = texture2D(uVelocity, vUv).xy;
    if (vL.x < 0.0) { L = -C.x; }   // invisible walls: reflect at boundaries
    if (vR.x > 1.0) { R = -C.x; }
    if (vT.y > 1.0) { T = -C.y; }
    if (vB.y < 0.0) { B = -C.y; }
    float div = 0.5 * (R - L + T - B);
    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
  }
`;

const curlShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uVelocity, vL).y;
    float R = texture2D(uVelocity, vR).y;
    float T = texture2D(uVelocity, vT).x;
    float B = texture2D(uVelocity, vB).x;
    float vorticity = R - L - T + B;
    gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
  }
`;

const vorticityShader = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uVelocity;
  uniform sampler2D uCurl;
  uniform float curl;
  uniform float dt;
  void main () {
    float L = texture2D(uCurl, vL).x;
    float R = texture2D(uCurl, vR).x;
    float T = texture2D(uCurl, vT).x;
    float B = texture2D(uCurl, vB).x;
    float C = texture2D(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity += force * dt;
    velocity = min(max(velocity, -1000.0), 1000.0);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;

const pressureShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    float divergence = texture2D(uDivergence, vUv).x;
    float pressure = (L + R + B + T - divergence) * 0.25;
    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
  }
`;

const gradientSubtractShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity.xy -= vec2(R - L, T - B);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;

const bloomPrefilterShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform vec3 curve;
  uniform float threshold;
  void main () {
    vec3 c = texture2D(uTexture, vUv).rgb;
    float br = max(c.r, max(c.g, c.b));
    float rq = clamp(br - curve.x, 0.0, curve.y);
    rq = curve.z * rq * rq;
    c *= max(rq, br - threshold) / max(br, 0.0001);
    gl_FragColor = vec4(c, 1.0);
  }
`;

const bloomBlurShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uTexture;
  void main () {
    vec4 sum = texture2D(uTexture, vL)
             + texture2D(uTexture, vR)
             + texture2D(uTexture, vT)
             + texture2D(uTexture, vB);
    gl_FragColor = sum * 0.25;
  }
`;

const displayShader = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uTexture;   // dye
  uniform sampler2D uBloom;
  uniform vec2 texelSize;
  uniform float uBloomIntensity;
  uniform float uExposure;

  float hash12 (vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // ACES filmic tonemap — rolls highlights off smoothly, keeping colour in
  // bright cores instead of clipping to flat white.
  vec3 aces (vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  void main () {
    vec3 c = texture2D(uTexture, vUv).rgb;

    // Treat dye intensity as a height field → surface normal, so ribbons read
    // as glossy liquid catching a soft light (not flat smoke).
    vec3 lc = texture2D(uTexture, vL).rgb;
    vec3 rc = texture2D(uTexture, vR).rgb;
    vec3 tc = texture2D(uTexture, vT).rgb;
    vec3 bc = texture2D(uTexture, vB).rgb;
    float dx = length(rc) - length(lc);
    float dy = length(tc) - length(bc);
    vec3 n = normalize(vec3(dx * 5.0, dy * 5.0, 1.0));

    vec3 L = normalize(vec3(-0.30, 0.45, 0.84));   // soft key light, upper-left
    float ambient = 0.78;
    float diffuse = ambient + (1.0 - ambient) * clamp(dot(n, L), 0.0, 1.0);
    c *= diffuse;

    // Glossy specular sheen along ribbon edges only (wet liquid highlight).
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float spec = pow(clamp(dot(n, H), 0.0, 1.0), 32.0);
    spec *= smoothstep(0.015, 0.18, length(c));    // only where there is ink
    c += spec * 0.28;

    // Soft luminous edges
    c += texture2D(uBloom, vUv).rgb * uBloomIntensity;

    // Exposure + filmic highlight roll-off (no pure-white clipping)
    c = aces(c * uExposure);

    // Dither to kill banding on the near-black gradients
    c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;

    gl_FragColor = vec4(c, 1.0);
  }
`;

/* Logo refraction pass — subtly warps the artwork using the LIVE fluid fields.
 *
 * ONE logo, one result. Per fragment we take the original sample and a
 * velocity-displaced sample of the SAME texture, then blend between them by a
 * localized ink mask:  out = mix(original, displaced, mask).
 *   • mask == 0 (no ink) → output is EXACTLY the original logo.
 *   • mask  > 0 (ink)    → smoothly interpolate toward the displaced sample.
 * The displacement itself also scales with the mask, so it fades to zero outside
 * ink and stays tiny inside it. There is never a full displaced layer drawn over
 * a full static layer — so no ghost / duplicate / offset outline. It reads as
 * refraction inside the single white logo. The artwork lives in a transparent-
 * padded texture and every sample UV is clamped to [0,1], so a displaced sample
 * near an edge reads transparent padding, not a CLAMP_TO_EDGE smear of the glyph
 * contour. Output is premultiplied → blend with (ONE, ONE_MINUS_SRC_ALPHA). ----*/
const logoShader = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uLogo;       // padded artwork (white, alpha = coverage)
  uniform sampler2D uVelocity;   // live fluid velocity field
  uniform sampler2D uDye;        // live ink density field
  uniform vec2 uResolution;      // viewport size in CSS px
  uniform vec4 uLogoRect;        // PADDED logo quad in CSS px: x, y, width, height
  uniform float uDispScale;      // velocity → px gain
  uniform float uMaxPx;          // displacement ceiling (px)
  void main () {
    // Fragment position in CSS px (y-down) → padded-logo UV.
    vec2 px  = vec2(vUv.x * uResolution.x, (1.0 - vUv.y) * uResolution.y);
    vec2 luv = (px - uLogoRect.xy) / uLogoRect.zw;
    if (luv.x < 0.0 || luv.x > 1.0 || luv.y < 0.0 || luv.y > 1.0) discard;

    // Localized ink mask (soft threshold) — tight to the actual ink influence.
    vec3 dye = texture2D(uDye, vUv).rgb;
    float amount = max(dye.r, max(dye.g, dye.b));
    float mask = smoothstep(0.06, 0.50, amount);

    // Original + velocity-displaced samples of the SAME texture. Displacement
    // scales with the mask, so it disappears outside ink and stays subtle inside.
    vec2 vel = texture2D(uVelocity, vUv).xy;
    vec2 dispPx = clamp(vel * uDispScale, -uMaxPx, uMaxPx) * mask;
    vec2 dispUV = vec2(dispPx.x, -dispPx.y) / uLogoRect.zw;
    vec4 orig = texture2D(uLogo, clamp(luv, 0.0, 1.0));
    vec4 disp = texture2D(uLogo, clamp(luv + dispUV, 0.0, 1.0));

    // Single composited result: blend original → displaced by the mask, in
    // premultiplied alpha. No second silhouette is ever drawn.
    vec4 origPM = vec4(orig.rgb * orig.a, orig.a);
    vec4 dispPM = vec4(disp.rgb * disp.a, disp.a);
    vec4 outPM  = mix(origPM, dispPM, mask);
    if (outPM.a < 0.004) discard;                    // keep ink visible in counters
    gl_FragColor = outPM;
  }
`;

/* ─── GL HELPERS ────────────────────────────────────────────────────────── */
function getWebGLContext(canvas) {
  const params = {
    alpha: false, depth: false, stencil: false,
    antialias: false, preserveDrawingBuffer: false, premultipliedAlpha: false,
  };
  let gl = canvas.getContext('webgl2', params);
  const isWebGL2 = !!gl;
  if (!isWebGL2) {
    gl = canvas.getContext('webgl', params) ||
         canvas.getContext('experimental-webgl', params);
  }
  if (!gl) return null;

  let halfFloat, supportLinearFiltering;
  if (isWebGL2) {
    gl.getExtension('EXT_color_buffer_float');
    supportLinearFiltering = gl.getExtension('OES_texture_float_linear') ||
                             gl.getExtension('OES_texture_half_float_linear');
  } else {
    halfFloat = gl.getExtension('OES_texture_half_float');
    supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
  }

  gl.clearColor(0.0, 0.0, 0.0, 1.0);
  const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT
    : (halfFloat && halfFloat.HALF_FLOAT_OES);

  let formatRGBA, formatRG, formatR;
  if (isWebGL2) {
    formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
    formatRG   = getSupportedFormat(gl, gl.RG16F,   gl.RG,   halfFloatTexType);
    formatR    = getSupportedFormat(gl, gl.R16F,    gl.RED,  halfFloatTexType);
  } else {
    formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    formatRG   = formatRGBA;
    formatR    = formatRGBA;
  }

  return {
    gl, isWebGL2,
    ext: { formatRGBA, formatRG, formatR, halfFloatTexType,
           supportLinearFiltering: !!supportLinearFiltering },
  };
}

function getSupportedFormat(gl, internalFormat, format, type) {
  if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
    switch (internalFormat) {
      case gl.R16F:  return getSupportedFormat(gl, gl.RG16F,   gl.RG,   type);
      case gl.RG16F: return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
      default:       return null;
    }
  }
  return { internalFormat, format };
}

function supportRenderTextureFormat(gl, internalFormat, format, type) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(texture);
  return status === gl.FRAMEBUFFER_COMPLETE;
}

function compileShader(gl, type, source, keywords) {
  let src = source;
  if (keywords) {
    let prefix = '';
    for (const k of keywords) prefix += '#define ' + k + '\n';
    src = prefix + source;
  }
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[InteractiveInk] shader compile error:', gl.getShaderInfoLog(shader));
  }
  return shader;
}

function createProgram(gl, vs, fs) {
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'aPosition');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[InteractiveInk] program link error:', gl.getProgramInfoLog(program));
  }
  return program;
}

function getUniforms(gl, program) {
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const name = gl.getActiveUniform(program, i).name;
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return uniforms;
}

/* ─── MAIN CLASS ────────────────────────────────────────────────────────── */
export class InteractiveInkBackground {
  constructor(options = {}) {
    this.opts = Object.assign({}, DEFAULTS, options);
    this.intensity   = this.opts.intensity;
    this.radius      = this.opts.radius;
    this.dissipation = this.opts.dissipation;
    this.curl        = this.opts.curl;
    this.palette     = this.opts.palette;

    this.container = this.opts.container || document.body;
    this.target    = this.opts.target || window;
    this.reduceMotion = typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.pointers = new Map(); // pointerId → pointer state
    this.running  = false;
    this.rafId    = null;
    this.lastTime = 0;
    this.lastInteraction = 0;
    this.destroyed = false;

    // ── optional fluid-displaced logo ──────────────────────────────────────
    this.logo = null;
    this.logoEnabled = false;     // capability + runtime watchdog gate
    this.logoActive  = false;     // currently compositing the GL logo?
    this.logoTexture = null;
    if (this.opts.logo && this.opts.logo.svg) {
      const L = this.opts.logo;
      this.logo = {
        svg: L.svg,
        aspect:          L.aspect          != null ? L.aspect          : 1302 / 99,
        minWidth:        L.minWidth        != null ? L.minWidth        : 280,
        maxWidth:        L.maxWidth        != null ? L.maxWidth        : 1302,
        vwFraction:      L.vwFraction      != null ? L.vwFraction      : 0.76,
        offsetY:         L.offsetY         != null ? L.offsetY         : 0,
        dispScale:       L.dispScale       != null ? L.dispScale       : 0.04,
        maxDisplacement: L.maxDisplacement != null ? L.maxDisplacement : 5,   // hard ceiling
        pad:             L.pad             != null ? L.pad             : 0.10, // transparent border (each side)
        onActive:        typeof L.onActive === 'function' ? L.onActive : null,
      };
    }
    // perf watchdog: drop the displaced logo (→ static fallback) if fps tanks
    this._rafIntervals = [];
    this._prevRaf = 0;
    this._logoWatchdogTripped = false;

    this._createCanvas();

    const ctx = getWebGLContext(this.canvas);
    if (!ctx) {
      // No WebGL at all → leave the (black) canvas in place, do nothing else.
      this.unsupported = true;
      this._notifyLogo(false);   // ensure the static SVG fallback stays visible
      return;
    }
    this.gl = ctx.gl;
    this.ext = ctx.ext;
    this.isWebGL2 = ctx.isWebGL2;

    // prefers-reduced-motion → static black, no simulation, no listeners.
    if (this.reduceMotion) {
      this._clearScreen();
      this._notifyLogo(false);   // keep the original static SVG, undistorted
      return;
    }

    this._initGL();
    this._bindEvents();
    this._clearScreen();   // guarantee a pure-black first frame, no idle loop
  }

  /* ── canvas + sizing ─────────────────────────────────────────────────── */
  _createCanvas() {
    const canvas = document.createElement('canvas');
    canvas.className = this.opts.className || '';
    Object.assign(canvas.style, {
      position: 'fixed',
      top: '0', left: '0',
      width: '100%', height: '100%',
      display: 'block',
      zIndex: String(this.opts.zIndex),
      pointerEvents: 'none',   // content underneath stays clickable
      background: '#000',
    });
    this.canvas = canvas;
    this.container.appendChild(canvas);
    this._resizeCanvas();
  }

  _resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap DPR at 2
    const w = Math.floor(this.container === document.body
      ? window.innerWidth  : this.container.clientWidth);
    const h = Math.floor(this.container === document.body
      ? window.innerHeight : this.container.clientHeight);
    const pw = Math.max(1, Math.floor(w * dpr));
    const ph = Math.max(1, Math.floor(h * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
      return true;
    }
    return false;
  }

  /* ── GL init ─────────────────────────────────────────────────────────── */
  _initGL() {
    const gl = this.gl;

    // Fullscreen quad
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    // Programs
    const vs = compileShader(gl, gl.VERTEX_SHADER, baseVertexShader);
    const manualFilter = this.ext.supportLinearFiltering ? undefined : ['MANUAL_FILTERING'];
    this.vs = vs;
    this.programs = {
      clear:       this._program(vs, clearShader),
      splat:       this._program(vs, splatShader),
      advection:   this._program(vs, advectionShader, manualFilter),
      divergence:  this._program(vs, divergenceShader),
      curl:        this._program(vs, curlShader),
      vorticity:   this._program(vs, vorticityShader),
      pressure:    this._program(vs, pressureShader),
      gradient:    this._program(vs, gradientSubtractShader),
      prefilter:   this._program(vs, bloomPrefilterShader),
      blur:        this._program(vs, bloomBlurShader),
      display:     this._program(vs, displayShader),
      logo:        this._program(vs, logoShader),
    };

    this._initFramebuffers();
    this._initLogo();
  }

  _program(vs, fsSource, keywords) {
    const gl = this.gl;
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource, keywords);
    const program = createProgram(gl, vs, fs);
    return { program, uniforms: getUniforms(gl, program) };
  }

  _getResolution(resolution) {
    const gl = this.gl;
    let aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1 / aspect;
    const min = Math.round(resolution);
    const max = Math.round(resolution * aspect);
    return gl.drawingBufferWidth > gl.drawingBufferHeight
      ? { width: max, height: min }
      : { width: min, height: max };
  }

  _createFBO(w, h, internalFormat, format, type, filter) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const texelSizeX = 1.0 / w;
    const texelSizeY = 1.0 / h;
    return {
      texture, fbo, width: w, height: h, texelSizeX, texelSizeY,
      attach(id) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
    };
  }

  _createDoubleFBO(w, h, internalFormat, format, type, filter) {
    let fbo1 = this._createFBO(w, h, internalFormat, format, type, filter);
    let fbo2 = this._createFBO(w, h, internalFormat, format, type, filter);
    return {
      width: w, height: h, texelSizeX: fbo1.texelSizeX, texelSizeY: fbo1.texelSizeY,
      get read() { return fbo1; },
      set read(v) { fbo1 = v; },
      get write() { return fbo2; },
      set write(v) { fbo2 = v; },
      swap() { const t = fbo1; fbo1 = fbo2; fbo2 = t; },
    };
  }

  _deleteFramebuffers() {
    const gl = this.gl;
    const delFBO = (f) => {
      if (!f) return;
      if (f.texture) gl.deleteTexture(f.texture);
      if (f.fbo) gl.deleteFramebuffer(f.fbo);
    };
    const delDouble = (d) => { if (d) { delFBO(d.read); delFBO(d.write); } };
    delDouble(this.dye); delDouble(this.velocity); delDouble(this.pressure);
    delFBO(this.divergence); delFBO(this.curlFBO); delFBO(this.bloom);
    if (this.bloomMips) this.bloomMips.forEach(delFBO);
  }

  _initFramebuffers() {
    const gl = this.gl;
    const ext = this.ext;

    this._deleteFramebuffers(); // free any previous set (resize) — no GPU leak

    // Cap dye resolution on small / DPR-limited screens for performance.
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    let dyeRes = DYE_RESOLUTION;
    if (Math.min(window.innerWidth, window.innerHeight) < 600) dyeRes = 512;
    dyeRes = Math.min(dyeRes, maxTex);

    const simRes   = this._getResolution(SIM_RESOLUTION);
    const dyeResXY = this._getResolution(dyeRes);
    const bloomRes = this._getResolution(BLOOM_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const rgba = ext.formatRGBA;
    const rg = ext.formatRG;
    const r = ext.formatR;
    const filter = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    this.texType = texType;

    this.dye = this._createDoubleFBO(dyeResXY.width, dyeResXY.height,
      rgba.internalFormat, rgba.format, texType, filter);
    this.velocity = this._createDoubleFBO(simRes.width, simRes.height,
      rg.internalFormat, rg.format, texType, filter);
    this.divergence = this._createFBO(simRes.width, simRes.height,
      r.internalFormat, r.format, texType, gl.NEAREST);
    this.curlFBO = this._createFBO(simRes.width, simRes.height,
      r.internalFormat, r.format, texType, gl.NEAREST);
    this.pressure = this._createDoubleFBO(simRes.width, simRes.height,
      r.internalFormat, r.format, texType, gl.NEAREST);

    // Bloom mip chain
    this.bloom = this._createFBO(bloomRes.width, bloomRes.height,
      rgba.internalFormat, rgba.format, texType, filter);
    this.bloomMips = [];
    for (let i = 0; i < BLOOM_ITERATIONS; i++) {
      const w = bloomRes.width  >> (i + 1);
      const h = bloomRes.height >> (i + 1);
      if (w < 2 || h < 2) break;
      this.bloomMips.push(this._createFBO(w, h, rgba.internalFormat, rgba.format, texType, filter));
    }
  }

  /* ── blit ────────────────────────────────────────────────────────────── */
  _blit(target, clear = false) {
    const gl = this.gl;
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    if (clear) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  _clearScreen() {
    const gl = this.gl;
    if (!gl) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /* ── fluid-displaced logo ────────────────────────────────────────────── */
  _notifyLogo(active) {
    this.logoActive = active;
    if (this.logo && this.logo.onActive) {
      try { this.logo.onActive(active); } catch (e) { /* host callback */ }
    }
  }

  // Capability gate for the GPU-displaced logo. Requires WebGL2 + linear-float
  // textures (needed for the fluid FBOs). Allows both fine-pointer (mouse) and
  // coarse-pointer (touch/stylus) — mobile is explicitly supported. Only blocks
  // genuinely tiny screens where the logo wouldn't be legible regardless.
  // Runtime performance is handled by the FPS watchdog in _watchLogoPerf().
  _logoCapable() {
    if (!this.logo || !this.isWebGL2 || !this.ext.supportLinearFiltering) return false;
    return Math.min(window.innerWidth, window.innerHeight) >= 320;
  }

  _initLogo() {
    if (!this._logoCapable()) { this.logoEnabled = false; this._notifyLogo(false); return; }
    this.logoEnabled = true;

    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const inner = 1 - 2 * this.logo.pad;               // fraction occupied by artwork

    // Texture = padded canvas; the artwork is drawn inset by `pad` on every side
    // so a displaced sample near an edge reads TRANSPARENT padding, never a
    // clamped glyph contour. Content is sized for crisp 1:1 at the displayed size.
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const rw = Math.min(2560, maxTex, Math.round((this.logo.maxWidth * dpr) / inner));
    const rh = Math.max(2, Math.round(rw / this.logo.aspect));
    const cw = Math.max(1, Math.round(rw * inner));     // content width
    const ch = Math.max(1, Math.round(rh * inner));     // content height
    const ox = Math.round((rw - cw) / 2);
    const oy = Math.round((rh - ch) / 2);

    // Force an explicit pixel size onto the SVG root so it rasterises sharply
    // and consistently across browsers (viewBox alone is unreliable here).
    const markup = this.logo.svg.replace(/<svg([^>]*?)>/i, (m, attrs) => {
      const cleaned = attrs.replace(/\s(width|height)="[^"]*"/gi, '');
      return `<svg${cleaned} width="${cw}" height="${ch}">`;
    });

    const img = new Image();
    img.decoding = 'async';
    this._logoImg = img;
    img.onload = () => {
      if (this.destroyed || !this.logoEnabled) return;
      try {
        const c = document.createElement('canvas');
        c.width = rw; c.height = rh;
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, rw, rh);                    // transparent padding
        ctx.drawImage(img, ox, oy, cw, ch);             // artwork inset

        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
        this.logoTexture = tex;

        this._notifyLogo(true);            // host hides its static DOM logo
        if (!this.running) this._drawIdleFrame();   // paint the static GL logo now
      } catch (e) {
        this.logoEnabled = false;
        this._notifyLogo(false);
      }
    };
    img.onerror = () => { this.logoEnabled = false; this._notifyLogo(false); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
  }

  // PADDED logo quad in CSS px. The VISIBLE logo mirrors the page's CSS layout
  // (clamp(minWidth, vwFraction·vw, maxWidth), centred, nudged by offsetY); we
  // then grow the quad by `pad` on every side so [0,1] maps to the padded
  // texture (the visible artwork sits in its inner [pad, 1-pad] region).
  _computeLogoRect() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const L = this.logo;
    let w = Math.min(Math.max(L.minWidth, vw * L.vwFraction), L.maxWidth);
    w = Math.min(w, vw * 0.94);
    const h = w / L.aspect;
    const inner = 1 - 2 * L.pad;
    const wp = w / inner, hp = h / inner;          // padded quad size
    const cx = vw / 2, cy = vh / 2 + L.offsetY;    // visible-logo centre
    return { vw, vh, w: wp, h: hp, left: cx - wp / 2, top: cy - hp / 2 };
  }

  _drawLogo() {
    if (!this.logo || !this.logoEnabled || !this.logoTexture) return;
    const gl = this.gl;
    const r = this._computeLogoRect();
    const prog = this.programs.logo;

    gl.useProgram(prog.program);
    if (prog.uniforms.texelSize) gl.uniform2f(prog.uniforms.texelSize, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.logoTexture);
    gl.uniform1i(prog.uniforms.uLogo, 0);
    gl.uniform1i(prog.uniforms.uVelocity, this.velocity.read.attach(1));
    gl.uniform1i(prog.uniforms.uDye, this.dye.read.attach(2));
    gl.uniform2f(prog.uniforms.uResolution, r.vw, r.vh);
    gl.uniform4f(prog.uniforms.uLogoRect, r.left, r.top, r.w, r.h);
    gl.uniform1f(prog.uniforms.uDispScale, this.logo.dispScale);
    gl.uniform1f(prog.uniforms.uMaxPx, this.logo.maxDisplacement);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // shader outputs premultiplied alpha
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.BLEND);
  }

  // Static composite used whenever the sim loop isn't running: pure black + the
  // (zero-displacement) logo, so the canvas still shows the mark at idle.
  _drawIdleFrame() {
    if (!this.gl) return;
    gl_bind_quad(this.gl, this.quadBuffer, this.indexBuffer);
    this._clearScreen();
    this._drawLogo();
  }

  /* ── events ──────────────────────────────────────────────────────────── */
  _bindEvents() {
    this._onDown   = this._handleDown.bind(this);
    this._onMove   = this._handleMove.bind(this);
    this._onUp     = this._handleUp.bind(this);
    this._onResize = this._handleResize.bind(this);
    this._onVisibility = this._handleVisibility.bind(this);
    this._onContextLost = (e) => { e.preventDefault(); this._stopLoop(); };

    const t = this.target;
    t.addEventListener('pointerdown', this._onDown, { passive: true });
    t.addEventListener('pointermove', this._onMove, { passive: true });
    window.addEventListener('pointerup', this._onUp, { passive: true });
    window.addEventListener('pointercancel', this._onUp, { passive: true });
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('orientationchange', this._onResize, { passive: true });
    document.addEventListener('visibilitychange', this._onVisibility);
    this.canvas.addEventListener('webglcontextlost', this._onContextLost, false);
  }

  _pointerCoords(e) {
    // Canvas is fixed/fullscreen → map against the viewport (or container).
    let w, h, x, y;
    if (this.container === document.body) {
      w = window.innerWidth; h = window.innerHeight;
      x = e.clientX; y = e.clientY;
    } else {
      const rect = this.container.getBoundingClientRect();
      w = rect.width; h = rect.height;
      x = e.clientX - rect.left; y = e.clientY - rect.top;
    }
    return { x: x / w, y: 1.0 - y / h }; // texture space, y-up
  }

  _handleDown(e) {
    const { x, y } = this._pointerCoords(e);
    const p = {
      id: e.pointerId, down: true,
      texcoordX: x, texcoordY: y, prevX: x, prevY: y,
      deltaX: 0, deltaY: 0, moved: false, hold: 0,
      seed: Math.random() * 6.283,
      color: pickColor(this.palette),
      firstSplat: true,
    };
    this.pointers.set(e.pointerId, p);
    this.lastInteraction = performance.now();
    this._startLoop();
  }

  _handleMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p || !p.down) return;
    const { x, y } = this._pointerCoords(e);
    p.prevX = p.texcoordX; p.prevY = p.texcoordY;
    p.texcoordX = x; p.texcoordY = y;
    p.deltaX = this._correctDeltaX(x - p.prevX);
    p.deltaY = this._correctDeltaY(y - p.prevY);
    if (Math.abs(p.deltaX) > 0 || Math.abs(p.deltaY) > 0) { p.moved = true; p.hold = 0; }
    this.lastInteraction = performance.now();
  }

  _handleUp(e) {
    // Injection stops immediately; existing dye keeps flowing & fading.
    this.pointers.delete(e.pointerId);
    this.lastInteraction = performance.now();
  }

  _correctDeltaX(d) {
    const aspect = this.canvas.width / this.canvas.height;
    return aspect < 1 ? d * aspect : d;
  }
  _correctDeltaY(d) {
    const aspect = this.canvas.width / this.canvas.height;
    return aspect > 1 ? d / aspect : d;
  }

  _handleResize() {
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      if (this.destroyed) return;
      if (this._resizeCanvas()) {
        this._initFramebuffers();
        this._clearScreen();
      }
      // Repaint the idle logo at the new size when not actively simulating.
      if (!this.running) this._drawIdleFrame();
    }, 120);
  }

  _handleVisibility() {
    if (document.hidden) {
      if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    } else if (this.running && this.rafId == null) {
      this.lastTime = performance.now();
      this.rafId = requestAnimationFrame(this._loop.bind(this));
    }
  }

  /* ── lifecycle of the render loop ────────────────────────────────────── */
  _startLoop() {
    if (this.running || this.unsupported || this.reduceMotion) return;
    this.running = true;
    this.lastTime = performance.now();
    if (this.rafId == null && !document.hidden) {
      this.rafId = requestAnimationFrame(this._loop.bind(this));
    }
  }

  _stopLoop() {
    this.running = false;
    this._prevRaf = 0;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    // Guarantee we settle back to pure black (no residue) and free the sim.
    if (this.gl && this.dye) {
      this._clearFBO(this.dye.read); this._clearFBO(this.dye.write);
      this._clearFBO(this.velocity.read); this._clearFBO(this.velocity.write);
      this._drawIdleFrame();   // pure black + the undistorted logo (if active)
    }
  }

  _clearFBO(fbo) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  _loop(now) {
    if (this.destroyed) return;
    this.rafId = requestAnimationFrame(this._loop.bind(this));
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (!(dt > 0)) dt = 0.016666;
    dt = Math.min(dt, 0.016666); // cap for stability after stalls

    this._watchLogoPerf(now);

    gl_bind_quad(this.gl, this.quadBuffer, this.indexBuffer);

    this._applyInputs(dt);
    this._step(dt);
    this._render();

    // Once released and fully settled, stop entirely → no idle work, pure black.
    if (this.pointers.size === 0 && (now - this.lastInteraction) > SETTLE_MS) {
      this._stopLoop();
    }
  }

  // If real frame intervals stay poor while the displaced logo is on, drop it
  // (reveal the static SVG) rather than letting the page run slow. Latches once.
  _watchLogoPerf(now) {
    if (!this.logoEnabled || this._logoWatchdogTripped) { this._prevRaf = now; return; }
    if (this._prevRaf) {
      this._rafIntervals.push(now - this._prevRaf);
      if (this._rafIntervals.length > 60) this._rafIntervals.shift();
      if (this._rafIntervals.length >= 50) {
        const avg = this._rafIntervals.reduce((a, b) => a + b, 0) / this._rafIntervals.length;
        if (avg > 24) {           // sustained < ~42fps → fall back
          this._logoWatchdogTripped = true;
          this.logoEnabled = false;
          this._notifyLogo(false);
        }
      }
    }
    this._prevRaf = now;
  }

  /* ── inject splats from pointer state (only while pressed) ───────────── */
  _applyInputs(dt) {
    this.pointers.forEach((p) => {
      if (!p.down) return;

      if (p.firstSplat) {
        // A soft blob appears at the press point, even without movement.
        p.firstSplat = false;
        this._splat(p.texcoordX, p.texcoordY, 0, 0, p.color, 1.0);
      }

      if (p.moved) {
        p.moved = false;
        this._splat(p.texcoordX, p.texcoordY,
          p.deltaX * FORCE_BASE * this.intensity,
          p.deltaY * FORCE_BASE * this.intensity,
          p.color, 1.0);
      } else {
        // Pressed and still → subtle evolution around the point.
        p.hold += dt;
        if (p.hold > 0.1) {
          const ang = p.hold * 1.7 + p.seed;
          const s = IDLE_FORCE * this.intensity;
          this._splat(p.texcoordX, p.texcoordY,
            Math.cos(ang) * s, Math.sin(ang) * s,
            p.color, IDLE_COLOR_SCALE / COLOR_SCALE * 0.9);
        }
      }
    });
  }

  _splat(x, y, dx, dy, color, colorMul) {
    const gl = this.gl;
    const r2 = SPLAT_R2_BASE * this.radius;

    // velocity
    let prog = this.programs.splat;
    gl.useProgram(prog.program);
    gl.uniform1i(prog.uniforms.uTarget, this.velocity.read.attach(0));
    gl.uniform1f(prog.uniforms.aspectRatio, this.canvas.width / this.canvas.height);
    gl.uniform2f(prog.uniforms.point, x, y);
    gl.uniform3f(prog.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(prog.uniforms.radius, r2);
    gl.uniform1f(prog.uniforms.clampMax, 1e9);   // velocity: effectively no clamp
    this._blit(this.velocity.write);
    this.velocity.swap();

    // dye
    const m = COLOR_SCALE * this.intensity * (colorMul == null ? 1 : colorMul);
    gl.uniform1i(prog.uniforms.uTarget, this.dye.read.attach(0));
    gl.uniform3f(prog.uniforms.color, color[0] * m, color[1] * m, color[2] * m);
    gl.uniform1f(prog.uniforms.clampMax, 1.8);   // dye ceiling → bright but coloured cores
    this._blit(this.dye.write);
    this.dye.swap();
  }

  /* ── one simulation step ─────────────────────────────────────────────── */
  _step(dt) {
    const gl = this.gl;
    const vel = this.velocity;
    gl.disable(gl.BLEND);

    // Curl
    let prog = this.programs.curl;
    gl.useProgram(prog.program);
    gl.uniform2f(prog.uniforms.texelSize, vel.texelSizeX, vel.texelSizeY);
    gl.uniform1i(prog.uniforms.uVelocity, vel.read.attach(0));
    this._blit(this.curlFBO);

    // Vorticity confinement
    prog = this.programs.vorticity;
    gl.useProgram(prog.program);
    gl.uniform2f(prog.uniforms.texelSize, vel.texelSizeX, vel.texelSizeY);
    gl.uniform1i(prog.uniforms.uVelocity, vel.read.attach(0));
    gl.uniform1i(prog.uniforms.uCurl, this.curlFBO.attach(1));
    gl.uniform1f(prog.uniforms.curl, CURL_BASE * this.curl);
    gl.uniform1f(prog.uniforms.dt, dt);
    this._blit(vel.write);
    vel.swap();

    // Divergence
    prog = this.programs.divergence;
    gl.useProgram(prog.program);
    gl.uniform2f(prog.uniforms.texelSize, vel.texelSizeX, vel.texelSizeY);
    gl.uniform1i(prog.uniforms.uVelocity, vel.read.attach(0));
    this._blit(this.divergence);

    // Decay pressure a touch, then Jacobi iterations
    prog = this.programs.clear;
    gl.useProgram(prog.program);
    gl.uniform1i(prog.uniforms.uTexture, this.pressure.read.attach(0));
    gl.uniform1f(prog.uniforms.value, PRESSURE_DECAY);
    this._blit(this.pressure.write);
    this.pressure.swap();

    prog = this.programs.pressure;
    gl.useProgram(prog.program);
    gl.uniform2f(prog.uniforms.texelSize, vel.texelSizeX, vel.texelSizeY);
    gl.uniform1i(prog.uniforms.uDivergence, this.divergence.attach(0));
    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(prog.uniforms.uPressure, this.pressure.read.attach(1));
      this._blit(this.pressure.write);
      this.pressure.swap();
    }

    // Subtract pressure gradient → divergence-free velocity
    prog = this.programs.gradient;
    gl.useProgram(prog.program);
    gl.uniform2f(prog.uniforms.texelSize, vel.texelSizeX, vel.texelSizeY);
    gl.uniform1i(prog.uniforms.uPressure, this.pressure.read.attach(0));
    gl.uniform1i(prog.uniforms.uVelocity, vel.read.attach(1));
    this._blit(vel.write);
    vel.swap();

    // Advect velocity
    prog = this.programs.advection;
    gl.useProgram(prog.program);
    gl.uniform2f(prog.uniforms.texelSize, vel.texelSizeX, vel.texelSizeY);
    if (prog.uniforms.dyeTexelSize)
      gl.uniform2f(prog.uniforms.dyeTexelSize, vel.texelSizeX, vel.texelSizeY);
    gl.uniform1i(prog.uniforms.uVelocity, vel.read.attach(0));
    gl.uniform1i(prog.uniforms.uSource, vel.read.attach(0));
    gl.uniform1f(prog.uniforms.dt, dt);
    gl.uniform1f(prog.uniforms.dissipation, VELOCITY_DISSIPATION);
    this._blit(vel.write);
    vel.swap();

    // Advect dye (with strong dissipation → returns to black)
    gl.uniform2f(prog.uniforms.texelSize, vel.texelSizeX, vel.texelSizeY);
    if (prog.uniforms.dyeTexelSize)
      gl.uniform2f(prog.uniforms.dyeTexelSize, this.dye.texelSizeX, this.dye.texelSizeY);
    gl.uniform1i(prog.uniforms.uVelocity, vel.read.attach(0));
    gl.uniform1i(prog.uniforms.uSource, this.dye.read.attach(1));
    gl.uniform1f(prog.uniforms.dissipation, DYE_DISSIPATION_BASE * this.dissipation);
    this._blit(this.dye.write);
    this.dye.swap();
  }

  /* ── render: bloom + display to screen ───────────────────────────────── */
  _render() {
    this._applyBloom(this.dye.read, this.bloom);

    const gl = this.gl;
    const prog = this.programs.display;
    gl.useProgram(prog.program);
    gl.uniform2f(prog.uniforms.texelSize, this.dye.texelSizeX, this.dye.texelSizeY);
    gl.uniform1i(prog.uniforms.uTexture, this.dye.read.attach(0));
    gl.uniform1i(prog.uniforms.uBloom, this.bloom.attach(1));
    gl.uniform1f(prog.uniforms.uBloomIntensity, BLOOM_INTENSITY);
    gl.uniform1f(prog.uniforms.uExposure, EXPOSURE);
    this._blit(null);

    // Composite the fluid-displaced logo over the rendered ink.
    this._drawLogo();
  }

  _applyBloom(source, destination) {
    const gl = this.gl;
    if (this.bloomMips.length < 2) return;

    gl.disable(gl.BLEND);

    // Prefilter (bright-pass with soft knee)
    let prog = this.programs.prefilter;
    gl.useProgram(prog.program);
    const knee = BLOOM_THRESHOLD * BLOOM_SOFT_KNEE + 0.0001;
    gl.uniform3f(prog.uniforms.curve, BLOOM_THRESHOLD - knee, knee * 2, 0.25 / knee);
    gl.uniform1f(prog.uniforms.threshold, BLOOM_THRESHOLD);
    gl.uniform1i(prog.uniforms.uTexture, source.attach(0));
    this._blit(destination);

    // Downsample
    prog = this.programs.blur;
    gl.useProgram(prog.program);
    let last = destination;
    for (let i = 0; i < this.bloomMips.length; i++) {
      const dest = this.bloomMips[i];
      gl.uniform2f(prog.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
      gl.uniform1i(prog.uniforms.uTexture, last.attach(0));
      this._blit(dest);
      last = dest;
    }

    // Upsample (additive)
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);
    for (let i = this.bloomMips.length - 2; i >= 0; i--) {
      const base = this.bloomMips[i];
      gl.uniform2f(prog.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
      gl.uniform1i(prog.uniforms.uTexture, last.attach(0));
      this._blit(base);
      last = base;
    }
    gl.disable(gl.BLEND);

    gl.uniform2f(prog.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
    gl.uniform1i(prog.uniforms.uTexture, last.attach(0));
    this._blit(destination);
  }

  /* ── public runtime setters ──────────────────────────────────────────── */
  set(options = {}) {
    if (options.intensity   != null) this.intensity   = options.intensity;
    if (options.radius      != null) this.radius      = options.radius;
    if (options.dissipation != null) this.dissipation = options.dissipation;
    if (options.curl        != null) this.curl        = options.curl;
    if (options.palette     != null) this.palette     = options.palette;
  }

  /* ── teardown ────────────────────────────────────────────────────────── */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this._resizeTimer) clearTimeout(this._resizeTimer);

    if (!this.reduceMotion && !this.unsupported) {
      const t = this.target;
      t.removeEventListener('pointerdown', this._onDown);
      t.removeEventListener('pointermove', this._onMove);
      window.removeEventListener('pointerup', this._onUp);
      window.removeEventListener('pointercancel', this._onUp);
      window.removeEventListener('resize', this._onResize);
      window.removeEventListener('orientationchange', this._onResize);
      document.removeEventListener('visibilitychange', this._onVisibility);
      this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    }

    // Release GPU resources.
    const gl = this.gl;
    if (gl) {
      if (this.logoTexture) { gl.deleteTexture(this.logoTexture); this.logoTexture = null; }
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
    if (this._logoImg) { this._logoImg.onload = this._logoImg.onerror = null; this._logoImg = null; }
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    this.pointers.clear();
  }
}

/* Bind the shared quad before each frame's draws. */
function gl_bind_quad(gl, quadBuffer, indexBuffer) {
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);
}

if (typeof window !== 'undefined') {
  window.InteractiveInkBackground = InteractiveInkBackground;
}

export default InteractiveInkBackground;
