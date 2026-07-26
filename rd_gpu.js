/**
 * rd_gpu.js -- WebGL2 port of the reaction-diffusion page background.
 *
 * Replaces the CPU hot loops in rd_common.js / rd_background.js with GPU passes.
 * The CPU path is kept intact as the fallback: if WebGL2 or float render targets
 * are unavailable (or the context is lost later), this module bows out and
 * rd_background.js runs exactly as it did in v50.
 *
 * Contract with rd_background.js:
 *   - This file MUST be loaded before rd_background.js.
 *   - On success it sets window.__RD_GPU_ACTIVE = true; rd_background.js then
 *     skips its own self-init but still exposes window.RDBackground.init().
 *   - On failure it leaves the flag false and hands the canvas back clean.
 *
 * What is preserved from the CPU version (the look):
 *   - Same Gray-Scott regime (F=0.027, k=0.055, Du=1.0, Dv=0.47) and the same
 *     grid sizing (pixelDiv 11, simBounds [88,165,60,110], maxDpr 1.5), so
 *     corridor width in screen pixels is unchanged.
 *   - Same OU-correlated stochastic forcing, same rare-nucleation kicks, same
 *     aspect-corrected pointer pulse.
 *   - Same render: one separable 1-2-1 blur on V, colorize at SIM resolution
 *     (not screen resolution -- that is what keeps the contours soft and
 *     faceted rather than razor-crisp), then bilinear upscale at 0.84 alpha
 *     over the drawSoftBase gradient + drifting blobs.
 *
 * What necessarily differs:
 *   - The specific labyrinth pattern. Gray-Scott is chaotic and the CPU version
 *     draws from a *sequential* seeded RNG in scan order, which cannot be
 *     reproduced by parallel fragments. Per-cell randomness here is hash-based.
 *     Same handwriting, different sentence.
 *
 * Implementation notes:
 *   - State is stored as (a, v) where a = 1 - U, NOT (U, V). In quiescent
 *     regions U ~ 1 and the F*(1-U) term is ~2.7e-5, which is below half-float
 *     resolution near 1.0 -- the classic cause of GPU Gray-Scott stalling into
 *     banding. Storing 1-U keeps those values near zero where float precision is
 *     densest, and makes the RG16F fallback safe on weak mobile GPUs.
 *     The Laplacian is zero-sum, so lap(1-U) = -lap(U) and the update becomes
 *       a' = a + Du*lap(a) + (1-a)*v*v - F*a
 *     which is algebraically identical to the CPU form.
 *   - Sim-space rows use the CPU convention (row 0 = top of screen) wherever
 *     screen orientation is observable (ribbon seed, pointer pulse). Everything
 *     else is orientation-agnostic.
 *   - Sim/blur textures wrap REPEAT to reproduce the CPU's wraparound neighbor
 *     tables for free. The colorized field wraps CLAMP_TO_EDGE to match what
 *     canvas drawImage() does at the borders.
 */
(function () {
  "use strict";

  // ---- Config. Mirrors rd_background.js + rd_common.js. ---------------------
  var MAX_DPR = 1.5;
  var PIXEL_DIV = 11;
  var SIM_BOUNDS = [88, 165, 60, 110];      // [minW, maxW, minH, maxH]
  var REBUILD_HEIGHT_THRESHOLD = 10;        // sim rows; mobile URL-bar hysteresis

  var DU = 1.0, DV = 0.47;
  var FEED = 0.027, KILL = 0.055;
  var NOISE_AMP = 0.20;
  var OU_DECAY = 0.9996;
  var OU_KICK = Math.sqrt(1 - OU_DECAY * OU_DECAY);
  var SIGMA_V = 0.00035 * NOISE_AMP;
  var SIGMA_F = 0.00011 * NOISE_AMP;
  var KICK_PROB = 0.00035 * NOISE_AMP;
  var KICK_MAG = 0.022;

  var WARMUP_TOTAL = 980;
  var WARMUP_PER_FRAME = 24;                // ~0.7s visible settle-in, as in v50

  // v50 ran "1 step if dt > 30ms else 2", which tied sim speed to refresh rate:
  // a 120Hz display drifted 2x faster than 60Hz, and a struggling 30fps phone
  // ran 4x slower than desktop. Fixed timestep at v50's 60Hz rate (2 x 60).
  var STEPS_PER_SEC = 120;
  var MAX_STEPS_PER_FRAME = 4;              // anti spiral-of-death after a stall

  // globalAlpha 0.84 x the per-pixel alpha 228/255 baked into paintField().
  var FIELD_ALPHA = 0.84 * (228 / 255);

  // Same six seed ribbons as DEFAULT_RIBBONS in rd_common.js.
  var RIBBONS_GLSL =
    "const vec4 RIB[6] = vec4[6](" +
    "vec4(0.10,0.18,0.46,0.22),vec4(0.38,0.18,0.76,0.31)," +
    "vec4(0.15,0.45,0.55,0.53),vec4(0.54,0.50,0.90,0.43)," +
    "vec4(0.18,0.77,0.58,0.68),vec4(0.56,0.77,0.88,0.82));\n" +
    "const float RIBW[6] = float[6](0.045,0.042,0.050,0.044,0.048,0.044);\n";

  // ---- Shader sources ------------------------------------------------------

  // Fullscreen triangle from gl_VertexID -- no vertex buffer needed.
  var VERT =
    "#version 300 es\n" +
    "void main(){\n" +
    "  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n" +
    "  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\n" +
    "}\n";

  var HEAD =
    "#version 300 es\n" +
    "precision highp float;\n" +
    "precision highp int;\n" +
    "precision highp sampler2D;\n";

  // Hash-based per-cell randomness. Replaces the CPU's sequential mulberry32,
  // which is inherently serial. randn() mirrors BgUtils.randn (Box-Muller).
  var RAND =
    "uint uhash(uint x){\n" +
    "  x ^= x >> 16; x *= 0x7feb352du;\n" +
    "  x ^= x >> 15; x *= 0x846ca68bu;\n" +
    "  x ^= x >> 16; return x;\n" +
    "}\n" +
    "float hrand(uvec3 p){\n" +
    "  uint h = uhash(p.x ^ uhash(p.y ^ uhash(p.z ^ 0x9e3779b9u)));\n" +
    "  return float(h) * (1.0 / 4294967296.0);\n" +
    "}\n" +
    "float hrandn(uvec3 p){\n" +
    "  float a = max(hrand(p), 1e-8);\n" +
    "  float b = max(hrand(p + uvec3(0u, 0u, 0x51ed270bu)), 1e-8);\n" +
    "  return sqrt(-2.0 * log(a)) * cos(6.283185307179586 * b);\n" +
    "}\n";

  // Seed: the same ribbon field + interference wave + jitter as rd_common.seed().
  var FS_SEED = HEAD + RAND + RIBBONS_GLSL +
    "uniform vec2 uSim;\n" +
    "out vec4 outColor;\n" +
    "float distToSegment(vec2 p, vec2 a, vec2 b){\n" +
    "  vec2 v = b - a, w = p - a;\n" +
    "  float c = clamp(dot(w, v) / max(1e-6, dot(v, v)), 0.0, 1.0);\n" +
    "  return length(p - (a + v * c));\n" +
    "}\n" +
    "void main(){\n" +
    "  ivec2 g = ivec2(gl_FragCoord.xy);\n" +
    "  float nx = float(g.x) / max(uSim.x - 1.0, 1.0);\n" +
    // CPU convention: row 0 = top of screen.
    "  float ny = float(int(uSim.y) - 1 - g.y) / max(uSim.y - 1.0, 1.0);\n" +
    "  vec2 p = vec2(nx, ny);\n" +
    "  float v = 0.0;\n" +
    "  for (int i = 0; i < 6; i++){\n" +
    "    float d = distToSegment(p, RIB[i].xy, RIB[i].zw);\n" +
    "    float w = RIBW[i];\n" +
    "    v = max(v, exp(-(d * d) / (w * w)) * (0.70 + float(i) * 0.035));\n" +
    "  }\n" +
    "  float wave = sin(nx * 29.0 + ny * 13.0) * sin(ny * 23.0 - nx * 7.0) * 0.020;\n" +
    "  v = clamp(v + wave + (hrand(uvec3(uvec2(g), 1u)) - 0.5) * 0.030, 0.0, 1.0);\n" +
    // U = 1 - v*0.54  ->  a = 1 - U = v*0.54
    "  outColor = vec4(v * 0.54, v, 0.0, 1.0);\n" +
    "}\n";

  // Ornstein-Uhlenbeck smooth-field forcing, advanced once per sim step.
  var FS_NOISE = HEAD + RAND +
    "uniform sampler2D uNoise;\n" +
    "uniform float uDecay, uKickAmp;\n" +
    "uniform uint uFrame;\n" +
    "out vec4 outColor;\n" +
    "void main(){\n" +
    "  ivec2 g = ivec2(gl_FragCoord.xy);\n" +
    "  float n = texelFetch(uNoise, g, 0).r;\n" +
    "  outColor = vec4(n * uDecay + hrandn(uvec3(uvec2(g), uFrame)) * uKickAmp, 0.0, 0.0, 1.0);\n" +
    "}\n";

  // One Gray-Scott step. State texture is RG = (a, v) with a = 1 - U.
  var FS_STEP = HEAD + RAND +
    "uniform sampler2D uState;\n" +
    "uniform sampler2D uNoise;\n" +
    "uniform vec2 uSim;\n" +
    "uniform ivec2 uNoiseSize;\n" +
    "uniform uint uFrame;\n" +
    "uniform float uFeed, uKill, uDu, uDv;\n" +
    "uniform float uSigmaV, uSigmaF, uKickProb, uKickMag;\n" +
    "uniform float uPulse, uAspect;\n" +
    "uniform vec2 uPointer;\n" +
    "out vec4 outColor;\n" +
    "void main(){\n" +
    "  ivec2 g = ivec2(gl_FragCoord.xy);\n" +
    "  vec2 tx = 1.0 / uSim;\n" +
    "  vec2 uv = gl_FragCoord.xy * tx;\n" +
    // REPEAT wrap gives the CPU's wraparound neighbours for free.
    "  vec2 c  = texture(uState, uv).rg;\n" +
    "  vec2 e  = texture(uState, uv + vec2( tx.x, 0.0)).rg;\n" +
    "  vec2 w  = texture(uState, uv + vec2(-tx.x, 0.0)).rg;\n" +
    "  vec2 n  = texture(uState, uv + vec2(0.0,  tx.y)).rg;\n" +
    "  vec2 s  = texture(uState, uv + vec2(0.0, -tx.y)).rg;\n" +
    "  vec2 ne = texture(uState, uv + vec2( tx.x,  tx.y)).rg;\n" +
    "  vec2 nw = texture(uState, uv + vec2(-tx.x,  tx.y)).rg;\n" +
    "  vec2 se = texture(uState, uv + vec2( tx.x, -tx.y)).rg;\n" +
    "  vec2 sw = texture(uState, uv + vec2(-tx.x, -tx.y)).rg;\n" +
    // Same 9-point stencil and operation order as rd_common.step().
    "  vec2 lap = 0.2 * (e + w + s + n) + 0.05 * (ne + nw + se + sw) - c;\n" +
    // Bilinear sample of the coarse OU field, matching the CPU's clamp-to-edge map.
    "  float gx = float(g.x) * (float(uNoiseSize.x) - 1.0) / max(uSim.x - 1.0, 1.0);\n" +
    "  float gy = float(g.y) * (float(uNoiseSize.y) - 1.0) / max(uSim.y - 1.0, 1.0);\n" +
    "  int gx0 = int(gx), gy0 = int(gy);\n" +
    "  int gx1 = min(gx0 + 1, uNoiseSize.x - 1);\n" +
    "  int gy1 = min(gy0 + 1, uNoiseSize.y - 1);\n" +
    "  float fx = gx - float(gx0), fy = gy - float(gy0);\n" +
    "  float n00 = texelFetch(uNoise, ivec2(gx0, gy0), 0).r;\n" +
    "  float n10 = texelFetch(uNoise, ivec2(gx1, gy0), 0).r;\n" +
    "  float n01 = texelFetch(uNoise, ivec2(gx0, gy1), 0).r;\n" +
    "  float n11 = texelFetch(uNoise, ivec2(gx1, gy1), 0).r;\n" +
    "  float ou = (n00 * (1.0 - fx) + n10 * fx) * (1.0 - fy)\n" +
    "           + (n01 * (1.0 - fx) + n11 * fx) * fy;\n" +
    "  float a = c.r, v = c.g;\n" +
    "  float u = 1.0 - a;\n" +
    "  float localF = uFeed + ou * uSigmaF;\n" +
    "  float reaction = u * v * v;\n" +
    // a' = a + Du*lap(a) + reaction - F*a   (equivalent to the CPU's u' form)
    "  float aa = a + uDu * lap.r + reaction - localF * a;\n" +
    "  float vv = v + uDv * lap.g + reaction - (localF + uKill) * v;\n" +
    "  float ouForce = ou * uSigmaV * sqrt(v + 0.02);\n" +
    "  vv += ouForce;\n" +
    "  aa += ouForce * 0.30;\n" +
    // Rare large nucleation events.
    "  if (v > 0.02 && hrand(uvec3(uvec2(g), uFrame * 3u + 11u)) < uKickProb) {\n" +
    "    float kick = (hrand(uvec3(uvec2(g), uFrame * 7u + 23u)) - 0.30) * uKickMag;\n" +
    "    vv += kick;\n" +
    "    aa += kick * 0.25;\n" +
    "  }\n" +
    "  if (uPulse > 0.0) {\n" +
    "    float nx = float(g.x) / max(uSim.x - 1.0, 1.0);\n" +
    "    float ny = float(int(uSim.y) - 1 - g.y) / max(uSim.y - 1.0, 1.0);\n" +
    // Aspect-correct so the pulse is circular on screen, not elliptical.
    "    float dx = (nx - uPointer.x) * uAspect;\n" +
    "    float dy = ny - uPointer.y;\n" +
    "    float pulse = exp(-(dx * dx + dy * dy) / 0.0035) * uPulse * 0.11\n" +
    "                * max(0.0, 1.0 - v * 0.75);\n" +
    "    vv += pulse;\n" +
    "    aa += pulse * 0.30;\n" +
    "  }\n" +
    "  outColor = vec4(clamp(aa, 0.0, 1.0), clamp(vv, 0.0, 1.0), 0.0, 1.0);\n" +
    "}\n";

  // Separable 1-2-1 blur on V. uAxis picks the horizontal or vertical pass;
  // uSrcChannel picks .g (state) on pass 1 and .r (blur buffer) on pass 2.
  var FS_BLUR = HEAD +
    "uniform sampler2D uSrc;\n" +
    "uniform vec2 uSim;\n" +
    "uniform vec2 uAxis;\n" +
    "uniform bool uFromState;\n" +
    "out vec4 outColor;\n" +
    "float tap(vec2 uv){\n" +
    "  vec4 t = texture(uSrc, uv);\n" +
    "  return uFromState ? t.g : t.r;\n" +
    "}\n" +
    "void main(){\n" +
    "  vec2 tx = uAxis / uSim;\n" +
    "  vec2 uv = gl_FragCoord.xy / uSim;\n" +
    "  outColor = vec4((tap(uv - tx) + 2.0 * tap(uv) + tap(uv + tx)) * 0.25, 0.0, 0.0, 1.0);\n" +
    "}\n";

  // Colorize at SIM resolution -- deliberately not at screen resolution, so the
  // subsequent bilinear upscale keeps v50's soft faceted contours.
  var FS_COLOR = HEAD +
    "uniform sampler2D uBlur;\n" +
    "uniform vec2 uSim;\n" +
    "uniform vec3 uPaperBlue, uBodyMix, uHotMix, uBlue;\n" +
    "out vec4 outColor;\n" +
    "void main(){\n" +
    "  vec2 tx = 1.0 / uSim;\n" +
    "  vec2 uv = gl_FragCoord.xy * tx;\n" +
    "  float v = texture(uBlur, uv).r;\n" +
    "  float gxv = abs(texture(uBlur, uv + vec2(tx.x, 0.0)).r - texture(uBlur, uv - vec2(tx.x, 0.0)).r);\n" +
    "  float gyv = abs(texture(uBlur, uv + vec2(0.0, tx.y)).r - texture(uBlur, uv - vec2(0.0, tx.y)).r);\n" +
    "  float edge = smoothstep(0.020, 0.10, sqrt(gxv * gxv + gyv * gyv));\n" +
    "  float band = smoothstep(0.080, 0.36, v);\n" +
    "  float hot  = smoothstep(0.34, 0.60, v);\n" +
    "  vec3 col = mix(uPaperBlue, uBodyMix, band * 0.80);\n" +
    "  col = mix(col, uHotMix, hot * 0.44);\n" +
    "  col = mix(col, uBlue, edge * 0.16);\n" +
    "  outColor = vec4(col, 1.0);\n" +
    "}\n";

  // Final pass: BgUtils.drawSoftBase() translated to closed form, then the
  // upscaled field composited over it.
  var FS_COMPOSITE = HEAD +
    "uniform sampler2D uField;\n" +
    "uniform vec2 uRes;\n" +
    "uniform float uTime, uFieldAlpha;\n" +
    "uniform vec3 uLime, uBlue, uMint, uSoftLime;\n" +
    "out vec4 outColor;\n" +
    // drawSoftBase's linear gradient stops (#f2f6ff / #f4f8ff / #eff9f4 / #fff).
    "const vec3 G0 = vec3(242.0, 246.0, 255.0) / 255.0;\n" +
    "const vec3 G1 = vec3(244.0, 248.0, 255.0) / 255.0;\n" +
    "const vec3 G2 = vec3(239.0, 249.0, 244.0) / 255.0;\n" +
    "const vec3 G3 = vec3(255.0, 255.0, 255.0) / 255.0;\n" +
    // Canvas radial gradient: alpha falls linearly to 0 at r, composited source-over.
    "vec3 blob(vec3 dst, vec2 p, vec2 centre, float radius, vec3 col, float alpha){\n" +
    "  float d = length(p - centre) / radius;\n" +
    "  return mix(dst, col, alpha * (1.0 - clamp(d, 0.0, 1.0)));\n" +
    "}\n" +
    "void main(){\n" +
    "  float w = uRes.x, h = uRes.y;\n" +
    // Canvas space has y down; gl_FragCoord has y up.
    "  vec2 p = vec2(gl_FragCoord.x, h - gl_FragCoord.y);\n" +
    "  float t = clamp(dot(p, vec2(w, h)) / (w * w + h * h), 0.0, 1.0);\n" +
    "  vec3 base;\n" +
    "  if (t < 0.36)      base = mix(G0, G1, t / 0.36);\n" +
    "  else if (t < 0.72) base = mix(G1, G2, (t - 0.36) / 0.36);\n" +
    "  else               base = mix(G2, G3, (t - 0.72) / 0.28);\n" +
    "  float R = max(w, h);\n" +
    "  base = blob(base, p, vec2((0.76 + sin(uTime * 0.09) * 0.025) * w,\n" +
    "                            (0.08 + cos(uTime * 0.08) * 0.018) * h), 0.44 * R, uLime,     0.34);\n" +
    "  base = blob(base, p, vec2((0.17 + cos(uTime * 0.07) * 0.018) * w,\n" +
    "                            (0.16 + sin(uTime * 0.06) * 0.020) * h), 0.38 * R, uBlue,     0.12);\n" +
    "  base = blob(base, p, vec2((0.16 + sin(uTime * 0.06) * 0.020) * w,\n" +
    "                            (0.88 + cos(uTime * 0.05) * 0.020) * h), 0.42 * R, uMint,     0.22);\n" +
    "  base = blob(base, p, vec2(0.86 * w, 0.86 * h),                     0.36 * R, uSoftLime, 0.11);\n" +
    // uField is CLAMP_TO_EDGE + LINEAR: same bilinear upscale canvas drawImage does.
    "  vec3 field = texture(uField, gl_FragCoord.xy / uRes).rgb;\n" +
    "  outColor = vec4(mix(base, field, uFieldAlpha), 1.0);\n" +
    "}\n";

  // ---- GL helpers ----------------------------------------------------------

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("shader compile failed: " + log);
    }
    return sh;
  }

  function makeProgram(gl, fsSrc) {
    var vs = compile(gl, gl.VERTEX_SHADER, VERT);
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error("program link failed: " + log);
    }
    var u = {};
    var count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < count; i++) {
      var name = gl.getActiveUniform(prog, i).name.replace(/\[0\]$/, "");
      u[name] = gl.getUniformLocation(prog, name);
    }
    return { prog: prog, u: u };
  }

  function makeTex(gl, w, h, internal, format, type, filter, wrap) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return tex;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // Window-level pointer: .page-bg is pointer-events:none, so the canvas never
  // sees pointer events itself. Same behaviour as rd_background.js.
  function makeWindowPointer() {
    var pointer = { x: 0.62, y: 0.58, px: 0.62, py: 0.58, active: 0, energy: 0, hover: 0, timer: 0 };
    function at(event, boost) {
      var w = Math.max(1, window.innerWidth);
      var h = Math.max(1, window.innerHeight);
      pointer.px = pointer.x;
      pointer.py = pointer.y;
      pointer.x = clamp(event.clientX / w, 0, 1);
      pointer.y = clamp(event.clientY / h, 0, 1);
      pointer.hover = 1;
      pointer.active = 1;
      pointer.energy = Math.min(1, pointer.energy + (boost != null ? boost :
        Math.hypot(pointer.x - pointer.px, pointer.y - pointer.py) * 12));
      clearTimeout(pointer.timer);
      pointer.timer = setTimeout(function () { pointer.active = 0; }, 280);
    }
    window.addEventListener("pointermove", function (e) { at(e, null); }, { passive: true });
    window.addEventListener("pointerleave", function () { pointer.hover = 0; pointer.active = 0; }, { passive: true });
    // Taps fire pointerdown/pointerup but no pointermove, so without this a
    // touch produces zero energy. pointerup specifically -- scroll gestures
    // resolve as pointercancel, so this won't flash the bg on every scroll.
    window.addEventListener("pointerup", function (e) { at(e, 0.5); }, { passive: true });
    return pointer;
  }

  // ---- Init ----------------------------------------------------------------

  var glContextCreated = false;

  function init() {
    var utils = window.BgUtils;
    if (!utils) return false;

    var canvas = document.getElementById("shader-gradient");
    if (!canvas) return false;

    var gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
    });
    if (!gl) return false;
    glContextCreated = true;

    // A WebGL2 context is NOT proof of a GPU. When a driver is blocklisted (common
    // on cheap Android and on locked-down desktops) Chrome silently backs the
    // context with SwiftShader, its software rasteriser -- and rasterising the
    // fullscreen composite in software is *slower* than v50's CPU path, which at
    // least got GPU-accelerated canvas blits. Detect that and decline.
    // If the renderer string is unavailable (Firefox/Safari mask it for privacy)
    // we proceed: real hardware is overwhelmingly the common case.
    var dbgInfo = gl.getExtension("WEBGL_debug_renderer_info");
    var renderer = "";
    try {
      renderer = String(gl.getParameter(dbgInfo ? dbgInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
    } catch (err) {
      renderer = "";
    }
    if (/swiftshader|llvmpipe|softpipe|software rasterizer|basic render/i.test(renderer)) {
      console.info("rd_gpu: software rasteriser (" + renderer + "), using CPU background");
      return false;
    }

    // Float render targets. RG32F is preferred; RG16F is safe here only because
    // state is stored as (1-U, V) -- see the header note.
    var hasFloat = !!gl.getExtension("EXT_color_buffer_float");
    var hasHalf = hasFloat || !!gl.getExtension("EXT_color_buffer_half_float");
    if (!hasHalf) return false;

    var FMT = hasFloat
      ? { rg: gl.RG32F, r: gl.R32F, type: gl.FLOAT }
      : { rg: gl.RG16F, r: gl.R16F, type: gl.HALF_FLOAT };

    var progs;
    try {
      progs = {
        seed: makeProgram(gl, FS_SEED),
        noise: makeProgram(gl, FS_NOISE),
        step: makeProgram(gl, FS_STEP),
        blur: makeProgram(gl, FS_BLUR),
        color: makeProgram(gl, FS_COLOR),
        comp: makeProgram(gl, FS_COMPOSITE),
      };
    } catch (err) {
      console.warn("rd_gpu: shader build failed, falling back to CPU background", err);
      return false;
    }

    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var fbo = gl.createFramebuffer();

    var pointer = makeWindowPointer();
    var reduced = utils.hasReducedMotion();
    var pal = utils.palette;
    var bodyMix = utils.mixColor(pal.softLime, pal.paperBlue, 0.15);
    var hotMix = utils.mixColor(pal.lime, bodyMix, 0.30);
    function norm(c) { return [c[0] / 255, c[1] / 255, c[2] / 255]; }

    var size = utils.resizeCanvas(canvas, MAX_DPR);
    var simW = 0, simH = 0, noiseW = 0, noiseH = 0;
    var state = [null, null], noise = [null, null];
    var blurA = null, blurB = null, field = null;
    var cur = 0, noiseCur = 0;
    var frameIndex = 1;
    var warmupRemaining = WARMUP_TOTAL;
    var acc = 0;
    var t0 = performance.now();
    var last = t0;
    var rafId = 0;
    var dead = false;

    function drawTo(tex, w, h) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function bindTex(unit, tex, loc) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, unit);
    }

    function releaseTargets() {
      [state[0], state[1], noise[0], noise[1], blurA, blurB, field].forEach(function (t) {
        if (t) gl.deleteTexture(t);
      });
      state = [null, null];
      noise = [null, null];
      blurA = blurB = field = null;
    }

    function allocTargets() {
      releaseTargets();
      var NEAR = gl.NEAREST, LIN = gl.LINEAR, REP = gl.REPEAT, EDGE = gl.CLAMP_TO_EDGE;
      // REPEAT reproduces the CPU's wraparound neighbour tables.
      state[0] = makeTex(gl, simW, simH, FMT.rg, gl.RG, FMT.type, NEAR, REP);
      state[1] = makeTex(gl, simW, simH, FMT.rg, gl.RG, FMT.type, NEAR, REP);
      noise[0] = makeTex(gl, noiseW, noiseH, FMT.r, gl.RED, FMT.type, NEAR, EDGE);
      noise[1] = makeTex(gl, noiseW, noiseH, FMT.r, gl.RED, FMT.type, NEAR, EDGE);
      blurA = makeTex(gl, simW, simH, FMT.r, gl.RED, FMT.type, NEAR, REP);
      blurB = makeTex(gl, simW, simH, FMT.r, gl.RED, FMT.type, NEAR, REP);
      // CLAMP_TO_EDGE + LINEAR == what canvas drawImage() does when upscaling.
      field = makeTex(gl, simW, simH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, LIN, EDGE);

      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state[0], 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("float framebuffer incomplete");
      }
      // Zero the OU field, then lay down the seed.
      gl.clearColor(0, 0, 0, 1);
      [noise[0], noise[1]].forEach(function (t) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        gl.viewport(0, 0, noiseW, noiseH);
        gl.clear(gl.COLOR_BUFFER_BIT);
      });
      gl.useProgram(progs.seed.prog);
      gl.uniform2f(progs.seed.u.uSim, simW, simH);
      drawTo(state[0], simW, simH);
      cur = 0;
      noiseCur = 0;
    }

    // Mirrors rd_common.build(): always resize the display canvas, but only
    // reseed when the grid really changed. Mobile URL-bar show/hide moves
    // innerHeight by 50-80px (~4-7 sim rows at pixelDiv 11) and must not
    // trigger a full regeneration on every scroll.
    function build() {
      size = utils.resizeCanvas(canvas, MAX_DPR);
      var newW = clamp(Math.round(size.cssW / PIXEL_DIV), SIM_BOUNDS[0], SIM_BOUNDS[1]);
      var newH = clamp(Math.round(size.cssH / PIXEL_DIV), SIM_BOUNDS[2], SIM_BOUNDS[3]);
      if (state[0] && newW === simW && Math.abs(newH - simH) <= REBUILD_HEIGHT_THRESHOLD) {
        return;
      }
      simW = newW;
      simH = newH;
      noiseW = Math.max(8, Math.round(simW / 8));
      noiseH = Math.max(6, Math.round(simH / 8));
      allocTargets();
      warmupRemaining = WARMUP_TOTAL;
      acc = 0;
    }

    function simStep(usePointer) {
      var p = progs.noise;
      gl.useProgram(p.prog);
      bindTex(0, noise[noiseCur], p.u.uNoise);
      gl.uniform1f(p.u.uDecay, OU_DECAY);
      gl.uniform1f(p.u.uKickAmp, OU_KICK);
      gl.uniform1ui(p.u.uFrame, frameIndex >>> 0);
      drawTo(noise[1 - noiseCur], noiseW, noiseH);
      noiseCur = 1 - noiseCur;

      var active = usePointer && (pointer.active || pointer.energy > 0.04);
      p = progs.step;
      gl.useProgram(p.prog);
      bindTex(0, state[cur], p.u.uState);
      bindTex(1, noise[noiseCur], p.u.uNoise);
      gl.uniform2f(p.u.uSim, simW, simH);
      gl.uniform2i(p.u.uNoiseSize, noiseW, noiseH);
      gl.uniform1ui(p.u.uFrame, frameIndex >>> 0);
      gl.uniform1f(p.u.uFeed, FEED);
      gl.uniform1f(p.u.uKill, KILL);
      gl.uniform1f(p.u.uDu, DU);
      gl.uniform1f(p.u.uDv, DV);
      gl.uniform1f(p.u.uSigmaV, SIGMA_V);
      gl.uniform1f(p.u.uSigmaF, SIGMA_F);
      gl.uniform1f(p.u.uKickProb, KICK_PROB);
      gl.uniform1f(p.u.uKickMag, KICK_MAG);
      gl.uniform1f(p.u.uPulse, active ? pointer.energy : 0);
      gl.uniform1f(p.u.uAspect, size.cssW / Math.max(size.cssH, 1));
      gl.uniform2f(p.u.uPointer, pointer.x, pointer.y);
      drawTo(state[1 - cur], simW, simH);
      cur = 1 - cur;
      frameIndex++;
    }

    function updateField() {
      var p = progs.blur;
      gl.useProgram(p.prog);
      gl.uniform2f(p.u.uSim, simW, simH);
      bindTex(0, state[cur], p.u.uSrc);
      gl.uniform2f(p.u.uAxis, 1, 0);
      gl.uniform1i(p.u.uFromState, 1);
      drawTo(blurA, simW, simH);

      bindTex(0, blurA, p.u.uSrc);
      gl.uniform2f(p.u.uAxis, 0, 1);
      gl.uniform1i(p.u.uFromState, 0);
      drawTo(blurB, simW, simH);

      p = progs.color;
      gl.useProgram(p.prog);
      bindTex(0, blurB, p.u.uBlur);
      gl.uniform2f(p.u.uSim, simW, simH);
      gl.uniform3fv(p.u.uPaperBlue, norm(pal.paperBlue));
      gl.uniform3fv(p.u.uBodyMix, norm(bodyMix));
      gl.uniform3fv(p.u.uHotMix, norm(hotMix));
      gl.uniform3fv(p.u.uBlue, norm(pal.blue));
      drawTo(field, simW, simH);
    }

    function composite(time) {
      var p = progs.comp;
      gl.useProgram(p.prog);
      bindTex(0, field, p.u.uField);
      gl.uniform2f(p.u.uRes, size.w, size.h);
      gl.uniform1f(p.u.uTime, time);
      gl.uniform1f(p.u.uFieldAlpha, FIELD_ALPHA);
      gl.uniform3fv(p.u.uLime, norm(pal.lime));
      gl.uniform3fv(p.u.uBlue, norm(pal.blue));
      gl.uniform3fv(p.u.uMint, norm(pal.mint));
      gl.uniform3fv(p.u.uSoftLime, norm(pal.softLime));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, size.w, size.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function frame(now) {
      if (dead) return;
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      var steps = 0;
      if (warmupRemaining > 0) {
        steps = warmupRemaining < WARMUP_PER_FRAME ? warmupRemaining : WARMUP_PER_FRAME;
        for (var i = 0; i < steps; i++) simStep(false);
        warmupRemaining -= steps;
        acc = 0;
      } else {
        acc += dt;
        steps = Math.floor(acc * STEPS_PER_SEC);
        if (steps > MAX_STEPS_PER_FRAME) { steps = MAX_STEPS_PER_FRAME; acc = 0; }
        else { acc -= steps / STEPS_PER_SEC; }
        for (var j = 0; j < steps; j++) simStep(true);
      }
      // Frame-rate independent decay; matches v50's 0.94/frame at 60fps.
      pointer.energy *= Math.pow(0.94, dt * 60);
      if (!pointer.active && pointer.energy < 0.02) pointer.energy = 0;
      // The blobs drift every frame, but the field only changes when the sim did.
      if (steps > 0) updateField();
      composite((now - t0) / 1000);
      rafId = requestAnimationFrame(frame);
    }

    try {
      build();
    } catch (err) {
      console.warn("rd_gpu: target allocation failed, falling back to CPU background", err);
      return false;
    }

    // Reduced motion: run the whole warmup up front and paint one static frame,
    // otherwise PRM users would see the un-warmed seed ribbons.
    if (reduced) {
      for (var k = 0; k < warmupRemaining; k++) simStep(false);
      warmupRemaining = 0;
      updateField();
      composite(0);
    } else {
      updateField();
      composite(0);
      rafId = requestAnimationFrame(frame);
    }

    var resizeTimer = 0;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (dead) return;
        try {
          build();
          if (reduced) {
            for (var i = 0; i < warmupRemaining; i++) simStep(false);
            warmupRemaining = 0;
            updateField();
            composite(0);
          }
        } catch (err) {
          console.warn("rd_gpu: rebuild failed", err);
        }
      }, 150);
    });

    window.addEventListener("pagehide", function () {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    });
    window.addEventListener("pageshow", function (event) {
      if (event.persisted && !reduced && !rafId && !dead) {
        last = performance.now();
        rafId = requestAnimationFrame(frame);
      }
    });

    // GPU reset / driver crash: stop cleanly and hand the background to the CPU
    // implementation on a fresh canvas element (a canvas that has held a WebGL
    // context can never return a 2D context).
    canvas.addEventListener("webglcontextlost", function (event) {
      event.preventDefault();
      if (dead) return;
      dead = true;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      console.warn("rd_gpu: WebGL context lost, falling back to CPU background");
      swapInFreshCanvas();
      if (window.RDBackground && window.RDBackground.init) window.RDBackground.init();
    }, false);

    return true;
  }

  // A canvas that has held a WebGL context cannot hand out a 2D context, so the
  // CPU fallback needs a brand new element in the same DOM slot.
  function swapInFreshCanvas() {
    var old = document.getElementById("shader-gradient");
    if (!old || !old.parentNode) return;
    var fresh = document.createElement("canvas");
    fresh.id = old.id;
    fresh.className = old.className;
    old.parentNode.replaceChild(fresh, old);
  }

  var ok = false;
  try {
    ok = init();
  } catch (err) {
    console.warn("rd_gpu: init failed, falling back to CPU background", err);
    ok = false;
  }
  if (!ok && glContextCreated) swapInFreshCanvas();
  window.__RD_GPU_ACTIVE = ok;
})();
