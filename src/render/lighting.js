// Sun, sky and ambient light: a late-afternoon Mediterranean look.
//
// - Physical sky (three's Sky addon) that also feeds the image-based ambient light.
// - Sun from the west-south-west at ~45° elevation, warm #FFF3E0, with Cascaded Shadow
//   Maps: crisp shadows next to the camera, progressively softer (lower texel density)
//   with distance, out to `shadowFar`.
// - Hemisphere fill: soft azure sky (#87CEEB) over a warm limestone bounce (#D2B48C).
// - A day <-> night blend (N key in the demo).

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CSM } from 'three/addons/csm/CSM.js';

export const SUN = Object.freeze({ elevationDeg: 45, azimuthDeg: 250 }); // azimuth: clockwise from north

/** Unit vector toward the sun (+X east, -Z north). */
export function sunDirection({ elevationDeg, azimuthDeg } = SUN) {
  const el = THREE.MathUtils.degToRad(elevationDeg), az = THREE.MathUtils.degToRad(azimuthDeg);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}

const LOOK = {
  day: {
    background: new THREE.Color(0x9fc3dc), fog: new THREE.Color(0xdccfb8), fogNear: 250, fogFar: 1800,
    hemiSky: new THREE.Color(0x87ceeb), hemiGround: new THREE.Color(0xd2b48c), hemi: 0.4,
    sun: new THREE.Color(0xfff3e0), sunIntensity: 3.6, env: 0.2, exposure: 0.78,
  },
  night: {
    background: new THREE.Color(0x0a0f1d), fog: new THREE.Color(0x0e1322), fogNear: 120, fogFar: 1200,
    hemiSky: new THREE.Color(0x2a3656), hemiGround: new THREE.Color(0x16120d), hemi: 0.18,
    sun: new THREE.Color(0x9fb4ff), sunIntensity: 0.3, env: 0.06, exposure: 1.2,
  },
};

export function createLighting({ renderer, scene, camera, shadowFar = 700 }) {
  const dir = sunDirection();

  // Sky dome: follows the camera and is drawn first, behind everything.
  const sky = new Sky();
  sky.scale.setScalar(1000);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  sky.material.depthTest = false;
  sky.material.depthWrite = false;
  const su = sky.material.uniforms;
  su.turbidity.value = 6.5; // dusty late-afternoon haze
  su.rayleigh.value = 1.0;
  su.mieCoefficient.value = 0.004;
  su.mieDirectionalG.value = 0.82;
  su.sunPosition.value.copy(dir);
  scene.add(sky);

  // Image-based ambient light from the same sky.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(1000);
  Object.assign(envSky.material.uniforms.sunPosition.value, dir);
  for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) envSky.material.uniforms[k].value = su[k].value;
  envScene.add(envSky);
  const envTarget = pmrem.fromScene(envScene, 0, 1, 2000);
  scene.environment = envTarget.texture;
  envSky.geometry.dispose();
  envSky.material.dispose();
  pmrem.dispose();

  const hemi = new THREE.HemisphereLight(LOOK.day.hemiSky, LOOK.day.hemiGround, LOOK.day.hemi);
  scene.add(hemi);

  const csm = new CSM({
    camera,
    parent: scene,
    cascades: 4,
    maxFar: shadowFar,
    mode: 'practical',
    shadowMapSize: 2048,
    lightDirection: dir.clone().negate(),
    lightIntensity: LOOK.day.sunIntensity,
    lightNear: 1,
    lightFar: 3000,
    lightMargin: 250,
    shadowBias: -0.00015,
  });
  csm.fade = true;
  for (const light of csm.lights) {
    light.color.copy(LOOK.day.sun);
    light.shadow.normalBias = 0.35;
  }
  csm.updateFrustums();

  scene.fog = new THREE.Fog(LOOK.day.fog.clone(), LOOK.day.fogNear, LOOK.day.fogFar);
  scene.background = LOOK.day.background.clone();

  const patched = new WeakSet();
  return {
    csm,
    hemi,
    sky,
    sunDirection: dir,

    /**
     * Enables cascaded shadows on a material. CSM installs its own onBeforeCompile, so any
     * existing hook (our procedural shaders) is kept and run first.
     */
    setupMaterial(material) {
      if (patched.has(material) || !(material.isMeshStandardMaterial || material.isMeshPhongMaterial || material.isMeshLambertMaterial)) return;
      patched.add(material);
      const own = material.onBeforeCompile;
      csm.setupMaterial(material);
      const csmHook = material.onBeforeCompile;
      material.onBeforeCompile = function (shader, r) {
        own.call(this, shader, r);
        csmHook.call(this, shader, r);
      };
    },

    releaseMaterial(material) {
      csm.shaders.delete(material);
    },

    /** 0 = day, 1 = night. */
    setNight(t) {
      const a = LOOK.day, b = LOOK.night;
      sky.visible = t < 0.5;
      scene.background.lerpColors(a.background, b.background, t);
      scene.fog.color.lerpColors(a.fog, b.fog, t);
      scene.fog.near = THREE.MathUtils.lerp(a.fogNear, b.fogNear, t);
      scene.fog.far = THREE.MathUtils.lerp(a.fogFar, b.fogFar, t);
      hemi.color.lerpColors(a.hemiSky, b.hemiSky, t);
      hemi.groundColor.lerpColors(a.hemiGround, b.hemiGround, t);
      hemi.intensity = THREE.MathUtils.lerp(a.hemi, b.hemi, t);
      for (const light of csm.lights) {
        light.color.lerpColors(a.sun, b.sun, t);
        light.intensity = THREE.MathUtils.lerp(a.sunIntensity, b.sunIntensity, t);
      }
      scene.environmentIntensity = THREE.MathUtils.lerp(a.env, b.env, t);
      renderer.toneMappingExposure = THREE.MathUtils.lerp(a.exposure, b.exposure, t);
    },

    /** Call once per frame after the camera moved. */
    update() {
      sky.position.copy(camera.position);
      sky.updateMatrixWorld();
      csm.update();
    },

    onResize() {
      csm.updateFrustums();
    },
  };
}
