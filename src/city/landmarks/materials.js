// Materials for the hand-built landmarks: one MeshStandardMaterial whose shader draws the
// stonework per vertex style (see geometry.js STYLE / aStone), so all the landmark masonry
// can share a few draw calls.
//
//   ashlar    Jerusalem limestone in courses of `course` m, stones ~`length` m long with a
//             per-course length and offset, darker mortar joints, per-stone tint, weathering
//             near the ground and rain streaks
//   herodian  the Western Wall: huge stones with a drafted margin (a recessed flat border around
//             a raised boss) in the lower courses
//   lead      grey lead domes and roofs (slightly metallic)
//   wood      planks (the Mughrabi bridge)
//   metal     dark painted iron (fences, gate doors)
//   foliage   caper bushes growing from the Western Wall
//   paving    large square flagstones (platform tops)
// At night the stone is washed by warm floodlights (uNight), as the real walls are.

import * as THREE from 'three';

export function createLandmarkMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  mat.customProgramCacheKey = () => 'landmark-stone-v1';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aStone;
varying vec3 vStone;
varying vec3 vLmPos;
varying vec3 vLmNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vStone = aStone;
  vLmPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vLmNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uNight;
varying vec3 vStone;
varying vec3 vLmPos;
varying vec3 vLmNormal;
float lmHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float lmNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(lmHash(i), lmHash(i + vec2(1, 0)), f.x), mix(lmHash(i + vec2(0, 1)), lmHash(i + vec2(1, 1)), f.x), f.y);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float lmRough = 0.88;
float lmMetal = 0.0;
float lmStone = 0.0;
{
  float style = floor(vStone.z + 0.5);
  vec3 n = normalize(vLmNormal);
  // Coordinates on the face: along it (u) and up (v); tops use x / z.
  bool vertical = abs(n.y) < 0.6;
  vec2 fc = vertical ? vec2(vLmPos.x * -n.z + vLmPos.z * n.x, vLmPos.y) : vLmPos.xz;
  vec2 aa = fwidth(fc) + 1e-4;
  if (style < 1.5) {
    lmStone = 1.0;
    float course = max(vStone.x, 0.2);
    float row = floor(fc.y / course);
    float len = vStone.y * (0.65 + 0.7 * lmHash(vec2(row, 3.1)));
    float u = fc.x / len + lmHash(vec2(row, 9.7));
    float col = floor(u);
    vec2 f = vec2(fract(u), fract(fc.y / course));
    vec2 edge = min(f, 1.0 - f) * vec2(len, course);          // meters to the nearest joint
    float joint = 1.0 - smoothstep(0.012, 0.03 + aa.x * 1.5, min(edge.x, edge.y));
    float h = lmHash(vec2(col, row));
    vec3 tint = mix(vec3(0.93, 0.9, 0.84), vec3(1.05, 1.0, 0.9), h);
    if (h > 0.86) tint *= vec3(1.02, 0.94, 0.8);                // a few honey-coloured stones
    if (h < 0.08) tint *= 0.86;                                 // and some weathered dark ones
    float margin = 0.0;
    if (style > 0.5) {
      // Drafted margin: a flat recessed border ~10 cm wide around the raised boss.
      margin = 1.0 - smoothstep(0.08, 0.12, min(edge.x, edge.y));
      tint *= 1.0 - 0.1 * margin;
    }
    float grain = lmNoise(fc * 3.0) * 0.08 + lmNoise(fc * 17.0) * 0.05;
    float streak = smoothstep(0.55, 1.0, lmNoise(vec2(fc.x * 1.7, fc.y * 0.08))) * 0.12;
    diffuseColor.rgb *= tint * (1.0 - grain - streak);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55, joint * (vertical ? 1.0 : 0.6));
    lmRough = 0.9 - 0.1 * margin;
  } else if (style < 2.5) {
    // Lead: grey, seams every ~0.9 m around the dome, slightly metallic.
    float toSeam = min(fract(fc.x / 0.9), 1.0 - fract(fc.x / 0.9)) * 0.9; // meters to the nearest seam
    float seam = 1.0 - smoothstep(0.01, 0.03 + aa.x, toSeam);
    diffuseColor.rgb *= 0.95 - 0.12 * seam + lmNoise(fc * 2.0) * 0.08;
    lmRough = 0.55;
    lmMetal = 0.35;
  } else if (style < 3.5) {
    float plank = abs(fract(fc.x / 0.18) - 0.5);
    diffuseColor.rgb *= 0.85 + 0.2 * lmNoise(vec2(floor(fc.x / 0.18), fc.y * 0.5)) - 0.25 * (1.0 - smoothstep(0.42, 0.48, plank) );
    lmRough = 0.8;
  } else if (style < 4.5) {
    lmRough = 0.5;
    lmMetal = 0.5;
  } else if (style < 5.5) {
    diffuseColor.rgb *= 0.8 + 0.4 * lmNoise(fc * 6.0);
    lmRough = 0.95;
  } else if (style < 6.5) {
    // Flagstones ~1.2 m square in running bond.
    vec2 g = fc / vec2(1.2, 1.0);
    g.x += 0.5 * mod(floor(g.y), 2.0);
    vec2 f = fract(g);
    float joint = 1.0 - smoothstep(0.015, 0.035, min(min(f.x, 1.0 - f.x) * 1.2, min(f.y, 1.0 - f.y)));
    diffuseColor.rgb *= (0.9 + 0.12 * lmHash(floor(g))) * (1.0 - 0.3 * joint);
    lmRough = 0.85;
    lmStone = 0.5;
  } else {
    lmRough = 1.0; // plain: window and arch openings in shadow
  }
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = lmRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = lmMetal;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  // Warm floodlighting of the stone at night, brighter low on the walls.
  totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.8, 0.55) * uNight * lmStone * 0.55;`);
  };
  return mat;
}
