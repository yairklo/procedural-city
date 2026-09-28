// Post-processing chain (three.js addons, no extra dependencies):
//
//   RenderPass (4x MSAA, half-float HDR)
//   -> GTAO     ground-truth ambient occlusion: contact darkening where walls meet streets,
//               in alleys, courtyards and under roof equipment
//   -> Bloom    soft glow only on the brightest highlights (sunlit white stone, lit windows)
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

  const gtao = new GTAOPass(scene, camera, size.x, size.y);
  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.blendIntensity = 1;
  gtao.updateGtaoMaterial({
    radius: 2.2, // meters: wide enough to darken wall/street junctions and narrow alleys
    distanceExponent: 1.5,
    thickness: 1.5,
    distanceFallOff: 1,
    scale: 1.25,
    samples: 16,
    screenSpaceRadius: false,
  });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 16 });
  composer.addPass(gtao);

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.16, 0.45, 1.4);
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
      bloom.strength = THREE.MathUtils.lerp(0.16, 0.45, t);
      bloom.threshold = THREE.MathUtils.lerp(1.4, 0.5, t);
      grade.uniforms.warmth.value = THREE.MathUtils.lerp(1, 0, t);
    },
  };
}

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
