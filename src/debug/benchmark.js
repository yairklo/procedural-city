// Scripted camera benchmark: open the app with ?bench (optionally ?bench&night).
//
// Flies three fixed 8-second camera paths around the spawn point (street level, rooftop
// level, aerial) and records real frame times plus draw calls / triangles per frame. The
// summary is shown in the HUD, logged to the console and kept on window.benchResult, so
// numbers from different machines and builds can be compared.

const PHASES = [
  { name: 'street', seconds: 8, radius: 22, height: 1.7, lookHeight: 1.7 },
  { name: 'rooftops', seconds: 8, radius: 110, height: 38, lookHeight: 10 },
  { name: 'aerial', seconds: 8, radius: 380, height: 260, lookHeight: 0 },
];
const WARMUP_SECONDS = 2; // let shaders compile and shadow maps settle before measuring

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

export function createBenchmark({ camera, controls, renderer }) {
  let center = null;
  let t = -WARMUP_SECONDS;
  let last = 0;
  const samples = PHASES.map(() => []);
  let result = null;

  return {
    get running() {
      return center !== null && result === null;
    },
    get result() {
      return result;
    },

    start(spawn) {
      center = { x: spawn.x, y: spawn.y, z: spawn.z };
      controls.enabled = false;
      last = performance.now();
    },

    /** Moves the camera for this frame. Call before rendering. */
    update() {
      const now = performance.now();
      const ms = now - last;
      last = now;
      t += ms / 1000;

      let start = 0, phase = 0;
      while (phase < PHASES.length - 1 && t >= start + PHASES[phase].seconds) start += PHASES[phase++].seconds;
      const p = PHASES[phase];
      const a = (Math.max(0, t - start) / p.seconds) * Math.PI * 2;
      camera.position.set(center.x + Math.cos(a) * p.radius, center.y + p.height, center.z + Math.sin(a) * p.radius);
      camera.lookAt(center.x, center.y + p.lookHeight, center.z);
      camera.updateMatrixWorld();
      return { phase, ms, measuring: t >= 0 };
    },

    /** Records the frame just rendered. */
    record(frame) {
      if (!frame.measuring || result) return;
      const info = renderer.info.render;
      samples[frame.phase].push({ ms: frame.ms, calls: info.calls, triangles: info.triangles });
      const total = PHASES.reduce((n, p) => n + p.seconds, 0);
      if (t >= total) result = summarize();
    },
  };

  function summarize() {
    const phases = PHASES.map((p, i) => {
      const s = samples[i];
      const ms = s.map((x) => x.ms).sort((a, b) => a - b);
      const avgMs = ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length);
      return {
        phase: p.name,
        frames: s.length,
        avgFps: +(1000 / avgMs).toFixed(1),
        medianMs: +percentile(ms, 0.5).toFixed(2),
        p95Ms: +percentile(ms, 0.95).toFixed(2),
        onePercentLowFps: +(1000 / percentile(ms, 0.99)).toFixed(1),
        drawCalls: Math.round(s.reduce((a, x) => a + x.calls, 0) / Math.max(1, s.length)),
        trianglesK: Math.round(s.reduce((a, x) => a + x.triangles, 0) / Math.max(1, s.length) / 1000),
      };
    });
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const out = {
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      resolution: `${renderer.domElement.width}x${renderer.domElement.height}`,
      phases,
    };
    controls.enabled = true;
    window.benchResult = out;
    console.table(phases);
    console.info('[bench]', out.gpu, out.resolution);
    return out;
  }
}

/** HUD text for a finished benchmark. */
export function formatBenchmark(r) {
  const rows = r.phases.map(
    (p) => `${p.phase.padEnd(9)} ${String(p.avgFps).padStart(6)} fps · median ${p.medianMs} ms · p95 ${p.p95Ms} ms · 1% low ${p.onePercentLowFps} fps · ${p.drawCalls} calls · ${p.trianglesK}k tris`,
  );
  return `<strong>Benchmark</strong> <span class="dim">${r.gpu} · ${r.resolution}</span>\n${rows.join('\n')}\n<span class="dim">window.benchResult has the numbers · reload without ?bench to play</span>`;
}
