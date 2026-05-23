/**
 * rd_background.js -- reaction-diffusion site background for v43newbg.
 *
 * Replaces the WebGL fluid-shader background from script.js. Always active.
 * Reuses the existing <canvas id="shader-gradient"> element with a 2D context.
 *
 * Tuning ("v0e lime calm"):
 *   - Labyrinth Gray-Scott on a coarse grid (pixelDiv 11) -- wide corridors
 *   - Stochastic forcing dialed way down (noiseAmp 0.3, ouDecay 0.9992)
 *   - 1-2 sim steps per render frame -- very slow visible motion
 *   - Render: 1 separable 1-2-1 blur pass on V; pale-lime body with a thin
 *     electric-blue contour around each corridor; globalAlpha 0.84
 *
 * For other variants tested during development see bg_ideas/rd_*.html.
 */
(function () {
  // Pointer factory that listens at the window level. The .page-bg wrapper has
  // pointer-events: none, so the canvas itself never sees pointer events.
  function makeWindowPointer() {
    const pointer = {
      x: 0.62, y: 0.58,
      px: 0.62, py: 0.58,
      active: 0, energy: 0, hover: 0, timer: 0,
    };
    function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }
    window.addEventListener("pointermove", function (event) {
      const w = Math.max(1, window.innerWidth);
      const h = Math.max(1, window.innerHeight);
      pointer.px = pointer.x;
      pointer.py = pointer.y;
      pointer.x = clamp01(event.clientX / w);
      pointer.y = clamp01(event.clientY / h);
      pointer.hover = 1;
      pointer.active = 1;
      pointer.energy = Math.min(1, pointer.energy + Math.hypot(pointer.x - pointer.px, pointer.y - pointer.py) * 12);
      clearTimeout(pointer.timer);
      pointer.timer = setTimeout(function () { pointer.active = 0; }, 280);
    }, { passive: true });
    window.addEventListener("pointerleave", function () {
      pointer.hover = 0;
      pointer.active = 0;
    }, { passive: true });
    return pointer;
  }

  function init() {
    const utils = window.BgUtils;
    const RDCommon = window.RDCommon;
    if (!utils || !RDCommon) {
      console.warn("rd_background: bg_common.js or rd_common.js not loaded");
      return;
    }

    const canvas = document.getElementById("shader-gradient");
    if (!canvas) return;

    // Hide the orb fallback in case anything earlier revealed it.
    const fallback = document.getElementById("orb-fallback");
    if (fallback) fallback.hidden = true;
    canvas.style.display = "";

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const pointer = makeWindowPointer();
    const reduced = utils.hasReducedMotion();
    const rng = utils.makeRng(71429);
    const simCanvas = document.createElement("canvas");
    const simCtx = simCanvas.getContext("2d", { willReadFrequently: true });

    const sim = RDCommon.createLabyrinthSim({
      canvas, pointer, rng,
      pixelDiv: 11,
      simBounds: [88, 165, 60, 110],
      noiseAmp: 0.20,
      ouDecay: 0.9996,
      feed: 0.027,    // baseline 0.026 -> nudged toward more topological variety
      // We do the 980-step warmup ourselves, chunked across rAFs (see frame() below),
      // so the load doesn't block the main thread for ~150ms with a blank canvas.
      warmupSteps: 0,
    });

    const WARMUP_TOTAL = 980;
    const WARMUP_PER_FRAME = 24;
    let warmupRemaining = WARMUP_TOTAL;

    let imageData = null;
    let blurBuf0 = null;
    let blurBuf1 = null;
    let t0 = performance.now();
    let last = t0;
    let rafId = 0;

    function buildAll() {
      const prevW = sim.simW;
      const prevH = sim.simH;
      sim.build();
      // Reset warmup any time the sim grid was rebuilt (fresh V/U state).
      if (sim.simW !== prevW || sim.simH !== prevH || !imageData) {
        warmupRemaining = WARMUP_TOTAL;
        simCanvas.width = sim.simW;
        simCanvas.height = sim.simH;
        imageData = simCtx.createImageData(sim.simW, sim.simH);
        blurBuf0 = new Float32Array(sim.simW * sim.simH);
        blurBuf1 = new Float32Array(sim.simW * sim.simH);
      }
      render((performance.now() - t0) / 1000);
    }

    function paintField() {
      const data = imageData.data;
      const simW = sim.simW;
      const simH = sim.simH;
      const V = sim.V;
      const prevX = sim.prevX;
      const nextX = sim.nextX;
      const rowUp = sim.rowUp;
      const rowMid = sim.rowMid;
      const rowDown = sim.rowDown;

      // 1 separable 1-2-1 blur pass on V. Precomputed neighbor tables eliminate
      // the modulo math from the hot loop.
      for (let y = 0; y < simH; y++) {
        const row = rowMid[y];
        for (let x = 0; x < simW; x++) {
          blurBuf1[row + x] = (V[row + prevX[x]] + 2 * V[row + x] + V[row + nextX[x]]) * 0.25;
        }
      }
      for (let y = 0; y < simH; y++) {
        const yu = rowUp[y];
        const yc = rowMid[y];
        const yd = rowDown[y];
        for (let x = 0; x < simW; x++) {
          blurBuf0[yc + x] = (blurBuf1[yu + x] + 2 * blurBuf1[yc + x] + blurBuf1[yd + x]) * 0.25;
        }
      }

      const bodyMix = utils.mixColor(utils.palette.softLime, utils.palette.paperBlue, 0.15);
      const hotMix = utils.mixColor(utils.palette.lime, bodyMix, 0.30);
      const paperBlue = utils.palette.paperBlue;
      const blue = utils.palette.blue;

      for (let y = 0; y < simH; y++) {
        const yu = rowUp[y];
        const yc = rowMid[y];
        const yd = rowDown[y];
        for (let x = 0; x < simW; x++) {
          const xm = prevX[x];
          const xp = nextX[x];
          const i = yc + x;
          const p = i * 4;
          const v = blurBuf0[i];
          const gxv = Math.abs(blurBuf0[yc + xp] - blurBuf0[yc + xm]);
          const gyv = Math.abs(blurBuf0[yd + x] - blurBuf0[yu + x]);
          // sqrt(dx*dx + dy*dy) is meaningfully faster than Math.hypot here and
          // the result is visually identical for these small gradient magnitudes.
          const edge = utils.smoothstep(0.020, 0.10, Math.sqrt(gxv * gxv + gyv * gyv));
          const band = utils.smoothstep(0.080, 0.36, v);
          const hot = utils.smoothstep(0.34, 0.60, v);

          let color = utils.mixColor(paperBlue, bodyMix, band * 0.80);
          color = utils.mixColor(color, hotMix, hot * 0.44);
          color = utils.mixColor(color, blue, edge * 0.16);

          data[p] = color[0];
          data[p + 1] = color[1];
          data[p + 2] = color[2];
          data[p + 3] = 228;
        }
      }
      simCtx.putImageData(imageData, 0, 0);
      ctx.save();
      ctx.globalAlpha = 0.84;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(simCanvas, 0, 0, sim.size.w, sim.size.h);
      ctx.restore();
    }

    function render(time) {
      utils.drawSoftBase(ctx, sim.size, time, 1);
      paintField();
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const time = (now - t0) / 1000;
      if (warmupRemaining > 0) {
        // Chunked warmup: run many small steps across the first ~40 frames so the
        // labyrinth visibly settles in instead of the page hitching on load.
        const n = warmupRemaining < WARMUP_PER_FRAME ? warmupRemaining : WARMUP_PER_FRAME;
        for (let i = 0; i < n; i++) sim.step(false);
        warmupRemaining -= n;
      } else {
        // Steady-state: 1-2 sim steps per frame -- gentle motion, slightly more lively
        // than 1-only after the prior over-slowdown.
        const steps = dt > 0.03 ? 1 : 2;
        for (let i = 0; i < steps; i++) sim.step(true);
      }
      utils.relaxPointer(pointer);
      render(time);
      if (!reduced) rafId = requestAnimationFrame(frame);
    }

    buildAll();

    // Reduced-motion users see only the static first frame. With chunked warmup
    // gating on the rAF loop, that frame would otherwise show the un-warmed seed
    // (ribbons) instead of the settled labyrinth. Run the warmup synchronously
    // for the PRM path and re-render so they get the real bg.
    if (reduced && warmupRemaining > 0) {
      for (let i = 0; i < warmupRemaining; i++) sim.step(false);
      warmupRemaining = 0;
      render((performance.now() - t0) / 1000);
    }

    // Debounce resize so a single drag doesn't fire buildAll() many times.
    // Combined with the dimension-change short-circuit inside buildAll/sim.build,
    // this makes resize feel instant in the common case.
    let resizeTimer = 0;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(buildAll, 150);
    });
    if (!reduced) rafId = requestAnimationFrame(frame);
    window.addEventListener("pagehide", function () {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;  // clear so pageshow can detect that we need to restart
      }
    });
    // Fix 2: bfcache restore -- pagehide cancels rAF, so on back-button restore
    // we have a frozen canvas. Restart the loop if the page was persisted.
    window.addEventListener("pageshow", function (event) {
      if (event.persisted && !reduced && !rafId) {
        last = performance.now();   // reset dt so the first restored frame isn't huge
        rafId = requestAnimationFrame(frame);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
