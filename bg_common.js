(function () {
  const isPreviewMode = !!(window.location && /(?:\?|&)preview=1(?:&|$)/.test(window.location.search));
  if (isPreviewMode) {
    document.documentElement.classList.add("is-preview");
  }

  const palette = {
    paper: [248, 251, 255],
    paperBlue: [242, 246, 255],
    mint: [184, 222, 209],
    lime: [184, 242, 0],
    softLime: [218, 246, 144],
    blue: [44, 95, 246],
    softBlue: [133, 169, 246],
    navy: [16, 26, 91],
    ink: [26, 33, 80],
  };

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

  function mixColor(a, b, t) {
    return [
      lerp(a[0], b[0], t),
      lerp(a[1], b[1], t),
      lerp(a[2], b[2], t),
    ];
  }

  function rgba(color, alpha) {
    return "rgba(" + Math.round(color[0]) + "," + Math.round(color[1]) + "," + Math.round(color[2]) + "," + alpha + ")";
  }

  function makeRng(seed) {
    let t = seed >>> 0 || 1;
    return function () {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randn(rng) {
    const u = Math.max(rng(), 1e-8);
    const v = Math.max(rng(), 1e-8);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * v);
  }

  function resizeCanvas(canvas, maxDpr) {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr || 1.5);
    const cssW = Math.max(1, window.innerWidth);
    const cssH = Math.max(1, window.innerHeight);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h, cssW, cssH, dpr };
  }

  function makePointer(canvas) {
    const pointer = {
      x: 0.62,
      y: 0.58,
      px: 0.62,
      py: 0.58,
      active: 0,
      energy: 0,
      hover: 0,
      timer: 0,
    };

    canvas.addEventListener("pointerenter", function () {
      pointer.hover = 1;
    }, { passive: true });

    canvas.addEventListener("pointerleave", function () {
      pointer.hover = 0;
      pointer.active = 0;
    }, { passive: true });

    canvas.addEventListener("pointermove", function (event) {
      const rect = canvas.getBoundingClientRect();
      pointer.px = pointer.x;
      pointer.py = pointer.y;
      pointer.x = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      pointer.y = clamp((event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1);
      pointer.hover = 1;
      pointer.active = 1;
      pointer.energy = Math.min(1, pointer.energy + Math.hypot(pointer.x - pointer.px, pointer.y - pointer.py) * 12);
      clearTimeout(pointer.timer);
      pointer.timer = setTimeout(function () {
        pointer.active = 0;
      }, 280);
    }, { passive: true });

    return pointer;
  }

  function relaxPointer(pointer) {
    pointer.energy *= 0.94;
    if (!pointer.active && pointer.energy < 0.02) pointer.energy = 0;
    return pointer;
  }

  function drawSoftBase(ctx, size, time, alpha) {
    const w = size.w;
    const h = size.h;
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#f2f6ff");
    g.addColorStop(0.36, "#f4f8ff");
    g.addColorStop(0.72, "#eff9f4");
    g.addColorStop(1, "#ffffff");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const blobs = [
      [0.76 + Math.sin(time * 0.09) * 0.025, 0.08 + Math.cos(time * 0.08) * 0.018, 0.44, palette.lime, 0.34],
      [0.17 + Math.cos(time * 0.07) * 0.018, 0.16 + Math.sin(time * 0.06) * 0.02, 0.38, palette.blue, 0.12],
      [0.16 + Math.sin(time * 0.06) * 0.02, 0.88 + Math.cos(time * 0.05) * 0.02, 0.42, palette.mint, 0.22],
      [0.86, 0.86, 0.36, palette.softLime, 0.11],
    ];

    blobs.forEach(function (blob) {
      const x = blob[0] * w;
      const y = blob[1] * h;
      const r = blob[2] * Math.max(w, h);
      const radial = ctx.createRadialGradient(x, y, 0, x, y, r);
      radial.addColorStop(0, rgba(blob[3], blob[4]));
      radial.addColorStop(1, rgba(blob[3], 0));
      ctx.fillStyle = radial;
      ctx.fillRect(0, 0, w, h);
    });
    ctx.restore();
  }

  function drawMathDust(ctx, size, time, density) {
    const w = size.w;
    const h = size.h;
    const dpr = size.dpr || 1;
    const step = Math.max(74 * dpr, Math.min(w, h) / 10);
    const glyphs = ["dX", "dt", "L", "nabla", "p(x)", "D", "lambda", "div b=0"];
    ctx.save();
    ctx.font = Math.max(10, 11 * dpr) + "px Inconsolata, ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = rgba(palette.navy, density == null ? 0.06 : density);
    ctx.strokeStyle = rgba(palette.blue, 0.045);
    ctx.lineWidth = 1 * dpr;

    let k = 0;
    for (let y = -step; y < h + step; y += step) {
      for (let x = -step; x < w + step; x += step) {
        const off = Math.sin(k * 1.7 + time * 0.18) * step * 0.12;
        ctx.fillText(glyphs[k % glyphs.length], x + off, y - off * 0.35);
        if (k % 4 === 0) {
          ctx.beginPath();
          ctx.moveTo(x - step * 0.18, y + step * 0.22);
          ctx.quadraticCurveTo(x, y + Math.sin(time * 0.12 + k) * step * 0.08, x + step * 0.22, y - step * 0.08);
          ctx.stroke();
        }
        k++;
      }
    }
    ctx.restore();
  }

  function drawPointerRing(ctx, size, pointer, color, maxRadius) {
    if (!pointer || (!pointer.active && pointer.energy <= 0.01)) return;
    const w = size.w;
    const h = size.h;
    const energy = pointer.active ? Math.max(0.2, pointer.energy) : pointer.energy;
    const x = pointer.x * w;
    const y = pointer.y * h;
    const r = (maxRadius || 90) * (size.dpr || 1) * (0.75 + energy * 0.4);
    ctx.save();
    ctx.strokeStyle = rgba(color || palette.blue, 0.12 + energy * 0.12);
    ctx.lineWidth = Math.max(1, 1.2 * (size.dpr || 1));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function hasReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function showError(message) {
    document.body.innerHTML = '<div class="error">' + message + '</div>';
  }

  window.BgUtils = {
    palette,
    clamp,
    lerp,
    smoothstep,
    mixColor,
    rgba,
    makeRng,
    randn,
    resizeCanvas,
    makePointer,
    relaxPointer,
    drawSoftBase,
    drawMathDust,
    drawPointerRing,
    hasReducedMotion,
    isPreview: function () { return isPreviewMode; },
    showError,
  };
})();
