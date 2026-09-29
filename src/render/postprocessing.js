// Post-processing chain (three.js addons, no extra dependencies):
//
//   RenderPass (4x MSAA, half-float HDR)
//   -> GTAO     ground-truth ambient occlusion: contact darkening where walls meet streets,
//               in alleys, courtyards and under roof equipment
//   -> Bloom    halos only around real light sources: by day just the brightest glints (the
//               gold dome, polished paving in low sun) - sunlit stone (~2 in linear HDR)
//               stays below the threshold; at night lanterns (~3), headlights (~4), tail
//               lights and lit shops / windows (~1) glow, floodlit stone (< 0.6) doesn't
//   -> Grade    warm white balance + a little saturation (golden-hour limestone)
//   -> Vignette
//   -> Output   ACES Filmic tone mapping + sRGB (uses renderer.toneMapping / exposure)

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';

export function createPostProcessing(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);

  composer.addPass(new RenderPass(scene, camera));

  // AO is low-frequency: compute it at half resolution (a quarter of the pixels), then the
  // denoised result is blended onto the full-resolution image.
  const AO_SCALE = 0.5;
  const gtao = new GTAOPass(scene, camera, Math.round(size.x * pr * AO_SCALE), Math.round(size.y * pr * AO_SCALE));
  const gtaoSetSize = gtao.setSize.bind(gtao);
  gtao.setSize = (w, h) => gtaoSetSize(Math.max(1, Math.round(w * AO_SCALE)), Math.max(1, Math.round(h * AO_SCALE)));
  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.blendIntensity = 1;
  // Tuned for small objects as well as buildings: a 2.2 m radius spread the occlusion of a
  // 20 cm limb or a bench over meters, so it faded to nothing and people and props looked
  // flat. A tighter radius with a stronger scale and more samples gives crisp contact
  // shading under feet, benches, tree trunks and curbs; alleys and wall/street junctions
  // still darken. Thinner `thickness` stops thin objects occluding what lies behind them.
  gtao.updateGtaoMaterial({
    radius: 1.6, // meters
    distanceExponent: 1.3,
    thickness: 1.0,
    distanceFallOff: 0.85,
    scale: 1.45,
    samples: 16,
    screenSpaceRadius: false,
  });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 12 });
  // GTAO renders the scene again for normals/depth. Without this, that render would also
  // redraw every shadow map (all cascades, all casters) a second time each frame. Objects in
  // `noAO` (particles, additive glows) are hidden from that pass: they have no surface.
  const noAO = [];
  const gtaoRender = gtao.render.bind(gtao);
  gtao.render = (...args) => {
    const auto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    const shown = noAO.map((o) => o.visible);
    for (const o of noAO) o.visible = false;
    try {
      gtaoRender(...args);
    } finally {
      renderer.shadowMap.autoUpdate = auto;
      noAO.forEach((o, i) => (o.visible = shown[i]));
    }
  };
  composer.addPass(gtao);

  // Firefly clamp: a soft cap on single-pixel HDR spikes (a sun glint on one sub-pixel facet)
  // so bloom can't blow them up into flashing halos. Real light sources (LEDs, lanterns,
  // headlights: 3-4) are well below the cap.
  const fireflies = new ShaderPass(FireflyClampShader);
  composer.addPass(fireflies);

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), BLOOM.day.strength, BLOOM.day.radius, BLOOM.day.threshold);
  bloom.highPassUniforms.smoothWidth.value = BLOOM.day.knee; // soft knee: no hard-edged halos
  composer.addPass(bloom);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  const vignette = new ShaderPass(VignetteShader);
  vignette.uniforms.offset.value = 0.95;
  vignette.uniforms.darkness.value = 1.1;
  composer.addPass(vignette);

  composer.addPass(new OutputPass());

  return {
    composer,
    gtao,
    bloom,
    noAO,
    grade,
    vignette,
    enabled: true,
    render(dt) {
      if (this.enabled) composer.render(dt);
      else renderer.render(scene, camera);
    },
    setSize(w, h) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
    /** Night: stronger bloom so lit windows glow. */
    setNight(t) {
      const a = BLOOM.day, b = BLOOM.night, L = THREE.MathUtils.lerp;
      bloom.strength = L(a.strength, b.strength, t);
      bloom.radius = L(a.radius, b.radius, t);
      bloom.threshold = L(a.threshold, b.threshold, t);
      bloom.highPassUniforms.smoothWidth.value = L(a.knee, b.knee, t);
      grade.uniforms.warmth.value = THREE.MathUtils.lerp(1, 0, t);
    },
  };
}

/** Soft luminance cap before bloom (linear HDR): above `limit`, brightness compresses. */
const FireflyClampShader = {
  name: 'FireflyClampShader',
  uniforms: { tDiffuse: { value: null }, limit: { value: 5.0 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float limit;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      if (l > limit) c.rgb *= (limit + log(1.0 + l - limit)) / l;
      gl_FragColor = c;
    }`,
};

/** Bloom by time of day (thresholds are linear-HDR luminance, before exposure). */
export const BLOOM = Object.freeze({
  day: { strength: 0.12, radius: 0.3, threshold: 2.4, knee: 0.6 },
  night: { strength: 0.55, radius: 0.32, threshold: 0.95, knee: 0.35 },
});

/** Linear-HDR color grade applied before tone mapping. */
const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    warmth: { value: 1 },
    saturation: { value: 1.12 },
    tint: { value: new THREE.Vector3(1.06, 1.0, 0.9) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float warmth;
    uniform float saturation;
    uniform vec3 tint;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb * mix(vec3(1.0), tint, warmth);
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = max(mix(vec3(l), col, saturation), 0.0);
      gl_FragColor = vec4(col, c.a);
    }`,
};
