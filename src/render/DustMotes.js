// Golden-hour dust motes: a few hundred specks drifting in a box around the camera, bright
// when you look toward the sun (forward scattering, the way dust shows up in sunbeams) and
// faint otherwise. One draw call; nothing is updated on the CPU. The box wraps around the
// camera in the vertex shader (each speck's position is taken modulo the box), and each
// speck drifts on its own slow, wavering path.

import * as THREE from 'three';

export class DustMotes {
  /**
   * @param {object} p
   * @param {THREE.Vector3} p.sunDirection  unit vector toward the sun
   * @param {number} [p.count]
   * @param {number} [p.size]  box edge, meters
   */
  constructor({ sunDirection, count = 700, size = 22 }) {
    const pos = new Float32Array(count * 3), seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = Math.random(); pos[i * 3 + 1] = Math.random(); pos[i * 3 + 2] = Math.random();
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.uniforms = {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uSun: { value: sunDirection.clone().normalize() },
      uBox: { value: size },
      uNight: { value: 0 },
      uPixel: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime, uBox, uPixel;
        uniform vec3 uCam, uSun;
        varying float vAlpha;
        varying float vForward;
        void main() {
          // Slow drift (mostly sideways and a little down) plus a per-speck wander.
          vec3 drift = vec3(0.12, -0.035, 0.05) * uTime;
          vec3 wander = 0.35 * vec3(sin(uTime * 0.31 + aSeed * 40.0), sin(uTime * 0.23 + aSeed * 17.0), cos(uTime * 0.27 + aSeed * 29.0));
          vec3 local = fract(position + (drift + wander) / uBox - uCam / uBox) - 0.5;
          vec3 world = uCam + local * uBox;
          vec4 mv = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mv;
          float dist = -mv.z;
          // Fade at the box edges (no popping as specks wrap) and right in front of the lens.
          float edge = 1.0 - smoothstep(0.32, 0.5, max(abs(local.x), max(abs(local.y), abs(local.z))));
          float near = smoothstep(0.6, 2.0, dist);
          vec3 view = normalize(world - cameraPosition);
          vForward = pow(max(dot(view, uSun), 0.0), 6.0);
          vAlpha = edge * near * (0.35 + 0.65 * fract(aSeed * 7.13));
          gl_PointSize = clamp(uPixel * (0.035 + 0.03 * aSeed) / max(dist, 0.1) * 900.0, 1.0, 6.0 * uPixel);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNight;
        varying float vAlpha;
        varying float vForward;
        void main() {
          float r = length(gl_PointCoord - 0.5);
          float soft = 1.0 - smoothstep(0.2, 0.5, r);
          // Daylight: warm specks, much brighter toward the sun. Night: barely there.
          float day = 1.0 - uNight;
          float lum = (0.05 + 0.9 * vForward) * day + 0.025 * uNight;
          gl_FragColor = vec4(vec3(1.0, 0.86, 0.62) * lum * soft * vAlpha, 1.0);
        }`,
    });
    this.object3D = new THREE.Points(geo, this.material);
    this.object3D.name = 'DustMotes';
    this.object3D.frustumCulled = false;
    this.object3D.renderOrder = 10;
  }

  /** @param {THREE.Camera} camera @param {number} time seconds @param {number} pixelRatio */
  update(camera, time, pixelRatio = 1) {
    this.uniforms.uCam.value.copy(camera.position);
    this.uniforms.uTime.value = time;
    this.uniforms.uPixel.value = pixelRatio;
  }

  setNight(t) {
    this.uniforms.uNight.value = t;
  }

  dispose() {
    this.object3D.geometry.dispose();
    this.material.dispose();
  }
}
