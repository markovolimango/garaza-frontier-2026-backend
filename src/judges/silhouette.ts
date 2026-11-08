import * as THREE from "three";

/** Dark matte silhouette with a Fresnel rim. `uSpeakGlow` (0..1) brightens the rim while the judge talks. */
export function createSilhouetteMaterial(base: THREE.ColorRepresentation, rim: THREE.ColorRepresentation = "#9fc4ff") {
  return new THREE.ShaderMaterial({
    uniforms: {
      uBase: { value: new THREE.Color(base) },
      uRim: { value: new THREE.Color(rim) },
      uRimPower: { value: 2.6 },
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
        vec3 col = uBase * matte + uRim * fres * (0.45 + 1.8 * uSpeakGlow);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}
