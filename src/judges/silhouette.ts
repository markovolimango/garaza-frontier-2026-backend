import * as THREE from "three";

/** Deep body color + bright rim, both in the tint's hue (grey tints stay grey). */
function paletteFrom(tint: THREE.ColorRepresentation) {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(tint).getHSL(hsl);
  const sat = Math.min(1, hsl.s * 1.1);
  return {
    base: new THREE.Color().setHSL(hsl.h, sat * 0.5, 0.27),
    rim: new THREE.Color().setHSL(hsl.h, sat * 0.7, 0.76),
  };
}

/** Matte silhouette in the tint's hue with a Fresnel rim. `uSpeakGlow` (0..1) brightens the rim while the judge talks. */
export function createSilhouetteMaterial(tint: THREE.ColorRepresentation) {
  const { base, rim } = paletteFrom(tint);
  return new THREE.ShaderMaterial({
    uniforms: {
      uBase: { value: base },
      uRim: { value: rim },
      uRimPower: { value: 3.0 },
      uSpeakGlow: { value: 0 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <skinning_pars_vertex>
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <defaultnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        vN = normalize(transformedNormal);
        vV = normalize(-mvPosition.xyz);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uBase;
      uniform vec3 uRim;
      uniform float uRimPower;
      uniform float uSpeakGlow;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec3 n = normalize(vN);
        float fres = pow(1.0 - clamp(dot(n, normalize(vV)), 0.0, 1.0), uRimPower);
        float matte = 0.55 + 0.45 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = uBase * matte + uRim * fres * (0.42 + 1.4 * uSpeakGlow) + uRim * 0.06 * uSpeakGlow;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}
