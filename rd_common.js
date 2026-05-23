/**
 * rd_common.js — shared Gray-Scott labyrinth simulation with gentle OU stochasticity.
 *
 * Variants (index_reactiondiffusion.html) all run the same underlying sim and
 * only differ in their render. To retune the simulation globally, change
 * defaults here.
 */
(function () {
  const utils = window.BgUtils;
  if (!utils) throw new Error("rd_common.js requires bg_common.js to be loaded first.");

  function distToSegment(px, py, ax, ay, bx, by) {
    const vx = bx - ax;
    const vy = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const denom = Math.max(1e-6, vx * vx + vy * vy);
    const c = utils.clamp((wx * vx + wy * vy) / denom, 0, 1);
    const dx = px - (ax + vx * c);
    const dy = py - (ay + vy * c);
    return Math.hypot(dx, dy);
  }

  const DEFAULT_RIBBONS = [
    [0.10, 0.18, 0.46, 0.22, 0.045],
    [0.38, 0.18, 0.76, 0.31, 0.042],
    [0.15, 0.45, 0.55, 0.53, 0.050],
    [0.54, 0.50, 0.90, 0.43, 0.044],
    [0.18, 0.77, 0.58, 0.68, 0.048],
    [0.56, 0.77, 0.88, 0.82, 0.044],
  ];

  /**
   * Construct a Gray-Scott labyrinth simulator with subtle OU-correlated noise.
   *
   * opts:
   *   canvas:   HTMLCanvasElement (for resize)
   *   pointer:  pointer state from utils.makePointer
   *   rng:      seeded RNG from utils.makeRng
   *   maxDpr:   maxDpr for resizeCanvas (default 1.5)
   *   pixelDiv: simW = cssW / pixelDiv (default 7)
   *   simBounds:[minW, maxW, minH, maxH] (default [132, 250, 92, 168])
   *   ribbons:  array of [ax, ay, bx, by, width] in [0,1] (default DEFAULT_RIBBONS)
   *   warmupSteps: number of initial sim steps before first paint (default 980)
   *   noiseAmp: scale on OU sigmas (default 1.0; set 0 to disable stochasticity)
   *   pointerEnabled: bool, default true
   */
  function createLabyrinthSim(opts) {
    const canvas = opts.canvas;
    const pointer = opts.pointer;
    const rng = opts.rng;
    const maxDpr = opts.maxDpr || 1.5;
    const pixelDiv = opts.pixelDiv || 7;
    const sb = opts.simBounds || [132, 250, 92, 168];
    const ribbons = opts.ribbons || DEFAULT_RIBBONS;
    const warmupSteps = opts.warmupSteps == null ? 980 : opts.warmupSteps;
    const noiseAmp = opts.noiseAmp == null ? 1.0 : opts.noiseAmp;
    const pointerEnabled = opts.pointerEnabled !== false;

    // Gray-Scott labyrinth regime. baseF / k can be overridden via opts for experiments.
    const Du = 1.0;
    const Dv = 0.47;
    const baseF = opts.feed == null ? 0.026 : opts.feed;
    const k = opts.kill == null ? 0.055 : opts.kill;

    // OU smooth-field forcing (very subtle). Decay closer to 1 = slower drift.
    const ouDecay = opts.ouDecay == null ? 0.996 : opts.ouDecay;
    const ouKick = Math.sqrt(1 - ouDecay * ouDecay);
    const sigmaV = 0.00035 * noiseAmp;
    const sigmaF = 0.00011 * noiseAmp;
    const kickProb = 0.00035 * noiseAmp;
    const kickMag = 0.022;

    const state = {
      size: utils.resizeCanvas(canvas, maxDpr),
      simW: 0,
      simH: 0,
      U: null,
      V: null,
      nextU: null,
      nextV: null,
      noiseGrid: null,
      noiseGridW: 0,
      noiseGridH: 0,
      // Precomputed wraparound neighbor index tables (Int32Array). Eliminate the
      // per-cell modulo + function-call cost of idx(x,y) in the hot loops.
      prevX: null,   // prevX[x] = (x - 1 + simW) % simW
      nextX: null,   // nextX[x] = (x + 1) % simW
      rowUp: null,   // rowUp[y] = ((y - 1 + simH) % simH) * simW
      rowMid: null,  // rowMid[y] = y * simW
      rowDown: null, // rowDown[y] = ((y + 1) % simH) * simW
    };

    function idx(x, y) {
      x = (x + state.simW) % state.simW;
      y = (y + state.simH) % state.simH;
      return y * state.simW + x;
    }

    function build() {
      const prevW = state.simW;
      const prevH = state.simH;
      // Always update the display canvas backing size (cheap -- no sim work).
      state.size = utils.resizeCanvas(canvas, maxDpr);
      const newSimW = utils.clamp(Math.round(state.size.cssW / pixelDiv), sb[0], sb[1]);
      const newSimH = utils.clamp(Math.round(state.size.cssH / pixelDiv), sb[2], sb[3]);
      // Grid dimensions unchanged -- preserve existing sim state, skip the warmup.
      // This makes resize feel instant in the common case where viewport changes
      // don't cross a simBounds clamp threshold.
      if (newSimW === prevW && newSimH === prevH && state.V) return;
      state.simW = newSimW;
      state.simH = newSimH;
      const n = state.simW * state.simH;
      state.U = new Float32Array(n);
      state.V = new Float32Array(n);
      state.nextU = new Float32Array(n);
      state.nextV = new Float32Array(n);
      state.noiseGridW = Math.max(8, Math.round(state.simW / 8));
      state.noiseGridH = Math.max(6, Math.round(state.simH / 8));
      state.noiseGrid = new Float32Array(state.noiseGridW * state.noiseGridH);
      // Build wraparound neighbor lookup tables.
      const simW = state.simW;
      const simH = state.simH;
      state.prevX = new Int32Array(simW);
      state.nextX = new Int32Array(simW);
      for (let x = 0; x < simW; x++) {
        state.prevX[x] = (x - 1 + simW) % simW;
        state.nextX[x] = (x + 1) % simW;
      }
      state.rowUp = new Int32Array(simH);
      state.rowMid = new Int32Array(simH);
      state.rowDown = new Int32Array(simH);
      for (let y = 0; y < simH; y++) {
        state.rowUp[y] = ((y - 1 + simH) % simH) * simW;
        state.rowMid[y] = y * simW;
        state.rowDown[y] = ((y + 1) % simH) * simW;
      }
      seed();
      for (let i = 0; i < warmupSteps; i++) step(false);
    }

    function seed() {
      const simW = state.simW;
      const simH = state.simH;
      const U = state.U;
      const V = state.V;
      for (let y = 0; y < simH; y++) {
        for (let x = 0; x < simW; x++) {
          const i = y * simW + x;
          const nx = x / Math.max(simW - 1, 1);
          const ny = y / Math.max(simH - 1, 1);
          let v = 0;
          for (let ri = 0; ri < ribbons.length; ri++) {
            const r = ribbons[ri];
            const d = distToSegment(nx, ny, r[0], r[1], r[2], r[3]);
            v = Math.max(v, Math.exp(-(d * d) / (r[4] * r[4])) * (0.70 + ri * 0.035));
          }
          const wave = Math.sin(nx * 29 + ny * 13) * Math.sin(ny * 23 - nx * 7) * 0.020;
          v = utils.clamp(v + wave + (rng() - 0.5) * 0.030, 0, 1);
          U[i] = 1 - v * 0.54;
          V[i] = v;
        }
      }
    }

    function step(usePointer) {
      const simW = state.simW;
      const simH = state.simH;
      const U = state.U;
      const V = state.V;
      const nextU = state.nextU;
      const nextV = state.nextV;
      const noiseGrid = state.noiseGrid;
      const noiseGridW = state.noiseGridW;
      const noiseGridH = state.noiseGridH;
      const prevX = state.prevX;
      const nextX = state.nextX;
      const rowUp = state.rowUp;
      const rowMid = state.rowMid;
      const rowDown = state.rowDown;
      const active = pointerEnabled && usePointer && pointer &&
        (pointer.active || pointer.energy > 0.04);

      // Advance OU noise field once per step.
      for (let j = 0; j < noiseGrid.length; j++) {
        noiseGrid[j] = noiseGrid[j] * ouDecay + utils.randn(rng) * ouKick;
      }
      const gridSx = (noiseGridW - 1) / Math.max(simW - 1, 1);
      const gridSy = (noiseGridH - 1) / Math.max(simH - 1, 1);

      for (let y = 0; y < simH; y++) {
        const yu = rowUp[y];
        const ym = rowMid[y];
        const yd = rowDown[y];
        for (let x = 0; x < simW; x++) {
          const xm = prevX[x];
          const xp = nextX[x];
          const i = ym + x;
          const u = U[i];
          const v = V[i];

          // Bilinearly sample OU field.
          const gx = x * gridSx;
          const gy = y * gridSy;
          const gx0 = gx | 0;
          const gy0 = gy | 0;
          const gx1 = gx0 + 1 < noiseGridW ? gx0 + 1 : gx0;
          const gy1 = gy0 + 1 < noiseGridH ? gy0 + 1 : gy0;
          const fx = gx - gx0;
          const fy = gy - gy0;
          const n00 = noiseGrid[gy0 * noiseGridW + gx0];
          const n10 = noiseGrid[gy0 * noiseGridW + gx1];
          const n01 = noiseGrid[gy1 * noiseGridW + gx0];
          const n11 = noiseGrid[gy1 * noiseGridW + gx1];
          const ouSample =
            (n00 * (1 - fx) + n10 * fx) * (1 - fy) +
            (n01 * (1 - fx) + n11 * fx) * fy;

          const localF = baseF + ouSample * sigmaF;
          // 9-point Laplacian with precomputed wraparound neighbors. Operation order
          // is preserved exactly so the float32 result is bit-identical to the
          // previous idx()-based version.
          const lapU =
            0.2 * (U[ym + xp] + U[ym + xm] + U[yd + x] + U[yu + x]) +
            0.05 * (U[yd + xp] + U[yd + xm] + U[yu + xp] + U[yu + xm]) -
            u;
          const lapV =
            0.2 * (V[ym + xp] + V[ym + xm] + V[yd + x] + V[yu + x]) +
            0.05 * (V[yd + xp] + V[yd + xm] + V[yu + xp] + V[yu + xm]) -
            v;
          const reaction = u * v * v;
          let uu = u + Du * lapU - reaction + localF * (1 - u);
          let vv = v + Dv * lapV + reaction - (localF + k) * v;

          // Smooth-field stochastic forcing on V.
          const noiseAmpLocal = Math.sqrt(v + 0.02);
          const ouForce = ouSample * sigmaV * noiseAmpLocal;
          vv += ouForce;
          uu -= ouForce * 0.30;

          // Rare large nucleation events.
          if (v > 0.02 && rng() < kickProb) {
            const kick = (rng() - 0.30) * kickMag;
            vv += kick;
            uu -= kick * 0.25;
          }

          if (active) {
            const nx = x / Math.max(simW - 1, 1);
            const ny = y / Math.max(simH - 1, 1);
            // Aspect-correct the pulse so it appears circular on screen.
            // (Sim grid is rendered stretched to the full viewport, so a circle in
            // normalized sim coords would otherwise appear as an ellipse.)
            const aspect = state.size.cssW / Math.max(state.size.cssH, 1);
            const dx = (nx - pointer.x) * aspect;
            const dy = ny - pointer.y;
            const pulse = Math.exp(-(dx * dx + dy * dy) / 0.0035) * (0.036 + pointer.energy * 0.055);
            vv += pulse;
            uu -= pulse * 0.34;
          }

          nextU[i] = utils.clamp(uu, 0, 1);
          nextV[i] = utils.clamp(vv, 0, 1);
        }
      }
      // Swap buffers.
      const tU = state.U; state.U = state.nextU; state.nextU = tU;
      const tV = state.V; state.V = state.nextV; state.nextV = tV;
    }

    return {
      build,
      step,
      idx,
      get size() { return state.size; },
      get simW() { return state.simW; },
      get simH() { return state.simH; },
      get U() { return state.U; },
      get V() { return state.V; },
      // Expose neighbor lookup tables so paint code in rd_background.js can use the
      // same precomputed indices and skip its own modulo / idx() calls.
      get prevX() { return state.prevX; },
      get nextX() { return state.nextX; },
      get rowUp() { return state.rowUp; },
      get rowMid() { return state.rowMid; },
      get rowDown() { return state.rowDown; },
    };
  }

  window.RDCommon = { createLabyrinthSim, distToSegment };
})();
