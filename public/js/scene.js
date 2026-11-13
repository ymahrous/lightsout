// The town behind the interface: a three.js skyline where every player owns one window.
// Night, dawn and the vote each have a sky; a window goes dark when its player is out.
// If WebGL or the library is unavailable the game still works over a plain gradient.
const rnd = n => Math.floor(Math.random() * n);

export async function createScene(canvas) {
  const none = { mood() {}, windows() {}, pulse() {}, demo() {} };
  let T; try { T = await import('/vendor/three/three.module.js'); } catch (e) { return none; }
  // Colours here are authored as final screen values, so three's colour management stays out of the way.
  T.ColorManagement.enabled = false;
  // Phones and tablets get a lighter scene: fewer pixels, fewer particles, 30 frames a second.
  // The town moves slowly, so the difference is hard to see and saves a lot of battery.
  const light = matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4;
  let R; try { R = new T.WebGLRenderer({ canvas, antialias: !light, powerPreference: 'low-power' }); } catch (e) { return none; }
  R.outputColorSpace = T.LinearSRGBColorSpace;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  R.setPixelRatio(Math.min(window.devicePixelRatio || 1, light ? 1.25 : 2));
  const scene = new T.Scene(), cam = new T.PerspectiveCamera(38, 1, 0.1, 700);
  scene.add(cam); scene.fog = new T.Fog(0x000000, 10, 70);
  const HOR = 0.2, FT = Math.tan(T.MathUtils.degToRad(19)), NEAR_Z = -12;
  const U = { uTop: { value: new T.Color() }, uHor: { value: new T.Color() }, uOrbCol: { value: new T.Color() }, uOrb: { value: new T.Vector2(.7, .6) }, uOrbSize: { value: .05 }, uSun: { value: 0 }, uStars: { value: 1 }, uTime: { value: 0 }, uAspect: { value: 1 }, uHorizon: { value: HOR } };
  const sky = new T.Mesh(new T.PlaneGeometry(1, 1), new T.ShaderMaterial({
    uniforms: U, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uTop,uHor,uOrbCol; uniform vec2 uOrb; uniform float uOrbSize,uSun,uStars,uTime,uAspect,uHorizon; varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      void main(){
        float t=clamp((vUv.y-uHorizon)/(1.0-uHorizon),0.0,1.0);
        vec3 col=mix(uHor,uTop,pow(t,0.5));
        col+=uHor*0.4*exp(-t*10.0);
        vec2 g=vUv*vec2(uAspect,1.0)*90.0; vec2 id=floor(g); float h=hash(id);
        vec2 f=fract(g)-0.5-(vec2(hash(id+1.3),hash(id+7.1))-0.5)*0.6;
        float star=step(0.985,h)*smoothstep(0.2,0.0,length(f));
        col+=vec3(0.9,0.92,1.0)*star*(0.55+0.45*sin(uTime*(0.8+h*3.0)+h*40.0))*uStars*smoothstep(0.02,0.4,t);
        vec2 d=(vUv-uOrb)*vec2(uAspect,1.0); float r=length(d);
        float disc=smoothstep(uOrbSize,uOrbSize*0.93,r);
        float bite=smoothstep(uOrbSize*0.92,uOrbSize*0.85,length(d-vec2(uOrbSize*0.45,uOrbSize*0.2)));
        float body=mix(disc*(1.0-bite),disc,uSun);
        col+=uOrbCol*exp(-r/(uOrbSize*mix(1.8,4.0,uSun)))*mix(0.3,0.7,uSun);
        col=mix(col,uOrbCol,body);
        gl_FragColor=vec4(col,1.0);
      }`
  }));
  sky.renderOrder = -10; sky.frustumCulled = false; cam.add(sky);

  let seed = 11; const rr = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const matB = new T.MeshBasicMaterial({ color: 0x000000 });
  const box = new T.BoxGeometry(1, 1, 1), near = [], far = [];
  const rowOf = (z, x0, x1, h0, h1, w0, w1, keep) => { let x = x0; while (x < x1) { const w = w0 + rr() * (w1 - w0), h = h0 + rr() * (h1 - h0); const m = new T.Mesh(box, matB); m.scale.set(w, h, 2); m.position.set(x + w / 2, h / 2, z); scene.add(m); keep.push({ x: x + w / 2, w, h }); x += w + rr() * .35; } };
  rowOf(-34, -80, 80, 5, 15, 2.5, 6, far);
  rowOf(NEAR_Z, -44, 44, 2.4, 6.2, 1.8, 3.4, near);
  const ground = new T.Mesh(new T.PlaneGeometry(700, 260), matB); ground.rotation.x = -Math.PI / 2; ground.position.set(0, 0, -70); scene.add(ground);

  // far city lights
  const fl = []; for (const b of far) { const n = Math.floor(rr() * 3); for (let i = 0; i < n; i++) fl.push([b.x + (rr() - .5) * (b.w - .8), 1 + rr() * (b.h - 1.6)]); }
  const farMat = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .55 });
  const farWin = new T.InstancedMesh(new T.PlaneGeometry(.3, .42), farMat, fl.length);
  const dm = new T.Object3D(); fl.forEach((p, i) => { dm.position.set(p[0], p[1], -32.9); dm.updateMatrix(); farWin.setMatrixAt(i, dm.matrix); }); scene.add(farWin);

  // twelve player windows on the near row
  let slots = [];
  for (const b of near) { if (Math.abs(b.x) > 6.4) continue; const cols = Math.max(1, Math.floor((b.w - .5) / .75)), rows = Math.max(1, Math.floor((b.h - .9) / 1)); for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) slots.push({ x: b.x + (c - (cols - 1) / 2) * .75, y: 1 + r + (b.h - .9 - rows) * .5 }); }
  for (let i = slots.length - 1; i > 0; i--) { const j = Math.floor(rr() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
  while (slots.length < 12) slots.push({ x: (rr() - .5) * 11, y: 1 + rr() * 1.4 });
  slots = slots.slice(0, 12);
  const gc = document.createElement('canvas'); gc.width = gc.height = 64; const g2 = gc.getContext('2d'); const gr = g2.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.3, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g2.fillStyle = gr; g2.fillRect(0, 0, 64, 64);
  const glowTex = new T.CanvasTexture(gc), OFF = new T.Color('#15101d');
  const wins = slots.map(s => {
    const m = new T.Mesh(new T.PlaneGeometry(.36, .52), new T.MeshBasicMaterial({ color: 0x000000, fog: false })); m.position.set(s.x, s.y, NEAR_Z + 1.02);
    const gl = new T.Mesh(new T.PlaneGeometry(2.8, 2.8), new T.MeshBasicMaterial({ map: glowTex, transparent: true, blending: T.AdditiveBlending, depthWrite: false, fog: false, opacity: 0 })); gl.position.set(s.x, s.y, NEAR_Z + 1.1);
    scene.add(m, gl); return { m, gl, lit: 0, to: 0, tint: new T.Color('#d2ab63'), me: false, ph: rr() * 6 };
  });

  // drifting motes
  const N = light ? 280 : 700, pos = new Float32Array(N * 3), sd = new Float32Array(N);
  for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - .5) * 46; pos[i * 3 + 1] = Math.random() * 14; pos[i * 3 + 2] = -30 + Math.random() * 40; sd[i] = Math.random(); }
  const pg = new T.BufferGeometry(); pg.setAttribute('position', new T.BufferAttribute(pos, 3)); pg.setAttribute('aSeed', new T.BufferAttribute(sd, 1));
  const PU = { uTime: { value: 0 }, uFlow: { value: 0 }, uWarp: { value: 0 }, uPx: { value: 1 }, uCol: { value: new T.Color() } };
  const motes = new T.Points(pg, new T.ShaderMaterial({
    uniforms: PU, transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    vertexShader: `attribute float aSeed; uniform float uTime,uFlow,uWarp,uPx; varying float vA;
      void main(){ vec3 p=position; p.y=mod(p.y+uFlow*(0.12+aSeed*0.3),14.0); p.x+=sin(uTime*0.3+aSeed*30.0)*0.6;
        vec4 mv=modelViewMatrix*vec4(p,1.0); gl_PointSize=uPx*(1.5+aSeed*3.0)*(1.0+uWarp*1.5)*10.0/-mv.z;
        vA=(0.25+0.75*aSeed)*smoothstep(0.0,1.5,p.y)*smoothstep(14.0,11.0,p.y); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: 'uniform vec3 uCol; varying float vA; void main(){ float a=smoothstep(0.5,0.0,length(gl_PointCoord-0.5)); gl_FragColor=vec4(uCol,a*vA*0.6); }'
  }));
  motes.frustumCulled = false; scene.add(motes);

  const MOODS = {
    dusk: { top: '#110c1e', hor: '#4a2a48', fog: '#2c1c33', bld: '#0c0912', orb: [.52, .88], nar: [.8, .9], oc: '#e9d9b0', os: .05, sun: 0, stars: .7, mote: '#d2ab63', win: 1 },
    night: { top: '#05050d', hor: '#1c1b38', fog: '#12122a', bld: '#07060d', orb: [.28, .8], oc: '#dfe6f5', os: .046, sun: 0, stars: 1, mote: '#93a9da', win: 1 },
    day: { top: '#1a1730', hor: '#d08a5c', fog: '#6b4650', bld: '#120d18', orb: [.7, .34], oc: '#ffd9a0', os: .06, sun: 1, stars: .05, mote: '#ffd9a0', win: .55 },
    vote: { top: '#12080f', hor: '#8a2740', fog: '#40162a', bld: '#0b060b', orb: [.24, .3], oc: '#ff9a7a', os: .07, sun: 1, stars: .15, mote: '#e06a6a', win: .85 },
    town: { top: '#10202a', hor: '#e0b877', fog: '#5f6a66', bld: '#0d1014', orb: [.5, .44], oc: '#fff0c8', os: .075, sun: 1, stars: 0, mote: '#ffe7a8', win: .6 },
    mafia: { top: '#070308', hor: '#5a1226', fog: '#2a0a16', bld: '#050305', orb: [.5, .72], oc: '#d8455f', os: .055, sun: 0, stars: .5, mote: '#b23a52', win: 1 }
  };
  const parse = m => ({ top: new T.Color(m.top), hor: new T.Color(m.hor), fog: new T.Color(m.fog), bld: new T.Color(m.bld), oc: new T.Color(m.oc), mote: new T.Color(m.mote), ox: m.orb[0], oy: m.orb[1], nx: m.nar ? m.nar[0] : m.orb[0], ny: m.nar ? m.nar[1] : m.orb[1], os: m.os, sun: m.sun, stars: m.stars, win: m.win });
  let moodName = 'dusk', tg = parse(MOODS.dusk); const cur = parse(MOODS.dusk); let orbType = 0;
  let warp = 0, flow = 0, time = 0, last = 0, px = 0, py = 0, tx = 0, ty = 0, dist = 26, narrow = false, demo = true, demoT = 4, demoI = -1;
  function size() {
    const w = window.innerWidth, h = window.innerHeight, a = w / h;
    R.setSize(w, h, false); cam.aspect = a; cam.setViewOffset(w, h, 0, -(0.5 - HOR) * h, w, h); cam.updateProjectionMatrix();
    dist = Math.max(26, 6.8 / (FT * a)); narrow = a < .8;
    const H = 2 * 500 * FT; sky.scale.set(H * a, H, 1); sky.position.set(0, (0.5 - HOR) * H, -500);
    U.uAspect.value = a; PU.uPx.value = h / 900 * R.getPixelRatio();
    scene.fog.near = dist - 14; scene.fog.far = dist + 46;
  }
  window.addEventListener('resize', size); size();
  window.addEventListener('pointermove', e => { tx = e.clientX / window.innerWidth - .5; ty = e.clientY / window.innerHeight - .5; }, { passive: true });
  function frame(t) {
    requestAnimationFrame(frame);
    if (document.hidden) { last = t; return; }
    if (light && t - last < 30) return;
    const dt = Math.min(.05, (t - last) / 1000 || 0); last = t; time += dt;
    const k = 1 - Math.exp(-dt * 1.5), ko = 1 - Math.exp(-dt * 2.2);
    for (const c of ['top', 'hor', 'fog', 'bld', 'oc', 'mote']) cur[c].lerp(tg[c], k);
    for (const n of ['os', 'stars', 'win']) cur[n] += (tg[n] - cur[n]) * k;
    if (tg.sun !== orbType) { cur.oy += (HOR - .16 - cur.oy) * ko; if (cur.oy < HOR - .1) { orbType = tg.sun; cur.ox = narrow ? tg.nx : tg.ox; } }
    else { cur.ox += ((narrow ? tg.nx : tg.ox) - cur.ox) * ko; cur.oy += ((narrow ? tg.ny : tg.oy) - cur.oy) * ko; }
    U.uTop.value.copy(cur.top); U.uHor.value.copy(cur.hor); U.uOrbCol.value.copy(cur.oc); U.uOrb.value.set(cur.ox, cur.oy); U.uOrbSize.value = cur.os; U.uSun.value = orbType; U.uStars.value = cur.stars; U.uTime.value = time;
    scene.fog.color.copy(cur.fog); matB.color.copy(cur.bld); farMat.color.copy(cur.mote); farMat.opacity = .25 + .3 * cur.win;
    warp += (0 - warp) * (1 - Math.exp(-dt * 1.6));
    flow += dt * (still ? .15 : 1 + warp * 14);
    PU.uTime.value = time; PU.uFlow.value = flow; PU.uWarp.value = warp; PU.uCol.value.copy(cur.mote);
    if (demo) { demoT -= dt; if (demoT < 0) { if (demoI >= 0) { wins[demoI].to = 1; demoI = -1; demoT = 3.5; } else { demoI = rnd(12); wins[demoI].to = 0; demoT = 2.6; } } }
    for (const w of wins) {
      w.lit += (w.to - w.lit) * (1 - Math.exp(-dt * (w.to < w.lit ? 5 : 2.2)));
      const fl2 = still ? 1 : .9 + .1 * Math.sin(time * 2.3 + w.ph) * Math.sin(time * 5.1 + w.ph * 2);
      const stutter = (!still && w.to < .5 && w.lit > .12) ? (Math.sin(time * 46) > 0 ? 1 : .35) : 1;
      const v = w.lit * fl2 * stutter;
      w.m.material.color.copy(OFF).lerp(w.tint, Math.min(1, v * (.55 + .45 * cur.win) * (w.me ? 1.15 : 1)));
      w.gl.material.color.copy(w.tint); w.gl.material.opacity = v * cur.win * (w.me ? .75 : .45);
    }
    if (!still) { px += (tx - px) * (1 - Math.exp(-dt * 2)); py += (ty - py) * (1 - Math.exp(-dt * 2)); }
    cam.position.set(px * 1.6, 1.4 - py * .4, NEAR_Z + dist - (still ? 0 : warp * 3.2));
    R.render(scene, cam);
  }
  requestAnimationFrame(frame);
  return {
    mood(n) { if (n === moodName || !MOODS[n]) return; moodName = n; tg = parse(MOODS[n]); if (!still) warp = 1; },
    pulse() { if (!still) warp = 1; },
    demo(v) { if (demo && !v && demoI >= 0) { demoI = -1; } demo = v; },
    windows(list) { wins.forEach((w, i) => { const p = list[i]; w.to = p && p.on ? 1 : 0; w.me = !!(p && p.me); if (p) w.tint.set(p.t); }); }
  };
}
