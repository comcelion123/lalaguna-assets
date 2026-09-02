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

  const SKY_VERT = /* glsl */`
    varying vec3 vDir;
    void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

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

    vec3 env(vec3 d){ return textureCube(uEnv, d).rgb; }

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
      <button id="cedain-gate-skip" type="button" aria-label="Enter the site">enter</button>
      <p id="cedain-gate-hint"></p>
      <style>
        #cedain-gate{position:fixed;inset:0;z-index:${opts.zIndex};background:${opts.ink};
          transform:translateY(0);will-change:transform;overflow:hidden;
          transition:transform ${opts.leaveDuration}ms cubic-bezier(.76,0,.24,1)}
        #cedain-gate.is-leaving{transform:translateY(-100%)}
        #cedain-gate-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;
          opacity:0;transition:opacity 700ms ease}
        #cedain-gate.is-ready #cedain-gate-canvas{opacity:1}
        #cedain-gate-skip{position:absolute;right:28px;bottom:24px;background:none;border:0;
          color:#E8D3A6;font:400 13px/1 'Nohemi',system-ui,sans-serif;letter-spacing:.04em;
          padding:10px 12px;cursor:pointer;opacity:0;transition:opacity 600ms ease 1600ms}
        #cedain-gate.is-ready #cedain-gate-skip{opacity:.85}
        #cedain-gate.has-control #cedain-gate-skip{opacity:1;border:1px solid rgba(232,211,166,.5);border-radius:2px}
        #cedain-gate-skip:hover,#cedain-gate-skip:focus-visible{opacity:1;outline:1px solid #E8D3A6;outline-offset:3px}
        #cedain-gate-hint{position:absolute;left:0;right:0;bottom:28px;margin:0;text-align:center;
          color:#DED6D8;font:400 12px/1 'Nohemi',system-ui,sans-serif;letter-spacing:.06em;
          opacity:0;transition:opacity 800ms ease;pointer-events:none;text-shadow:0 1px 6px rgba(8,9,12,.55)}
        #cedain-gate.is-ready #cedain-gate-hint{opacity:.72;transition-delay:2200ms}
        #cedain-gate.has-control #cedain-gate-hint{opacity:0;transition-delay:0ms}
        #cedain-gate-canvas{touch-action:none;cursor:grab}
        #cedain-gate-canvas:active{cursor:grabbing}
      </style>`;
    document.body.appendChild(gate);
    return gate;
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
      ? (matchMedia('(pointer:coarse)').matches ? 'drag to look around, pinch to zoom' : 'drag to look around, scroll to zoom')
      : '';

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    const isMobile = matchMedia('(pointer:coarse)').matches || innerWidth < 720;
    renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
    renderer.setSize(innerWidth, innerHeight, false);
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = opts.sky.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const floatOK = renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
    const rtType = floatOK ? THREE.FloatType : THREE.HalfFloatType;

    // environment cubemap ---------------------------------------------------
    const envRT = new THREE.WebGLCubeRenderTarget(512, { type: THREE.HalfFloatType, generateMipmaps: false });
    {
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

    const scene = new THREE.Scene();
    scene.background = envRT.texture;

    const backMat = new THREE.ShaderMaterial({ vertexShader: BACK_VERT, fragmentShader: BACK_FRAG, side: THREE.BackSide, toneMapped: false });
    const glassMat = new THREE.ShaderMaterial({
      vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG, side: THREE.DoubleSide,
      defines: { STEPS: isMobile ? Math.max(8, opts.marchSteps >> 1) : opts.marchSteps },
      uniforms: {
        uEnv:  { value: envRT.texture },
        uBack: { value: null },
        uTint: { value: new THREE.Vector3().fromArray(opts.tint) },
        uIor:  { value: opts.ior },
        uDisp: { value: opts.dispersion },
        uF0:   { value: Math.pow((opts.fresnelIOR - 1) / (opts.fresnelIOR + 1), 2) },
        uMaxThick: { value: maxThick },
      }
    });
    // debug:true swaps in a material that cannot fail, so an empty frame means
    // geometry or camera rather than the glass shader
    const mesh = new THREE.Mesh(geo, opts.debug ? new THREE.MeshNormalMaterial({ flatShading: true }) : glassMat);
    scene.add(mesh);
    const backScene = new THREE.Scene();
    const backMesh = new THREE.Mesh(geo, backMat);
    backScene.add(backMesh);

    let backRT = null;
    function sizeTargets() {
      const w = renderer.domElement.width, h = renderer.domElement.height;
      if (backRT && backRT.width === w && backRT.height === h) return;
      if (backRT) backRT.dispose();
      backRT = new THREE.WebGLRenderTarget(w, h, { type: rtType, format: THREE.RGBAFormat, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      glassMat.uniforms.uBack.value = backRT.texture;
    }

    // camera + flight path --------------------------------------------------
    const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.02, 200);
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
      const baseFov = 42;
      // keep horizontal field constant in portrait so the word stays in frame
      camera.fov = aspect >= 1 ? baseFov : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(baseFov) / 2) / aspect));
      camera.updateProjectionMatrix();
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
      orbitTo.theta -= dx * 0.005;
      orbitTo.phi = THREE.MathUtils.clamp(orbitTo.phi - dy * 0.005, PHI_MIN, PHI_MAX);
      if (e.touches && e.cancelable) e.preventDefault();
    }
    function onUp() { dragging = false; pinchDist = 0; }
    function onWheel(e) {
      lastInput = performance.now();
      takeOver();
      orbitTo.radius = THREE.MathUtils.clamp(orbitTo.radius * (1 + Math.sign(e.deltaY) * 0.09), R_MIN, R_MAX);
      if (e.cancelable) e.preventDefault();
    }

    if (opts.controls) {
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

      if (phase === 'flight') {
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
      renderer.render(scene, camera);

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
      document.documentElement.style.overflow = prevOverflow;
      gate.remove();
    }

    if (opts.skipOnInput || opts.controls) {
      skipBtn.addEventListener('click', leave);
      addEventListener('keydown', function onKey(e) { if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') { leave(); removeEventListener('keydown', onKey); } });
    } else skipBtn.remove();

    let resolveDone;
    const donePromise = new Promise(r => { resolveDone = r; });

    // warm the shader before the reveal so the first frame isn't a hitch. If the
    // program fails to link, three logs the GLSL error and the mesh silently
    // disappears while the sky keeps drawing -- so say so loudly here.
    renderer.compile(scene, camera);
    if (!opts.debug) {
      const prog = renderer.info.programs && renderer.info.programs.find(pr => pr.cacheKey && pr.cacheKey.indexOf('marchExit') !== -1);
      if (prog && prog.diagnostics && !prog.diagnostics.runnable) {
        console.error('[cedain-intro] glass shader failed to link; the wordmark will not draw.', prog.diagnostics);
      }
    }
    console.info('[cedain-intro] v2 ready — text "' + opts.text + '", ' +
      (geo.attributes.position.count) + ' verts, width ' + extent.x.toFixed(2) +
      (opts.debug ? ' [DEBUG: normal material]' : ''));
    requestAnimationFrame(() => { gate.classList.add('is-ready'); raf = requestAnimationFrame(frame); });
    return donePromise;
  }

  return { mount, DEFAULTS };
})();
