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
//   tile      glazed tilework (the Dome of the Rock): the vertex colour is the ground colour,
//             with a repeating star-and-cross pattern in turquoise, white and a darker blue,
//             framed in bands; glossy
//   gold      gold leaf (the Dome of the Rock's dome): metallic, with a faint sky reflection
//             so it reads gold even under the low image-based light
//   marble    veined white-grey marble panels in thin dark frames (lower walls)
// Night lighting (uNight), by the geometry's lighting profile (aLight.y, geometry.js LIGHT):
//   0 wash     a flat warm wash
//   1 sodium   the Old City walls and the Citadel: sodium-yellow uplights at the foot of the
//              wall, bright low and fading with the height above the ground (aLight.x)
//   2 white    the Knesset: cool white floodlighting
//   3 warm     the Temple Mount, the Western Wall, churches: warm white uplighting; floodlit
//              gold glows
//   4 dark     not floodlit (the Mount of Olives cemetery)
// Festival (uFestival, the L key): the walls become a projection screen, as for the Light
// Festival and national days: blue-and-white bands rising, then colour fields sweeping along.

/** Shared by every landmark material: time and the festival switch (LandmarkLayer.update). */
export const createShowUniforms = () => ({ uLmTime: { value: 0 }, uFestival: { value: 0 } });

import * as THREE from 'three';

export function createLandmarkMaterial(uniforms, show = createShowUniforms()) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  mat.customProgramCacheKey = () => 'landmark-stone-v3';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uLmTime = show.uLmTime;
    shader.uniforms.uFestival = show.uFestival;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aStone;
attribute vec2 aLight;
varying vec3 vStone;
varying vec2 vLmLight;
varying vec3 vLmPos;
varying vec3 vLmNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vStone = aStone;
  vLmLight = aLight;
  vLmPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vLmNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uNight;
uniform float uLmTime;
uniform float uFestival;
varying vec3 vStone;
varying vec2 vLmLight;
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
  } else if (style < 7.5) {
    lmRough = 1.0; // plain: window and arch openings in shadow
  } else if (style < 8.5) {
    // Tiles: 0.6 m panels, each a star (turquoise) on a cross (white) over the ground colour,
    // separated by thin light grout; the pattern repeats in every panel.
    vec2 g = fc / 0.6;
    vec2 f = fract(g) - 0.5;
    float grout = 1.0 - smoothstep(0.46, 0.49, max(abs(f.x), abs(f.y)));
    float ang = atan(f.y, f.x);
    float r = length(f);
    float star = 1.0 - smoothstep(0.0, 0.03, r - (0.2 + 0.07 * cos(ang * 8.0)));
    float cross = 1.0 - smoothstep(0.0, 0.03, min(abs(f.x), abs(f.y)) - 0.045);
    float ring = 1.0 - smoothstep(0.0, 0.025, abs(r - 0.33) - 0.02);
    vec3 col = diffuseColor.rgb;
    col = mix(col, vec3(0.93, 0.93, 0.88), cross * 0.9 * (1.0 - star));
    col = mix(col, vec3(0.12, 0.55, 0.62), star);
    col = mix(col, diffuseColor.rgb * 0.55, ring * 0.8);
    col *= 0.94 + 0.1 * lmHash(floor(g));
    diffuseColor.rgb = mix(vec3(0.9, 0.88, 0.82), col, grout);
    lmRough = 0.28;
    lmStone = 0.35;
  } else if (style < 9.5) {
    // Gold leaf: fine sheet seams, a sky tint where the surface faces up.
    float toSeam = min(fract(fc.x / 0.75), 1.0 - fract(fc.x / 0.75)) * 0.75;
    float seam = 1.0 - smoothstep(0.004, 0.02 + aa.x, toSeam);
    diffuseColor.rgb *= 1.0 - 0.1 * seam + 0.05 * lmNoise(fc * 3.0);
    lmRough = 0.3;
    lmMetal = 0.85;
    lmStone = 0.6;
  } else {
    // Marble: panels ~1.3 m wide in thin dark frames, soft grey veins.
    vec2 g = vec2(fc.x / 1.3, fc.y / 2.2);
    vec2 f = fract(g);
    float frame = 1.0 - smoothstep(0.01, 0.025, min(min(f.x, 1.0 - f.x) * 1.3, min(f.y, 1.0 - f.y) * 2.2));
    float vein = smoothstep(0.62, 0.7, lmNoise(fc * vec2(1.4, 0.7) + lmHash(floor(g)) * 11.0));
    vein += 0.5 * smoothstep(0.7, 0.76, lmNoise(fc * 4.0 + 3.0));
    diffuseColor.rgb *= (0.97 + 0.06 * lmHash(floor(g))) * (1.0 - 0.18 * vein) * (1.0 - 0.45 * frame);
    lmRough = 0.35;
    lmStone = 0.8;
  }
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = lmRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = lmMetal;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  // Night floodlighting by profile (see the header).
  {
    float prof = floor(vLmLight.y + 0.5);
    float h = vLmLight.x;
    vec3 lampCol = vec3(1.0, 0.8, 0.55);
    float glow = 0.55;
    if (prof > 0.5 && prof < 1.5) { lampCol = vec3(1.0, 0.64, 0.28); glow = 0.3 + 1.3 * exp(-h / 7.0); }
    else if (prof > 1.5 && prof < 2.5) { lampCol = vec3(0.9, 0.95, 1.0); glow = 0.5 + 0.9 * exp(-h / 14.0); }
    else if (prof > 2.5) { lampCol = vec3(1.0, 0.84, 0.62); glow = 0.35 + 1.0 * exp(-h / 10.0); }
    if (uFestival > 0.001 && prof > 0.5 && prof < 1.5) {
      // Two programmes, 24 s each: the national colours rising up the wall, then colour
      // fields sweeping along it with twinkling points.
      float prog = mod(floor(uLmTime / 24.0), 2.0);
      vec3 fest;
      if (prog < 0.5) {
        float band = smoothstep(0.42, 0.5, abs(fract(vLmPos.y / 5.0 - uLmTime * 0.12) - 0.5) * 2.0);
        fest = mix(vec3(1.0), vec3(0.08, 0.3, 1.0), band);
      } else {
        float hue = fract((vLmPos.x - vLmPos.z) / 140.0 - uLmTime * 0.04);
        fest = clamp(abs(fract(hue + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
        vec2 cell = floor(vec2(vLmPos.x + vLmPos.z, vLmPos.y) / 1.5);
        float tw = step(0.965, lmHash(cell)) * (0.5 + 0.5 * sin(uLmTime * 3.0 + lmHash(cell + 7.0) * 30.0));
        fest += vec3(tw * 2.0);
      }
      lampCol = mix(lampCol, fest * 1.3, uFestival);
      glow = mix(glow, 1.1, uFestival);
    }
    if (prof > 3.5) glow = 0.0;
    totalEmissiveRadiance += diffuseColor.rgb * lampCol * glow * uNight * (prof < 0.5 ? lmStone : max(lmStone, 0.4));
    // Floodlit gold (the Dome of the Rock) blazes at night.
    if (prof > 0.5 && floor(vStone.z + 0.5) == 9.0) totalEmissiveRadiance += diffuseColor.rgb * uNight * 1.3;
  }
  // Gold: the image-based light is weak (and warm-tinted by day), so add a little of the
  // sky the dome would mirror, stronger toward the top.
  if (floor(vStone.z + 0.5) == 9.0) totalEmissiveRadiance += diffuseColor.rgb * (0.22 + 0.2 * max(normalize(vLmNormal).y, 0.0)) * (1.0 - 0.6 * uNight);`);
  };
  return mat;
}
