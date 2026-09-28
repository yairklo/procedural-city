// The rest of the city beyond the modelled area, so it doesn't sit in a void:
//
// - A distant skyline ring (~1.8 km out): hills covered with low buildings, drawn as one
//   procedural cylinder. By day it is a hazy ridge; by night a dark silhouette with scattered
//   warm windows and an orange street-light glow along its base.
// - A night sky dome: light-polluted orange-brown horizon fading to deep navy, a few stars.
//
// Two draw calls in total. Both are fully procedural (no textures).

import * as THREE from 'three';

const GLSL_HASH = /* glsl */ `
float sHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float sNoise(float x) {
  float i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(sHash(vec2(i, 7.0)), sHash(vec2(i + 1.0, 7.0)), f);
}`;

/**
 * @param {object} o
 * @param {number} [o.radius]        skyline distance (keep below the camera far plane)
 * @param {boolean} [o.followCamera] keep the ring centred on the camera (an "at infinity"
 *                                    backdrop, for worlds larger than the ring)
 */
export function createSurroundings({ scene, center = new THREE.Vector3(), radius = 3300, followCamera = true }) {
  const uniforms = {
    uNight: { value: 0 },
    uFogColor: { value: scene.fog?.color ?? new THREE.Color(0xd4cbbb) },
    uRadius: { value: radius },
  };

  // --- Skyline ring ---------------------------------------------------------------------
  const ringGeo = new THREE.CylinderGeometry(radius, radius, 160, 512, 1, true).translate(0, 50, 0);
  const ringMat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      uniform vec3 uFogColor;
      uniform float uRadius;
      varying vec3 vLocal;
      ${GLSL_HASH}
      void main() {
        float ang = atan(vLocal.z, vLocal.x);            // -pi..pi
        float s = (ang + 3.14159265) * uRadius;          // meters along the ring
        float y = vLocal.y;
        // Rolling Jerusalem hills.
        float hill = 32.0 * sNoise(s / 900.0) + 14.0 * sNoise(s / 260.0 + 3.0) - 12.0;
        // Buildings 10–22 m wide, mostly 3–8 floors, a rare tower.
        float col = floor(s / 16.0);
        float hb = sHash(vec2(col, 1.0));
        float top = hill + 9.0 + 16.0 * hb + step(0.985, sHash(vec2(col, 2.0))) * 45.0;
        if (y > top) discard;
        bool building = y > hill;

        // Windows: 3.2 m floors, 3.5 m bays, ~7% lit; fade to their average when sub-pixel.
        vec2 cell = vec2(s / 3.5, (y - hill) / 3.2);
        vec2 f = fract(cell) - 0.5;
        vec2 aa = fwidth(cell);
        float win = step(abs(f.x), 0.2) * step(abs(f.y), 0.25);
        float lit = step(0.93, sHash(floor(cell) + col * 0.37));
        float fade = smoothstep(0.3, 0.8, max(aa.x, aa.y));
        float windows = building ? mix(win * lit, 0.2 * 0.5 * 0.07, fade) : 0.0;

        // Street lights along the slopes below the rooftops.
        float streets = exp(-max(y - hill, 0.0) / 10.0) * (building ? 0.35 : 0.5);
        streets *= 0.6 + 0.4 * sNoise(s / 40.0);

        vec3 dayStone = building ? vec3(0.62, 0.56, 0.47) * mix(0.85, 1.05, hb) : vec3(0.42, 0.4, 0.3);
        vec3 day = mix(dayStone, uFogColor, 0.72);
        vec3 night = vec3(0.012, 0.012, 0.018)
          + windows * vec3(1.0, 0.62, 0.3) * 1.3
          + streets * vec3(0.9, 0.45, 0.16) * 0.35;
        gl_FragColor = vec4(mix(day, night, uNight), 1.0);
      }`,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.name = 'DistantCity';
  ring.position.copy(center);
  ring.frustumCulled = false;
  scene.add(ring);

  // --- Night sky dome -------------------------------------------------------------------
  const domeMat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    // Opaque render list (so renderOrder puts it before the city), but alpha-blended over the day sky.
    transparent: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      varying vec3 vDir;
      ${GLSL_HASH}
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        // Light pollution: warm glow low on the horizon, deep navy overhead.
        vec3 horizon = vec3(0.16, 0.085, 0.04);
        vec3 zenith = vec3(0.008, 0.012, 0.03);
        vec3 col = mix(horizon, zenith, smoothstep(-0.03, 0.45, h));
        col += vec3(0.05, 0.025, 0.01) * exp(-abs(h) * 18.0);
        // A few stars, washed out near the horizon.
        vec2 g = floor(vec2(atan(d.z, d.x) * 180.0, h * 360.0));
        float star = step(0.9975, sHash(g)) * smoothstep(0.15, 0.5, h);
        col += vec3(0.6, 0.62, 0.7) * star * sHash(g + 3.0);
        gl_FragColor = vec4(col, uNight);
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), domeMat);
  dome.name = 'NightSky';
  dome.renderOrder = -999; // after the day sky (-1000), before everything else
  dome.frustumCulled = false;
  scene.add(dome);

  return {
    uniforms,
    /** Puts the skyline's base at the surrounding terrain level. */
    setBaseHeight(y) {
      ring.position.y = center.y + y;
    },
    setNight(t) {
      uniforms.uNight.value = t;
      dome.visible = t > 0.001;
    },
    update(camera) {
      dome.position.copy(camera.position);
      dome.updateMatrixWorld();
      if (followCamera) {
        ring.position.x = camera.position.x;
        ring.position.z = camera.position.z;
      }
    },
    dispose() {
      scene.remove(ring, dome);
      ringGeo.dispose();
      ringMat.dispose();
      dome.geometry.dispose();
      domeMat.dispose();
    },
  };
}
