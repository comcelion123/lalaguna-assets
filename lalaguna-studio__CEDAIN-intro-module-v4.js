/* ============================================================================
   lalaguna.studio — CEDAIN glass intro
   Pre-entry gate: refractive glass wordmark, camera fly-through, slide reveal.

   Usage (from the footer dispatcher, data-page="cedain"):
     CEDAIN_GLASS_INTRO.mount({ fontURL: '<neoda typeface json url>' })
       .then(() => { ... page is revealed ... });

   Rendering model (a Three.js port of the two-surface idea in the reference):
     pass 1  back faces  -> RGBA float target: world normal (xyz) + view depth (w)
     pass 2  front faces -> refract at entry, screen-space march along the
             refracted ray against pass-1 depth to find the exit surface,
             refract out (or TIR), sample env. Three IORs for dispersion.
             Camera inside the glass is handled by the back-facing branch.
     env     procedural sky / sun / clouds / mirror sea rendered once to a
             half-float cubemap. AgX tonemap on output.
   land    (v4) the surround as a live scene: the Bogota terrain, the city at
             night and its traffic, the Canal Valley sketch overhead listening
             to the music, the glass over it lit by searchlights, and the
             viewer on foot on the Cerros Orientales. See "the land" below.
   film    (v3) the surround as a looping video instead of a cubemap: the
             Bogota flight's last seconds over the city at night, the traffic
             running under the letters. It is a flat plate, so it is mapped
             from the camera's own view - the city stays below the word
             however the viewer orbits - and the glass refracts it through
             the same mapping, so what is seen through a letter is the plate
             behind it, bent.
   ========================================================================== */
window.CEDAIN_GLASS_INTRO = (function () {
  'use strict';

  const DEFAULTS = {
    text: 'CEDAIN',
    // Replace with the Neoda typeface (see tools/woff-to-typeface.py). Fallback keeps the gate working.
    fontURL: 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/fonts/helvetiker_bold.typeface.json',
    fontJSON: null,                   // inline typeface object; wins over fontURL
    threeURL: 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',

    controls: true,                   // let the viewer orbit after the flight
    settleDuration: 1400,             // flight -> orbit handoff, ms
    driftDelay: 2600,                 // idle before the slow auto-orbit resumes, ms
    driftSpeed: 0.055,                // rad/sec
    duration: 9500,                   // flight, ms
    leaveDuration: 1100,              // slide reveal, ms
    oncePerSession: true,
    sessionKey: 'cedain-intro-seen',
    skipOnInput: true,
    respectReducedMotion: true,

    // glass
    ior: 1.45,
    dispersion: 0.045,                // IOR spread red<->blue
    fresnelIOR: 1.7,                  // matches the reference Glass BSDF fresnel
    roughness: 0.008,
    tint: [1.0, 1.0, 1.0],
    marchSteps: 24,                   // desktop; mobile is halved
    letterSize: 1.0,
    letterSpacing: 0.02,
    depth: 0.34,
    bevel: 0.035,

    // environment
    sky: {
      zenith:   '#0733B4',
      horizon:  '#9BEAF7',
      sea:      '#04197F',
      cloud:    '#FFFFFF',
      sunDir:   [0.45, 0.42, -0.55],
      sunPower: 9.0,
      exposure: 0.88,
      cloudCover: 0.46,
    },

    // THE ENVIRONMENT. With env.base set, the gate stands in the Unreal
    // panorama (the lalaguna view from the mountains) with the lattice drawing
    // in its sky, instead of the procedural sky below. The footer passes its
    // LALA_CONFIG.env here. envExposure lifts the tonemapped panorama back up
    // after it has been linearised for the glass and the AgX output.
    env: null,
    envExposure: 1.55,

    // THE FILM (v3). With film set, neither env nor sky is used: the gate
    // stands over the city from the Bogota flight, looping. The footer passes
    // LALA_CONFIG.cedainFilm here.
    //   src / srcMobile  the loop (h264 mp4), full size and phone size
    //   poster           a frame of it, shown until the video has data and
    //                    kept if it never gets any
    //   aspect           width over height of the plate
    //   horizon          where the horizon sits in the plate, 0..1 from the bottom
    //   anchor           where that horizon should sit on screen, 0..1 from the
    //                    bottom - the letters hang at the centre, so this is
    //                    how much city shows beneath them
    //   exposure         lift after the plate is linearised for the glass
    film: null,

    // THE LAND (v4). With land set (and a mouse and keyboard), the gate is a
    // walk on the mountains above the city, the glass CEDAIN over the plain.
    // The footer passes LALA_CONFIG.cedainLand. Phones fall through to film.
    land: null,
    walk: { WALK: 4.3, RUN: 7.0, JUMP: 8.1, G: 25, EYE: 1.7 },   // Minecraft's feel: 4.3 m/s, a 1.25 m jump that lands in 0.63 s (8.1 lands the apex at 1.25 once the frame steps are counted)

    debug: false,          // true = flat normal-shaded mesh, to check geometry/camera without the glass shader
    ink: '#08090C',
    zIndex: 99999,
    onDone: null,
  };

  /* ------------------------------------------------------------ shaders */

  const SKY_FRAG = /* glsl */`
    varying vec3 vDir;
    uniform vec3 uZenith, uHorizon, uSea, uCloud, uSunDir;
    uniform float uSunPower, uCover;

    float hash(vec3 p){ p = fract(p*0.3183099 + vec3(0.1,0.2,0.3)); p *= 17.0;
      return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
    float vnoise(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);
      return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),
                     mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                 mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                     mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
    float fbm(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<6;i++){ s+=a*vnoise(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=0.5; } return s; }

    vec3 skyAbove(vec3 d){
      float h = clamp(d.y, 0.0, 1.0);
      vec3 col = mix(uHorizon, uZenith, pow(h, 0.55));
      float sd = max(dot(d, uSunDir), 0.0);
      col += vec3(1.0, 0.97, 0.9) * (pow(sd, 6.0)*0.35 + pow(sd, 48.0)*0.6);
      col += vec3(1.0, 0.98, 0.94) * pow(sd, 1400.0) * uSunPower;
      // clouds on a flattened dome
      vec3 p = d / max(d.y, 0.06);
      float n = fbm(p*0.9 + vec3(3.0, 0.0, 7.0));
      float c = smoothstep(1.0-uCover, 1.0-uCover+0.32, n);
      c *= smoothstep(0.0, 0.16, d.y);
      float shade = 0.72 + 0.28*fbm(p*2.6 + 4.0);
      vec3 cl = uCloud * shade * (0.9 + 0.5*pow(sd, 3.0));
      return mix(col, cl, c);
    }

    // base AgX is flatter than Blender's Medium High Contrast look; put the
    // contrast and saturation back before the cubemap is written
    vec3 punch(vec3 c){
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, 1.42);
      return max(vec3(0.0), (c - 0.5) * 1.28 + 0.5);
    }

    void main(){
      vec3 d = normalize(vDir);
      vec3 col;
      if (d.y >= 0.0) col = skyAbove(d);
      else {
        vec3 r = vec3(d.x, -d.y, d.z);
        vec3 refl = skyAbove(r);
        float f = pow(1.0 - clamp(-d.y, 0.0, 1.0), 5.0);      // grazing = mirror, steep = water
        vec3 deep = uSea * (0.42 + 0.38*smoothstep(-1.0, 0.0, d.y));
        col = mix(deep, refl, 0.10 + 0.90*f);
      }
      gl_FragColor = vec4(punch(col), 1.0);
    }`;

  // the environment sphere, shared word for word with the footer's buildEnvBg
  const ENV_FRAG_LINES = [
    'precision highp float;',
    'varying vec3 vDir;',
    'uniform sampler2D uPano, uMask, uLattice, uValley;',
    'uniform float uHasPano, uHasMask, uHasLattice, uHasValley;',
    'uniform float uT, uLatGain, uLatGlow, uYaw, uGain, uFallback;',
    'uniform vec3 uInk, uChamb, uCham, uShell, uDusk;',
    /* equirect, as pano_assemble.py wrote it: longitude from UE +X toward
       UE +Y, which in the site's frame (x east, y up, z south) is
       atan(z, x); latitude up. flipY on load puts row 0 at v = 1. */
    'vec2 eq(vec3 d){ return vec2(atan(d.z, d.x) / 6.2831853 + 0.5 + uYaw, asin(clamp(d.y, -1.0, 1.0)) / 3.1415927 + 0.5); }',
    /* the drawing, with its poles on the horizon so straight up is clean,
       and its two ends cross-faded where they meet */
    'vec2 latUV(vec3 d){ return vec2(atan(d.y, d.z) / 6.2831853 + 0.5, asin(clamp(d.x, -1.0, 1.0)) / 3.1415927 + 0.5); }',
    'float lat2(vec2 uv, float bias){',
    '  float u0 = fract(uv.x);',
    '  float w0 = smoothstep(0.0, 0.17, min(u0, 1.0 - u0));',
    '  float vy = clamp(uv.y, 0.003, 0.997);',
    '  float A = texture2D(uLattice, vec2(u0, vy), bias).r;',
    '  float B = texture2D(uLattice, vec2(fract(u0 + 0.5), vy), bias).r;',
    '  return mix(B, A, w0);',
    '}',
    'void main(){',
    '  vec3 d = normalize(vDir);',
    '  vec2 uv = eq(d);',
    '  vec3 base; float sky;',
    '  if (uHasPano > 0.5) {',
    '    base = texture2D(uPano, uv).rgb * uGain;',
    '    sky = (uHasMask > 0.5) ? texture2D(uMask, uv).r : smoothstep(0.0, 0.08, d.y);',
    '  } else if (uFallback > 0.5) {',
    /* no panorama yet and something else (the hydra valley) is drawing
       underneath: paint nothing but the lattice, with alpha */
    '    base = vec3(0.0);',
    '    sky = smoothstep(-0.05, 0.10, d.y);',
    '  } else {',
    /* no panorama yet, opaque: ink, a dusk band at the horizon, the ground dark */
    '    float h = d.y;',
    '    base = mix(uDusk, uInk, smoothstep(-0.02, 0.5, h));',
    '    base = mix(uInk * 0.7, base, smoothstep(-0.12, 0.01, h));',
    '    sky = smoothstep(0.0, 0.06, h);',
    '  }',
    '  if (uHasLattice > 0.5) {',
    '    vec2 lu = latUV(d);',
    '    lu.x += uT * 0.0015;',
    '    if (uHasValley > 0.5) {',
    '      vec2 fld = texture2D(uValley, vec2(fract(lu.x), clamp(lu.y, 0.003, 0.997))).gb;',
    '      lu += (fld - 0.5) * 2.0 * 0.012 * (0.6 + 0.4 * sin(uT * 0.21));',
    '    }',
    '    float ln = lat2(lu, 0.0);',
    '    float halo = lat2(lu, 3.5);',
    '    vec3 lines = mix(uChamb, uCham, smoothstep(0.35, 0.95, ln)) * ln * uLatGain',
    '               + uShell * smoothstep(0.75, 1.0, ln) * 0.35 * uLatGain',
    '               + uChamb * halo * uLatGlow;',
    '    base += lines * sky;',
    '  }',
    /* premultiplied: in the transparent mode the light IS the coverage */
    '  float a = (uHasPano > 0.5 || uFallback < 0.5) ? 1.0 : clamp(max(base.r, max(base.g, base.b)), 0.0, 1.0);',
    '  gl_FragColor = vec4(base, a);',
    '}'
  ];
  // the cube pass needs LINEAR light for the glass and the AgX output: the
  // panorama is a tonemapped sRGB jpeg, so it is decoded on the way in
  const ENV_FRAG = ENV_FRAG_LINES.join('\n')
    .replace('gl_FragColor = vec4(base, a);',
             'base = pow(max(base, 0.0), vec3(2.2)) * uExposure; gl_FragColor = vec4(base, 1.0);')
    .replace('uniform float uT, uLatGain, uLatGlow, uYaw, uGain, uFallback;',
             'uniform float uT, uLatGain, uLatGlow, uYaw, uGain, uFallback, uExposure;');

  function loadTex(THREE, url) {
    return new Promise(resolve => {
      const tl = new THREE.TextureLoader(); tl.setCrossOrigin('anonymous');
      tl.load(url, t => { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; resolve(t); },
              undefined, () => { console.warn('[cedain-intro] env texture missing:', url); resolve(null); });
    });
  }

  const SKY_VERT = /* glsl */`
    varying vec3 vDir;
    void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

  // the film as the backdrop: a screen-filling quad through the same plate
  // mapping the glass uses, so the view through a letter lines up with the
  // view beside it
  const FILM_BG_VERT = /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }`;
  const FILM_BG_FRAG = /* glsl */`
    varying vec2 vUv;
    uniform sampler2D uFilm;
    uniform vec4 uPlate;
    void main(){
      vec2 uv = vec2(0.5 + (vUv.x - 0.5) / uPlate.x, (vUv.y - uPlate.z) / uPlate.y);
      uv = 1.0 - abs(fract(uv * 0.5) * 2.0 - 1.0);
      // the frame as it was graded, straight to the screen: the glass alone
      // sees it linearised, through its own exposure
      gl_FragColor = vec4(texture2D(uFilm, uv).rgb, 1.0);
    }`;

  const BACK_VERT = /* glsl */`
    varying vec3 vN; varying float vD;
    void main(){
      vN = normalize(mat3(modelMatrix) * normal);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vD = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`;
  const BACK_FRAG = /* glsl */`
    varying vec3 vN; varying float vD;
    void main(){ gl_FragColor = vec4(normalize(vN), vD); }`;

  const GLASS_VERT = /* glsl */`
    varying vec3 vP; varying vec3 vN;
    void main(){
      vP = (modelMatrix * vec4(position, 1.0)).xyz;
      vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * vec4(vP, 1.0);
    }`;

  const GLASS_FRAG = /* glsl */`
    varying vec3 vP; varying vec3 vN;
    // three injects viewMatrix and cameraPosition into the fragment prefix but NOT
    // projectionMatrix (vertex-only), so declare it here or the program won't compile.
    uniform mat4 projectionMatrix;
    uniform samplerCube uEnv;
    uniform sampler2D uBack;
    uniform vec3 uTint;
    uniform float uIor, uDisp, uF0, uMaxThick;

    #ifdef FILM
    // The plate, mapped from the camera's view: a direction becomes the
    // screen position it would land on and that becomes a point on the
    // plate, fitted to cover the screen with the horizon pinned where the
    // footer asked for it. Past the frame the plate mirrors, so a ray bent
    // out of the picture still sees sky or city rather than an edge.
    uniform sampler2D uFilm;
    uniform vec4 uPlate;   // x plate width in screen widths, y height in screen heights, z bottom edge (screen, from the bottom), w exposure
    uniform vec2 uTan;     // tan of half the field of view, horizontal and vertical
    vec3 plate(vec2 s){
      vec2 uv = vec2(0.5 + (s.x - 0.5) / uPlate.x, (s.y - uPlate.z) / uPlate.y);
      uv = 1.0 - abs(fract(uv * 0.5) * 2.0 - 1.0);
      // read a little down the mip chain: a bent ray through thick glass
      // averages the city's thousand lights rather than picking one, which is
      // the difference between glass and glitter
      vec3 c = texture2D(uFilm, uv, 2.5).rgb;
      return pow(max(c, vec3(0.0)), vec3(2.2)) * uPlate.w;
    }
    vec3 env(vec3 d){
      vec3 c = mat3(viewMatrix) * d;
      float z = max(abs(c.z), 0.05);
      return plate(vec2(0.5 + 0.5 * (c.x / z) / uTan.x, 0.5 + 0.5 * (c.y / z) / uTan.y));
    }
    #else
    vec3 env(vec3 d){ return textureCube(uEnv, d).rgb; }
    #endif

    float viewDepth(vec3 P){ return -(viewMatrix * vec4(P, 1.0)).z; }
    vec2 screenUV(vec3 P){ vec4 c = projectionMatrix * viewMatrix * vec4(P, 1.0); return c.xy / c.w * 0.5 + 0.5; }

    // March from P0 along T until we pass the nearest back face. Returns distance, or -1.
    float marchExit(vec3 P0, vec3 T, out vec3 Nb){
      float stepLen = uMaxThick / float(STEPS);
      float tPrev = 0.0;
      vec4 b = vec4(0.0);
      for (int i = 1; i <= STEPS; i++) {
        float t = float(i) * stepLen;
        vec3 P = P0 + T * t;
        vec2 uv = screenUV(P);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
        b = texture2D(uBack, uv);
        if (b.w > 0.0 && viewDepth(P) >= b.w) {
          float lo = tPrev, hi = t;
          for (int j = 0; j < 4; j++) {
            float mid = 0.5 * (lo + hi);
            vec3 Pm = P0 + T * mid;
            vec4 bm = texture2D(uBack, screenUV(Pm));
            if (bm.w > 0.0 && viewDepth(Pm) >= bm.w) { hi = mid; b = bm; } else lo = mid;
          }
          Nb = normalize(b.xyz);
          return hi;
        }
        tPrev = t;
      }
      return -1.0;
    }

    // one wavelength through the solid; dist<0 means "no exit found" (thin-plate fallback)
    vec3 throughGlass(vec3 V, vec3 N, vec3 P0, float ior, float dist, vec3 Nb){
      vec3 T = refract(V, N, 1.0 / ior);
      if (dot(T, T) < 1e-6) return env(reflect(V, N));
      vec3 outDir;
      if (dist < 0.0) {
        outDir = refract(T, -N, ior);              // parallel plate: exits along V
        if (dot(outDir, outDir) < 1e-6) outDir = V;
      } else {
        outDir = refract(T, -Nb, ior);
        if (dot(outDir, outDir) < 1e-6) {          // total internal reflection
          vec3 R = reflect(T, -Nb);
          vec3 o2 = refract(R, N, ior);            // second try through the front plate
          if (dot(o2, o2) < 1e-6) return env(R) * 0.55;
          return env(o2) * 0.92;
        }
      }
      return env(outDir);
    }

    void main(){
      vec3 N = normalize(vN);
      vec3 V = normalize(vP - cameraPosition);
      vec3 col;

      if (gl_FrontFacing) {
        float cosT = clamp(dot(-V, N), 0.0, 1.0);
        float F = uF0 + (1.0 - uF0) * pow(1.0 - cosT, 5.0);
        vec3 refl = env(reflect(V, N));

        // march once at the centre IOR, reuse the path length for the other two
        vec3 Nb = -N;
        vec3 Tg = refract(V, N, 1.0 / uIor);
        float dist = (dot(Tg, Tg) < 1e-6) ? -1.0 : marchExit(vP, Tg, Nb);

        vec3 r = throughGlass(V, N, vP, uIor - uDisp, dist, Nb);
        vec3 g = throughGlass(V, N, vP, uIor,         dist, Nb);
        vec3 b = throughGlass(V, N, vP, uIor + uDisp, dist, Nb);
        vec3 refr = vec3(r.r, g.g, b.b) * uTint;

        col = mix(refr, refl, F);
        #ifdef LIT
        // Over the night city the glass would go black; the film lit its
        // mark with searchlights from the ground, so the same lights play
        // on this one: three icy beams from below and in front, as narrow
        // highlights, and a cold rim where the glass turns away.
        vec3 R = reflect(V, N);
        vec3 L1 = normalize(vec3(-0.55, -0.80, 0.55)), L2 = normalize(vec3(0.0, -0.92, 0.40)), L3 = normalize(vec3(0.55, -0.80, 0.55));
        vec3 icy = vec3(0.62, 0.78, 1.00), cold = vec3(0.86, 0.90, 1.00);
        col += icy  * (max(dot(N, L1), 0.0) * 0.13 + pow(max(dot(R, L1), 0.0), 24.0) * 0.45);
        col += cold * (max(dot(N, L2), 0.0) * 0.15 + pow(max(dot(R, L2), 0.0), 24.0) * 0.50);
        col += icy  * (max(dot(N, L3), 0.0) * 0.13 + pow(max(dot(R, L3), 0.0), 24.0) * 0.45);
        col += vec3(0.42, 0.58, 0.86) * pow(1.0 - cosT, 3.0) * 0.16;
        #endif
      } else {
        // camera is inside the solid: this is an exit surface
        vec3 Ni = -N;
        float cosT = clamp(dot(-V, Ni), 0.0, 1.0);
        float F = uF0 + (1.0 - uF0) * pow(1.0 - cosT, 5.0);
        vec3 outR = refract(V, Ni, uIor - uDisp);
        vec3 outG = refract(V, Ni, uIor);
        vec3 outB = refract(V, Ni, uIor + uDisp);
        vec3 R = reflect(V, Ni);
        vec3 refl = env(R) * 0.6;
        vec3 refr = vec3(
          dot(outR, outR) < 1e-6 ? refl.r : env(outR).r,
          dot(outG, outG) < 1e-6 ? refl.g : env(outG).g,
          dot(outB, outB) < 1e-6 ? refl.b : env(outB).b) * uTint;
        col = mix(refr, refl, F);
      }

      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  /* ------------------------------------------------------------ helpers */

  function loadThree(url) {
    return import(/* webpackIgnore: true */ url);
  }

  function loadFont(opts) {
    if (opts.fontJSON) return Promise.resolve(opts.fontJSON);
    return fetch(opts.fontURL).then(r => { if (!r.ok) throw new Error('font ' + r.status); return r.json(); });
  }

  // Minimal typeface.json -> shapes (same command grammar as three's Font class)
  function textShapes(THREE, font, text, size, spacing) {
    const scale = size / font.resolution;
    const paths = [];
    let x = 0;
    for (const ch of text) {
      const g = font.glyphs[ch] || font.glyphs['?'];
      if (!g) continue;
      if (g.o) {
        const o = g.o.split(' ');
        const p = new THREE.ShapePath();
        let i = 0;
        const n = () => parseFloat(o[i++]);
        while (i < o.length) {
          const cmd = o[i++];
          if (cmd === 'm') p.moveTo(n() * scale + x, n() * scale);
          else if (cmd === 'l') p.lineTo(n() * scale + x, n() * scale);
          else if (cmd === 'q') { const ex = n() * scale + x, ey = n() * scale, cx = n() * scale + x, cy = n() * scale; p.quadraticCurveTo(cx, cy, ex, ey); }
          else if (cmd === 'b') { const ex = n() * scale + x, ey = n() * scale, c1x = n() * scale + x, c1y = n() * scale, c2x = n() * scale + x, c2y = n() * scale; p.bezierCurveTo(c1x, c1y, c2x, c2y, ex, ey); }
        }
        paths.push(p);
      }
      x += g.ha * scale + spacing * size;
    }
    const shapes = [];
    for (const p of paths) shapes.push(...p.toShapes());
    return shapes;
  }

  const ease = {
    inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
    outCubic:  t => 1 - Math.pow(1 - t, 3),
    inQuart:   t => t * t * t * t,
  };

  function buildDOM(opts) {
    const gate = document.createElement('div');
    gate.id = 'cedain-gate';
    gate.setAttribute('role', 'presentation');
    gate.innerHTML = `
      <canvas id="cedain-gate-canvas"></canvas>
      <button id="cedain-gate-skip" type="button" aria-label="Enter the site"><span class="ln"></span><span class="lbl">Enter</span></button>
      <p id="cedain-gate-hint"></p>
      <style>
        #cedain-gate{position:fixed;inset:0;z-index:${opts.zIndex};background:${opts.ink};
          transform:translateY(0);will-change:transform;overflow:hidden;
          transition:transform ${opts.leaveDuration}ms cubic-bezier(.76,0,.24,1)}
        #cedain-gate.is-leaving{transform:translateY(-100%)}
        #cedain-gate-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;
          opacity:0;transition:opacity 700ms ease}
        #cedain-gate.is-ready #cedain-gate-canvas{opacity:1}
        #cedain-gate-skip{position:absolute;left:50%;bottom:11vh;transform:translateX(-50%);z-index:3;
          display:flex;flex-direction:column;align-items:center;gap:10px;
          padding:14px 22px;border:0;background:none;color:#DED6D8;cursor:pointer;
          font:400 clamp(14px,1.7vw,21px)/1 'LalaTitle','Bebas Neue',sans-serif;letter-spacing:.42em;text-indent:.42em;text-transform:uppercase;
          opacity:0;transition:opacity 900ms ease 1200ms,color .25s ease}
        #cedain-gate-skip .ln{display:block;width:clamp(120px,15vw,210px);height:1px;
          background:linear-gradient(90deg,rgba(232,211,166,.15),rgba(232,211,166,.85) 45%,rgba(232,211,166,.15));
          transition:box-shadow .3s ease,transform .3s ease}
        #cedain-gate.is-ready #cedain-gate-skip{opacity:.92}
        #cedain-gate-skip:hover,#cedain-gate-skip:focus-visible{opacity:1;color:#E8D3A6;outline:none}
        #cedain-gate-skip:hover .ln,#cedain-gate-skip:focus-visible .ln{box-shadow:0 0 14px rgba(232,211,166,.55);transform:scaleY(2)}
        #cedain-gate-hint{position:absolute;left:0;right:0;bottom:28px;margin:0;text-align:center;
          color:#DED6D8;font:400 12px/1 'LalaButton','Nohemi',system-ui,sans-serif;letter-spacing:.06em;
          opacity:0;transition:opacity 800ms ease;pointer-events:none;text-shadow:0 1px 6px rgba(8,9,12,.55)}
        #cedain-gate.is-ready #cedain-gate-hint{opacity:.62;transition-delay:2200ms}
        #cedain-gate.has-control #cedain-gate-hint{opacity:.62;transition-delay:0ms}
        @media (max-width:760px){#cedain-gate-skip{bottom:13vh}}
        #cedain-gate.is-land #cedain-gate-skip{left:auto;right:3.5vw;bottom:auto;top:50%;transform:translateY(-50%);align-items:flex-end;padding:14px 18px;border-radius:3px;background:rgba(8,9,12,.30);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);text-shadow:0 0 16px rgba(8,9,12,.95),0 1px 3px rgba(8,9,12,.9)}
        #cedain-gate.is-land #cedain-gate-skip .ln{width:76px}
        #cedain-gate.is-land #cedain-gate-skip .lbl{text-indent:0;letter-spacing:.42em;margin-right:-.42em}
        #cedain-gate.is-loading #cedain-gate-hint{opacity:.62;transition-delay:0ms}
        #cedain-gate-canvas.is-walk{cursor:default}
        #cedain-gate-canvas{touch-action:none;cursor:grab}
        #cedain-gate-canvas:active{cursor:grabbing}
      </style>`;
    document.body.appendChild(gate);
    return gate;
  }

  /* ============================================================ the land
     (v4) The surround as a live scene instead of a film. Everything here is
     the data that fed the Unreal film, served small:
       terrain   the Copernicus hero box (48 km) as a 1024-cell plate, a
                 1024-cell plate over the mountains and the core (12 km),
                 and the 100 km ring for the horizon - 16-bit heights as
                 R*256+G, displaced in the vertex shader, read back in JS for
                 the walk
       the city  the cadastre core as the same nine Draco tiles the home
                 page walks through, with the lit-window facade; the rest of
                 the city as its lights - street lamps every 30 m along the
                 main roads, the traffic on them, and a glow of windows
                 scattered from the cadastre's own counts
       the sky   the Canal Valley sketch on a dome, as over the city, and it
                 listens: window.LALA_AUDIO (the footer's analyser) moves the
                 noise and the lattice with the bass and the drums and the
                 colours with the mids and highs
       the mark  the glass CEDAIN over the city, lit by seven searchlights
                 from the ground, seen in the glass through a cubemap of
                 this very scene
     The viewer stands on the Cerros Orientales, east of the city, and walks:
     WASD, Shift or R to run, Space to jump (Minecraft's numbers), drag to
     look. ENTER sits on the right of the screen. Phones keep the film. */

  // the height read the same way on the GPU and in JS: texel centres, so the
  // walker's feet and the drawn ground agree to the centimetre
  const LAND_H_AT = /* glsl */`
    float hAt(vec2 p){
      vec2 uv = (clamp((p - uBox.xy) / uBox.zw, 0.0, 1.0) * (uN - 1.0) + 0.5) / uN;
      vec4 t = texture2D(uH, vec2(uv.x, 1.0 - uv.y));
      return uLoHi.x + (t.r * 255.0 * 256.0 + t.g * 255.0) / 65535.0 * (uLoHi.y - uLoHi.x);
    }`;
  const LAND_TERRAIN_VERT = /* glsl */`
    uniform sampler2D uH; uniform vec4 uBox; uniform vec2 uLoHi; uniform float uDrop, uN;
    varying vec3 vW;
    ${LAND_H_AT}
    void main(){
      vec4 w = modelMatrix * vec4(position, 1.0);
      w.y = hAt(w.xz) - uDrop;
      vW = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`;
  const LAND_TERRAIN_FRAG = /* glsl */`
    uniform sampler2D uH, uDens; uniform vec4 uBox, uDensBox; uniform vec2 uLoHi; uniform float uTexel, uFogK, uPlain, uN, uLight;
    uniform vec3 uMoon, uHorizon;
    varying vec3 vW;
    ${LAND_H_AT}
    float h21(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
    float fbm(vec2 p){ return vn(p) * 0.5 + vn(p * 2.07 + vec2(5.2, 1.3)) * 0.25 + vn(p * 4.19 + vec2(1.7, 9.2)) * 0.125; }
    void main(){
      float e = uTexel;
      float hx = hAt(vW.xz + vec2(e, 0.0)) - hAt(vW.xz - vec2(e, 0.0));
      float hz = hAt(vW.xz + vec2(0.0, e)) - hAt(vW.xz - vec2(0.0, e));
      vec3 n = normalize(vec3(-hx, 2.0 * e, -hz));
      float d = length(vW - cameraPosition);
      // the ground under your feet: tufts and stones as a bump, faded with
      // distance so the far slopes never shimmer
      float det = exp(-d / 900.0);
      vec2 p = vW.xz;
      float grain = 0.5;
      if (det > 0.02) {
        float b0 = fbm(p * 0.33), bx = fbm(p * 0.33 + vec2(0.9, 0.0)), bz = fbm(p * 0.33 + vec2(0.0, 0.9));
        n = normalize(n + vec3(-(bx - b0), 0.0, -(bz - b0)) * det * 2.6);
        grain = fbm(p * 1.7);
      }
      float alt = clamp((vW.y - uPlain) / 900.0, 0.0, 1.0);
      // forest on the slopes, paramo above the tree line, the city floor flat and dark
      vec3 forest = vec3(0.020, 0.032, 0.032), paramo = vec3(0.060, 0.064, 0.058), plain = vec3(0.022, 0.024, 0.034);
      vec3 base = mix(forest, paramo, smoothstep(0.55, 1.0, alt));
      base = mix(plain, base, smoothstep(0.0, 0.05, alt));
      base *= 0.65 + 0.70 * fbm(p * 0.045);                 // 20 m patches of scrub and rock
      base *= 1.0 + det * (grain - 0.5) * 0.7;              // the fine grain up close
      // moonlight, the navy of the sky from above, and the city's own glow on its floor
      float lam = max(dot(n, uMoon), 0.0);
      float amb = 0.35 + 0.65 * max(n.y, 0.0);
      vec3 col = base * (amb * vec3(0.40, 0.52, 0.78) * 0.45 + lam * lam * vec3(0.95, 1.0, 1.15) * 1.1) * uLight;
      col += vec3(0.10, 0.14, 0.22) * pow(lam, 4.0) * 0.06 * uLight;
      // the city on its floor: the cadastre's own density as a pale carpet of
      // blocks - the facades the film lit - thinning to the dark sabana
      float onPlain = 1.0 - smoothstep(0.0, 0.06, alt);
      if (onPlain > 0.0 && uDensBox.z > 0.0) {
        vec2 duv = (p - uDensBox.xy) / uDensBox.zw;
        float inside = step(0.0, duv.x) * step(duv.x, 1.0) * step(0.0, duv.y) * step(duv.y, 1.0);
        float dens = texture2D(uDens, clamp(duv, 0.0, 1.0)).r * inside;
        vec2 cell = floor(p / 36.0);
        float r1 = h21(cell + 7.1), r2 = h21(cell * 1.3 + 2.9);
        float blk = step(0.22, r1);                                 // most cells built on, some gaps between
        float close = exp(-d / 7000.0);
        vec3 wall = mix(vec3(0.17, 0.17, 0.18), vec3(0.11, 0.115, 0.13), r2);
        vec3 carpet = mix(vec3(0.040, 0.040, 0.046), wall, mix(0.72, blk, close)) * (0.8 + 0.4 * r2);
        col = mix(col, carpet * uLight * 2.0, onPlain * smoothstep(0.03, 0.45, dens));
      }
      float fog = 1.0 - exp(-d * d * uFogK * uFogK);
      gl_FragColor = vec4(mix(col, uHorizon, clamp(fog, 0.0, 1.0)), 1.0);
      #include <colorspace_fragment>
    }`;
  const LAND_POINT_VERT = /* glsl */`
    attribute float aTone; attribute float aSize;
    uniform float uPx, uReach, uFogK; uniform vec3 uWarm, uCool, uHorizon;
    varying vec3 vCol; varying float vA;
    void main(){
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float d = max(-mv.z, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = clamp(uPx * aSize * uReach / d, 1.0, 16.0);
      vCol = mix(uWarm, uCool, aTone);
      float fog = 1.0 - exp(-d * d * uFogK * uFogK);
      vA = clamp(uReach * 0.6 / d, 0.12, 1.0) * (1.0 - fog * 0.85);
    }`;
  const LAND_POINT_FRAG = /* glsl */`
    varying vec3 vCol; varying float vA;
    void main(){
      vec2 c = gl_PointCoord - 0.5; float r = length(c);
      if (r > 0.5) discard;
      float a = smoothstep(0.5, 0.05, r);
      gl_FragColor = vec4(vCol * a * vA, a * vA);
      #include <colorspace_fragment>
    }`;
  const LAND_CAR_VERT = /* glsl */`
    attribute vec3 aEnd; attribute vec3 aMeta;   // phase, speed (m/s), direction
    uniform float uT, uPx, uReach, uFogK;
    varying vec3 vCol; varying float vA;
    void main(){
      vec3 s = position, e = aEnd;
      float len = max(distance(s, e), 1.0);
      float f = fract(aMeta.x + uT * aMeta.y / len);
      if (aMeta.z > 0.5) f = 1.0 - f;
      vec3 p = mix(s, e, f);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      float d = max(-mv.z, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = clamp(uPx * uReach * 0.9 / d, 1.0, 9.0);
      vCol = (aMeta.z > 0.5) ? vec3(1.0, 0.20, 0.10) : vec3(0.80, 0.90, 1.0);
      float fog = 1.0 - exp(-d * d * uFogK * uFogK);
      vA = clamp(uReach * 0.8 / d, 0.2, 1.0) * (1.0 - fog * 0.85);
    }`;
  const LAND_LINE_VERT = /* glsl */`
    uniform float uFogK; varying float vA;
    void main(){
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float d = max(-mv.z, 1.0);
      float fog = 1.0 - exp(-d * d * uFogK * uFogK);
      vA = (1.0 - fog * 0.9) * clamp(3000.0 / d, 0.3, 1.0);
      gl_Position = projectionMatrix * mv;
    }`;
  const LAND_LINE_FRAG = /* glsl */`
    uniform vec3 uCol; uniform float uA; varying float vA;
    void main(){ float a = uA * vA; gl_FragColor = vec4(uCol * a, a);
      #include <colorspace_fragment>
    }`;
  const LAND_FACADE_VERT = /* glsl */`
    varying vec3 vW; varying vec3 vL; uniform float uBaseY;
    void main(){
      vec4 w = modelMatrix * vec4(position, 1.0);
      vW = w.xyz;
      vL = vec3(position.x, position.y - uBaseY, position.z);
      gl_Position = projectionMatrix * viewMatrix * w;
    }`;
  const LAND_FACADE_FRAG = /* glsl */`
    varying vec3 vW; varying vec3 vL;
    uniform vec3 uWall, uWarm, uCool, uHorizon; uniform float uFogK;
    float h21(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    void main(){
      vec3 n = normalize(cross(dFdx(vL), dFdy(vL)));
      float up = abs(n.y);
      vec3 col;
      if (up > 0.55) {
        col = uWall * 0.30;
      } else {
        float u = (abs(n.x) > abs(n.z)) ? vL.z : vL.x;
        vec2 cell = vec2(floor(u / 3.2), floor(vL.y / 3.0));
        vec2 f = vec2(fract(u / 3.2), fract(vL.y / 3.0));
        float pane = step(0.14, f.x) * step(f.x, 0.86) * step(0.20, f.y) * step(f.y, 0.84);
        float lit = step(0.55, h21(cell)) * pane;
        vec3 glow = mix(uWarm, uCool, step(0.72, h21(cell * 1.7 + 11.3)));
        col = mix(uWall * 0.38, glow * 0.95, lit);
        col *= 0.82 + 0.26 * abs(n.x);
      }
      float d = length(vW - cameraPosition);
      float fog = 1.0 - exp(-d * d * uFogK * uFogK);
      gl_FragColor = vec4(mix(col, uHorizon, clamp(fog, 0.0, 1.0)), 1.0);
      #include <colorspace_fragment>
    }`;
  const LAND_SKY_VERT = /* glsl */`
    varying vec3 vD;
    void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const LAND_SKY_FRAG = /* glsl */`
    varying vec3 vD;
    uniform float uT, uMode, uGain, uHue, uLift;
    uniform sampler2D uCanal; uniform vec3 uInk;
    vec3 hueShift(vec3 c, float a){
      const vec3 k = vec3(0.57735);
      float cs = cos(a), sn = sin(a);
      return c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);
    }
    vec2 h22(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
    void main(){
      vec3 d = normalize(vD);
      float el = d.y;
      float a = atan(d.z, d.x), e = asin(clamp(el, -1.0, 1.0));
      // the stars: one in a few cells of the sky, round, slow to twinkle
      vec2 sp = vec2(a, e) * 150.0, ci = floor(sp), cf = fract(sp);
      vec2 rp = h22(ci), rq = h22(ci + 19.7);
      float star = step(0.982, rq.x) * smoothstep(0.34, 0.0, length((cf - rp) * vec2(cos(e), 1.0))) * smoothstep(0.03, 0.25, el);
      float tw = 0.65 + 0.35 * sin(uT * 1.7 + rq.y * 40.0);
      vec3 starCol = vec3(0.85, 0.90, 1.0) * star * tw;
      vec3 col = uInk * 0.9;
      if (uMode > 0.5) {
        // the sketch draped with its poles on the horizon, its two ends cross-faded
        float cu = atan(d.y, d.z) / 6.2831853 + 0.5;
        float cv = asin(clamp(d.x, -1.0, 1.0)) / 3.1415927 + 0.5;
        float u0 = fract(cu);
        float w0 = smoothstep(0.0, 0.17, min(u0, 1.0 - u0));
        float vy = clamp(cv, 0.003, 0.997);
        vec3 A = texture2D(uCanal, vec2(u0, vy)).rgb;
        vec3 B = texture2D(uCanal, vec2(fract(u0 + 0.5), vy)).rgb;
        vec3 sk = hueShift(mix(B, A, w0), uHue);
        // the night chain is light on ink already: the lattice, the haze, the noise
        col = uInk * 0.85 + sk * (uGain + uLift);
        float lum = dot(sk, vec3(0.299, 0.587, 0.114));
        col += starCol * 0.55 * (1.0 - smoothstep(0.08, 0.45, lum));
      } else {
        col += starCol * 0.55;
      }
      float sky = smoothstep(-0.10, 0.12, el);
      col = mix(uInk * 0.55, col, sky);
      gl_FragColor = vec4(max(col, 0.0), 1.0);
      #include <colorspace_fragment>
    }`;
  const LAND_BEAM_VERT = /* glsl */`
    varying vec2 vUv; varying vec3 vN; varying vec3 vW;
    void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
  const LAND_BEAM_FRAG = /* glsl */`
    varying vec2 vUv; varying vec3 vN; varying vec3 vW;
    uniform vec3 uCol; uniform float uA;
    void main(){
      vec3 V = normalize(cameraPosition - vW);
      float edge = pow(1.0 - abs(dot(normalize(vN), V)), 1.4);        // thin at the rim, like a real cone of haze
      float along = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
      float a = uA * along * (0.35 + 0.65 * edge);
      gl_FragColor = vec4(uCol * a, a);
      #include <colorspace_fragment>
    }`;

  function landAudio() {
    const A = window.LALA_AUDIO;
    return (A && A.active) ? A : { level: 0, bass: 0, mid: 0, high: 0, kick: 0, active: false };
  }

  // a 16-bit height plate: the image for the GPU, the numbers for the walk
  function loadPlate(THREE, url, spec, lo, hi) {
    return new Promise((resolve) => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => {
        const n = img.naturalWidth;
        const cv = document.createElement('canvas'); cv.width = n; cv.height = img.naturalHeight;
        const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, n, cv.height).data;
        const data = new Float32Array(n * cv.height);
        for (let i = 0; i < data.length; i++) data[i] = lo + (px[i * 4] * 256 + px[i * 4 + 1]) / 65535 * (hi - lo);
        const tex = new THREE.Texture(img);
        tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
        tex.colorSpace = THREE.NoColorSpace; tex.needsUpdate = true;
        resolve({ tex, data, n, spec });
      };
      img.onerror = () => { console.warn('[cedain-intro] land: plate missing', url); resolve(null); };
      img.src = url;
    });
  }

  // bilinear height from a plate, or null outside it
  function plateHeight(p, x, z) {
    if (!p) return null;
    const s = p.spec;
    const fx = (x - s.x0) / s.w * (p.n - 1), fz = (z - s.z0) / s.h * (p.n - 1);
    if (fx < 0 || fz < 0 || fx > p.n - 1 || fz > p.n - 1) return null;
    const x0 = Math.min(p.n - 2, Math.floor(fx)), z0 = Math.min(p.n - 2, Math.floor(fz));
    const tx = fx - x0, tz = fz - z0, D = p.data, N = p.n;
    return (D[z0 * N + x0] * (1 - tx) + D[z0 * N + x0 + 1] * tx) * (1 - tz) +
           (D[(z0 + 1) * N + x0] * (1 - tx) + D[(z0 + 1) * N + x0 + 1] * tx) * tz;
  }

  // the height of the drawn terrain: the plate sampled at the mesh's own
  // vertices and interpolated across its triangles exactly as the GPU does
  // (PlaneGeometry splits every cell along the b-d diagonal), so the feet of
  // the walker stand on the surface that is on screen
  function meshHeight(p, segs, x, z) {
    if (!p) return null;
    const s = p.spec;
    const fx = (x - s.x0) / s.w * segs, fz = (z - s.z0) / s.h * segs;
    if (fx < 0 || fz < 0 || fx > segs || fz > segs) return null;
    const ix = Math.min(segs - 1, Math.floor(fx)), iz = Math.min(segs - 1, Math.floor(fz));
    const tx = fx - ix, tz = fz - iz, cw = s.w / segs, ch = s.h / segs;
    const X0 = s.x0 + ix * cw, Z0 = s.z0 + iz * ch;
    const ha = plateHeight(p, X0, Z0), hb = plateHeight(p, X0, Z0 + ch), hc = plateHeight(p, X0 + cw, Z0 + ch), hd = plateHeight(p, X0 + cw, Z0);
    if (ha == null || hb == null || hc == null || hd == null) return null;
    if (tx + tz <= 1) return ha + (hd - ha) * tx + (hb - ha) * tz;
    return hc + (hb - hc) * (1 - tx) + (hd - hc) * (1 - tz);
  }

  // the lights file: LGT1, counts, quantisation, then lamps / segments / glow as uint16
  async function loadLights(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('lights ' + r.status);
    const buf = await r.arrayBuffer();
    const dv = new DataView(buf);
    if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'LGT1') throw new Error('lights: not LGT1');
    const nl = dv.getUint32(4, true), ns = dv.getUint32(8, true), ng = dv.getUint32(12, true);
    const qx0 = dv.getFloat32(16, true), qxs = dv.getFloat32(20, true), qy0 = dv.getFloat32(24, true), qys = dv.getFloat32(28, true);
    let off = 32;
    const u16 = (count) => { const a = new Uint16Array(buf, off, count); off += count * 2; return a; };
    const la = u16(nl * 4), se = u16(ns * 8), gl = u16(ng * 4);
    const X = v => v / qxs + qx0, Y = v => v / qys + qy0;
    return { nl, ns, ng, la, se, gl, X, Y };
  }

  // Draco tiles decoded by the classic r128 loaders already on the page (or
  // fetched now), rebuilt as this module's own geometry so nothing crosses
  // between two copies of three
  function loadClassic(urls) {
    return urls.reduce((p, u) => p.then(() => new Promise((res, rej) => {
      const sc = document.createElement('script'); sc.src = u; sc.onload = res; sc.onerror = () => rej(new Error('script ' + u)); document.head.appendChild(sc);
    })), Promise.resolve());
  }
  async function loadCoreTiles(THREE, land) {
    const W = window;
    const need = [];
    if (!W.THREE) need.push('https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js');
    if (!W.THREE || !W.THREE.GLTFLoader) need.push('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js');
    if (!W.THREE || !W.THREE.DRACOLoader) need.push('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/DRACOLoader.js');
    await loadClassic(need);
    const T0 = W.THREE;
    const draco = new T0.DRACOLoader();
    draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/libs/draco/gltf/');
    draco.setDecoderConfig({ type: 'js' });
    const gltf = new T0.GLTFLoader(); gltf.setDRACOLoader(draco);
    const out = [];
    await Promise.all(land.tiles.map(t => new Promise((res) => {
      gltf.load(land.cityBase + t.file, (g) => {
        g.scene.traverse((o) => {
          if (!o.isMesh) return;
          const pos = o.geometry.attributes.position.array;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
          if (o.geometry.index) geo.setIndex(new THREE.BufferAttribute(o.geometry.index.array.slice(), 1));
          out.push({ geo, x: t.x, z: t.z });
        });
        res();
      }, undefined, () => { console.warn('[cedain-intro] land: tile missing', t.file); res(); });
    })));
    try { draco.dispose(); } catch (_) {}
    return out;
  }

  async function startLandSky(THREE, land) {
    const C = land.canal || {};
    if (!C.url) return null;
    await new Promise((res, rej) => {
      if (window.Hydra) return res();
      let sc = document.getElementById('lala-hydra-lib');
      if (!sc) { sc = document.createElement('script'); sc.id = 'lala-hydra-lib'; sc.src = C.url; sc.async = true; document.head.appendChild(sc); }
      sc.addEventListener('load', () => window.Hydra ? res() : rej(new Error('no Hydra')));
      sc.addEventListener('error', () => rej(new Error('hydra blocked')));
      setTimeout(() => window.Hydra ? res() : rej(new Error('hydra timed out')), 15000);
    });
    const cv = document.createElement('canvas'); cv.width = C.w || 1024; cv.height = C.h || 512;
    const h = new window.Hydra({ canvas: cv, detectAudio: false, makeGlobal: false, autoLoop: false, enableStreamCapture: false });
    const y = h.synth;
    const ZOOM = C.zoom || 0.42, TERRAC = C.terrac || 5, BANDS = C.bands || 9, FLOW = C.flow || 0.10, SMEAR = C.smear || 0.022, CRAWL = C.crawl || 0.05;
    const A = landAudio;
    // the Canal Valley at night: the same lattice (the bands) bent by the same
    // valley (the scan), but drawn as light on ink the way the film's sky
    // was - steel blue to icy cyan - instead of the pages' pale print. The
    // music, when the ear is on: bass and kicks in the flow, the smear and
    // the crawl (the lattice and the noise), mids and highs in the colours.
    const bands = () => y.osc(BANDS, 0.035, 0.25).rotate(1.05).modulate(y.osc(2.2, () => 0.02 + A().kick * 0.06, 0).rotate(-0.4), 0.22);
    const valleyFromScan = () => y.src(y.s0).scale(ZOOM).contrast(1.15).posterize(TERRAC, 0.55).modulateScale(y.osc(0.6, 0.02, 0), () => 0.03 + A().bass * 0.05);
    const valleyProcedural = () => y.noise(1.8, () => 0.05 + A().bass * 0.25).add(y.noise(3.6, () => 0.08 + A().kick * 0.3), 0.35).posterize(TERRAC, 0.55).contrast(1.15);
    function run(valley, label) {
      bands()
        .modulate(valley(), () => FLOW + 0.035 * Math.sin(y.time * 0.19) + A().bass * 0.12)
        .modulateScale(valley().rotate(() => y.time * (CRAWL + A().kick * 0.25)), () => 0.05 + A().bass * 0.04)
        .modulate(y.src(y.o0).scale(1.006), () => SMEAR + A().kick * 0.04)
        .blend(y.src(y.o0), 0.42)
        .luma(0.60, 0.22)                                                        // the crests of the bands: the lattice as lines
        .mult(y.solid(() => 0.50 + 0.42 * A().mid, () => 0.63 + 0.22 * A().mid + 0.14 * A().high, () => 0.84 + 0.14 * A().high))
        .add(valley().invert().luma(0.60, 0.40).mult(y.solid(0.20, 0.27, 0.38)), () => 0.32 + A().high * 0.30)   // the valley as the nebula's haze
        .add(y.noise(3.0, () => 0.05 + A().kick * 0.40).luma(0.62, 0.30).mult(y.solid(0.55, 0.66, 0.80)), () => 0.10 + A().kick * 0.28)   // the noise, with the drums
        .mult(y.solid(() => 0.80 + A().level * 0.30, () => 0.80 + A().level * 0.30, () => 0.80 + A().level * 0.30))
        .out(y.o0);
      y.render(y.o0);
      for (let w = 0; w < 240; w++) { try { h.tick(33.3); } catch (e) { break; } }
      console.log('[cedain-intro] land: canal valley running at night (' + label + ')');
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.colorSpace = THREE.NoColorSpace;
    const sky = { tex, hydra: h, acc: 0, every: 1000 / (C.fps || 30), tick(dtMs) { this.acc += dtMs; if (this.acc < this.every) return; try { h.tick(this.acc); } catch (e) {} this.acc = 0; tex.needsUpdate = true; } };
    return new Promise((res) => {
      let settled = false;
      const once = (fn, label) => { if (settled) return; settled = true; try { run(fn, label); res(sky); } catch (err) { console.warn('[cedain-intro] land: sky pipeline failed', err); res(null); } };
      if (C.scan) {
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => { try { y.s0.init({ src: img, dynamic: false }); } catch (err) { return once(valleyProcedural, 'procedural'); } once(valleyFromScan, 'scan'); };
        img.onerror = () => once(valleyProcedural, 'procedural');
        img.src = C.scan;
        setTimeout(() => once(valleyProcedural, 'procedural'), 6000);
      } else once(valleyProcedural, 'procedural');
    });
  }

  async function buildLand(THREE, renderer, scene, opts, say) {
    const L = opts.land;
    const lo = L.lo, hi = L.hi;
    const HORIZON = new THREE.Color(0x070A12), INK = new THREE.Color(0x08090C);
    const WARM = new THREE.Color(0xFFB36A), COOL = new THREE.Color(0xC9DCFF), CHAMPAGNE = new THREE.Color(0xE8D3A6), CHAMBRAY = new THREE.Color(0x9EB4D3);
    const FOGK = L.fog != null ? L.fog : 0.000042;
    const group = new THREE.Group(); group.name = 'land'; scene.add(group);
    const out = { group, ready: false, groundAt: null, update: () => {}, sky: null, dispose: () => {} };
    const plates = {};

    say('the sabana: terrain');
    const [near, far, ring] = await Promise.all([
      loadPlate(THREE, L.base + L.near.file, L.near, lo, hi),
      loadPlate(THREE, L.base + L.far.file, L.far, lo, hi),
      L.ring ? loadPlate(THREE, L.base + L.ring.file, L.ring, lo, hi) : Promise.resolve(null),
    ]);
    plates.near = near; plates.far = far; plates.ring = ring;
    if (!near && !far) throw new Error('no terrain');
    const moon = new THREE.Vector3(-0.35, 0.72, 0.55).normalize();
    const densU = { value: null }, densBoxU = { value: new THREE.Vector4(0, 0, 0, 0) };   // the city's density, shared by every plate
    function terrainMesh(p, segs, drop) {
      const g = new THREE.PlaneGeometry(p.spec.w, p.spec.h, segs, segs); g.rotateX(-Math.PI / 2);
      const m = new THREE.ShaderMaterial({
        vertexShader: LAND_TERRAIN_VERT, fragmentShader: LAND_TERRAIN_FRAG,
        uniforms: { uH: { value: p.tex }, uBox: { value: new THREE.Vector4(p.spec.x0, p.spec.z0, p.spec.w, p.spec.h) }, uLoHi: { value: new THREE.Vector2(lo, hi) },
          uDrop: { value: drop }, uTexel: { value: p.spec.w / (p.n - 1) }, uN: { value: p.n }, uFogK: { value: FOGK }, uPlain: { value: L.plain || 2560 },
          uLight: { value: L.light != null ? L.light : 0.5 }, uMoon: { value: moon }, uHorizon: { value: HORIZON }, uDens: densU, uDensBox: densBoxU },
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(p.spec.x0 + p.spec.w / 2, 0, p.spec.z0 + p.spec.h / 2);
      mesh.frustumCulled = false;
      return mesh;
    }
    const NEAR_SEGS = 640;                                   // 18.75 m facets over the walk
    const inGlass = (o) => { o.layers.enable(1); return o; };          // what the glass reflects (see the cube camera in mount)
    if (near) group.add(terrainMesh(near, NEAR_SEGS, 0));
    if (far) group.add(inGlass(terrainMesh(far, 360, near ? 2.5 : 0)));
    if (ring) group.add(inGlass(terrainMesh(ring, 160, 24)));
    out.groundAt = (x, z) => { const a = meshHeight(near, NEAR_SEGS, x, z); if (a != null) return a; const b = plateHeight(far, x, z); if (b != null) return b - 2.5; const c = plateHeight(ring, x, z); return c != null ? c - 24 : (L.plain || 2560); };

    // ---- the lights
    say('the sabana: the city');
    let lights = null;
    try { lights = await loadLights(L.base + L.lights); } catch (e) { console.warn('[cedain-intro] land:', e.message); }
    const pointMats = [];
    if (lights) {
      const mkPoints = (n, fill, px, reach) => {
        const pos = new Float32Array(n * 3), tone = new Float32Array(n), size = new Float32Array(n);
        fill(pos, tone, size);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aTone', new THREE.BufferAttribute(tone, 1)); g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
        const m = new THREE.ShaderMaterial({ vertexShader: LAND_POINT_VERT, fragmentShader: LAND_POINT_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          uniforms: { uPx: { value: px }, uReach: { value: reach }, uFogK: { value: FOGK }, uWarm: { value: WARM }, uCool: { value: COOL }, uHorizon: { value: HORIZON } } });
        pointMats.push(m);
        const pts = new THREE.Points(g, m); pts.frustumCulled = false; return inGlass(pts);
      };
      const { la, se, gl, X, Y } = lights;
      group.add(mkPoints(lights.nl, (pos, tone, size) => { for (let i = 0; i < lights.nl; i++) { pos[i * 3] = X(la[i * 4]); pos[i * 3 + 1] = Y(la[i * 4 + 1]); pos[i * 3 + 2] = X(la[i * 4 + 2]); tone[i] = la[i * 4 + 3]; size[i] = 1.0; } }, 1.0, 2600));
      group.add(mkPoints(lights.ng, (pos, tone, size) => { for (let i = 0; i < lights.ng; i++) { pos[i * 3] = X(gl[i * 4]); pos[i * 3 + 1] = Y(gl[i * 4 + 1]); pos[i * 3 + 2] = X(gl[i * 4 + 2]); tone[i] = gl[i * 4 + 3] ? 0.0 : 1.0; size[i] = 0.75 + 0.5 * ((i * 7919) % 97) / 97; } }, 0.85, 2200));
      // the traffic: a few cars on every segment each way, with a short fading trail behind each
      const perSeg = []; let total = 0;
      for (let i = 0; i < lights.ns; i++) { const w = se[i * 8 + 6]; const n = w >= 3 ? 3 : (w >= 2 ? 2 : 1); perSeg.push(n); total += n * 2 * 3; }
      const cpos = new Float32Array(total * 3), cend = new Float32Array(total * 3), cmeta = new Float32Array(total * 3);
      let k = 0, seed = 11;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let i = 0; i < lights.ns; i++) {
        const sx = X(se[i * 8]), sy = Y(se[i * 8 + 1]), sz = X(se[i * 8 + 2]), ex = X(se[i * 8 + 3]), ey = Y(se[i * 8 + 4]), ez = X(se[i * 8 + 5]);
        for (let c = 0; c < perSeg[i]; c++) for (let dir = 0; dir < 2; dir++) {
          const phase = rnd(), speed = 9 + rnd() * 9;
          for (let tr = 0; tr < 3; tr++) {
            cpos[k * 3] = sx; cpos[k * 3 + 1] = sy; cpos[k * 3 + 2] = sz; cend[k * 3] = ex; cend[k * 3 + 1] = ey; cend[k * 3 + 2] = ez;
            cmeta[k * 3] = phase - tr * 0.012 * (dir ? -1 : 1); cmeta[k * 3 + 1] = speed; cmeta[k * 3 + 2] = dir; k++;
          }
        }
      }
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.BufferAttribute(cpos, 3)); cg.setAttribute('aEnd', new THREE.BufferAttribute(cend, 3)); cg.setAttribute('aMeta', new THREE.BufferAttribute(cmeta, 3));
      const cm = new THREE.ShaderMaterial({ vertexShader: LAND_CAR_VERT, fragmentShader: LAND_POINT_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uT: { value: 0 }, uPx: { value: 1.0 }, uReach: { value: 2400 }, uFogK: { value: FOGK } } });
      const cars = new THREE.Points(cg, cm); cars.frustumCulled = false; group.add(cars);
      out.cars = cm;
      // the streets themselves, as the film drew them: thin red lines on the plain
      const lpos = new Float32Array(lights.ns * 6);
      for (let i = 0; i < lights.ns; i++) {
        lpos[i * 6] = X(se[i * 8]); lpos[i * 6 + 1] = Y(se[i * 8 + 1]) + 0.4; lpos[i * 6 + 2] = X(se[i * 8 + 2]);
        lpos[i * 6 + 3] = X(se[i * 8 + 3]); lpos[i * 6 + 4] = Y(se[i * 8 + 4]) + 0.4; lpos[i * 6 + 5] = X(se[i * 8 + 5]);
      }
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lpos, 3));
      const lm = new THREE.ShaderMaterial({ vertexShader: LAND_LINE_VERT, fragmentShader: LAND_LINE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uFogK: { value: FOGK }, uCol: { value: new THREE.Color(0xFF3A58) }, uA: { value: L.streets != null ? L.streets : 0.55 } } });
      const streets = new THREE.LineSegments(lg, lm); streets.frustumCulled = false; group.add(inGlass(streets));
      // where the city is: the windows' own density on a coarse grid, for the carpet
      const DB = L.far || L.near, DN = 64, dens = new Float32Array(DN * DN);
      for (let i = 0; i < lights.ng; i++) {
        const ix = Math.floor((X(gl[i * 4]) - DB.x0) / DB.w * DN), iz = Math.floor((X(gl[i * 4 + 2]) - DB.z0) / DB.h * DN);
        if (ix >= 0 && ix < DN && iz >= 0 && iz < DN) dens[iz * DN + ix] += 1;
      }
      const sorted = Array.from(dens).filter(v => v > 0).sort((a, b) => a - b), p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
      const d8 = new Uint8Array(DN * DN);
      for (let i = 0; i < d8.length; i++) d8[i] = Math.min(255, Math.round(dens[i] / p95 * 255));
      const densTex = new THREE.DataTexture(d8, DN, DN, THREE.RedFormat, THREE.UnsignedByteType);
      densTex.minFilter = THREE.LinearFilter; densTex.magFilter = THREE.LinearFilter; densTex.generateMipmaps = false; densTex.needsUpdate = true;
      densU.value = densTex; densBoxU.value.set(DB.x0, DB.z0, DB.w, DB.h);
      console.log('[cedain-intro] land: lights', lights.nl, 'lamps,', lights.ng, 'windows,', total, 'traffic points');
    }

    // ---- the core as real buildings
    if (L.tiles && L.tiles.length) {
      say('the sabana: the core');
      try {
        const tiles = await loadCoreTiles(THREE, L);
        const fm = new THREE.ShaderMaterial({ vertexShader: LAND_FACADE_VERT, fragmentShader: LAND_FACADE_FRAG, side: THREE.DoubleSide,
          uniforms: { uWall: { value: new THREE.Color(0x1A2230) }, uWarm: { value: CHAMPAGNE }, uCool: { value: CHAMBRAY }, uHorizon: { value: HORIZON }, uFogK: { value: FOGK }, uBaseY: { value: L.baseY || 2544.55 } } });
        tiles.forEach(t => { const m = new THREE.Mesh(t.geo, fm); m.position.set(t.x, 0, t.z); m.frustumCulled = false; group.add(inGlass(m)); });
        console.log('[cedain-intro] land: core tiles', tiles.length);
      } catch (e) { console.warn('[cedain-intro] land: core tiles skipped -', e.message); }
    }

    // ---- the sky
    const skyMat = new THREE.ShaderMaterial({ vertexShader: LAND_SKY_VERT, fragmentShader: LAND_SKY_FRAG, side: THREE.BackSide, depthWrite: false,
      uniforms: { uT: { value: 0 }, uMode: { value: 0 }, uGain: { value: L.skyGain != null ? L.skyGain : 0.35 }, uHue: { value: 0 }, uLift: { value: 0 }, uCanal: { value: null }, uInk: { value: INK } } });
    const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(58000, 64, 40), skyMat); skyMesh.frustumCulled = false; group.add(inGlass(skyMesh));
    startLandSky(THREE, L).then((sky) => { if (!sky) return; out.sky = sky; skyMat.uniforms.uCanal.value = sky.tex; skyMat.uniforms.uMode.value = 1; }).catch(() => {});

    // ---- the searchlights: seven, from the ground under the mark, each sweeping its own letters
    const LT = L.letters;
    const beams = [];
    const beamCols = [0x7DE8FF, 0xA9D8FF, 0xDCE9FF, 0xFFFFFF, 0xC9DCFF, 0x8FB7E8, 0x6FA0D8];
    // the text runs along its own x, which the mount turns by a quarter plus
    // its yaw: so "along" and "facing" (toward the viewer) in the world
    const th = Math.PI / 2 + (LT.yawDeg || 0) * Math.PI / 180;
    const along = { x: Math.cos(th), z: -Math.sin(th) }, facing = { x: Math.sin(th), z: Math.cos(th) };
    for (let i = 0; i < 7; i++) {
      const u = (i - 3) * LT.width * 0.14 + (i % 2 ? 60 : -60), v = 260 + (i % 3) * 90;
      const bx = LT.x + along.x * u + facing.x * v, bz = LT.z + along.z * u + facing.z * v;
      const by = out.groundAt(bx, bz);
      const len = Math.hypot(LT.x - bx, LT.y - by, LT.z - bz);
      const g = new THREE.CylinderGeometry(LT.width * 0.06, 12, len, 20, 1, true);
      g.translate(0, len / 2, 0);
      const m = new THREE.ShaderMaterial({ vertexShader: LAND_BEAM_VERT, fragmentShader: LAND_BEAM_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { uCol: { value: new THREE.Color(beamCols[i]) }, uA: { value: L.beams != null ? L.beams : 0.30 } } });
      const mesh = new THREE.Mesh(g, m); mesh.position.set(bx, by, bz); mesh.frustumCulled = false; group.add(inGlass(mesh));
      beams.push({ mesh, bx, by, bz, i, period: 9 + i * 1.7 });
    }
    const aim = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), dirv = new THREE.Vector3();

    out.update = (dt, t) => {
      if (out.sky) out.sky.tick(dt * 1000);
      const A = landAudio();
      skyMat.uniforms.uT.value = t;
      skyMat.uniforms.uHue.value = A.active ? (A.mid * 0.35 - A.high * 0.2) : 0;
      skyMat.uniforms.uLift.value = A.active ? A.level * 0.15 : 0;
      if (out.cars) out.cars.uniforms.uT.value = t;
      for (const b of beams) {
        const sweep = Math.sin(t * 6.2831853 / b.period + b.i) * LT.width * 0.42;
        aim.set(LT.x + along.x * sweep, LT.y + Math.sin(t * 0.7 + b.i * 1.3) * LT.width * 0.03, LT.z + along.z * sweep);
        dirv.set(aim.x - b.bx, aim.y - b.by, aim.z - b.bz).normalize();
        q.setFromUnitVectors(up, dirv); b.mesh.quaternion.copy(q);
      }
    };
    out.ready = true;
    out.dispose = () => { group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); scene.remove(group); if (out.sky) { try { out.sky.hydra.synth && out.sky.hydra.synth.hush && out.sky.hydra.synth.hush(); } catch (_) {} } };
    return out;
  }

  /* ------------------------------------------------------------ main */

  async function mount(userOpts) {
    const opts = Object.assign({}, DEFAULTS, userOpts || {});
    opts.sky = Object.assign({}, DEFAULTS.sky, (userOpts && userOpts.sky) || {});

    if (opts.oncePerSession && sessionStorage.getItem(opts.sessionKey)) return false;
    if (opts.respectReducedMotion && matchMedia('(prefers-reduced-motion: reduce)').matches) return false;

    const gate = buildDOM(opts);
    const canvas = gate.querySelector('#cedain-gate-canvas');
    const skipBtn = gate.querySelector('#cedain-gate-skip');
    const hintEl = gate.querySelector('#cedain-gate-hint');
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';

    let THREE, font;
    try {
      [THREE, font] = await Promise.all([loadThree(opts.threeURL), loadFont(opts)]);
    } catch (e) {
      console.warn('[cedain-intro] load failed, skipping gate', e);
      teardown(); return false;
    }

    // renderer -------------------------------------------------------------
    if (hintEl) hintEl.textContent = opts.controls
      ? (matchMedia('(pointer:coarse)').matches ? 'drag to look around · tap to enter' : 'drag to look around · click to enter')
      : '';

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    const isMobile = matchMedia('(pointer:coarse)').matches || innerWidth < 720;
    const LANDOPT = (opts.land && opts.land.base && !isMobile) ? opts.land : null;
    const scene = new THREE.Scene();
    let land = null;
    if (LANDOPT) {
      gate.classList.add('is-loading');
      const sayLoad = (m) => { if (hintEl) hintEl.textContent = m; };
      try { land = await buildLand(THREE, renderer, scene, opts, sayLoad); }
      catch (e) { console.warn('[cedain-intro] land failed, falling back:', e && e.message); land = null; }
      gate.classList.remove('is-loading');
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
    renderer.setSize(innerWidth, innerHeight, false);
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = opts.sky.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const floatOK = renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
    const rtType = floatOK ? THREE.FloatType : THREE.HalfFloatType;

    // environment cubemap ---------------------------------------------------
    const F = (!land && opts.film && (opts.film.src || opts.film.poster)) ? opts.film : null;
    const envRT = new THREE.WebGLCubeRenderTarget(land ? 256 : (F ? 16 : 1024), { type: THREE.HalfFloatType, generateMipmaps: false });
    const E = opts.env;
    // the plate's uniforms are shared by the glass and the backdrop
    const plateU = { uFilm: { value: null }, uPlate: { value: new THREE.Vector4(1, 1, 0, 1) }, uTan: { value: new THREE.Vector2(1, 1) } };
    let filmVideo = null, bgScene = null;
    if (F) {
      const loader = new THREE.TextureLoader(); loader.setCrossOrigin('anonymous');
      const prep = t => { t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t; };
      if (F.poster) loader.load(F.poster, t => { if (!plateU.uFilm.value) plateU.uFilm.value = prep(t); }, undefined, () => {});
      const src = (isMobile && F.srcMobile) ? F.srcMobile : F.src;
      if (src) {
        const v = document.createElement('video');
        v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.preload = 'auto';
        v.crossOrigin = 'anonymous';
        v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('loop', '');
        v.style.cssText = 'position:fixed;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none';
        v.src = src;
        const vt = prep(new THREE.VideoTexture(v));
        const useVideo = () => { if (v.readyState >= 2) plateU.uFilm.value = vt; };
        v.addEventListener('loadeddata', useVideo); v.addEventListener('playing', useVideo);
        v.addEventListener('error', () => console.warn('[cedain-intro] film did not load:', src));
        gate.appendChild(v);
        const pr = v.play(); if (pr && pr.catch) pr.catch(() => {});
        filmVideo = v;
      }
      bgScene = new THREE.Scene();
      bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        vertexShader: FILM_BG_VERT, fragmentShader: FILM_BG_FRAG, uniforms: { uFilm: plateU.uFilm, uPlate: plateU.uPlate },
        depthTest: false, depthWrite: false, toneMapped: false
      })));
      console.log('[cedain-intro] environment: the film', src ? '(' + src.split('/').pop() + ')' : '(poster only)');
    } else if (land) {
      console.log('[cedain-intro] environment: the land');
    } else if (E && E.base) {
      const url = f => (!f ? null : (/^https?:/.test(f) ? f : E.base + f));
      const [pano, mask, lattice, valley] = await Promise.all([url(E.pano), url(E.skyMask), url(E.lattice), url(E.valley)]
        .map(u => u ? loadTex(THREE, u) : Promise.resolve(null)));
      const skyScene = new THREE.Scene();
      const envMat = new THREE.ShaderMaterial({
        vertexShader: SKY_VERT, fragmentShader: ENV_FRAG, side: THREE.BackSide, depthWrite: false, toneMapped: false,
        uniforms: {
          uPano: { value: pano }, uMask: { value: mask }, uLattice: { value: lattice }, uValley: { value: valley },
          uHasPano: { value: pano ? 1 : 0 }, uHasMask: { value: mask ? 1 : 0 }, uHasLattice: { value: lattice ? 1 : 0 }, uHasValley: { value: valley ? 1 : 0 },
          uT: { value: 0 }, uLatGain: { value: E.latticeGain != null ? E.latticeGain : 0.6 }, uLatGlow: { value: E.latticeGlow != null ? E.latticeGlow : 0.2 },
          uYaw: { value: (E.yaw || 0) / 360 }, uGain: { value: 1.0 }, uExposure: { value: opts.envExposure }, uFallback: { value: 0 },
          uInk: { value: new THREE.Color(0x08090C) }, uChamb: { value: new THREE.Color(0x9EB4D3) },
          uCham: { value: new THREE.Color(0xE8D3A6) }, uShell: { value: new THREE.Color(0xEDE6E8) }, uDusk: { value: new THREE.Color(0x2A2633) }
        }
      });
      skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 48, 32), envMat));
      const cubeCam = new THREE.CubeCamera(0.1, 100, envRT);
      cubeCam.update(renderer, skyScene);
      envMat.dispose();
      console.log('[cedain-intro] environment:', pano ? 'panorama' : 'no panorama (ink horizon)', lattice ? '+ lattice' : '');
    } else {
      const skyScene = new THREE.Scene();
      const skyMat = new THREE.ShaderMaterial({
        vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, toneMapped: false,
        uniforms: {
          uZenith:  { value: new THREE.Color(opts.sky.zenith) },
          uHorizon: { value: new THREE.Color(opts.sky.horizon) },
          uSea:     { value: new THREE.Color(opts.sky.sea) },
          uCloud:   { value: new THREE.Color(opts.sky.cloud) },
          uSunDir:  { value: new THREE.Vector3().fromArray(opts.sky.sunDir).normalize() },
          uSunPower:{ value: opts.sky.sunPower },
          uCover:   { value: opts.sky.cloudCover },
        }
      });
      skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMat));
      const cubeCam = new THREE.CubeCamera(0.1, 100, envRT);
      cubeCam.update(renderer, skyScene);
      skyMat.dispose();
    }

    // wordmark --------------------------------------------------------------
    const shapes = textShapes(THREE, font, opts.text, opts.letterSize, opts.letterSpacing);
    const geo = new THREE.ExtrudeGeometry(shapes, {
      depth: opts.depth * opts.letterSize, bevelEnabled: true,
      bevelThickness: opts.bevel * opts.letterSize, bevelSize: opts.bevel * 0.85 * opts.letterSize,
      bevelSegments: 3, curveSegments: 10, steps: 1,
    });
    geo.computeBoundingBox();
    const bb = geo.boundingBox, center = bb.getCenter(new THREE.Vector3());
    geo.translate(-center.x, -center.y, -center.z);
    geo.computeVertexNormals();
    const extent = bb.getSize(new THREE.Vector3());
    const maxThick = extent.length() * 0.35;

    if (!bgScene && !land) scene.background = envRT.texture;

    const backMat = new THREE.ShaderMaterial({ vertexShader: BACK_VERT, fragmentShader: BACK_FRAG, side: THREE.BackSide, toneMapped: false });
    const glassMat = new THREE.ShaderMaterial({
      vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG, side: THREE.DoubleSide,
      defines: Object.assign({ STEPS: isMobile ? Math.max(8, opts.marchSteps >> 1) : opts.marchSteps }, bgScene ? { FILM: 1, LIT: 1 } : {}, land ? { LIT: 1 } : {}),
      uniforms: Object.assign({
        uEnv:  { value: envRT.texture },
        uBack: { value: null },
        uTint: { value: new THREE.Vector3().fromArray(opts.tint) },
        uIor:  { value: opts.ior },
        uDisp: { value: opts.dispersion },
        uF0:   { value: Math.pow((opts.fresnelIOR - 1) / (opts.fresnelIOR + 1), 2) },
        uMaxThick: { value: maxThick },
      }, bgScene ? plateU : {})
    });
    // debug:true swaps in a material that cannot fail, so an empty frame means
    // geometry or camera rather than the glass shader
    const mesh = new THREE.Mesh(geo, opts.debug ? new THREE.MeshNormalMaterial({ flatShading: true }) : glassMat);
    scene.add(mesh);
    const backScene = new THREE.Scene();
    const backMesh = new THREE.Mesh(geo, backMat);
    backScene.add(backMesh);
    let cubeCam = null;
    if (land) {
      const LT = opts.land.letters;
      const k = LT.width / extent.x;
      mesh.scale.setScalar(k); backMesh.scale.setScalar(k);
      mesh.position.set(LT.x, LT.y, LT.z); backMesh.position.copy(mesh.position);
      // the word faces east, toward the mountains the viewer stands on
      mesh.rotation.set(0, Math.PI / 2 + (LT.yawDeg || 0) * Math.PI / 180, 0); backMesh.rotation.copy(mesh.rotation);
      glassMat.uniforms.uMaxThick.value = maxThick * k;
      cubeCam = new THREE.CubeCamera(20, 60000, envRT);
      cubeCam.position.copy(mesh.position);
      // the glass reflects the cheap half of the scene (layer 1: the sky, the
      // far ground, the lights, the streets, the core) - never the walk's own
      // fine terrain or the traffic - one face every few frames, so the
      // reflection costs a sliver of each frame instead of a hitch
      cubeCam.children.forEach(c => c.layers.set(1));
      scene.add(cubeCam);
    }

    let backRT = null;
    function sizeTargets() {
      const w = renderer.domElement.width, h = renderer.domElement.height;
      if (backRT && backRT.width === w && backRT.height === h) return;
      if (backRT) backRT.dispose();
      backRT = new THREE.WebGLRenderTarget(w, h, { type: rtType, format: THREE.RGBAFormat, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      glassMat.uniforms.uBack.value = backRT.texture;
    }

    // camera + flight path --------------------------------------------------
    const camera = new THREE.PerspectiveCamera(land ? 62 : 42, innerWidth / innerHeight, land ? 0.6 : 0.02, land ? 70000 : 200);
    const W = extent.x;
    // positions are in wordmark units; text is centred at origin, reading toward +x, face toward +z
    // An orbit that stays wide enough to keep the whole word framed, closes in,
    // then dives through the gap between the last two letters on the final beat.
    const R = W * 1.15;                       // orbit radius: whole word in frame at fov 42
    const gapX = W * 0.30;                    // x of the hole we exit through
    const posCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-R * 1.30,  W * 0.42,  R * 1.30),
      new THREE.Vector3(-R * 1.15,  W * 0.10,  R * 0.75),
      new THREE.Vector3(-R * 0.80, -W * 0.18,  R * 0.95),
      new THREE.Vector3(-R * 0.20,  W * 0.22,  R * 1.05),
      new THREE.Vector3( R * 0.45,  W * 0.30,  R * 0.90),
      new THREE.Vector3( R * 0.70,  W * 0.05,  R * 0.55),
      new THREE.Vector3( gapX,      0.0,       W * 0.30),   // lined up on the gap
      new THREE.Vector3( gapX,      0.0,      -W * 1.20),   // through it
    ], false, 'centripetal', 0.5);
    const lookCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(-W * 0.10, 0, 0),
      new THREE.Vector3( 0, W * 0.04, 0),
      new THREE.Vector3( W * 0.12, 0, 0),
      new THREE.Vector3( W * 0.24, 0, 0),
      new THREE.Vector3( gapX, 0, -W * 0.60),
      new THREE.Vector3( gapX, 0, -W * 3.00),
    ], false, 'centripetal', 0.5);

    function fitCamera() {
      const aspect = innerWidth / innerHeight;
      camera.aspect = aspect;
      const baseFov = land ? 62 : 42;
      // keep horizontal field constant in portrait so the word stays in frame
      camera.fov = aspect >= 1 ? baseFov : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(baseFov) / 2) / aspect));
      camera.updateProjectionMatrix();
      if (bgScene) {
        // Cover the screen with the plate and pin its horizon at the anchor:
        // the plate's height in screen heights has to reach the top edge
        // once the horizon has been pulled down, and the bottom edge too.
        const Ap = F.aspect || 16 / 9, hp0 = F.horizon != null ? F.horizon : 0.54, hs = F.anchor != null ? F.anchor : 0.40;
        const hp = Math.max(aspect / Ap, 1, (1 - hs) / Math.max(1 - hp0, 0.05), hs / Math.max(hp0, 0.05));
        const b = hs - hp0 * hp;
        plateU.uPlate.value.set(hp * Ap / aspect, hp, b, F.exposure != null ? F.exposure : 1.4);
        const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
        plateU.uTan.value.set(tv * aspect, tv);
      }
    }

    function onResize() {
      renderer.setSize(innerWidth, innerHeight, false);
      fitCamera();
      sizeTargets();
    }
    addEventListener('resize', onResize);
    onResize();

    // run -------------------------------------------------------------------
    // Three phases when controls are on: the cinematic flight runs, the camera
    // settles back to an orbit vantage, then the viewer has it. Any drag, wheel
    // or touch during the first two phases hands over immediately.
    let start = null, leaving = false, done = false, raf = 0, prevNow = 0;
    let phase = opts.controls ? 'flight' : 'flight';
    let settleStart = 0;
    const up = new THREE.Vector3(0, 1, 0);
    const P = new THREE.Vector3(), L = new THREE.Vector3();
    const settleFrom = new THREE.Vector3(), settleLookFrom = new THREE.Vector3();

    // orbit state
    const target = new THREE.Vector3(0, 0, 0);
    const orbit = { theta: -0.55, phi: 1.32, radius: R * 1.25 };
    const orbitTo = { theta: -0.55, phi: 1.32, radius: R * 1.25 };
    const R_MIN = W * 0.10, R_MAX = W * 3.2;
    const PHI_MIN = 0.22, PHI_MAX = Math.PI - 0.22;
    let lastInput = -1e9, dragging = false, lastX = 0, lastY = 0, pinchDist = 0;
    let tapAt = 0, tapMoved = 0;   // a press that does not travel is a way in
    // the walk: on the ground, Minecraft's numbers
    const MC = Object.assign({}, DEFAULTS.walk, opts.walk || {});
    const walk = { yaw: 0, pitch: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), grounded: false, keys: {}, run: false, dragId: null, lx: 0, ly: 0, frame: 0 };
    const landListeners = [];
    if (land) {
      const S = opts.land.spawn || { x: -6500, z: 1500, yawDeg: 90, pitchDeg: -4 };
      walk.pos.set(S.x, land.groundAt(S.x, S.z) + MC.EYE, S.z);
      walk.yaw = (S.yawDeg || 0) * Math.PI / 180;
      walk.pitch = (S.pitchDeg || 0) * Math.PI / 180;
      walk.spawn = { x: S.x, z: S.z, reach: opts.land.reach || 3000 };
      camera.position.copy(walk.pos);
      phase = 'free';
      gate.classList.add('is-land', 'has-control');
      canvas.classList.add('is-walk');
      if (hintEl) hintEl.textContent = 'WASD walk · space jump · shift run · drag to look';
      const on = (el, ev, fn, o) => { el.addEventListener(ev, fn, o); landListeners.push([el, ev, fn]); };
      on(canvas, 'pointerdown', (e) => { if (walk.dragId === null) { walk.dragId = e.pointerId; walk.lx = e.clientX; walk.ly = e.clientY; canvas.style.cursor = 'grabbing'; } });
      on(window, 'pointermove', (e) => {
        if (e.pointerId !== walk.dragId) return;
        walk.yaw -= (e.clientX - walk.lx) * 0.0042;
        walk.pitch = THREE.MathUtils.clamp(walk.pitch - (e.clientY - walk.ly) * 0.0042, -1.35, 1.35);
        walk.lx = e.clientX; walk.ly = e.clientY;
      });
      const endDrag = (e) => { if (e.pointerId === walk.dragId) { walk.dragId = null; canvas.style.cursor = ''; } };
      on(window, 'pointerup', endDrag); on(window, 'pointercancel', endDrag);
      on(window, 'keydown', (e) => {
        walk.keys[e.code] = true;
        if (e.code === 'KeyR' && !e.repeat) walk.run = !walk.run;
        if (e.code === 'Space' && !(e.target && /^(INPUT|TEXTAREA|BUTTON)$/.test(e.target.tagName))) e.preventDefault();
      });
      on(window, 'keyup', (e) => { walk.keys[e.code] = false; });
      on(window, 'blur', () => { walk.keys = {}; });
    }
    // one step of the walk. Intent from the keys; the velocity chases it
    // fast on the ground and slowly in the air; a jump is a take-off speed
    // under constant gravity; coming down a slope the feet stay on it.
    function stepWalk(dt) {
      const K = walk.keys; let fwd = 0, side = 0;
      if (K.KeyW || K.ArrowUp) fwd += 1; if (K.KeyS || K.ArrowDown) fwd -= 1;
      if (K.KeyA || K.ArrowLeft) side -= 1; if (K.KeyD || K.ArrowRight) side += 1;
      const l = Math.hypot(fwd, side); if (l > 1) { fwd /= l; side /= l; }
      const sp = (walk.run || K.ShiftLeft || K.ShiftRight) ? MC.RUN : MC.WALK;
      const sy = Math.sin(walk.yaw), cy = Math.cos(walk.yaw);
      let wx = (-sy * fwd + cy * side) * sp, wz = (-cy * fwd - sy * side) * sp;
      // the path: past the reach the ground gives nothing back, you slow and stop
      const ox = walk.pos.x - walk.spawn.x, oz = walk.pos.z - walk.spawn.z, od = Math.hypot(ox, oz);
      if (od > walk.spawn.reach) { const outward = (wx * ox + wz * oz) / Math.max(od, 1); if (outward > 0) { wx -= ox / od * outward; wz -= oz / od * outward; } }
      const k = 1 - Math.exp(-dt * (walk.grounded ? 16 : 3));
      walk.vel.x += (wx - walk.vel.x) * k; walk.vel.z += (wz - walk.vel.z) * k;
      if (K.Space && walk.grounded) { walk.vel.y = MC.JUMP; walk.grounded = false; }
      walk.vel.y -= MC.G * dt;
      walk.pos.x += walk.vel.x * dt; walk.pos.z += walk.vel.z * dt; walk.pos.y += walk.vel.y * dt;
      const gy = land.groundAt(walk.pos.x, walk.pos.z) + MC.EYE;
      if (walk.pos.y <= gy) { walk.pos.y = gy; if (walk.vel.y < 0) walk.vel.y = 0; walk.grounded = true; }
      else if (walk.grounded && walk.vel.y <= 0 && walk.pos.y - gy < 1.2) { walk.pos.y = gy; walk.vel.y = 0; }   // down a slope, feet stay on it
      else walk.grounded = false;
    }
    if (land) { gate.__walk = walk; gate.__step = stepWalk; }   // for the harness: the walk can be stepped by hand

    function sphericalFromCamera() {
      const v = camera.position.clone().sub(target);
      orbit.radius = orbitTo.radius = THREE.MathUtils.clamp(v.length(), R_MIN, R_MAX);
      orbit.theta  = orbitTo.theta  = Math.atan2(v.x, v.z);
      orbit.phi    = orbitTo.phi    = THREE.MathUtils.clamp(Math.acos(THREE.MathUtils.clamp(v.y / Math.max(v.length(), 1e-5), -1, 1)), PHI_MIN, PHI_MAX);
    }

    function takeOver() {
      if (phase === 'free') return;
      sphericalFromCamera();
      phase = 'free';
      gate.classList.add('has-control');
    }

    function applyOrbit(dt) {
      const k = 1 - Math.pow(0.0016, dt);           // frame-rate independent damping
      orbit.theta  += (orbitTo.theta  - orbit.theta)  * k;
      orbit.phi    += (orbitTo.phi    - orbit.phi)    * k;
      orbit.radius += (orbitTo.radius - orbit.radius) * k;
      const s = Math.sin(orbit.phi);
      camera.position.set(
        target.x + orbit.radius * s * Math.sin(orbit.theta),
        target.y + orbit.radius * Math.cos(orbit.phi),
        target.z + orbit.radius * s * Math.cos(orbit.theta));
      camera.up.set(0, 1, 0);
      camera.lookAt(target);
    }

    // input ------------------------------------------------------------------
    function onDown(e) {
      dragging = true; lastInput = performance.now();
      const p = e.touches ? e.touches[0] : e;
      lastX = p.clientX; lastY = p.clientY;
      tapAt = performance.now(); tapMoved = 0;
      if (e.touches && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchDist = Math.hypot(dx, dy);
      }
      takeOver();
    }
    function onMove(e) {
      if (!dragging) return;
      lastInput = performance.now();
      if (e.touches && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY;
        const d = Math.hypot(dx, dy);
        if (pinchDist > 0) orbitTo.radius = THREE.MathUtils.clamp(orbitTo.radius * (pinchDist / Math.max(d, 1)), R_MIN, R_MAX);
        pinchDist = d;
        if (e.cancelable) e.preventDefault();
        return;
      }
      const p = e.touches ? e.touches[0] : e;
      const dx = p.clientX - lastX, dy = p.clientY - lastY;
      lastX = p.clientX; lastY = p.clientY;
      tapMoved += Math.abs(dx) + Math.abs(dy);
      orbitTo.theta -= dx * 0.005;
      orbitTo.phi = THREE.MathUtils.clamp(orbitTo.phi - dy * 0.005, PHI_MIN, PHI_MAX);
      if (e.touches && e.cancelable) e.preventDefault();
    }
    function onUp() {
      const wasDrag = !dragging || tapMoved > 10 || performance.now() - tapAt > 600 || pinchDist > 0;
      dragging = false; pinchDist = 0;
      if (!wasDrag && tapAt) { tapAt = 0; leave(); }
    }
    function onWheel(e) {
      lastInput = performance.now();
      takeOver();
      orbitTo.radius = THREE.MathUtils.clamp(orbitTo.radius * (1 + Math.sign(e.deltaY) * 0.09), R_MIN, R_MAX);
      if (e.cancelable) e.preventDefault();
    }

    if (opts.controls && !land) {
      canvas.addEventListener('pointerdown', onDown);
      addEventListener('pointermove', onMove);
      addEventListener('pointerup', onUp);
      addEventListener('pointercancel', onUp);
      canvas.addEventListener('touchstart', onDown, { passive: false });
      canvas.addEventListener('touchmove', onMove, { passive: false });
      addEventListener('touchend', onUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });
    }

    function frame(now) {
      if (start === null) { start = now; prevNow = now; }
      const dt = Math.min((now - prevNow) / 1000, 0.1); prevNow = now;
      let t = Math.min((now - start) / opts.duration, 1);
      const tt = ease.inOutSine(t) * 0.35 + t * 0.65;          // slow in, keeps momentum out

      if (land) {
        stepWalk(dt);
        camera.position.copy(walk.pos);
        camera.rotation.set(0, 0, 0, 'YXZ'); camera.rotateY(walk.yaw); camera.rotateX(walk.pitch);
        land.update(dt, now / 1000);
        // the glass sees the scene around it; refreshed every so often, never with itself in it
        if (cubeCam && (walk.frame++ % 4) === 0) {
          const face = (walk.frame >> 2) % 6, cam = cubeCam.children[face];
          const rt = renderer.getRenderTarget(), cf = renderer.getActiveCubeFace(), ml = renderer.getActiveMipmapLevel(), xr = renderer.xr.enabled;
          renderer.xr.enabled = false;
          renderer.setRenderTarget(envRT, face, 0); renderer.render(scene, cam);
          renderer.setRenderTarget(rt, cf, ml); renderer.xr.enabled = xr;
        }
      } else if (phase === 'flight') {
        posCurve.getPointAt(tt, P);
        lookCurve.getPointAt(tt, L);
        camera.position.copy(P);
        up.set(Math.sin(tt * Math.PI * 2) * 0.12, 1, 0).normalize(); // gentle bank
        camera.up.copy(up);
        camera.lookAt(L);
        if (t >= 1) {
          if (opts.controls) { phase = 'settle'; settleStart = now; settleFrom.copy(camera.position); settleLookFrom.copy(L); }
          else if (!leaving) leave();
        }
      } else if (phase === 'settle') {
        // ease from wherever the flight ended back to the orbit vantage
        const s = Math.min((now - settleStart) / opts.settleDuration, 1);
        const e = ease.outCubic(s);
        const sp = Math.sin(orbitTo.phi);
        const dest = new THREE.Vector3(
          orbitTo.radius * sp * Math.sin(orbitTo.theta),
          orbitTo.radius * Math.cos(orbitTo.phi),
          orbitTo.radius * sp * Math.cos(orbitTo.theta));
        camera.position.lerpVectors(settleFrom, dest, e);
        camera.up.set(0, 1, 0);
        L.lerpVectors(settleLookFrom, target, e);
        camera.lookAt(L);
        if (s >= 1) { sphericalFromCamera(); phase = 'free'; gate.classList.add('has-control'); }
      } else {
        // idle drift so the scene never sits dead still
        if (!dragging && now - lastInput > opts.driftDelay) orbitTo.theta -= opts.driftSpeed * dt;
        applyOrbit(dt);
      }

      if (phase !== 'free') {
        mesh.rotation.y = THREE.MathUtils.degToRad(-14 + 18 * tt);
        mesh.rotation.x = THREE.MathUtils.degToRad(6 - 8 * tt);
        backMesh.rotation.copy(mesh.rotation);
      }

      renderer.setRenderTarget(backRT);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.render(backScene, camera);
      renderer.setRenderTarget(null);
      if (bgScene) {
        renderer.autoClear = true;
        renderer.render(bgScene, camera);
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(scene, camera);
        renderer.autoClear = true;
      } else {
        renderer.render(scene, camera);
      }

      if (!opts.controls && t >= 0.80 && !leaving) leave();
      if (!done) raf = requestAnimationFrame(frame);
    }

    function leave() {
      if (leaving) return;
      leaving = true;
      if (opts.oncePerSession) { try { sessionStorage.setItem(opts.sessionKey, '1'); } catch (_) {} }
      gate.classList.add('is-leaving');
      setTimeout(finish, opts.leaveDuration + 40);
    }

    function finish() {
      done = true;
      cancelAnimationFrame(raf);
      teardown();
      geo.dispose(); glassMat.dispose(); backMat.dispose(); envRT.dispose(); if (backRT) backRT.dispose();
      if (filmVideo) { try { filmVideo.pause(); filmVideo.removeAttribute('src'); filmVideo.load(); } catch (_) {} }
      if (land) { try { land.dispose(); } catch (_) {} }
      renderer.dispose();
      if (typeof opts.onDone === 'function') opts.onDone();
      resolveDone(true);
    }

    function teardown() {
      removeEventListener('resize', onResize);
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      removeEventListener('touchend', onUp);
      landListeners.forEach(([el, ev, fn]) => el.removeEventListener(ev, fn));
      document.documentElement.style.overflow = prevOverflow;
      gate.remove();
    }

    if (opts.skipOnInput || opts.controls) {
      skipBtn.addEventListener('click', leave);
      addEventListener('keydown', function onKey(e) { if (e.key === 'Enter' || e.key === 'Escape' || (e.key === ' ' && !land)) { leave(); removeEventListener('keydown', onKey); } });
    } else skipBtn.remove();

    let resolveDone;
    const donePromise = new Promise(r => { resolveDone = r; });

    // warm the shader before the reveal so the first frame isn't a hitch. If the
    // program fails to link, three logs the GLSL error and the mesh silently
    // disappears while the sky keeps drawing -- so say so loudly here.
    renderer.compile(scene, camera);
    if (cubeCam) { mesh.visible = false; cubeCam.update(renderer, scene); mesh.visible = true; }
    if (!opts.debug) {
      const prog = renderer.info.programs && renderer.info.programs.find(pr => pr.cacheKey && pr.cacheKey.indexOf('marchExit') !== -1);
      if (prog && prog.diagnostics && !prog.diagnostics.runnable) {
        console.error('[cedain-intro] glass shader failed to link; the wordmark will not draw.', prog.diagnostics);
      }
    }
    console.info('[cedain-intro] v4 ready' + (land ? ' (the land)' : '') + ' — text "' + opts.text + '", ' +
      (geo.attributes.position.count) + ' verts, width ' + extent.x.toFixed(2) +
      (opts.debug ? ' [DEBUG: normal material]' : ''));
    requestAnimationFrame(() => { gate.classList.add('is-ready'); raf = requestAnimationFrame(frame); });
    return donePromise;
  }

  return { mount, DEFAULTS };
})();
