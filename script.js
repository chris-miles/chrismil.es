/* Canvas Animations & Page Interactivity */

// --- Haptics (inlined, no ES module import needed) ---

const haptics = (function () {
  var WEB_HAPTICS_ESM_URL = "https://cdn.jsdelivr.net/npm/web-haptics/+esm";
  var COOLDOWN_MS = 100;
  var PREFERENCE_KEY = "site-haptics-preference";
  var SUCCESS_PATTERN = [
    { duration: 40, intensity: 0.85 },
    { delay: 45, duration: 70, intensity: 1 },
  ];

  var reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  var hapticClient = null;
  var lastTriggerAt = 0;
  var moduleLoaded = false;

  import(WEB_HAPTICS_ESM_URL)
    .then(function (mod) {
      if (mod && typeof mod.WebHaptics === "function") {
        hapticClient = new mod.WebHaptics();
      }
      moduleLoaded = true;
    })
    .catch(function () {
      moduleLoaded = true;
    });

  function getPreference() {
    try {
      var stored = window.localStorage.getItem(PREFERENCE_KEY);
      return stored === "off" ? "off" : "auto";
    } catch (e) {
      return "auto";
    }
  }

  function setPreference(nextPreference) {
    var normalized = nextPreference === "off" ? "off" : "auto";
    try {
      window.localStorage.setItem(PREFERENCE_KEY, normalized);
    } catch (e) {}
    return normalized;
  }

  function isEnabled() {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && conn.saveData) return false;
    if (typeof window.matchMedia === "function" && !window.matchMedia("(pointer: coarse)").matches) return false;
    if (getPreference() === "off") return false;
    if (reducedMotionQuery.matches) return false;
    return true;
  }

  function trigger(type) {
    if (!isEnabled()) return false;
    if (!moduleLoaded || !hapticClient || typeof hapticClient.trigger !== "function") return false;
    var now = Date.now();
    if (now - lastTriggerAt < COOLDOWN_MS) return false;
    lastTriggerAt = now;
    hapticClient.trigger(type || "medium");
    return true;
  }

  return {
    trigger: trigger,
    selection: function () { return trigger("selection"); },
    light: function () { return trigger("light"); },
    medium: function () { return trigger("medium"); },
    success: function () { return trigger(SUCCESS_PATTERN); },
    getPreference: getPreference,
    setPreference: setPreference,
  };
})();

const TAU = Math.PI * 2;

// --- Motion and performance state ---

const MotionState = {
  reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  lowPower: false,
};

(function setupMotionWatchers() {
  const reducedMotionMedia = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  const coarsePointerMedia = window.matchMedia("(pointer: coarse)");
  let batteryLow = false;

  function recomputeLowPower() {
    MotionState.lowPower = coarsePointerMedia.matches || batteryLow;
    if (document.documentElement) {
      document.documentElement.classList.toggle("lowpower", MotionState.lowPower);
    }
  }

  MotionState.reduced = reducedMotionMedia.matches;
  recomputeLowPower();

  const onReducedMotion = function (event) {
    MotionState.reduced = event.matches;
  };

  const onCoarsePointer = function () {
    recomputeLowPower();
  };

  if (reducedMotionMedia.addEventListener) {
    reducedMotionMedia.addEventListener("change", onReducedMotion);
    coarsePointerMedia.addEventListener("change", onCoarsePointer);
  } else {
    reducedMotionMedia.addListener(onReducedMotion);
    coarsePointerMedia.addListener(onCoarsePointer);
  }

  if (navigator.getBattery) {
    navigator.getBattery().then(function (battery) {
      const updateBattery = function () {
        batteryLow = !battery.charging && battery.level <= 0.25;
        recomputeLowPower();
      };

      updateBattery();

      if (battery.addEventListener) {
        battery.addEventListener("chargingchange", updateBattery);
        battery.addEventListener("levelchange", updateBattery);
      }
    });
  }
})();

function getTargetFps() {
  return MotionState.lowPower ? 30 : 60;
}

function getCanvasDpr() {
  const base = window.devicePixelRatio || 1;
  const maxDpr = MotionState.lowPower ? 1.2 : 1.75;
  return Math.min(base, maxDpr);
}

// --- Numeric helpers ---

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function makeRng(seed) {
  let t = seed || 1;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randn(rng) {
  const u = Math.max(rng(), 1e-7);
  const v = Math.max(rng(), 1e-7);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

function cubicBezierPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;

  return {
    x:
      p0.x * mt2 * mt + 3 * p1.x * mt2 * t + 3 * p2.x * mt * t2 + p3.x * t2 * t,
    y:
      p0.y * mt2 * mt + 3 * p1.y * mt2 * t + 3 * p2.y * mt * t2 + p3.y * t2 * t,
  };
}

// --- Background: MiniGL-like fluid shader with CSS fallback ---

function initFluidBackground() {
  const canvas = document.getElementById("shader-gradient");
  const fallback = document.getElementById("orb-fallback");
  const heroSection = document.getElementById("home");

  if (!canvas) return;

  const showFallback = function () {
    canvas.style.display = "none";
    if (fallback) fallback.hidden = false;
  };

  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    premultipliedAlpha: true,
  });

  if (!gl) {
    showFallback();
    return;
  }

  const vertexShaderSource = [
    "attribute vec2 a_position;",
    "varying vec2 v_uv;",
    "void main() {",
    "  v_uv = a_position * 0.5 + 0.5;",
    "  gl_Position = vec4(a_position, 0.0, 1.0);",
    "}",
  ].join("\n");

  const fragmentShaderSource = [
    "precision mediump float;",
    "varying vec2 v_uv;",
    "uniform vec2 u_resolution;",
    "uniform vec2 u_mouse;",
    "uniform float u_time;",
    "uniform float u_energy;",
    "",
    "float hash(vec2 p) {",
    "  p = fract(p * vec2(123.34, 456.21));",
    "  p += dot(p, p + 78.233);",
    "  return fract(p.x * p.y);",
    "}",
    "",
    "float noise(vec2 p) {",
    "  vec2 i = floor(p);",
    "  vec2 f = fract(p);",
    "  float a = hash(i);",
    "  float b = hash(i + vec2(1.0, 0.0));",
    "  float c = hash(i + vec2(0.0, 1.0));",
    "  float d = hash(i + vec2(1.0, 1.0));",
    "  vec2 u = f * f * (3.0 - 2.0 * f);",
    "  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;",
    "}",
    "",
    "float fbm(vec2 p) {",
    "  float value = 0.0;",
    "  float amp = 0.5;",
    "  for (int i = 0; i < 4; i++) {",
    "    value += amp * noise(p);",
    "    p *= 2.02;",
    "    amp *= 0.5;",
    "  }",
    "  return value;",
    "}",
    "",
    "void main() {",
    "  vec2 uv = v_uv;",
    "  vec2 aspect = vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0);",
    "  vec2 p = (uv - 0.5) * aspect * 1.3;",
    "  vec2 m = (u_mouse - 0.5) * aspect;",
    "",
    "  float t = u_time * 0.22;",
    "  float n1 = fbm(p * 2.1 + vec2(t * 0.75, -t * 0.45));",
    "  float n2 = fbm((p + vec2(n1 * 0.35, -n1 * 0.2)) * 2.8 - vec2(t * 0.35, -t * 0.28));",
    "",
    "  float dist = length(p - m);",
    "  float mouseField = exp(-4.2 * dist) * (u_energy * 3.6 + 0.12);",
    "",
    "  float blendA = smoothstep(0.15, 0.86, n1 + 0.65 * mouseField);",
    "  float blendB = smoothstep(0.12, 0.82, n2 - 0.35 * mouseField);",
    "",
    "  // Electric indigo + chartreuse palette",
    "  vec3 c1 = vec3(0.98, 0.99, 1.0);",
    "  vec3 c2 = vec3(0.86, 0.91, 0.99);",
    "  vec3 c3 = vec3(0.72, 0.95, 0.0);",
    "  vec3 c4 = vec3(0.52, 0.72, 0.97);",
    "",
    "  vec3 color = mix(c1, mix(c2, c3, blendA * 0.55), 0.85);",
    "  color = mix(color, c4, blendB * 0.58);",
    "",
    "  float vignette = smoothstep(2.0, 0.28, length((uv - 0.5) * vec2(1.08, 1.0)));",
    "  color = mix(c1, color, vignette * 0.94 + 0.06);",
    "",
    "  gl_FragColor = vec4(color, 1.0);",
    "}",
  ].join("\n");

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    if (!shader) return null;

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  const vs = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
  const fs = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);

  if (!vs || !fs) {
    showFallback();
    return;
  }

  const program = gl.createProgram();
  if (!program) {
    showFallback();
    return;
  }

  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    showFallback();
    return;
  }

  gl.useProgram(program);

  const positionLoc = gl.getAttribLocation(program, "a_position");
  const resolutionLoc = gl.getUniformLocation(program, "u_resolution");
  const mouseLoc = gl.getUniformLocation(program, "u_mouse");
  const timeLoc = gl.getUniformLocation(program, "u_time");
  const energyLoc = gl.getUniformLocation(program, "u_energy");

  if (
    positionLoc < 0 ||
    !resolutionLoc ||
    !mouseLoc ||
    !timeLoc ||
    !energyLoc
  ) {
    showFallback();
    return;
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

  let rafId = 0;
  let running = false;
  let lastTs = 0;
  let heroVisible = true;
  let shaderTime = 0;
  let coastFramesLeft = 0;
  const COAST_FRAMES = 30;

  const pointerTarget = { x: 0.5, y: 0.5 };
  const pointerCurrent = { x: 0.5, y: 0.5 };
  let pointerEnergy = 0;

  const onPointerMove = function (event) {
    const w = Math.max(window.innerWidth, 1);
    const h = Math.max(window.innerHeight, 1);

    pointerTarget.x = clamp(event.clientX / w, 0, 1);
    pointerTarget.y = clamp(1 - event.clientY / h, 0, 1);

    if (!running) kickCoast();
  };

  function resize() {
    const dprCap = MotionState.lowPower ? 1.2 : 1.5;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const width = Math.max(1, Math.floor(window.innerWidth * dpr));
    const height = Math.max(1, Math.floor(window.innerHeight * dpr));

    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  }

  function render(ts) {
    if (MotionState.reduced) {
      stop();
      renderStaticFrame();
      return;
    }

    if (!running && coastFramesLeft <= 0) {
      rafId = 0;
      lastTs = 0;
      return;
    }

    rafId = requestAnimationFrame(render);

    if (document.hidden) return;

    const minDelta = 1000 / getTargetFps();
    if (lastTs && ts - lastTs < minDelta) return;

    const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016;
    lastTs = ts;

    pointerCurrent.x += (pointerTarget.x - pointerCurrent.x) * 0.08;
    pointerCurrent.y += (pointerTarget.y - pointerCurrent.y) * 0.08;

    const velocity = Math.hypot(
      pointerTarget.x - pointerCurrent.x,
      pointerTarget.y - pointerCurrent.y,
    );
    pointerEnergy = lerp(pointerEnergy, clamp(velocity * 8.0, 0, 1), 0.18);

    if (running) shaderTime += dt;
    else coastFramesLeft--;

    gl.uniform2f(resolutionLoc, canvas.width, canvas.height);
    gl.uniform2f(mouseLoc, pointerCurrent.x, pointerCurrent.y);
    gl.uniform1f(timeLoc, shaderTime);
    gl.uniform1f(energyLoc, pointerEnergy);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function renderStaticFrame() {
    pointerCurrent.x = 0.62;
    pointerCurrent.y = 0.58;

    gl.uniform2f(resolutionLoc, canvas.width, canvas.height);
    gl.uniform2f(mouseLoc, pointerCurrent.x, pointerCurrent.y);
    gl.uniform1f(timeLoc, 11.0);
    gl.uniform1f(energyLoc, 0.12);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function start() {
    if (running || MotionState.reduced || !heroVisible || document.hidden) return;
    running = true;
    lastTs = 0;
    if (!rafId) rafId = requestAnimationFrame(render);
  }

  function stop() {
    running = false;
    coastFramesLeft = 0;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    lastTs = 0;
  }

  function kickCoast() {
    if (running || MotionState.reduced || document.hidden) return;
    coastFramesLeft = COAST_FRAMES;
    if (!rafId) {
      lastTs = 0;
      rafId = requestAnimationFrame(render);
    }
  }

  resize();

  if (MotionState.reduced) {
    renderStaticFrame();
  } else {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    start();
  }

  window.addEventListener("resize", resize);

  if (typeof IntersectionObserver !== "undefined" && heroSection) {
    const heroObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          heroVisible = entry.isIntersecting;
          if (MotionState.reduced) return;
          if (heroVisible) start();
          else stop();
        });
      },
      { threshold: 0.18 },
    );
    heroObserver.observe(heroSection);
  }

  document.addEventListener("visibilitychange", function () {
    if (MotionState.reduced) return;
    if (document.hidden) stop();
    else if (heroVisible) start();
  });
}

// --- Research card canvas animations ---

function createSpatialGenomicsAnimator(rng) {
  let width = 1,
    height = 1,
    time = 0;
  const cells = [];

  function reset(w, h) {
    width = w;
    height = h;
    cells.length = 0;
    // Fixed grid of ~12 cells (4×3) + 1 extra to fill left-middle gap
    const cols = 4;
    const rows = 3;
    const cellW = width / cols;
    const cellH = height / rows;
    // Slightly increased radii to pack cells a bit tighter while keeping separation.
    const baseRx = cellW * 0.43;
    const baseRy = cellH * 0.50;

    function pushCell(cx, cy) {
      // Irregular: wide independent variation + random rotation for blobby shapes
      const rx = baseRx * (0.78 + rng() * 0.36);
      const ry = baseRy * (0.78 + rng() * 0.36);
      const rotation = (rng() - 0.5) * 0.4; // ±~23° tilt
      // Generate blob shape: radial offsets at N angles for organic boundary
      const blobN = 8;
      const blobR = [];
      for (let b = 0; b < blobN; b++) {
        blobR.push(0.88 + rng() * 0.2); // radius multiplier per vertex (max 1.08)
      }
      const ncx = cx + (rng() - 0.5) * rx * 0.3;
      const ncy = cy + (rng() - 0.5) * ry * 0.3;
      const nrx = rx * 0.38;
      const nry = ry * 0.38;

      const sites = Array.from({ length: 2 }, () => {
        const angle = rng() * Math.PI * 2;
        return {
          x: ncx + Math.cos(angle) * nrx * 0.9,
          y: ncy + Math.sin(angle) * nry * 0.9,
          pulse: 0,
        };
      });

      cells.push({ cx, cy, rx, ry, rotation, blobN, blobR, ncx, ncy, nrx, nry, sites, puncta: [] });
    }

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        // Hex stagger: odd rows offset by half cell width
        const xOff = (j % 2 === 1) ? cellW * 0.5 : 0;
        const cx = (i + 0.5) * cellW + xOff + (rng() - 0.5) * cellW * 0.07;
        const cy = (j + 0.5) * cellH + (rng() - 0.5) * cellH * 0.07;
        pushCell(cx, cy);
      }
    }
    // Extra cell to fill left-middle gap (partially off-screen is fine)
    pushCell(cellW * 0.05 + (rng() - 0.5) * 8, height * 0.5 + (rng() - 0.5) * 10);

    // Seed a few transcripts so the card reads as "active" immediately.
    cells.forEach((cell) => {
      cell.sites.forEach((site) => {
        if (rng() < 0.35) spawnBurst(cell, site);
      });
    });
  }

  function spawnBurst(cell, site) {
    const maxPuncta = MotionState.lowPower ? 8 : 15;
    if (cell.puncta.length >= maxPuncta) return;
    const count = 4 + Math.floor(rng() * 5);
    for (let i = 0; i < count; i++) {
      cell.puncta.push({
        x: site.x,
        y: site.y,
        vx: (rng() - 0.5) * 40,
        vy: (rng() - 0.5) * 40,
        life: 1.0,
        ttl: 3 + rng() * 5,
        size: 1.2 + rng() * 1.5,
      });
    }
    site.pulse = 1.0;
  }

  function update(dt) {
    time += dt;
    cells.forEach((c) => {
      c.sites.forEach((s) => {
        if (rng() < 0.8 * dt) spawnBurst(c, s);
        s.pulse = Math.max(0, s.pulse - dt * 2);
      });

      for (let i = c.puncta.length - 1; i >= 0; i--) {
        const p = c.puncta[i];
        // Brownian: strong random kicks, moderate damping
        p.vx = p.vx * 0.88 + (rng() - 0.5) * 18;
        p.vy = p.vy * 0.88 + (rng() - 0.5) * 18;
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        p.life -= dt / p.ttl;

        // Keep inside cell (rough ellipse constraint)
        const dx = (p.x - c.cx) / c.rx;
        const dy = (p.y - c.cy) / c.ry;
        if (dx * dx + dy * dy > 0.9) {
          p.vx *= -1;
          p.vy *= -1;
        }

        if (p.life <= 0) c.puncta.splice(i, 1);
      }
    });
  }

  function draw(ctx) {
    // Cool-blue wash to match the SciML panel tint and keep consistency.
    ctx.fillStyle = "rgba(216, 231, 255, 0.56)";
    ctx.fillRect(0, 0, width, height);

    cells.forEach((c) => {
      // Cell membrane
      // Draw blobby cell membrane using smooth curve through radial points
      const blobPts = [];
      for (let b = 0; b < c.blobN; b++) {
        const a = (b / c.blobN) * TAU + c.rotation;
        blobPts.push({
          x: c.cx + Math.cos(a) * c.rx * c.blobR[b],
          y: c.cy + Math.sin(a) * c.ry * c.blobR[b],
        });
      }
      ctx.beginPath();
      // Smooth closed curve through blob points (Catmull-Rom-like via bezier)
      for (let b = 0; b < c.blobN; b++) {
        const p0 = blobPts[(b - 1 + c.blobN) % c.blobN];
        const p1 = blobPts[b];
        const p2 = blobPts[(b + 1) % c.blobN];
        const p3 = blobPts[(b + 2) % c.blobN];
        if (b === 0) ctx.moveTo(p1.x, p1.y);
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(44, 95, 246, 0.28)";
      ctx.fill();
      ctx.strokeStyle = "rgba(44, 95, 246, 1)";
      ctx.lineWidth = 2.2;
      ctx.stroke();

      // Nucleus
      ctx.beginPath();
      ctx.ellipse(c.ncx, c.ncy, c.nrx, c.nry, c.rotation, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(44, 95, 246, 0.36)";
      ctx.fill();
      ctx.strokeStyle = "rgba(44, 95, 246, 0.95)";
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Sites
      c.sites.forEach((s) => {
        const r = 2 + s.pulse * 3.5;
        ctx.fillStyle = "rgba(184, 242, 0, " + (0.5 + s.pulse * 0.45) + ")";
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
      });

      // Transcripts
      c.puncta.forEach((p) => {
        ctx.globalAlpha = p.life;
        ctx.fillStyle = "rgba(184, 242, 0, 0.9)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1.0;
    });
  }
  return { reset, update, draw };
}

function createCytoskeletonAnimator(rng) {
  let width = 1,
    height = 1,
    time = 0;
  const filaments = [],
    motors = [];

  function reset(w, h) {
    width = w;
    height = h;
    filaments.length = 0;
    motors.length = 0;

    // Main microtubule filaments — longer, wigglier cubic splines.
    for (let i = 0; i < 34; i++) {
      const x0 = rng() * width;
      const y0 = rng() * height;
      const angle = rng() * TAU;
      const len = 95 + rng() * 250;
      const lw = 1.5 + rng() * 1.5;
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      const perpX = -dirY;
      const perpY = dirX;

      // Independent bends produce richer, less one-directional curvature.
      const bend1 = (rng() - 0.5) * len * 0.9;
      const bend2 = (rng() - 0.5) * len * 0.9;

      const x1 = x0 + dirX * len;
      const y1 = y0 + dirY * len;
      const cp1X = x0 + dirX * len * 0.32 + perpX * bend1;
      const cp1Y = y0 + dirY * len * 0.32 + perpY * bend1;
      const cp2X =
        x0 + dirX * len * 0.68 + perpX * (-bend1 * 0.45 + bend2 * 0.8);
      const cp2Y =
        y0 + dirY * len * 0.68 + perpY * (-bend1 * 0.45 + bend2 * 0.8);

      filaments.push({
        x0,
        y0,
        x1,
        y1,
        cp1X,
        cp1Y,
        cp2X,
        cp2Y,
        color: "rgba(26, 53, 168, 0.68)",
        lineWidth: lw,
      });
    }

    // Slightly denser motor population for richer light-blue diffusion on desktop.
    const motorCount = MotionState.lowPower ? 44 : 60;
    for (let i = 0; i < motorCount; i++) {
      const f = filaments[Math.floor(rng() * filaments.length)];
      const t = rng();
      const pos = cubicBezierPoint(
        { x: f.x0, y: f.y0 },
        { x: f.cp1X, y: f.cp1Y },
        { x: f.cp2X, y: f.cp2Y },
        { x: f.x1, y: f.y1 },
        t,
      );
      motors.push({
        f,
        t,
        speed: 0.15 + rng() * 0.3,
        state: "attached",
        x: pos.x,
        y: pos.y,
        vx: (rng() - 0.5) * 24,
        vy: (rng() - 0.5) * 24,
        diffuseTimer: 0,
        diffuseDuration: 1.1 + rng() * 0.9,
      });
    }
  }

  function update(dt) {
    time += dt;
    motors.forEach((m) => {
      if (m.state === "attached") {
        m.t += m.speed * dt;
        const p = cubicBezierPoint(
          { x: m.f.x0, y: m.f.y0 },
          { x: m.f.cp1X, y: m.f.cp1Y },
          { x: m.f.cp2X, y: m.f.cp2Y },
          { x: m.f.x1, y: m.f.y1 },
          clamp(m.t, 0, 1),
        );
        m.x = p.x;
        m.y = p.y;

        if (m.t > 1) {
          if (rng() < 0.32) {
            m.state = "diffuse";
            m.t = 0;
            m.diffuseTimer = 0;
            m.diffuseDuration = 1.1 + rng() * 0.9;
            m.vx = (rng() - 0.5) * 28;
            m.vy = (rng() - 0.5) * 28;
          } else {
            m.t = 0;
          }
        }
      } else {
        // Brownian-like diffusion: random kicks + damping.
        m.vx = m.vx * 0.88 + (rng() - 0.5) * 22;
        m.vy = m.vy * 0.88 + (rng() - 0.5) * 22;
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        m.diffuseTimer += dt;

        const pad = 4;
        if (m.x < pad) {
          m.x = pad;
          m.vx = Math.abs(m.vx) * 0.7;
        } else if (m.x > width - pad) {
          m.x = width - pad;
          m.vx = -Math.abs(m.vx) * 0.7;
        }
        if (m.y < pad) {
          m.y = pad;
          m.vy = Math.abs(m.vy) * 0.7;
        } else if (m.y > height - pad) {
          m.y = height - pad;
          m.vy = -Math.abs(m.vy) * 0.7;
        }

        if (m.diffuseTimer > m.diffuseDuration) {
          m.state = "attached";
          m.t = rng() * 0.2;
          m.f = filaments[Math.floor(rng() * filaments.length)];
          m.speed = 0.15 + rng() * 0.3;
        }
      }
    });
  }

  function draw(ctx) {
    // Microtubule filaments
    filaments.forEach((f) => {
      ctx.beginPath();
      ctx.moveTo(f.x0, f.y0);
      ctx.bezierCurveTo(f.cp1X, f.cp1Y, f.cp2X, f.cp2Y, f.x1, f.y1);
      ctx.strokeStyle = f.color;
      ctx.lineWidth = f.lineWidth;
      ctx.stroke();
    });

    // Motor proteins
    motors.forEach((m) => {
      if (m.state === "attached") {
        ctx.fillStyle = "rgba(184, 242, 0, 1)";
      } else {
        ctx.fillStyle = "rgba(120, 170, 255, 0.92)";
      }
      ctx.beginPath();
      ctx.arc(m.x, m.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  return { reset, update, draw };
}


const sharedHistData = {
  bins: new Array(18).fill(0),
  prevBins: new Array(18).fill(0),
  glow: new Array(18).fill(0),
  warmup: 0.5,
  lastTs: 0,
  time: 0,
  rng: makeRng((Date.now() ^ 0x82A1C) >>> 0),
  update: function(dt) {
    const now = performance.now();
    if (now - this.lastTs < 8) return;
    this.lastTs = now;
    this.time += dt;

    this.warmup -= dt;
    const warmFactor = this.warmup > 0 ? 5 : 1;

    for (let i = 0; i < this.bins.length; i++) {
      this.prevBins[i] = this.bins[i];
    }

    // Bimodal accumulation — two fixed centers matching the seeded distribution
    if (this.rng() < 12 * warmFactor * dt) {
      const center = this.rng() > 0.5 ? 0.28 : 0.75;
      let local = 0;
      for (let i = 0; i < 6; i++) local += this.rng();
      local = local / 6 - 0.5;
      const idx = Math.floor(
        clamp(center + local * 0.5, 0, 0.999) * this.bins.length,
      );
      this.bins[idx] += (2.2 + this.rng() * 1.6) * (this.warmup > 0 ? 1.1 : 1);
    }

    const decayBase = this.warmup > 0 ? 0.988 : 0.986;
    for (let i = 0; i < this.bins.length; i++) {
      this.bins[i] *= Math.pow(decayBase, dt * 14);
    }

    if (this.rng() < 3 * warmFactor * dt) {
      const idx = Math.floor(this.rng() * this.bins.length);
      this.bins[idx] += this.rng() * 0.4;
    }

    for (let i = 0; i < this.bins.length; i++) {
      const growth = this.bins[i] - this.prevBins[i];
      if (growth > 0) this.glow[i] += growth;
      this.glow[i] *= Math.pow(0.989, dt * 60);
      if (this.glow[i] < 0.002) this.glow[i] = 0;
    }
  },
  reset: function() {
    this.warmup = 0.5;
    this.time = 0;
    this.bins.fill(0);
    this.prevBins.fill(0);
    this.glow.fill(0);
    for (let i = 0; i < this.bins.length; i++) {
      const t = i / Math.max(1, this.bins.length - 1);
      const modeA = Math.exp(-Math.pow((t - 0.28) / 0.2, 2));
      const modeB = Math.exp(-Math.pow((t - 0.72) / 0.18, 2));
      this.bins[i] = (modeA + modeB) * 2.35 + 0.14 + this.rng() * 0.18;
    }
  }
};

function createSciMLAnimator(rng) {
  let width = 1,
    height = 1,
    time = 0;
  const nodes = [],
    links = [],
    signals = [];

  function reset(w, h) {
    width = w;
    height = h;
    nodes.length = 0;
    links.length = 0;
    signals.length = 0;
    sharedHistData.reset();

    // NN spans from ~3% to ~78% of canvas width — wide, fills left side
    const layers = [3, 5, 5, 2];
    const nnLeft = width * 0.03;
    const nnRight = width * 0.78;
    const layerSpacing = (nnRight - nnLeft) / (layers.length - 1);

    layers.forEach((count, lIdx) => {
      const x = nnLeft + lIdx * layerSpacing;
      for (let i = 0; i < count; i++) {
        nodes.push({
          x,
          y: ((i + 0.5) * height) / (count + 0.5),
          layer: lIdx,
          pulse: 0,
        });
      }
    });

    nodes.forEach((n1) =>
      nodes.forEach((n2) => {
        if (n2.layer === n1.layer + 1) links.push({ n1, n2 });
      }),
    );

    // Seed activity so static or first-frame renders aren't perceived as empty.
    for (let i = 0; i < 5; i++) spawnSignal();

  }

  function spawnSignal() {
    const inputs = nodes.filter((n) => n.layer === 0);
    const input = inputs[Math.floor(rng() * inputs.length)];
    const targets = nodes.filter((n) => n.layer === 1);
    const target = targets[Math.floor(rng() * targets.length)];
    signals.push({
      from: input,
      to: target,
      t: 0,
      speed: 1.8 + rng() * 1.2,
    });
    input.pulse = 1.0;
  }

  function update(dt) {
    time += dt;
    sharedHistData.update(dt);
    if (rng() < 4 * dt) spawnSignal();

    for (let i = signals.length - 1; i >= 0; i--) {
      const s = signals[i];
      s.t += s.speed * dt;
      if (s.t >= 1) {
        s.to.pulse = 1.0;
        const maxLayer = 3;
        if (s.to.layer < maxLayer) {
          const nextLayer = nodes.filter((n) => n.layer === s.to.layer + 1);
          const nextTarget = nextLayer[Math.floor(rng() * nextLayer.length)];
          s.from = s.to;
          s.to = nextTarget;
          s.t = 0;
        } else {

          signals.splice(i, 1);
        }
      }
    }

    nodes.forEach((n) => (n.pulse = Math.max(0, n.pulse - dt * 4)));

  }

  function draw(ctx) {
    // 1. NN links (behind everything)
    links.forEach((l) => {
      ctx.beginPath();
      ctx.moveTo(l.n1.x, l.n1.y);
      ctx.lineTo(l.n2.x, l.n2.y);
      ctx.strokeStyle = "rgba(44, 95, 246, 0.88)";
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // 2. NN signals
    signals.forEach((s) => {
      const x = s.from.x + (s.to.x - s.from.x) * s.t;
      const y = s.from.y + (s.to.y - s.from.y) * s.t;
      ctx.fillStyle = "rgba(184, 242, 0, 0.9)";
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });

    // 3. NN nodes
    nodes.forEach((n) => {
      const r = 3.5 + n.pulse * 2.5;
      if (n.pulse > 0) {
        ctx.fillStyle = "rgba(184, 242, 0, 0.95)";
      } else {
        ctx.fillStyle = "rgba(44, 95, 246, 0.94)";
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
    });

    // 4. Histogram
    const histX = width * 0.40;
    const histW = width * 0.58;
    const histH = height * 0.75;
    const groundY = height * 0.92;
const barW = histW / sharedHistData.bins.length;
    for (let i = 0; i < sharedHistData.bins.length; i++) {
      const h = Math.min(sharedHistData.bins[i] * 3.5, histH);
      const x = histX + i * barW;
      const w = Math.max(1, barW - 1);

      const r = Math.min(w * 0.3, h * 0.3, 4);

      // Define the soft rounded-top path for the bar
      ctx.beginPath();
      ctx.moveTo(x, groundY);
      ctx.lineTo(x, groundY - h + r);
      ctx.arcTo(x, groundY - h, x + w / 2, groundY - h, r);
      ctx.arcTo(x + w, groundY - h, x + w, groundY - h + r, r);
      ctx.lineTo(x + w, groundY);
      ctx.closePath();

      // Deep glowing blue gradient base
      const grad = ctx.createLinearGradient(0, groundY, 0, groundY - h);
      grad.addColorStop(0, "rgba(26, 53, 168, 0.4)");
      grad.addColorStop(1, "rgba(44, 95, 246, 0.85)");
      ctx.fillStyle = grad;
      ctx.fill();

      // Fill fresh growth chartreuse on top, clipped exactly to the soft path
      const freshH = Math.min((sharedHistData.glow[i] || 0) * 3.5, h);
      if (freshH > 0.1) {
        ctx.save();
        ctx.clip(); // Ensure it never spills outside the soft bar path

        const freshGrad = ctx.createLinearGradient(0, groundY - h, 0, groundY - h + freshH);
        freshGrad.addColorStop(0, "rgba(184, 242, 0, 1)");
        freshGrad.addColorStop(0.3, "rgba(184, 242, 0, 1)");
        freshGrad.addColorStop(1, "rgba(184, 242, 0, 0)");
        
        ctx.fillStyle = freshGrad;
        ctx.fillRect(x, groundY - h, w, freshH);
        
        ctx.restore();
      }
    }
    ctx.fillStyle = "rgba(44, 95, 246, 0.72)";
    ctx.fillRect(histX, groundY, histW, 1);
  }
  return { reset, update, draw };
}

function createUnifiedAnimator(rng) {
  let width = 1;
  let height = 1;
  let time = 0;

  const items = [];

  const cell = {
    item: null,
    rx: 1,
    ry: 1,
    rotation: 0,
    ncx: 0,
    ncy: 0,
    nrx: 1,
    nry: 1,
    blobR: [],
    sites: [],
    puncta: [],
  };

  const cyto = {
    item: null,
    filaments: [],
    motors: [],
  };

  const network = {
    item: null,
    nodes: [],
    links: [],
    pulses: [],
    layers: [[], [], []],
  };

  const hist = {
    item: null,
    bins: [],
    prevBins: [],
    glow: [],
    warmup: 0,
    warmupDuration: 0,
  };

  function layoutItems() {
    items.length = 0;

    var count = 4;
    var pad = 2;
    var gap = 4;
    var usable = width - 2 * pad;
    var slotW = usable / count;
    var itemH = height - 2 * pad;
    // cap width so motifs never get wider than 1.3x their height (prevents pancaking)
    var itemW = Math.min(slotW - gap, itemH * 1.3);

    var kinds = ["cell", "network", "cyto", "hist"];
    var opacities = [0.9, 0.9, 0.86, 0.92];

    for (var i = 0; i < count; i++) {
      var cx = pad + slotW * (i + 0.5);

      items.push({
        kind: kinds[i],
        x: cx,
        y: height * 0.5,
        w: itemW,
        h: itemH,
        driftX: 0.4 + rng() * 0.6,
        driftY: 0.2 + rng() * 0.3,
        driftSpeed: 0.1 + rng() * 0.08,
        driftPhase: rng() * TAU,
        opacity: opacities[i] + rng() * 0.05,
      });
    }
  }

  function spawnCellBurst(site) {
    if (!cell.item) return;
    const maxPuncta = MotionState.lowPower ? 90 : 150;
    if (cell.puncta.length >= maxPuncta) return;

    const count = 3 + Math.floor(rng() * 5);
    for (let i = 0; i < count; i++) {
      cell.puncta.push({
        x: site.x,
        y: site.y,
        vx: (rng() - 0.5) * 32,
        vy: (rng() - 0.5) * 32,
        life: 1,
        ttl: 2.4 + rng() * 3.2,
        size: 1.1 + rng() * 1.4,
      });
    }
    site.pulse = 1;
  }

  function resetCell(item) {
    cell.item = item;
    cell.rx = item.w * 0.45;
    cell.ry = item.h * 0.45;
    cell.rotation = (rng() - 0.5) * 0.36;
    cell.ncx = (rng() - 0.5) * cell.rx * 0.2;
    cell.ncy = (rng() - 0.5) * cell.ry * 0.2;
    cell.nrx = cell.rx * 0.39;
    cell.nry = cell.ry * 0.39;
    cell.puncta.length = 0;
    cell.sites.length = 0;
    cell.blobR.length = 0;

    for (let i = 0; i < 9; i++) {
      cell.blobR.push(0.86 + rng() * 0.24);
    }

    for (let i = 0; i < 2; i++) {
      const angle = rng() * TAU;
      cell.sites.push({
        x: cell.ncx + Math.cos(angle) * cell.nrx * 0.85,
        y: cell.ncy + Math.sin(angle) * cell.nry * 0.85,
        pulse: 0,
      });
    }

    cell.sites.forEach(function (site) {
      if (rng() < 0.85) spawnCellBurst(site);
    });
  }

  function updateCell(dt) {
    if (!cell.item) return;

    cell.sites.forEach(function (site) {
      if (rng() < 0.95 * dt) spawnCellBurst(site);
      site.pulse = Math.max(0, site.pulse - dt * 2.2);
    });

    for (let i = cell.puncta.length - 1; i >= 0; i--) {
      const p = cell.puncta[i];
      p.vx = p.vx * 0.9 + (rng() - 0.5) * 14;
      p.vy = p.vy * 0.9 + (rng() - 0.5) * 14;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const dx = p.x / cell.rx;
      const dy = p.y / cell.ry;
      const radial = dx * dx + dy * dy;
      if (radial > 0.98) {
        const norm = Math.sqrt(radial) || 1;
        p.x = (dx / norm) * cell.rx * 0.96;
        p.y = (dy / norm) * cell.ry * 0.96;
        p.vx *= -0.72;
        p.vy *= -0.72;
      }

      p.life -= dt / p.ttl;
      if (p.life <= 0) cell.puncta.splice(i, 1);
    }
  }

  function drawCell(ctx, item) {
    const pts = [];
    const blobN = cell.blobR.length;
    for (let i = 0; i < blobN; i++) {
      const angle = (i / blobN) * TAU + cell.rotation;
      pts.push({
        x: Math.cos(angle) * cell.rx * cell.blobR[i],
        y: Math.sin(angle) * cell.ry * cell.blobR[i],
      });
    }

    ctx.beginPath();
    for (let i = 0; i < blobN; i++) {
      const p0 = pts[(i - 1 + blobN) % blobN];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % blobN];
      const p3 = pts[(i + 2) % blobN];
      if (i === 0) ctx.moveTo(p1.x, p1.y);
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(44, 95, 246, 0.3)";
    ctx.fill();
    ctx.strokeStyle = "rgba(44, 95, 246, 0.92)";
    ctx.lineWidth = 1.8;
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(
      cell.ncx,
      cell.ncy,
      cell.nrx,
      cell.nry,
      cell.rotation,
      0,
      TAU,
    );
    ctx.fillStyle = "rgba(44, 95, 246, 0.38)";
    ctx.fill();
    ctx.strokeStyle = "rgba(44, 95, 246, 0.88)";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    cell.sites.forEach(function (site) {
      const radius = 1.9 + site.pulse * 2.8;
      ctx.fillStyle = "rgba(184, 242, 0, " + (0.72 + site.pulse * 0.24) + ")";
      ctx.beginPath();
      ctx.arc(site.x, site.y, radius, 0, TAU);
      ctx.fill();
    });

    cell.puncta.forEach(function (p) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = "rgba(184, 242, 0, 0.92)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function pointOnFilament(f, t) {
    return cubicBezierPoint(
      { x: f.x0, y: f.y0 },
      { x: f.cp1X, y: f.cp1Y },
      { x: f.cp2X, y: f.cp2Y },
      { x: f.x1, y: f.y1 },
      t,
    );
  }

  function resetCyto(item) {
    cyto.item = item;
    cyto.filaments.length = 0;
    cyto.motors.length = 0;

    var halfW = item.w * 0.48;
    var halfH = item.h * 0.46;
    const filamentCount = MotionState.lowPower ? 8 : 12;
    for (let i = 0; i < filamentCount; i++) {
      var x0 = (rng() - 0.5) * item.w * 0.7;
      var y0 = (rng() - 0.5) * item.h * 0.6;
      var angle = (rng() - 0.5) * Math.PI * 0.7;
      var lenX = item.w * (0.25 + rng() * 0.35);
      var lenY = item.h * (0.3 + rng() * 0.4);
      var len = Math.sqrt(lenX * lenX + lenY * lenY) * 0.7;
      var dirX = Math.cos(angle);
      var dirY = Math.sin(angle);
      var perpX = -dirY;
      var perpY = dirX;
      var bend1 = (rng() - 0.5) * len * 0.42;
      var bend2 = (rng() - 0.5) * len * 0.42;
      var x1 = x0 + dirX * len;
      var y1 = y0 + dirY * len;

      // clamp endpoints inside the bounding box
      x0 = clamp(x0, -halfW, halfW);
      y0 = clamp(y0, -halfH, halfH);
      x1 = clamp(x1, -halfW, halfW);
      y1 = clamp(y1, -halfH, halfH);

      cyto.filaments.push({
        x0,
        y0,
        x1: x1,
        y1: y1,
        cp1X: clamp(x0 + dirX * len * 0.32 + perpX * bend1, -halfW, halfW),
        cp1Y: clamp(y0 + dirY * len * 0.32 + perpY * bend1, -halfH, halfH),
        cp2X: clamp(x0 + dirX * len * 0.7 + perpX * (-bend1 * 0.38 + bend2 * 0.82), -halfW, halfW),
        cp2Y: clamp(y0 + dirY * len * 0.7 + perpY * (-bend1 * 0.38 + bend2 * 0.82), -halfH, halfH),
        lineWidth: 1 + rng() * 1.1,
      });
    }

    const motorCount = MotionState.lowPower ? 14 : 22;
    for (let i = 0; i < motorCount; i++) {
      const f = cyto.filaments[Math.floor(rng() * cyto.filaments.length)];
      const t = rng();
      const p = pointOnFilament(f, t);
      cyto.motors.push({
        f,
        t,
        speed: 0.2 + rng() * 0.26,
        state: "attached",
        x: p.x,
        y: p.y,
        vx: (rng() - 0.5) * 18,
        vy: (rng() - 0.5) * 18,
        diffuseTimer: 0,
        diffuseDuration: 0.9 + rng() * 0.7,
      });
    }
  }

  function updateCyto(dt) {
    if (!cyto.item || !cyto.filaments.length) return;

    const halfW = cyto.item.w * 0.5;
    const halfH = cyto.item.h * 0.5;

    cyto.motors.forEach(function (motor) {
      if (motor.state === "attached") {
        motor.t += motor.speed * dt;
        const p = pointOnFilament(motor.f, clamp(motor.t, 0, 1));
        motor.x = p.x;
        motor.y = p.y;

        if (motor.t > 1) {
          if (rng() < 0.34) {
            motor.state = "diffuse";
            motor.diffuseTimer = 0;
            motor.diffuseDuration = 0.9 + rng() * 0.7;
            motor.vx = (rng() - 0.5) * 20;
            motor.vy = (rng() - 0.5) * 20;
          } else {
            motor.f =
              cyto.filaments[Math.floor(rng() * cyto.filaments.length)];
            motor.t = 0;
            motor.speed = 0.2 + rng() * 0.26;
          }
        }
      } else {
        motor.vx = motor.vx * 0.88 + (rng() - 0.5) * 14;
        motor.vy = motor.vy * 0.88 + (rng() - 0.5) * 14;
        motor.x += motor.vx * dt;
        motor.y += motor.vy * dt;
        motor.diffuseTimer += dt;

        const pad = 3;
        if (motor.x < -halfW + pad) {
          motor.x = -halfW + pad;
          motor.vx = Math.abs(motor.vx) * 0.7;
        } else if (motor.x > halfW - pad) {
          motor.x = halfW - pad;
          motor.vx = -Math.abs(motor.vx) * 0.7;
        }
        if (motor.y < -halfH + pad) {
          motor.y = -halfH + pad;
          motor.vy = Math.abs(motor.vy) * 0.7;
        } else if (motor.y > halfH - pad) {
          motor.y = halfH - pad;
          motor.vy = -Math.abs(motor.vy) * 0.7;
        }

        if (motor.diffuseTimer > motor.diffuseDuration) {
          motor.state = "attached";
          motor.f =
            cyto.filaments[Math.floor(rng() * cyto.filaments.length)];
          motor.t = rng() * 0.18;
          motor.speed = 0.2 + rng() * 0.26;
        }
      }
    });
  }

  function drawCyto(ctx, item) {
    cyto.filaments.forEach(function (f) {
      ctx.beginPath();
      ctx.moveTo(f.x0, f.y0);
      ctx.bezierCurveTo(f.cp1X, f.cp1Y, f.cp2X, f.cp2Y, f.x1, f.y1);
      ctx.strokeStyle = "rgba(26, 53, 168, 0.7)";
      ctx.lineWidth = f.lineWidth;
      ctx.stroke();
    });

    cyto.motors.forEach(function (motor) {
      ctx.beginPath();
      ctx.arc(motor.x, motor.y, 2.3, 0, TAU);
      if (motor.state === "attached") {
        ctx.fillStyle = "rgba(184, 242, 0, 0.95)";
      } else {
        ctx.fillStyle = "rgba(120, 170, 255, 0.9)";
      }
      ctx.fill();
    });
  }

  function spawnNetworkPulse() {
    if (!network.layers[0].length || !network.layers[1].length) return;
    const from = network.layers[0][
      Math.floor(rng() * network.layers[0].length)
    ];
    const to = network.layers[1][Math.floor(rng() * network.layers[1].length)];
    from.pulse = 1;

    network.pulses.push({
      from,
      to,
      t: 0,
      speed: 1.6 + rng() * 1.1,
      targetLayer: 1,
    });
  }

  function resetNetwork(item) {
    network.item = item;
    network.nodes.length = 0;
    network.links.length = 0;
    network.pulses.length = 0;
    network.layers = [[], [], []];

    const layerCounts = [3, 4, 3];
    const left = -item.w * 0.46;
    const right = item.w * 0.46;
    const xGap = (right - left) / (layerCounts.length - 1);

    for (let layer = 0; layer < layerCounts.length; layer++) {
      const count = layerCounts[layer];
      const yGap = item.h / (count + 1);
      for (let i = 0; i < count; i++) {
        const node = {
          x: left + layer * xGap,
          y: -item.h * 0.5 + (i + 1) * yGap,
          layer,
          pulse: 0,
        };
        network.nodes.push(node);
        network.layers[layer].push(node);
      }
    }

    network.nodes.forEach(function (a) {
      network.nodes.forEach(function (b) {
        if (b.layer === a.layer + 1) {
          network.links.push({ a, b });
        }
      });
    });

    for (let i = 0; i < 3; i++) spawnNetworkPulse();
  }

  function updateNetwork(dt) {
    if (!network.item) return;

    if (rng() < 2.4 * dt) spawnNetworkPulse();

    for (let i = network.pulses.length - 1; i >= 0; i--) {
      const pulse = network.pulses[i];
      pulse.t += pulse.speed * dt;

      if (pulse.t >= 1) {
        pulse.to.pulse = 1;
        if (pulse.targetLayer < network.layers.length - 1) {
          const nextLayer = network.layers[pulse.targetLayer + 1];
          if (nextLayer.length) {
            const next = nextLayer[Math.floor(rng() * nextLayer.length)];
            pulse.from = pulse.to;
            pulse.to = next;
            pulse.targetLayer += 1;
            pulse.t = 0;
            continue;
          }
        }
        network.pulses.splice(i, 1);
      }
    }

    network.nodes.forEach(function (node) {
      node.pulse = Math.max(0, node.pulse - dt * 2.8);
    });
  }

  function drawNetwork(ctx, item) {
    // Draw edges — highlight active ones in green
    network.links.forEach(function (link) {
      var isActive = false;
      for (var pi = 0; pi < network.pulses.length; pi++) {
        var p = network.pulses[pi];
        if (p.from === link.a && p.to === link.b) { isActive = true; break; }
      }
      ctx.beginPath();
      ctx.moveTo(link.a.x, link.a.y);
      ctx.lineTo(link.b.x, link.b.y);
      ctx.strokeStyle = "rgba(44, 95, 246, 0.46)";
      ctx.lineWidth = isActive ? 2.2 : 1;
      ctx.stroke();
    });

    network.pulses.forEach(function (pulse) {
      const x = lerp(pulse.from.x, pulse.to.x, pulse.t);
      const y = lerp(pulse.from.y, pulse.to.y, pulse.t);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, TAU);
      ctx.fillStyle = "rgba(184, 242, 0, 1)";
      ctx.fill();
    });

    network.nodes.forEach(function (node) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.pulse > 0 ? 3.5 : 2.8, 0, TAU);
      if (node.pulse > 0) {
        ctx.fillStyle = "rgba(184, 242, 0, 0.95)";
      } else {
        ctx.fillStyle = "rgba(44, 95, 246, 0.72)";
      }
      ctx.fill();
    });
  }

  function resetHist(item) {
    hist.item = item;
    sharedHistData.reset();
  }

  function updateHist(dt) {
    if (!hist.item) return;
    sharedHistData.update(dt);
  }

function drawHist(ctx, item) {
    const padX = item.w * 0.06;
    const usableW = item.w - padX * 2;
    const barW = usableW / sharedHistData.bins.length;
    const compactMotif = item.h < 85;
    const groundY = item.h * (compactMotif ? 0.34 : 0.38);
    const maxH = item.h * (compactMotif ? 0.76 : 0.8);

    for (let i = 0; i < sharedHistData.bins.length; i++) {
      const h = Math.min(sharedHistData.bins[i] * 3.15, maxH);
      const x = -item.w * 0.5 + padX + i * barW;
      const w = Math.max(1, barW - 1.4);

      const r = Math.min(w / 2, h / 2);

      ctx.beginPath();
      ctx.moveTo(x, groundY);
      ctx.lineTo(x, groundY - h + r);
      ctx.arcTo(x, groundY - h, x + w / 2, groundY - h, r);
      ctx.arcTo(x + w, groundY - h, x + w, groundY - h + r, r);
      ctx.lineTo(x + w, groundY);
      ctx.closePath();

      const grad = ctx.createLinearGradient(0, groundY, 0, groundY - h);
      grad.addColorStop(0, "rgba(26, 53, 168, 0.4)");
      grad.addColorStop(1, "rgba(44, 95, 246, 0.85)");
      ctx.fillStyle = grad;
      ctx.fill();

      const freshH = Math.min((sharedHistData.glow[i] || 0) * 3.15, h);
      if (freshH > 0.1) {
        ctx.save();
        ctx.clip();

        // Keep chartreuse solid longer to avoid dark-green blending on dark bg
        ctx.fillStyle = "rgba(184, 242, 0, 0.95)";
        ctx.fillRect(x, groundY - h, w, Math.max(freshH * 0.7, 1));

        // Soft feather only at the trailing edge
        if (freshH > 2) {
          const featherH = freshH * 0.4;
          const featherY = groundY - h + freshH - featherH;
          const freshGrad = ctx.createLinearGradient(0, featherY, 0, featherY + featherH);
          freshGrad.addColorStop(0, "rgba(184, 242, 0, 0.9)");
          freshGrad.addColorStop(1, "rgba(184, 242, 0, 0)");
          ctx.fillStyle = freshGrad;
          ctx.fillRect(x, featherY, w, featherH);
        }

        ctx.restore();
      }
    }

    ctx.fillStyle = "rgba(44, 95, 246, 0.42)";
    ctx.fillRect(-item.w * 0.5 + padX, groundY, usableW, 1);
  }

  function drawMotif(ctx, item) {
    if (item.kind === "cell") drawCell(ctx, item);
    if (item.kind === "cyto") drawCyto(ctx, item);
    if (item.kind === "network") drawNetwork(ctx, item);
    if (item.kind === "hist") drawHist(ctx, item);
  }

  function reset(nextWidth, nextHeight) {
    width = Math.max(nextWidth, 1);
    height = Math.max(nextHeight, 1);
    time = 0;

    layoutItems();

    const byKind = {};
    items.forEach(function (item) {
      byKind[item.kind] = item;
    });

    if (byKind.cell) resetCell(byKind.cell);
    if (byKind.cyto) resetCyto(byKind.cyto);
    if (byKind.network) resetNetwork(byKind.network);
    if (byKind.hist) resetHist(byKind.hist);
  }

  function update(dt) {
    time += dt;
    updateCell(dt);
    updateCyto(dt);
    updateNetwork(dt);
    updateHist(dt);
  }

  function draw(ctx) {
    const drawOrder = items.slice().sort(function (a, b) {
      return a.y - b.y;
    });

    drawOrder.forEach(function (item) {
      const dx =
        Math.sin(time * item.driftSpeed + item.driftPhase) * item.driftX;
      const dy =
        Math.cos(time * item.driftSpeed * 0.87 + item.driftPhase * 1.13) *
        item.driftY;

      ctx.save();
      ctx.translate(item.x + dx, item.y + dy);
      ctx.globalAlpha = item.opacity;
      drawMotif(ctx, item);
      ctx.restore();
    });
  }

  return {
    reset: reset,
    update: update,
    draw: draw,
  };
}

function createAnimator(type, rng) {
  if (type === "gene") return createSpatialGenomicsAnimator(rng);
  if (type === "cyto") return createCytoskeletonAnimator(rng);
  if (type === "network") return createSciMLAnimator(rng);
  if (type === "unified") return createUnifiedAnimator(rng);
  return null;
}

function initCanvas(canvasEl, type) {
  const ctx = canvasEl.getContext("2d", { alpha: true });
  if (!ctx) return;

  const seed = hashString(type + "::" + (canvasEl.id || "canvas") + "::" + Date.now());
  const rng = makeRng(seed);
  const animator = createAnimator(type, rng);

  if (!animator) return;

  let width = 0;
  let height = 0;
  let dpr = getCanvasDpr();
  let rafId = 0;
  let running = false;
  let isVisible = true;
  let lastTs = 0;
  let resizeObserver = null;

  function drawFrame(ts) {
    if (!running) return;
    rafId = requestAnimationFrame(drawFrame);

    if (document.hidden) return;

    const minDelta = 1000 / getTargetFps();
    if (lastTs && ts - lastTs < minDelta) return;

    const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016;
    lastTs = ts;

    animator.update(dt);
    ctx.clearRect(0, 0, width, height);
    animator.draw(ctx);
  }

  function renderStatic() {
    // Static representative frame for reduced motion users.
    for (let i = 0; i < 12; i++) animator.update(0.16);
    ctx.clearRect(0, 0, width, height);
    animator.draw(ctx);
  }

  function resize() {
    const parent = canvasEl.parentElement;
    if (!parent) return;

    const newW = Math.max(parent.clientWidth, 1);
    const newH = Math.max(parent.clientHeight, 1);
    const newDpr = getCanvasDpr();

    // Always update canvas pixel dimensions and transform for DPR changes
    canvasEl.width = Math.max(1, Math.round(newW * newDpr));
    canvasEl.height = Math.max(1, Math.round(newH * newDpr));
    ctx.setTransform(newDpr, 0, 0, newDpr, 0, 0);

    // Only regenerate animation state when logical dimensions actually change
    const dimsChanged = newW !== width || newH !== height;
    width = newW;
    height = newH;
    dpr = newDpr;

    if (dimsChanged) {
      animator.reset(width, height);
    }

    if (MotionState.reduced) renderStatic();
  }

  function start() {
    if (running || MotionState.reduced || !isVisible) return;
    running = true;
    lastTs = 0;
    rafId = requestAnimationFrame(drawFrame);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  if (typeof IntersectionObserver !== "undefined") {
    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          isVisible = entry.isIntersecting;
          if (MotionState.reduced) return;
          if (isVisible && !document.hidden) start();
          else stop();
        });
      },
      { threshold: 0.15 },
    );
    observer.observe(canvasEl);
  } else {
    // Older browsers: assume visible and run continuously.
    isVisible = true;
  }

  document.addEventListener("visibilitychange", function () {
    if (MotionState.reduced) return;
    if (document.hidden) stop();
    else if (isVisible) start();
  });

  window.addEventListener("resize", resize);

  if (typeof ResizeObserver !== "undefined" && canvasEl.parentElement) {
    resizeObserver = new ResizeObserver(function () {
      resize();
    });
    resizeObserver.observe(canvasEl.parentElement);
  }

  resize();
  // Guard against delayed layout/style hydration.
  setTimeout(resize, 120);
  setTimeout(resize, 600);

  if (MotionState.reduced) {
    renderStatic();
  } else {
    start();
  }
}

// --- Leaflet Contact Map ---

function initContactMaps() {
  if (typeof L === "undefined") return;

  var mapEls = document.querySelectorAll(".js-contact-map");
  if (!mapEls.length) return;

  var lat = 40.76562;
  var lng = -111.84956;

  mapEls.forEach(function (el) {
    if (el._leaflet_id) {
      el._leaflet_id = null;
    }

    var map = L.map(el, {
      zoomControl: false,
      scrollWheelZoom: false,
      attributionControl: false,
      keyboard: false,
    }).setView([lat, lng], 15);

    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      {
        subdomains: "abcd",
        maxZoom: 20,
      },
    ).addTo(map);

    L.circle([lat, lng], {
      color: "#1a35a8",
      fillColor: "#1a35a8",
      fillOpacity: 0.2,
      radius: 60,
    }).addTo(map);

    var officeMarker = L.circleMarker([lat, lng], {
      radius: 6,
      fillColor: "#1a35a8",
      color: "#101a5b",
      weight: 2,
      opacity: 1,
      fillOpacity: 1,
    })
      .addTo(map)
      .bindPopup("Office: 106 LeRoy Cowles Bldg (LCB)", {
        closeButton: false,
        closeOnClick: false,
        autoClose: false,
        className: "map-label",
        offset: [0, -4],
      })
      .openPopup();

    var mapHoverTarget = el.closest("[data-map-hover]");
    if (mapHoverTarget) {
      var setMarkerHover = function (isHovered) {
        officeMarker.setStyle({
          fillColor: isHovered ? "#b8f200" : "#1a35a8",
          color: isHovered ? "#6d9200" : "#101a5b",
        });
      };

      mapHoverTarget.addEventListener("mouseenter", function () {
        setMarkerHover(true);
      });
      mapHoverTarget.addEventListener("mouseleave", function () {
        setMarkerHover(false);
      });
      mapHoverTarget.addEventListener("focusin", function () {
        setMarkerHover(true);
      });
      mapHoverTarget.addEventListener("focusout", function (event) {
        if (!mapHoverTarget.contains(event.relatedTarget)) {
          setMarkerHover(false);
        }
      });
    }
  });
}

function drawGlyphData(ctx, glyph) {
  const size = ctx.canvas.width;
  ctx.clearRect(0, 0, size, size);
  ctx.fillText(glyph, 2, 1);
  return ctx.getImageData(0, 0, size, size).data;
}

function glyphHasPixels(data) {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return true;
  }
  return false;
}

function glyphDataMatches(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function getGlyphStats(data, width, height) {
  let opaque = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  var colorBuckets = new Set();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const alpha = data[i + 3];
      if (alpha < 16) continue;

      opaque += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const bucket =
        (data[i] >> 5) + "-" + (data[i + 1] >> 5) + "-" + (data[i + 2] >> 5);
      colorBuckets.add(bucket);
    }
  }

  if (opaque === 0) {
    return { opaque: 0, fillRatio: 0, colorBuckets: 0 };
  }

  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;
  return {
    opaque: opaque,
    fillRatio: opaque / Math.max(boxW * boxH, 1),
    colorBuckets: colorBuckets.size,
  };
}

function supportsEmojiGlyph(glyph) {
  const canvas = document.createElement("canvas");
  canvas.width = 40;
  canvas.height = 40;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;

  ctx.textBaseline = "top";
  ctx.font =
    '32px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';

  const glyphData = drawGlyphData(ctx, glyph);
  if (!glyphHasPixels(glyphData)) return false;
  const glyphStats = getGlyphStats(glyphData, canvas.width, canvas.height);
  if (glyphStats.fillRatio < 0.24) return false;
  if (glyphStats.colorBuckets < 3) return false;

  const tofuData = drawGlyphData(ctx, String.fromCodePoint(0x10ffff));
  const replacementData = drawGlyphData(ctx, "\uFFFD");
  const hollowSquareData = drawGlyphData(ctx, "\u25A1");

  return (
    !glyphDataMatches(glyphData, tofuData) &&
    !glyphDataMatches(glyphData, replacementData) &&
    !glyphDataMatches(glyphData, hollowSquareData)
  );
}

function getBeetFallbackSvg() {
  return [
    '<svg class="emoji-fallback-svg" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">',
    '<path fill="#4DA84D" d="M30 8c-7 0-12 6-12 13 6 1 10-1 12-6 2 5 6 7 12 6 0-7-5-13-12-13Z"/>',
    '<path fill="#55B856" d="M19 18c-7 1-11 8-9 15 7 0 11-3 13-9 2 5 7 8 13 8 0-8-6-15-17-14Z"/>',
    '<path fill="#AB1F4F" d="M32 21c-11 0-20 9-20 20s9 21 20 21 20-10 20-21-9-20-20-20Z"/>',
    '<ellipse cx="32" cy="43" rx="13" ry="14" fill="#C92B63"/>',
    '<path fill="#F2EEF5" fill-opacity=".35" d="M25 50c6 2 14 2 21-1-7 6-15 8-23 6-2-1-3-4 2-5Z"/>',
    "</svg>",
  ].join("");
}

function initBeetEmojiFallback() {
  var beetEls = document.querySelectorAll('.emoji-fallback[data-emoji="beet"]');
  if (beetEls.length === 0) return;
  if (supportsEmojiGlyph("🫜")) return;

  beetEls.forEach(function (el) {
    el.classList.add("emoji-svg-fallback");
    el.innerHTML = getBeetFallbackSvg();
  });
}

// --- Page Interactivity ---

document.addEventListener("DOMContentLoaded", function () {
  initBeetEmojiFallback();

  // Initialize animated page background.
  initFluidBackground();

  // Initialize canvases
  document.querySelectorAll("canvas[data-anim]").forEach(function (c) {
    initCanvas(c, c.dataset.anim);
  });

  // Easter-egg tooltips (eBird, Letterboxd)
  document.querySelectorAll(".easter-link[data-tooltip-text]").forEach(function (link) {
    var tip = document.createElement("span");
    tip.className = "easter-tooltip";
    tip.setAttribute("aria-hidden", "true");
    var iconClass = link.getAttribute("data-tooltip-icon");
    if (iconClass) {
      var icon = document.createElement("i");
      icon.className = iconClass + " easter-tooltip-icon";
      tip.appendChild(icon);
    }
    tip.appendChild(document.createTextNode(link.getAttribute("data-tooltip-text")));
    link.appendChild(tip);

    // Keep easter links tactile but subtle.
    link.addEventListener("click", function () {
      haptics.light();
    });
  });

  // Initialize map(s)
  initContactMaps();


  // Hero News toggle
  var newsHeroBtn = document.getElementById("news-toggle-hero");
  var newsHeroHidden = document.querySelectorAll(".hidden-news-hero");

  if (newsHeroBtn) {
    newsHeroBtn.addEventListener("click", function (e) {
      e.preventDefault();
      var isHidden =
        newsHeroHidden[0] && newsHeroHidden[0].classList.contains("hidden");

      newsHeroHidden.forEach(function (el) {
        el.classList.toggle("hidden");
      });

      newsHeroBtn.textContent = isHidden ? "View Less" : "View All";
      haptics.light();

      rebuildSectionOffsets();
      if (typeof updateNav === "function") updateNav();
    });
  }

  // Publications toggle
  var pubsBtn = document.getElementById("pubs-toggle");
  var pubsHidden = document.querySelectorAll(".pub-item.hidden-item");
  var floatingCollapseBtn = document.getElementById("floating-collapse");
  let pubsExpanded = false;
  var setPubsButtonState = function (expanded) {
    if (!pubsBtn) return;
    pubsBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    pubsBtn.innerHTML = expanded
      ? '<span>Show Less</span><i class="fas fa-chevron-up text-[11px]" aria-hidden="true"></i>'
      : '<span>Show All</span><i class="fas fa-chevron-down text-[11px]" aria-hidden="true"></i>';
  };

  if (pubsBtn) {
    setPubsButtonState(false);
    pubsBtn.addEventListener("click", function () {
      var isHidden =
        pubsHidden[0] &&
        pubsHidden[0].classList.contains("hidden-item-collapsed");
      pubsHidden.forEach(function (el) {
        el.classList.toggle("hidden-item-collapsed");
      });
      pubsExpanded = isHidden;
      setPubsButtonState(pubsExpanded);
      haptics.medium();

      rebuildSectionOffsets();
      if (typeof updateNav === "function") updateNav();
    });
  }

  if (floatingCollapseBtn) {
    floatingCollapseBtn.addEventListener("click", function () {
      pubsHidden.forEach(function (el) {
        el.classList.add("hidden-item-collapsed");
      });
      pubsExpanded = false;
      setPubsButtonState(false);

      const pubsSection = document.getElementById("publications");
      if (pubsSection) {
        pubsSection.scrollIntoView({ behavior: "smooth" });
      }
      haptics.medium();

      floatingCollapseBtn.classList.add(
        "opacity-0",
        "pointer-events-none",
        "translate-y-10",
      );
      floatingCollapseBtn.classList.remove(
        "opacity-100",
        "pointer-events-auto",
        "translate-y-0",
      );
    });
  }

  // Group tabs
  var tabCurrent = document.getElementById("tab-current");
  var tabAlumni = document.getElementById("tab-alumni");
  var gridCurrent = document.getElementById("grid-current");
  var gridAlumni = document.getElementById("grid-alumni");
  if (tabCurrent && tabAlumni) {
    tabCurrent.addEventListener("click", function () {
      tabCurrent.classList.remove(
        "text-gray-500",
        "hover:text-[#2c5ff6]",
        "bg-transparent",
        "shadow-none",
      );
      tabCurrent.classList.add(
        "bg-[#2c5ff6]",
        "text-white",
        "shadow-[0_2px_12px_rgba(184,242,0,0.22),0_1px_6px_rgba(44,95,246,0.3)]",
      );

      tabAlumni.classList.add(
        "text-gray-500",
        "hover:text-[#2c5ff6]",
        "bg-transparent",
        "shadow-none",
      );
      tabAlumni.classList.remove(
        "bg-[#2c5ff6]",
        "text-white",
        "shadow-sm",
        "border-b-2",
        "border-[#b8f200]/50",
        "shadow-[0_2px_12px_rgba(184,242,0,0.22),0_1px_6px_rgba(44,95,246,0.3)]",
      );

      gridCurrent.style.display = "grid";
      gridAlumni.style.display = "none";
      gridCurrent.classList.remove("hidden");
      gridAlumni.classList.add("hidden");
      haptics.selection();

      rebuildSectionOffsets();
      if (typeof updateNav === "function") updateNav();
    });
    tabAlumni.addEventListener("click", function () {
      tabAlumni.classList.remove(
        "text-gray-500",
        "hover:text-[#2c5ff6]",
        "bg-transparent",
        "shadow-none",
      );
      tabAlumni.classList.add(
        "bg-[#2c5ff6]",
        "text-white",
        "shadow-[0_2px_12px_rgba(184,242,0,0.22),0_1px_6px_rgba(44,95,246,0.3)]",
      );

      tabCurrent.classList.add(
        "text-gray-500",
        "hover:text-[#2c5ff6]",
        "bg-transparent",
        "shadow-none",
      );
      tabCurrent.classList.remove(
        "bg-[#2c5ff6]",
        "text-white",
        "shadow-sm",
        "border-b-2",
        "border-[#b8f200]/50",
        "shadow-[0_2px_12px_rgba(184,242,0,0.22),0_1px_6px_rgba(44,95,246,0.3)]",
      );

      gridAlumni.style.display = "grid";
      gridCurrent.style.display = "none";
      gridAlumni.classList.remove("hidden");
      gridCurrent.classList.add("hidden");
      haptics.selection();

      rebuildSectionOffsets();
      if (typeof updateNav === "function") updateNav();
    });
  }

  // Publication/resource link feedback (user-initiated only)
  document.querySelectorAll(".pub-action-pill[href]").forEach(function (link) {
    link.addEventListener("click", function () {
      var href = link.getAttribute("href") || "";
      if (/\.pdf($|[?#])/i.test(href)) {
        haptics.success();
      }
    });
  });

  // Smooth scroll for nav links
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener("click", function (e) {
      var href = a.getAttribute("href");
      if (!href || href === "#") return;

      var target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        var isMobileNavLink = a.classList.contains("mobile-nav-link");
        var isDesktopNavLink = a.classList.contains("nav-link");
        if (isMobileNavLink || isDesktopNavLink) {
          haptics.selection();
        }
        target.scrollIntoView({ behavior: "smooth" });
        if (window.location.hash !== href) {
          history.pushState(null, "", href);
        }
      }
    });
  });

  // Sticky Morphing Nav Logic
  const nav = document.getElementById("main-nav");
  const navWrapper = nav ? nav.parentElement : null;
  const allSections = document.querySelectorAll("section, header");
  const navLinks = nav ? nav.querySelectorAll(".nav-link") : [];
  const mobileNavLinks = document.querySelectorAll(".mobile-nav-link");

  // --- Sliding Nav Indicator (Desktop) ---
  var navIndicator = document.getElementById("nav-indicator");
  var navHovered = false; // true while mouse is over a nav link

  function positionIndicator(targetLink, indicator, container) {
    if (!targetLink || !indicator || !container) return;
    var cRect = container.getBoundingClientRect();
    var tRect = targetLink.getBoundingClientRect();
    var originX = cRect.left + container.clientLeft;
    var originY = cRect.top + container.clientTop;
    var newX = tRect.left - originX;
    var newY = tRect.top - originY;
    var newWidth = tRect.width;
    var newHeight = tRect.height;

    // Detect: did the TARGET change, or just the LAYOUT?
    if (indicator._lastTarget !== targetLink) {
      // Target changed (hover or scrollspy) — use CSS transition for smooth slide
      indicator.style.transition = "";
    } else {
      // Same target, layout shifting (nav morph / resize) — snap instantly
      var dx = Math.abs(newX - (indicator._lastX || 0));
      var dy = Math.abs(newY - (indicator._lastY || 0));
      var dw = Math.abs(newWidth - (indicator._lastWidth || 0));
      if (dx > 0.1 || dy > 0.1 || dw > 0.1) {
        indicator.style.transition = "none";
      } else {
        indicator.style.transition = "";
      }
    }

    indicator._lastTarget = targetLink;
    indicator._lastX = newX;
    indicator._lastY = newY;
    indicator._lastWidth = newWidth;

    indicator.style.width = newWidth + "px";
    indicator.style.height = newHeight + "px";
    indicator.style.transform = "translate(" + newX + "px, " + newY + "px)";
  }

  // Keep indicator aligned during nav morph transition and window resize
  if (nav && navIndicator && window.ResizeObserver) {
    var navResizeObserver = new ResizeObserver(function () {
      if (!navHovered && navIndicator) {
        var activeLink = nav.querySelector(".nav-link.active");
        if (activeLink) {
          positionIndicator(activeLink, navIndicator, nav);
        }
      }
    });
    navResizeObserver.observe(nav);
    navLinks.forEach(function (link) {
      navResizeObserver.observe(link);
    });
  }

  if (nav && navIndicator) {
    navLinks.forEach(function (link) {
      link.addEventListener("mouseenter", function () {
        navHovered = true;
        var isActive = link.classList.contains("active");
        positionIndicator(link, navIndicator, nav);
        navIndicator.classList.add("visible");
        navIndicator.classList.toggle("hover-away", !isActive);
        nav.classList.toggle("indicator-hovering", !isActive);
      });
    });
    nav.addEventListener("mouseleave", function () {
      navHovered = false;
      navIndicator.classList.remove("hover-away");
      nav.classList.remove("indicator-hovering");
      var activeLink = nav.querySelector(".nav-link.active");
      if (activeLink) {
        positionIndicator(activeLink, navIndicator, nav);
      } else {
        navIndicator.classList.remove("visible");
      }
    });
  }

  // --- Sliding Nav Indicator (Mobile) ---
  var mobileIndicator = document.querySelector(".mobile-nav-indicator");
  var mobileNavInner = document.querySelector(".mobile-nav-inner");

  function positionMobileIndicator() {
    if (!mobileIndicator || !mobileNavInner) return;
    var activeLink = mobileNavInner.querySelector(".mobile-nav-link.active");
    if (!activeLink) {
      mobileIndicator.classList.remove("visible");
      return;
    }
    var cRect = mobileNavInner.getBoundingClientRect();
    var tRect = activeLink.getBoundingClientRect();
    var originX = cRect.left + mobileNavInner.clientLeft;
    mobileIndicator.style.transform =
      "translateX(" + (tRect.left - originX) + "px) translateY(-50%)";
    mobileIndicator.classList.add("visible");
  }

  // Cache section offsets. These only change on resize / font-swap, so
  // reading them inside the scroll handler forces layout every tick for
  // no reason. Rebuild only when layout could actually have shifted.
  var cachedSectionOffsets = [];
  function rebuildSectionOffsets() {
    cachedSectionOffsets = [];
    allSections.forEach(function (section) {
      if (!section || !section.id) return;
      cachedSectionOffsets.push({ id: section.id, top: section.offsetTop });
    });
  }
  rebuildSectionOffsets();
  window.addEventListener("resize", rebuildSectionOffsets, { passive: true });

  function getCurrentSectionId() {
    let current = "";
    const viewportProgress = window.pageYOffset + window.innerHeight * 0.35;
    for (let i = 0; i < cachedSectionOffsets.length; i++) {
      if (viewportProgress >= cachedSectionOffsets[i].top) {
        current = cachedSectionOffsets[i].id;
      }
    }
    return current;
  }

  function updateNav() {
    // --- Read phase: all layout reads grouped up front. ---
    const currentSection = getCurrentSectionId();
    const navWrapperTop =
      nav && navWrapper ? navWrapper.getBoundingClientRect().top : 0;
    const isScrolled = nav && navWrapper ? navWrapperTop <= 17 : false;
    const isPubsSection = currentSection === "publications";

    // --- Write phase: class toggles + indicator reposition. ---
    if (nav && navWrapper) {
      nav.classList.toggle("nav--scrolled", isScrolled);

      navLinks.forEach((link) => {
        link.classList.toggle(
          "active",
          link.getAttribute("href") === "#" + currentSection,
        );
      });

      if (!navHovered && navIndicator) {
        navIndicator.classList.remove("hover-away");
        nav.classList.remove("indicator-hovering");
        var activeLink = nav.querySelector(".nav-link.active");
        if (activeLink) {
          positionIndicator(activeLink, navIndicator, nav);
          navIndicator.classList.add("visible");
        } else {
          navIndicator.classList.remove("visible");
        }
      }
    }

    mobileNavLinks.forEach((link) => {
      link.classList.toggle(
        "active",
        link.getAttribute("href") === "#" + currentSection,
      );
    });

    positionMobileIndicator();

    if (floatingCollapseBtn) {
      if (pubsExpanded && isPubsSection) {
        floatingCollapseBtn.classList.remove(
          "opacity-0",
          "pointer-events-none",
          "translate-y-10",
        );
        floatingCollapseBtn.classList.add(
          "opacity-100",
          "pointer-events-auto",
          "translate-y-0",
        );
      } else {
        floatingCollapseBtn.classList.add(
          "opacity-0",
          "pointer-events-none",
          "translate-y-10",
        );
        floatingCollapseBtn.classList.remove(
          "opacity-100",
          "pointer-events-auto",
          "translate-y-0",
        );
      }
    }
  }

  // rAF-throttle scroll: coalesces every 120-Hz touch tick into one frame.
  var navScheduled = false;
  function onScrollNav() {
    if (navScheduled) return;
    navScheduled = true;
    requestAnimationFrame(function () {
      navScheduled = false;
      updateNav();
    });
  }

  window.addEventListener("scroll", onScrollNav, { passive: true });
  updateNav();

  // Re-sync after fonts and late layout settling so indicator and cached
  // offsets track final link/section geometry.
  window.addEventListener("load", function () {
    rebuildSectionOffsets();
    updateNav();
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready
      .then(function () {
        rebuildSectionOffsets();
        updateNav();
      })
      .catch(function () {});
  }

  // Group photo carousel
  var carouselIdx = 0;
  var slides = document.querySelectorAll("#group-carousel .carousel-slide");
  var dots = document.querySelectorAll("#group-carousel .carousel-dot");
  var autoTimer = null;

  function showSlide(i) {
    carouselIdx = ((i % slides.length) + slides.length) % slides.length;
    slides.forEach(function (s, j) {
      s.style.opacity = j === carouselIdx ? "1" : "0";
    });
    dots.forEach(function (d, j) {
      var span = d.querySelector("span");
      if (!span) return;
      var active = j === carouselIdx;
      span.style.opacity = active ? "1" : "0.45";
      span.style.transform = active ? "scale(1.25)" : "scale(1)";
      span.style.backgroundColor = active ? "#b8f200" : "#2c5ff6";
    });
  }

  var carouselPaused = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function resetAutoAdvance() {
    if (autoTimer) clearInterval(autoTimer);
    if (carouselPaused) return;
    autoTimer = setInterval(function () {
      showSlide(carouselIdx + 1);
    }, 5000);
  }

  window.carouselNav = function (dir) {
    showSlide(carouselIdx + dir);
    haptics.medium();
    resetAutoAdvance();
  };
  window.carouselGo = function (i) {
    showSlide(i);
    haptics.selection();
    resetAutoAdvance();
  };

  // Mobile tap to toggle captions
  var carouselEl = document.getElementById("group-carousel");
  if (carouselEl) {
    carouselEl.addEventListener("click", function (e) {
      // Don't toggle if clicking arrows or dots
      if (e.target.closest("button")) return;
      carouselEl.classList.toggle("captions-visible");
      haptics.light();
    });
  }

  // Pause on hover/focus for WCAG 2.2.2
  if (carouselEl) {
    carouselEl.addEventListener("mouseenter", function () {
      if (autoTimer) clearInterval(autoTimer);
    });
    carouselEl.addEventListener("mouseleave", function () {
      resetAutoAdvance();
    });
    carouselEl.addEventListener("focusin", function () {
      if (autoTimer) clearInterval(autoTimer);
    });
    carouselEl.addEventListener("focusout", function () {
      resetAutoAdvance();
    });
  }

  if (slides.length > 0) resetAutoAdvance();
});
