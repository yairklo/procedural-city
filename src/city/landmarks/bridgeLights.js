// The Chords Bridge light show. The real bridge carries 14,400 LEDs on 58 of its 66 cables
// and plays short clips and messages on them at night; here the cables are a pixel screen
// too: u across the strings (0 = shortest cable), v along each string (0 = deck, 1 = pylon),
// 248 LEDs per lit string. By day they are plain white steel cables.
//
// Programmes, 16 s each with a 2 s crossfade:
//   0 harp      cool white strings, plucked one by one: a standing wave rings along each
//   1 flag      white with two blue bands and the Star of David outlined in the middle
//   2 wave      blue and white bands sweeping across the strings
//   3 sparks    golden sparks racing up each string toward the pylon
//   4 ripples   golden rings spreading from the middle of the harp over deep blue
// The palette is the city's own: warm white, gold, and the national blue and white (as the
// bridge is lit for national days); no rainbow colours.
//   5 message   "ירושלים · JERUSALEM" scrolling across the strings
// The eight shortest cables carry no lights (58 of 66 lit, as on the bridge).
//
// From afar the cables are thinner than a pixel, so the show would vanish: a glow sheet
// spanning the lit strings plays the same programme, fading in with distance (from ~90 m,
// full at ~350 m), additive and unfogged, so the harp of light reads from across the city.

import * as THREE from 'three';
import { LIT_FOG } from './materials.js';

export const PROGRAMMES = Object.freeze(['harp', 'flag', 'wave', 'sparks', 'ripples', 'message']);
export const PROGRAMME_SECONDS = 16;
export const LEDS_PER_CABLE = 248;
const UNLIT = 8;

/** The programmes as GLSL: cbShow(programme, u, v, t) -> colour, shared by the cables and the far glow. */
const SHOW_GLSL = /* glsl */ `uniform float uNight;
uniform float uLmTime;
uniform sampler2D uText;
varying vec3 vCable;
float cbHash(float x) { return fract(sin(x * 91.345) * 47453.21); }
// Signed distance to an equilateral triangle (point up), radius r.
float cbTri(vec2 p, float r) {
  const float k = 1.7320508;
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}
vec3 cbShow(float prog, float u, float v, float t) {
  float cable = floor(u * 65.0 + 0.5);
  if (prog < 0.5) {
    // Harp: each string plucked in turn; a standing wave rings and decays along it.
    float ph = fract(t / 4.0 + cbHash(cable));
    float ring = exp(-ph * 5.0) * (0.55 + 0.45 * sin(v * 40.0 - ph * 70.0));
    return mix(vec3(0.55, 0.7, 1.0) * 0.35, vec3(1.0, 0.92, 0.75), clamp(ring, 0.0, 1.0));
  } else if (prog < 1.5) {
    // Flag: white, two blue bands, the Star of David outlined in blue.
    vec3 blue = vec3(0.05, 0.25, 1.0);
    float band = step(0.12, v) * step(v, 0.24) + step(0.76, v) * step(v, 0.88);
    vec2 p = vec2((u - 0.5) * 1.25, v - 0.5);
    float star = min(abs(cbTri(p, 0.13)), abs(cbTri(vec2(p.x, -p.y), 0.13)));
    float line = 1.0 - smoothstep(0.012, 0.022, star);
    return mix(vec3(1.0), blue, clamp(band + line, 0.0, 1.0));
  } else if (prog < 2.5) {
    // Blue and white bands sweeping across the strings.
    float w = 0.5 + 0.5 * sin((u * 1.4 - t * 0.12 + v * 0.2) * 6.2832 * 1.5);
    return mix(vec3(0.06, 0.28, 1.0), vec3(1.0, 0.98, 0.94), smoothstep(0.35, 0.65, w));
  } else if (prog < 3.5) {
    // Sparks racing up the strings.
    float s = fract(v * 3.0 - t * 0.6 + cbHash(cable + 3.0));
    float spark = smoothstep(0.9, 1.0, s) + smoothstep(0.55, 1.0, s) * 0.25;
    return vec3(0.05, 0.08, 0.25) + vec3(1.0, 0.62, 0.18) * spark * 1.6;
  } else if (prog < 4.5) {
    float d = length(vec2((u - 0.5) * 1.6, v - 0.55));
    float r = 0.5 + 0.5 * sin(d * 38.0 - t * 5.0);
    return mix(vec3(0.02, 0.08, 0.35), vec3(1.0, 0.8, 0.42), r * r) * (0.35 + 0.65 * (1.0 - clamp(d * 0.9, 0.0, 0.6)));
  }
  // Message scrolling across the strings.
  // Letters stand up toward the pylon (v up), in the wide middle band of the harp.
  float m = texture2D(uText, vec2(fract(u * 0.2 - t * 0.035), clamp((v - 0.18) / 0.55, 0.0, 1.0))).r;
  return mix(vec3(0.02, 0.05, 0.18), vec3(1.0, 0.86, 0.5), m);
}
vec3 cbNow(float u, float v, float T) {
  float slot = floor(T / ${PROGRAMME_SECONDS.toFixed(1)});
  float prog = mod(slot, ${PROGRAMMES.length.toFixed(1)});
  float next = mod(slot + 1.0, ${PROGRAMMES.length.toFixed(1)});
  float f = smoothstep(${(PROGRAMME_SECONDS - 2).toFixed(1)}, ${PROGRAMME_SECONDS.toFixed(1)}, mod(T, ${PROGRAMME_SECONDS.toFixed(1)}));
  return mix(cbShow(prog, u, v, T), cbShow(next, u, v, T), f);
}`;

/** Which programme (and the crossfade into the next) is showing at time t (seconds). */
export function programmeAt(t) {
  const i = Math.floor(t / PROGRAMME_SECONDS) % PROGRAMMES.length;
  const f = t % PROGRAMME_SECONDS;
  return { index: i, name: PROGRAMMES[i], fade: Math.min(1, Math.max(0, (f - (PROGRAMME_SECONDS - 2)) / 2)) };
}

/** The scrolling message as a texture (white on black); a blank 1x1 texture outside a browser. */
function messageTexture() {
  if (typeof document === 'undefined') {
    const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    t.needsUpdate = true;
    return t;
  }
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff';
  g.font = 'bold 92px "Segoe UI", Arial, sans-serif';
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.fillText('ירושלים  ✦  JERUSALEM  ✦', c.width / 2, c.height / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

/**
 * @param {{ top: number[], anchor: number[] }[]} cables  ordered from the shortest to the longest
 * @param {{ uNight: {value:number} }} uniforms
 * @param {{ uLmTime: {value:number} }} show
 * @returns {{ mesh: THREE.Mesh, material: THREE.Material }}
 */
export function createCableLights(cables, uniforms, show, { radius = 0.085, sides = 4, segments = 12 } = {}) {
  const pos = [], nrm = [], cab = [];
  const n = cables.length;
  cables.forEach(({ top, anchor }, k) => {
    const d = [top[0] - anchor[0], top[1] - anchor[1], top[2] - anchor[2]];
    const len = Math.hypot(...d);
    const dir = d.map((v) => v / len);
    const ref = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let a = [dir[1] * ref[2] - dir[2] * ref[1], dir[2] * ref[0] - dir[0] * ref[2], dir[0] * ref[1] - dir[1] * ref[0]];
    const al = Math.hypot(...a);
    a = a.map((v) => v / al);
    const b = [dir[1] * a[2] - dir[2] * a[1], dir[2] * a[0] - dir[0] * a[2], dir[0] * a[1] - dir[1] * a[0]];
    const u = n > 1 ? k / (n - 1) : 0;
    const lit = k >= UNLIT ? 1 : 0;
    const at = (t, s) => {
      const ang = (s / sides) * Math.PI * 2;
      const c = Math.cos(ang), sn = Math.sin(ang);
      const o = [a[0] * c + b[0] * sn, a[1] * c + b[1] * sn, a[2] * c + b[2] * sn];
      return { p: [anchor[0] + d[0] * t + o[0] * radius, anchor[1] + d[1] * t + o[1] * radius, anchor[2] + d[2] * t + o[2] * radius], n: o };
    };
    for (let i = 0; i < segments; i++) {
      const t0 = i / segments, t1 = (i + 1) / segments;
      for (let s = 0; s < sides; s++) {
        const q = [at(t0, s), at(t0, s + 1), at(t1, s + 1), at(t1, s)];
        const vs = [t0, t0, t1, t1];
        for (const idx of [0, 1, 2, 0, 2, 3]) {
          pos.push(...q[idx].p);
          nrm.push(...q[idx].n);
          cab.push(u, vs[idx], lit);
        }
      }
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aCable', new THREE.Float32BufferAttribute(cab, 3));
  geo.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({ color: 0xf2f3f1, roughness: 0.35, metalness: 0.5, side: THREE.DoubleSide });
  const text = messageTexture();
  material.customProgramCacheKey = () => 'chords-leds-v2';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uLmTime = show.uLmTime;
    shader.uniforms.uText = { value: text };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aCable;\nvarying vec3 vCable;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vCable = aCable;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
${SHOW_GLSL}`)
      .replace('#include <fog_fragment>', LIT_FOG)
      .replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
  if (uNight > 0.01 && vCable.z > 0.5) {
    vec3 col = cbNow(vCable.x, vCable.y, uLmTime);
    // Individual LEDs along the string; from afar they merge into a line.
    float led = abs(fract(vCable.y * ${LEDS_PER_CABLE.toFixed(1)}) - 0.5);
    float aa = fwidth(vCable.y * ${LEDS_PER_CABLE.toFixed(1)});
    float dots = mix(1.0 - smoothstep(0.18, 0.32, led), 0.6, smoothstep(0.3, 0.8, aa));
    totalEmissiveRadiance += col * dots * 3.2 * uNight;
    diffuseColor.rgb *= 1.0 - 0.8 * uNight; // the steel itself goes dark behind the LEDs
  }`);
  };
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'Landmark(ChordsBridgeLEDs)';
  mesh.castShadow = true;
  mesh.receiveShadow = false;

  // --- the far glow: a sheet between neighbouring lit strings ----------------------------------
  const gp = [], gc = [];
  const point = (c, t) => [c.anchor[0] + (c.top[0] - c.anchor[0]) * t, c.anchor[1] + (c.top[1] - c.anchor[1]) * t, c.anchor[2] + (c.top[2] - c.anchor[2]) * t];
  for (let k = UNLIT; k + 1 < n; k++) {
    const u0 = k / (n - 1), u1 = (k + 1) / (n - 1);
    for (let i = 0; i < segments; i++) {
      const t0 = i / segments, t1 = (i + 1) / segments;
      const q = [[point(cables[k], t0), u0, t0], [point(cables[k + 1], t0), u1, t0], [point(cables[k + 1], t1), u1, t1], [point(cables[k], t1), u0, t1]];
      for (const idx of [0, 1, 2, 0, 2, 3]) {
        gp.push(...q[idx][0]);
        gc.push(q[idx][1], q[idx][2], 1);
      }
    }
  }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
  gg.setAttribute('aCable', new THREE.Float32BufferAttribute(gc, 3));
  gg.computeBoundingSphere();
  const glowMaterial = new THREE.ShaderMaterial({
    uniforms: { uNight: uniforms.uNight, uLmTime: show.uLmTime, uText: { value: text } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aCable;
      varying vec3 vCable;
      varying float vFade;
      void main() {
        vCable = aCable;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vFade = smoothstep(90.0, 350.0, distance(w.xyz, cameraPosition));
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${SHOW_GLSL}
      varying float vFade;
      void main() {
        if (uNight < 0.01 || vFade < 0.01) discard;
        gl_FragColor = vec4(cbNow(vCable.x, vCable.y, uLmTime) * 0.5 * uNight * vFade, 1.0);
      }`,
  });
  const glow = new THREE.Mesh(gg, glowMaterial);
  glow.name = 'Landmark(ChordsBridgeGlow)';
  glow.castShadow = false;
  glow.receiveShadow = false;
  glow.renderOrder = 5;
  mesh.add(glow);
  return { mesh, material, glowMaterial };
}
