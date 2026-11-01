'use strict';
/* Spotteck — instrument renderers (VU meter, oscilloscope, cassette). Pure drawing, no state. */

const TAU = Math.PI * 2;

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.round(r.width);
  const h = Math.round(r.height);
  if (!w || !h) return null;
  // Canvas sizes are integers: compare rounded values, or fractional zoom resizes (and clears) every frame.
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

function reuseOffscreen(cacheObj, w, h, dpr) {
  if (!cacheObj.canvas) cacheObj.canvas = document.createElement('canvas');
  const c = cacheObj.canvas;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, ctx };
}

/* =====================================================================
   VU METER (DIN-style scale, warm pilot lamp, peak LED, needle shadow)
   ===================================================================== */

// dB → normalised scale position (non-linear, like a real VU face)
const VU_TABLE = [[-20, 0.03], [-10, 0.25], [-7, 0.37], [-5, 0.47], [-3, 0.58], [-2, 0.64], [-1, 0.70], [0, 0.765], [1, 0.83], [2, 0.895], [3, 0.96]];

function vuDbToPos(db) {
  if (!isFinite(db) || db <= -20) return Math.max(0, 0.03 + (Math.max(db, -40) + 20) * 0.0015);
  for (let i = 1; i < VU_TABLE.length; i++) {
    const [d1, p1] = VU_TABLE[i];
    if (db <= d1) {
      const [d0, p0] = VU_TABLE[i - 1];
      return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
    }
  }
  return Math.min(1.02, 0.96 + (db - 3) * 0.02);
}

function vuGeom(w, h) {
  const px = w / 2;
  const py = h * 1.2;
  const R = h * 0.93;
  const half = Math.asin(Math.min(0.92, (w * 0.40) / R));
  const angle = (pos) => -Math.PI / 2 - half + pos * 2 * half;
  return { px, py, R, angle };
}

const vuFaceCache = { key: '', canvas: null };

function vuFace(w, h, dpr) {
  const key = `${w}x${h}@${dpr}`;
  if (vuFaceCache.key === key && vuFaceCache.canvas) return vuFaceCache.canvas;
  const { c, ctx } = reuseOffscreen(vuFaceCache, w, h, dpr);
  const { px, py, R, angle } = vuGeom(w, h);

  // Paper base
  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, '#F3EAD4');
  base.addColorStop(1, '#E6DAC0');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // Paper fibre noise
  for (let i = 0; i < w * h * 0.06; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(90,70,40,0.05)' : 'rgba(255,255,255,0.10)';
    ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
  }

  const P = (pos, r) => [px + Math.cos(angle(pos)) * r, py + Math.sin(angle(pos)) * r];
  const zero = vuDbToPos(0);
  const sc = Math.max(0.58, Math.min(1.15, h / 148));

  // Main arc (black up to 0, red band above)
  ctx.lineCap = 'butt';
  ctx.strokeStyle = '#1D1B18';
  ctx.lineWidth = 1.2 * sc;
  ctx.beginPath();
  ctx.arc(px, py, R, angle(0), angle(zero));
  ctx.stroke();
  ctx.strokeStyle = '#C3341F';
  ctx.lineWidth = 4.5 * sc;
  ctx.beginPath();
  ctx.arc(px, py, R - 2.2 * sc, angle(zero), angle(vuDbToPos(3)));
  ctx.stroke();

  // Minor ticks every 0.5 dB between -10 and +3, every 1 dB below
  const minor = [];
  for (let d = -20; d < -10; d += 2.5) minor.push(d);
  for (let d = -10; d <= 3; d += 0.5) minor.push(d);
  minor.forEach((d) => {
    const pos = vuDbToPos(d);
    const [x0, y0] = P(pos, R);
    const [x1, y1] = P(pos, R + 3.5 * sc);
    ctx.strokeStyle = d > 0 ? '#C3341F' : '#3A3631';
    ctx.lineWidth = 0.7 * sc;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  });

  // Major ticks + numerals
  const majors = [[-20, '20'], [-10, '10'], [-7, '7'], [-5, '5'], [-3, '3'], [-2, '2'], [-1, '1'], [0, '0'], [1, '1'], [2, '2'], [3, '3']];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(10 * sc)}px "DIN Alternate", "Helvetica Neue", sans-serif`;
  majors.forEach(([d, label]) => {
    const pos = vuDbToPos(d);
    const red = d > 0;
    const [x0, y0] = P(pos, R - 1 * sc);
    const [x1, y1] = P(pos, R + 6.5 * sc);
    ctx.strokeStyle = red ? '#C3341F' : '#1D1B18';
    ctx.lineWidth = 1.2 * sc;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const [tx, ty] = P(pos, R + 13.5 * sc);
    ctx.fillStyle = red ? '#C3341F' : '#24211D';
    ctx.fillText(label, tx, ty);
  });

  // Percentage sub-scale under the arc
  ctx.font = `600 ${Math.max(6, Math.round(7.5 * sc))}px "Helvetica Neue", sans-serif`;
  [[0, '0'], [50, '50'], [100, '100']].forEach(([pc, label]) => {
    const pos = pc === 0 ? 0.03 : vuDbToPos(20 * Math.log10(pc / 100));
    const [x0, y0] = P(pos, R - 4.5 * sc);
    const [x1, y1] = P(pos, R - 8.5 * sc);
    ctx.strokeStyle = '#5A544B';
    ctx.lineWidth = 0.8 * sc;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const [tx, ty] = P(pos, R - 14 * sc);
    ctx.fillStyle = '#5A544B';
    ctx.fillText(label, tx, ty);
  });

  // End signs + legend
  ctx.font = `700 ${Math.round(11.5 * sc)}px "Helvetica Neue", sans-serif`;
  const [mx, my] = P(0.0, R - 25 * sc);
  ctx.fillStyle = '#24211D';
  ctx.fillText('−', mx + 5 * sc, my);
  const [plx, ply] = P(1.0, R - 25 * sc);
  ctx.fillStyle = '#C3341F';
  ctx.fillText('+', plx - 5 * sc, ply);

  ctx.font = `700 ${Math.round(14.5 * sc)}px "DIN Alternate", "Helvetica Neue", sans-serif`;
  ctx.fillStyle = '#24211D';
  ctx.fillText('VU', px, h * 0.60);

  // Printed edge shadow from the bezel lip
  const lip = ctx.createLinearGradient(0, 0, 0, 14);
  lip.addColorStop(0, 'rgba(60,40,20,0.30)');
  lip.addColorStop(1, 'rgba(60,40,20,0)');
  ctx.fillStyle = lip;
  ctx.fillRect(0, 0, w, 14);

  vuFaceCache.key = key;
  return c;
}

function drawVU(canvas, pos, peak, lamp) {
  const f = fitCanvas(canvas);
  if (!f) return;
  const { ctx, w, h, dpr } = f;
  const { px, py, R, angle } = vuGeom(w, h);

  ctx.drawImage(vuFace(w, h, dpr), 0, 0, w, h);

  const sr = h * 0.27;
  const sy = h + sr * 0.35;
  const lampY = sy - sr + 4;

  // 1. Warm incandescent backlight hidden BEHIND the black movement shroud,
  //    fanning upward across the cream/white VU dial face
  const glow = ctx.createRadialGradient(px, lampY + 6, 2, px, h * 0.62, h * 0.98);
  glow.addColorStop(0, `rgba(255, 196, 105, ${0.54 * lamp})`);
  glow.addColorStop(0.28, `rgba(255, 184, 92, ${0.30 * lamp})`);
  glow.addColorStop(0.62, `rgba(255, 195, 118, ${0.12 * lamp})`);
  glow.addColorStop(1, 'rgba(255, 205, 140, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // Soft warm rim bloom right along the top edge of the black shroud (light spilling from behind it)
  const rimBloom = ctx.createRadialGradient(px, sy, sr * 0.82, px, sy, sr * 1.45);
  rimBloom.addColorStop(0, `rgba(255, 182, 84, ${0.38 * lamp})`);
  rimBloom.addColorStop(0.55, `rgba(255, 175, 78, ${0.14 * lamp})`);
  rimBloom.addColorStop(1, 'rgba(255, 175, 78, 0)');
  ctx.fillStyle = rimBloom;
  ctx.fillRect(0, 0, w, h);

  // Corner falloff (natural vignette where the internal lamp falls off at upper corners)
  const fall = ctx.createRadialGradient(px, h * 0.72, h * 0.32, px, h * 0.55, w * 0.78);
  fall.addColorStop(0, 'rgba(40,25,10,0)');
  fall.addColorStop(1, 'rgba(35,22,8,0.28)');
  ctx.fillStyle = fall;
  ctx.fillRect(0, 0, w, h);

  // 2. Needle with a soft cast shadow on the illuminated paper dial
  const a = angle(Math.max(-0.02, Math.min(1.03, pos)));
  const tipR = R + 6;
  ctx.save();
  ctx.shadowColor = 'rgba(30,20,10,0.32)';
  ctx.shadowBlur = 2.5;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 3;
  ctx.strokeStyle = '#121110';
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.35;
  ctx.beginPath();
  ctx.moveTo(px + Math.cos(a) * (h * 0.18), py + Math.sin(a) * (h * 0.18));
  ctx.lineTo(px + Math.cos(a) * tipR, py + Math.sin(a) * tipR);
  ctx.stroke();
  ctx.restore();

  // 3. Solid matte-black movement shroud IN FRONT OF the lamp and needle pivot (NO yellow dot!)
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = -1;
  const shroud = ctx.createLinearGradient(0, sy - sr, 0, h);
  shroud.addColorStop(0, '#262422');
  shroud.addColorStop(0.35, '#191816');
  shroud.addColorStop(1, '#0F0E0D');
  ctx.fillStyle = shroud;
  ctx.beginPath();
  ctx.arc(px, sy, sr, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Subtle warm light reflection along the top bevel of the black shroud
  ctx.strokeStyle = `rgba(255, 210, 145, ${0.14 + 0.12 * lamp})`;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(px, sy, sr - 0.5, Math.PI * 1.08, Math.PI * 1.92);
  ctx.stroke();

  // Peak LED (top right)
  const ex = w - 15;
  const ey = 15;
  if (peak > 0.02) {
    const pg = ctx.createRadialGradient(ex, ey, 0, ex, ey, 12);
    pg.addColorStop(0, `rgba(255,60,25,${0.6 * peak})`);
    pg.addColorStop(1, 'rgba(255,60,25,0)');
    ctx.fillStyle = pg;
    ctx.fillRect(ex - 12, ey - 12, 24, 24);
  }
  const lg = ctx.createRadialGradient(ex - 0.8, ey - 0.8, 0.2, ex, ey, 3.6);
  lg.addColorStop(0, peak > 0.02 ? '#FFD0B8' : '#8A3A2A');
  lg.addColorStop(0.55, `rgb(${Math.round(110 + 145 * peak)},${Math.round(30 + 30 * peak)},${Math.round(22 + 6 * peak)})`);
  lg.addColorStop(1, '#3A120B');
  ctx.fillStyle = lg;
  ctx.beginPath();
  ctx.arc(ex, ey, 3.3, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

/* =====================================================================
   OSCILLOSCOPE (pure black CRT, triggered trace, phosphor afterglow)
   ===================================================================== */

function tracePath(ctx, tr, x0, x1, cy, amp) {
  const n = tr.length;
  const step = (x1 - x0) / (n - 1);
  ctx.beginPath();
  ctx.moveTo(x0, cy - tr[0] * amp);
  for (let i = 1; i < n - 1; i++) {
    const xm = x0 + (i + 0.5) * step;
    const ym = cy - ((tr[i] + tr[i + 1]) / 2) * amp;
    ctx.quadraticCurveTo(x0 + i * step, cy - tr[i] * amp, xm, ym);
  }
  ctx.lineTo(x1, cy - tr[n - 1] * amp);
}

function drawScope(canvas, traces) {
  const f = fitCanvas(canvas);
  if (!f) return;
  const { ctx, w, h } = f;
  const cy = h / 2;

  // 100% pure pitch-black background, zero glow/haze
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);

  const tr = Array.isArray(traces) ? traces[traces.length - 1] : traces;
  if (!tr || !tr.length) return;

  const x0 = w * 0.04;
  const x1 = w * 0.96;
  const amp = h * 0.36;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  tracePath(ctx, tr, x0, x1, cy, amp);

  ctx.strokeStyle = '#E8501E';
  ctx.lineWidth = 2.2;
  ctx.stroke();
}

/* =====================================================================
   COMPACT CASSETTE (smoked shell, real tape packs, cover-art label)
   ===================================================================== */

function cassetteGeom(w, h) {
  let sw = w * 0.9;
  let sh = sw / 1.574;
  if (sh > h * 0.9) { sh = h * 0.9; sw = sh * 1.574; }
  const sx = (w - sw) / 2;
  const sy = (h - sh) / 2;
  const u = sw / 100; // 1 mm
  return {
    sx, sy, sw, sh, u,
    hubY: sy + 33 * u,
    hubL: sx + (50 - 21.25) * u,
    hubR: sx + (50 + 21.25) * u,
    rCore: 10.5 * u,
    rFull: 20 * u,
    tapeY: sy + sh - 2.4 * u
  };
}

// Tangent point on circle (c, r) from external point p, picking the outer side.
function tangent(cxp, cyp, r, x, y, side) {
  const dx = x - cxp;
  const dy = y - cyp;
  const d = Math.hypot(dx, dy);
  if (d <= r) return [x, y];
  const th = Math.atan2(dy, dx);
  const al = Math.acos(r / d);
  const a1 = th + al;
  const a2 = th - al;
  const p1 = [cxp + Math.cos(a1) * r, cyp + Math.sin(a1) * r];
  const p2 = [cxp + Math.cos(a2) * r, cyp + Math.sin(a2) * r];
  return side < 0 ? (p1[0] < p2[0] ? p1 : p2) : (p1[0] > p2[0] ? p1 : p2);
}

function drawTapePack(ctx, x, y, r, rCore) {
  if (r <= rCore + 0.3) return;
  const g = ctx.createRadialGradient(x, y, rCore, x, y, r);
  g.addColorStop(0, '#170F0B');
  g.addColorStop(0.55, '#33241A');
  g.addColorStop(0.94, '#2B1D15');
  g.addColorStop(1, '#100B08');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();

  // Wound layers
  ctx.lineWidth = 0.5;
  for (let rr = rCore + 1.3; rr < r - 0.6; rr += 1.4) {
    ctx.strokeStyle = (Math.round(rr * 7) % 3 === 0) ? 'rgba(255,225,190,0.05)' : 'rgba(0,0,0,0.12)';
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, TAU);
    ctx.stroke();
  }

  // Fixed specular sheen (light from top-left)
  ctx.strokeStyle = 'rgba(255,215,170,0.13)';
  ctx.lineWidth = (r - rCore) * 0.55;
  ctx.beginPath();
  ctx.arc(x, y, (r + rCore) / 2, Math.PI * 1.05, Math.PI * 1.45);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,215,170,0.06)';
  ctx.beginPath();
  ctx.arc(x, y, (r + rCore) / 2, Math.PI * 0.05, Math.PI * 0.35);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();
}

function drawHub(ctx, x, y, angle, g) {
  const { u, rCore } = g;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  // White hub ring
  const ring = ctx.createRadialGradient(-2, -2, 1, 0, 0, rCore);
  ring.addColorStop(0, '#F4F0E7');
  ring.addColorStop(1, '#CFC9BD');
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(0, 0, rCore, 0, TAU);
  ctx.fill();

  // Tape clamp notch + 3 moulding holes (make rotation readable)
  ctx.fillStyle = '#1A1512';
  ctx.fillRect(rCore - 2.6 * u, -0.9 * u, 2.6 * u, 1.8 * u);
  for (let k = 0; k < 3; k++) {
    const a = (k * TAU) / 3 + 0.5;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * rCore * 0.78, Math.sin(a) * rCore * 0.78, 0.9 * u, 0, TAU);
    ctx.fill();
  }

  // Centre bore with 6 drive teeth
  const bore = 5.6 * u;
  ctx.fillStyle = '#0A0908';
  ctx.beginPath();
  ctx.arc(0, 0, bore, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#E4DFD4';
  for (let t = 0; t < 6; t++) {
    ctx.save();
    ctx.rotate((t * TAU) / 6);
    ctx.fillRect(-0.75 * u, -bore - 0.1, 1.5 * u, 1.9 * u);
    ctx.restore();
  }

  // Deck spindle engaged in the hub
  const sp = ctx.createRadialGradient(-0.6 * u, -0.6 * u, 0.2, 0, 0, 2.6 * u);
  sp.addColorStop(0, '#9A968E');
  sp.addColorStop(1, '#3A3835');
  ctx.fillStyle = sp;
  ctx.beginPath();
  ctx.arc(0, 0, 2.6 * u, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,20,20,0.7)';
  ctx.lineWidth = 0.8;
  for (let t = 0; t < 3; t++) {
    const a = (t * TAU) / 3;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * 0.6 * u, Math.sin(a) * 0.6 * u);
    ctx.lineTo(Math.cos(a) * 2.4 * u, Math.sin(a) * 2.4 * u);
    ctx.stroke();
  }
  ctx.restore();
}

const shellCache = { key: '', canvas: null };

function cassetteShell(w, h, dpr, g, cover) {
  const key = `${w}x${h}@${dpr}|${cover && cover.complete && cover.naturalWidth ? cover.src : ''}`;
  if (shellCache.key === key && shellCache.canvas) return shellCache.canvas;
  const { c, ctx } = reuseOffscreen(shellCache, w, h, dpr);
  const { sx, sy, sw, sh, u } = g;
  const X = (mm) => sx + mm * u;
  const Y = (mm) => sy + mm * u;

  // Smoked translucent shell — the tape packs read clearly through it
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(sx, sy, sw, sh, 3.4 * u);
  const smoke = ctx.createLinearGradient(0, sy, 0, sy + sh);
  smoke.addColorStop(0, 'rgba(40,37,34,0.42)');
  smoke.addColorStop(0.5, 'rgba(24,22,20,0.30)');
  smoke.addColorStop(1, 'rgba(18,17,15,0.50)');
  ctx.fillStyle = smoke;
  ctx.fill();
  ctx.restore();

  // Moulded window outline & inner rails
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(X(17), Y(19), 66 * u, 28 * u, 5 * u);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.roundRect(X(17) + 1, Y(19) + 1, 66 * u, 28 * u, 5 * u);
  ctx.stroke();

  // Cover-art label strip (inset cleanly inside the corner screws)
  const lx = X(9.5);
  const ly = Y(4.6);
  const lw = 81 * u;
  const lh = 9.2 * u;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(lx, ly, lw, lh, 1.2 * u);
  ctx.clip();
  if (cover && cover.complete && cover.naturalWidth) {
    const iw = cover.naturalWidth;
    const ih = cover.naturalHeight;
    const srcH = iw * (lh / lw);
    ctx.drawImage(cover, 0, (ih - srcH) * 0.42, iw, srcH, lx, ly, lw, lh);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(lx, ly, lw, lh);
  } else {
    ctx.fillStyle = '#E9E2D2';
    ctx.fillRect(lx, ly, lw, lh);
  }
  ctx.fillStyle = '#E8501E';
  ctx.fillRect(lx, ly + lh - 0.7 * u, lw, 0.7 * u);
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(lx, ly, lw, lh, 1.2 * u);
  ctx.stroke();

  // Bottom head-access trapezoid, with openings so the tape shows through
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(X(16), sy + sh);
  ctx.lineTo(X(21), sy + sh - 10.5 * u);
  ctx.lineTo(X(79), sy + sh - 10.5 * u);
  ctx.lineTo(X(84), sy + sh);
  ctx.closePath();
  ctx.rect(X(43.5), sy + sh - 5.2 * u, 13 * u, 5.2 * u);   // head
  ctx.rect(X(29), sy + sh - 4.2 * u, 5 * u, 4.2 * u);      // pinch roller
  ctx.rect(X(66), sy + sh - 4.2 * u, 5 * u, 4.2 * u);
  ctx.rect(X(20), sy + sh - 3.6 * u, 4 * u, 3.6 * u);      // guides
  ctx.rect(X(76), sy + sh - 3.6 * u, 4 * u, 3.6 * u);
  const trap = ctx.createLinearGradient(0, sy + sh - 10.5 * u, 0, sy + sh);
  trap.addColorStop(0, 'rgba(34,32,29,0.96)');
  trap.addColorStop(1, 'rgba(20,19,17,0.98)');
  ctx.fillStyle = trap;
  ctx.fill('evenodd');
  ctx.restore();
  ctx.fillStyle = '#050505';
  [37, 63].forEach((mm) => { ctx.beginPath(); ctx.arc(X(mm), sy + sh - 6.6 * u, 1.3 * u, 0, TAU); ctx.fill(); });

  // Write-protect tabs
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(X(9), sy, 4 * u, 1.6 * u);
  ctx.fillRect(X(87), sy, 4 * u, 1.6 * u);

  // Screws
  [[4.5, 4.5], [95.5, 4.5], [4.5, 59.3], [95.5, 59.3], [50, 49.5]].forEach(([mx, my]) => {
    const x = X(mx);
    const y = Y(my);
    const sg = ctx.createRadialGradient(x - 0.5, y - 0.5, 0.2, x, y, 1.7 * u);
    sg.addColorStop(0, '#77736C');
    sg.addColorStop(1, '#2A2825');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(x, y, 1.6 * u, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x - u, y); ctx.lineTo(x + u, y);
    ctx.moveTo(x, y - u); ctx.lineTo(x, y + u);
    ctx.stroke();
  });

  // Shell edges: highlight on top, shade on bottom
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1, 3.4 * u);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  ctx.roundRect(sx - 0.5, sy - 0.5, sw + 1, sh + 1, 3.6 * u);
  ctx.stroke();

  shellCache.key = key;
  shellCache.canvas = c;
  return c;
}

function drawCassette(canvas, s) {
  const f = fitCanvas(canvas);
  if (!f) return;
  const { ctx, w, h, dpr } = f;
  const g = cassetteGeom(w, h);
  const { u, rCore, rFull, hubY, hubL, hubR, sx, sw, sy, sh, tapeY } = g;

  // Deck well, faintly lit
  const bg = ctx.createRadialGradient(w / 2, h * 0.45, 10, w / 2, h / 2, w * 0.6);
  bg.addColorStop(0, '#1E1A16');
  bg.addColorStop(1, '#090807');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Tape pack radii from playback progress (tape area is conserved)
  const p = Math.min(1, Math.max(0, s.progress));
  const span = rFull * rFull - rCore * rCore;
  const rL = Math.sqrt(rCore * rCore + (1 - p) * span);
  const rR = Math.sqrt(rCore * rCore + p * span);

  drawTapePack(ctx, hubL, hubY, rL, rCore);
  drawTapePack(ctx, hubR, hubY, rR, rCore);

  // Tape path: supply pack → left guide → across the heads → right guide → take-up pack
  const gL = [sx + 13 * u, sy + sh - 6 * u];
  const gR = [sx + 87 * u, sy + sh - 6 * u];
  const tL = tangent(hubL, hubY, rL, gL[0], gL[1], -1);
  const tR = tangent(hubR, hubY, rR, gR[0], gR[1], 1);
  ctx.strokeStyle = '#3B2A1F';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(tL[0], tL[1]);
  ctx.lineTo(gL[0], gL[1]);
  ctx.lineTo(sx + 16 * u, tapeY);
  ctx.lineTo(sx + 84 * u, tapeY);
  ctx.lineTo(gR[0], gR[1]);
  ctx.lineTo(tR[0], tR[1]);
  ctx.stroke();
  ctx.fillStyle = '#B9B3A8';
  [gL, gR].forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 1.1 * u, 0, TAU); ctx.fill(); });

  drawHub(ctx, hubL, hubY, s.angleL, g);
  drawHub(ctx, hubR, hubY, s.angleR, g);

  ctx.drawImage(cassetteShell(w, h, dpr, g, s.cover), 0, 0, w, h);
}

/* =====================================================================
   4. VINYL TURNTABLE (Braun PCS 5 / Dieter Rams photorealistic deck)
   ===================================================================== */

const vinylDeckCache = { key: '', canvas: null };

function vinylDeckBase(w, h, dpr, cx, cy, R, pivotX, pivotY) {
  const key = `${w}x${h}@${dpr}`;
  if (vinylDeckCache.key === key && vinylDeckCache.canvas) return vinylDeckCache.canvas;
  const { c, ctx } = reuseOffscreen(vinylDeckCache, w, h, dpr);
  const u = R / 100; // proportional unit (1% of vinyl radius)

  // Anodized dark graphite top plate
  const plate = ctx.createLinearGradient(0, 0, 0, h);
  plate.addColorStop(0, '#22211E');
  plate.addColorStop(0.5, '#171614');
  plate.addColorStop(1, '#10100E');
  ctx.fillStyle = plate;
  ctx.fillRect(0, 0, w, h);

  // Subtle horizontal brushed metal grain
  ctx.fillStyle = 'rgba(255,255,255,0.015)';
  for (let y = 0; y < h; y += 2) {
    ctx.fillRect(0, y, w, 1);
  }

  // Recessed circular platter well
  const wellR = R * 1.075;
  const wellGrad = ctx.createRadialGradient(cx, cy + 2 * u, R * 0.85, cx, cy, wellR);
  wellGrad.addColorStop(0, '#050504');
  wellGrad.addColorStop(0.92, '#0A0908');
  wellGrad.addColorStop(1, '#2B2926');
  ctx.fillStyle = wellGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, wellR, 0, TAU);
  ctx.fill();

  // Machined bezel lip around platter well
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = Math.max(0.7, 0.9 * u);
  ctx.beginPath();
  ctx.arc(cx, cy, wellR + 0.5 * u, 0, TAU);
  ctx.stroke();

  // 4 corner hex screws on deck plate (scaled with u)
  const pad = Math.min(w, h) * 0.055;
  const scR = Math.max(2.0, 2.8 * u);
  [[pad, pad], [w - pad, pad], [pad, h - pad], [w - pad, h - pad]].forEach(([sx, sy]) => {
    const sg = ctx.createRadialGradient(sx - 0.3 * scR, sy - 0.3 * scR, 0.2, sx, sy, scR);
    sg.addColorStop(0, '#5C5953');
    sg.addColorStop(1, '#1B1A18');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.arc(sx, sy, scR, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = Math.max(0.5, 0.7 * u);
    ctx.stroke();
    ctx.fillStyle = '#0D0C0B';
    ctx.beginPath();
    ctx.arc(sx, sy, scR * 0.4, 0, TAU);
    ctx.fill();
  });

  // Braun speed selector switch (bottom-left corner, outside the platter well & scaled proportionally)
  const swW = 22 * u;
  const swH = 12 * u;
  const swX = Math.max(pad + swW * 0.65, cx - R * 0.98);
  const swY = Math.min(h - pad - swH * 0.55, cy + R * 0.88);
  ctx.fillStyle = '#0C0B0A';
  ctx.beginPath();
  ctx.roundRect(swX - swW / 2, swY - swH / 2, swW, swH, 2.6 * u);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = Math.max(0.5, 0.7 * u);
  ctx.stroke();

  const knobW = swW * 0.46;
  const knobH = swH * 0.78;
  const knob = ctx.createLinearGradient(0, swY - knobH / 2, 0, swY + knobH / 2);
  knob.addColorStop(0, '#3A3834');
  knob.addColorStop(1, '#1F1E1C');
  ctx.fillStyle = knob;
  ctx.beginPath();
  ctx.roundRect(swX - swW * 0.44, swY - knobH / 2, knobW, knobH, 1.8 * u);
  ctx.fill();

  ctx.fillStyle = '#E8E4DC';
  ctx.font = `700 ${Math.max(4.5, 5.2 * u)}px "DIN Alternate", "Helvetica Neue", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('33', swX - swW * 0.21, swY + 0.3 * u);
  ctx.fillStyle = '#7A756C';
  ctx.fillText('45', swX + swW * 0.23, swY + 0.3 * u);

  // Tonearm rest post & clip on the right side (scaled with u)
  const restX = pivotX - R * 0.04;
  const restY = cy + R * 0.30;
  ctx.fillStyle = '#0B0B0A';
  ctx.beginPath();
  ctx.arc(restX, restY, 5.5 * u, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = Math.max(0.5, 0.7 * u);
  ctx.stroke();
  ctx.fillStyle = '#4A4742';
  ctx.fillRect(restX - 3 * u, restY - 1.7 * u, 6 * u, 3.4 * u);

  // Multi-stepped machined gimbal base housing (top-right)
  const baseR = R * 0.24;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.75)';
  ctx.shadowBlur = 6 * u;
  ctx.shadowOffsetY = 2.5 * u;
  ctx.fillStyle = '#0E0D0C';
  ctx.beginPath();
  ctx.arc(pivotX, pivotY, baseR, 0, TAU);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = Math.max(0.6, 0.9 * u);
  ctx.beginPath();
  ctx.arc(pivotX, pivotY, baseR, 0, TAU);
  ctx.stroke();

  // Anti-skate calibration ring ticks around gimbal base
  ctx.strokeStyle = 'rgba(232,228,220,0.25)';
  ctx.lineWidth = Math.max(0.5, 0.65 * u);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    ctx.beginPath();
    ctx.moveTo(pivotX + Math.cos(a) * (baseR * 0.76), pivotY + Math.sin(a) * (baseR * 0.76));
    ctx.lineTo(pivotX + Math.cos(a) * (baseR * 0.88), pivotY + Math.sin(a) * (baseR * 0.88));
    ctx.stroke();
  }

  const ringGrad = ctx.createLinearGradient(pivotX - baseR, pivotY - baseR, pivotX + baseR, pivotY + baseR);
  ringGrad.addColorStop(0, '#6E6B64');
  ringGrad.addColorStop(0.5, '#2A2926');
  ringGrad.addColorStop(1, '#4A4742');
  ctx.fillStyle = ringGrad;
  ctx.beginPath();
  ctx.arc(pivotX, pivotY, baseR * 0.68, 0, TAU);
  ctx.fill();

  vinylDeckCache.key = key;
  return c;
}

function drawVinyl(canvas, s) {
  const f = fitCanvas(canvas);
  if (!f) return;
  const { ctx, w, h, dpr } = f;

  const unit = Math.min(w * 0.78, h * 0.88);
  const R = unit * 0.46;
  const u = R / 100;
  const cx = w * 0.42;
  const cy = h * 0.50;
  const pivotX = cx + R * 1.15;
  const pivotY = cy - R * 0.58;

  // 1. Static anodized Braun deck plate
  ctx.drawImage(vinylDeckBase(w, h, dpr, cx, cy, R, pivotX, pivotY), 0, 0, w, h);

  // 2. Clean satin-brushed machined aluminum platter rim (no aliasing dashes)
  const rimR = R * 1.032;
  const rimGrad = ctx.createLinearGradient(cx - rimR, cy - rimR, cx + rimR, cy + rimR);
  rimGrad.addColorStop(0, '#9E998F');
  rimGrad.addColorStop(0.32, '#4A4742');
  rimGrad.addColorStop(0.58, '#858077');
  rimGrad.addColorStop(0.85, '#33312E');
  rimGrad.addColorStop(1, '#757068');
  ctx.fillStyle = rimGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, rimR, 0, TAU);
  ctx.fill();

  // Subtle dark rubber platter mat edge inside the aluminum rim
  ctx.strokeStyle = '#141312';
  ctx.lineWidth = R * 0.018;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 1.009, 0, TAU);
  ctx.stroke();

  // Warm pilot illumination at 7 o'clock rim
  const strobeAngle = Math.PI * 0.72;
  const stX = cx + Math.cos(strobeAngle) * (R * 1.02);
  const stY = cy + Math.sin(strobeAngle) * (R * 1.02);
  const stGlow = ctx.createRadialGradient(stX, stY, 1, stX, stY, R * 0.14);
  const stAlpha = s.isPlaying ? 0.65 : 0.25;
  stGlow.addColorStop(0, `rgba(255, 130, 46, ${stAlpha})`);
  stGlow.addColorStop(0.5, `rgba(232, 80, 30, ${stAlpha * 0.45})`);
  stGlow.addColorStop(1, 'rgba(232, 80, 30, 0)');
  ctx.fillStyle = stGlow;
  ctx.beginPath();
  ctx.arc(stX, stY, R * 0.14, 0, TAU);
  ctx.fill();

  // 3. 180g Black Vinyl Record Body
  const vinylGrad = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
  vinylGrad.addColorStop(0, '#0A0A09');
  vinylGrad.addColorStop(0.65, '#0F0F0E');
  vinylGrad.addColorStop(0.96, '#080807');
  vinylGrad.addColorStop(0.99, '#22211F');
  vinylGrad.addColorStop(1, '#050504');
  ctx.fillStyle = vinylGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.fill();

  const rLabel = R * 0.33;
  const rRunout = R * 0.39;
  const rOuter = R * 0.965;

  // 4. Smooth anti-aliased anisotropic studio reflections on the vinyl surface
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R - 0.8, 0, TAU);
  ctx.clip();

  const wobble = Math.sin(s.spinAngle) * 0.008;
  [-0.72 + wobble, Math.PI - 0.72 + wobble].forEach((centerA) => {
    for (let k = -8; k <= 8; k++) {
      const da = k * 0.025;
      const wFactor = Math.cos((k / 9) * (Math.PI / 2));
      const alpha = wFactor * wFactor * 0.036;
      ctx.fillStyle = `rgba(250, 244, 232, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, centerA + da - 0.028, centerA + da + 0.028);
      ctx.closePath();
      ctx.fill();
    }
  });

  [0.65 - wobble, Math.PI + 0.65 - wobble].forEach((centerA) => {
    for (let k = -5; k <= 5; k++) {
      const da = k * 0.03;
      const wFactor = Math.cos((k / 6) * (Math.PI / 2));
      const alpha = wFactor * wFactor * 0.018;
      ctx.fillStyle = `rgba(255, 178, 102, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, centerA + da - 0.032, centerA + da + 0.032);
      ctx.closePath();
      ctx.fill();
    }
  });
  ctx.restore();

  // 5. Smooth, anti-aliased concentric groove bands (stationary circles = zero moiré/aliasing!)
  const grooveStep = Math.max(2.4, 3.2 * u);
  for (let r = rRunout + 2 * u; r <= rOuter; r += grooveStep) {
    const norm = (r - rRunout) / (rOuter - rRunout);
    const isTrackGap = Math.abs(norm - 0.34) < 0.014 || Math.abs(norm - 0.68) < 0.014;
    ctx.strokeStyle = isTrackGap ? 'rgba(0, 0, 0, 0.65)' : 'rgba(255, 242, 224, 0.026)';
    ctx.lineWidth = isTrackGap ? Math.max(1.0, 1.4 * u) : Math.max(0.7, 1.0 * u);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();
  }

  // 6. Center Record Label (softened matte paper print so it never looks overly sharp)
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(s.spinAngle);

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, rLabel, 0, TAU);
  ctx.clip();
  if (s.cover && s.cover.complete && s.cover.naturalWidth) {
    ctx.save();
    ctx.filter = 'blur(0.65px) contrast(0.84) saturate(0.80) brightness(0.90)';
    ctx.drawImage(s.cover, -rLabel, -rLabel, rLabel * 2, rLabel * 2);
    ctx.restore();
    const paper = ctx.createRadialGradient(0, 0, rLabel * 0.15, 0, 0, rLabel);
    paper.addColorStop(0, 'rgba(30, 26, 22, 0.18)');
    paper.addColorStop(0.75, 'rgba(24, 21, 18, 0.28)');
    paper.addColorStop(1, 'rgba(12, 10, 8, 0.52)');
    ctx.fillStyle = paper;
    ctx.fillRect(-rLabel, -rLabel, rLabel * 2, rLabel * 2);
  } else {
    ctx.fillStyle = '#C8481C';
    ctx.fillRect(-rLabel, -rLabel, rLabel * 2, rLabel * 2);
    ctx.fillStyle = '#141413';
    ctx.font = `700 ${Math.round(rLabel * 0.20)}px "DIN Alternate", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('BRAUN · PCS 5', 0, -rLabel * 0.42);
  }

  // Stamped concentric pressing ring on the paper label
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.30)';
  ctx.lineWidth = Math.max(0.7, 0.95 * u);
  ctx.beginPath();
  ctx.arc(0, 0, rLabel * 0.56, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.11)';
  ctx.lineWidth = Math.max(0.5, 0.65 * u);
  ctx.beginPath();
  ctx.arc(0, 0, rLabel * 0.56 - 1 * u, 0, TAU);
  ctx.stroke();

  // Outer edge of label
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.lineWidth = Math.max(0.8, 1.1 * u);
  ctx.beginPath();
  ctx.arc(0, 0, rLabel - 0.5 * u, 0, TAU);
  ctx.stroke();
  ctx.restore();
  ctx.restore(); // End rotating label space

  // 7. Center Machined Steel Spindle (stationary shadow, 3D metallic dome)
  const spR = R * 0.042;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.beginPath();
  ctx.arc(cx + 1.2 * u, cy + 1.8 * u, spR + 0.8 * u, 0, TAU);
  ctx.fill();

  const spGrad = ctx.createRadialGradient(cx - spR * 0.35, cy - spR * 0.35, 0.2, cx, cy, spR);
  spGrad.addColorStop(0, '#FFFFFF');
  spGrad.addColorStop(0.45, '#B8B3A8');
  spGrad.addColorStop(0.85, '#3E3C38');
  spGrad.addColorStop(1, '#141312');
  ctx.fillStyle = spGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, spR, 0, TAU);
  ctx.fill();

  // 8. Photorealistic Counterweighted Gimbal Tonearm (tracks real song progress, scaled with u)
  const p = Math.min(1, Math.max(0, s.progress || 0));
  const rStylus = rOuter - p * (rOuter - rRunout);

  const isParked = !s.isPlaying && p < 0.003;
  const contactAngle = 0.44;
  const targetX = isParked
    ? (pivotX - R * 0.04)
    : (cx + Math.cos(contactAngle) * rStylus);
  const targetY = isParked
    ? (cy + R * 0.58)
    : (cy + Math.sin(contactAngle) * rStylus);

  const dx = targetX - pivotX;
  const dy = targetY - pivotY;
  const armAngle = Math.atan2(dy, dx);
  const armLen = Math.hypot(dx, dy);

  const bendAngle = armAngle - 0.065;
  const elbowX = pivotX + Math.cos(bendAngle) * (armLen * 0.80);
  const elbowY = pivotY + Math.sin(bendAngle) * (armLen * 0.80);

  // Cast shadow of the tonearm on the deck and vinyl surface
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.62)';
  ctx.lineWidth = 4.8 * u;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.filter = `blur(${Math.max(1.2, 2.2 * u)}px)`;
  ctx.beginPath();
  ctx.moveTo(pivotX + 2.5 * u, pivotY + 5 * u);
  ctx.lineTo(elbowX + 3.5 * u, elbowY + 7 * u);
  ctx.lineTo(targetX + 2.5 * u, targetY + 5 * u);
  ctx.stroke();
  ctx.restore();

  // Rear tonearm stub direction (coaxial with pivot, opposite to tonearm wand)
  const rearAngle = bendAngle + Math.PI;
  const rearLen = R * 0.30;
  const backX = pivotX + Math.cos(rearAngle) * rearLen;
  const backY = pivotY + Math.sin(rearAngle) * rearLen;

  // Counterweight position: centered directly ON the rear shaft
  const cwDist = rearLen * 0.54;
  const cwX = pivotX + Math.cos(rearAngle) * cwDist;
  const cwY = pivotY + Math.sin(rearAngle) * cwDist;

  // Soft cast shadow of rear shaft and counterweight on deck plate
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.filter = `blur(${Math.max(1.2, 2.2 * u)}px)`;
  ctx.beginPath();
  ctx.ellipse(cwX + 2.5 * u, cwY + 4.5 * u, 7.5 * u, 5.5 * u, rearAngle, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Rear tubular aluminum tonearm shaft (base tube + highlights)
  ctx.strokeStyle = '#6E6A63';
  ctx.lineWidth = 3.6 * u;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pivotX, pivotY);
  ctx.lineTo(backX, backY);
  ctx.stroke();

  ctx.strokeStyle = '#D8D3C8';
  ctx.lineWidth = 2.0 * u;
  ctx.beginPath();
  ctx.moveTo(pivotX, pivotY);
  ctx.lineTo(backX, backY);
  ctx.stroke();

  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = Math.max(0.5, 0.7 * u);
  ctx.beginPath();
  ctx.moveTo(pivotX - 0.35 * u, pivotY - 0.35 * u);
  ctx.lineTo(backX - 0.35 * u, backY - 0.35 * u);
  ctx.stroke();

  // Coaxial counterweight assembly (perfectly threaded onto the rear shaft)
  ctx.save();
  ctx.translate(cwX, cwY);
  ctx.rotate(rearAngle);

  const cwR = 6.2 * u; // radius across the shaft (diameter = 12.4 * u)
  const cwFrontX = -5.6 * u; // front edge towards pivot
  const cwDialW = 3.6 * u;   // tracking force dial width
  const cwBodyX = cwFrontX + cwDialW; // -2.0 * u
  const cwBodyW = 7.6 * u;   // main steel body width

  // A. Front tracking force dial (ghiera numerata nero opaco)
  const dialGrad = ctx.createLinearGradient(0, -cwR * 0.95, 0, cwR * 0.95);
  dialGrad.addColorStop(0, '#363430');
  dialGrad.addColorStop(0.35, '#22201D');
  dialGrad.addColorStop(0.7, '#151412');
  dialGrad.addColorStop(1, '#0C0B0A');
  ctx.fillStyle = dialGrad;
  ctx.beginPath();
  ctx.roundRect(cwFrontX, -cwR * 0.92, cwDialW, cwR * 1.84, [1.5 * u, 0, 0, 1.5 * u]);
  ctx.fill();

  // Dial gram calibration ticks
  ctx.strokeStyle = 'rgba(235, 230, 220, 0.45)';
  ctx.lineWidth = Math.max(0.5, 0.65 * u);
  for (let k = -2; k <= 2; k++) {
    const tickY = (k / 3) * (cwR * 0.82);
    ctx.beginPath();
    ctx.moveTo(cwFrontX + 0.6 * u, tickY);
    ctx.lineTo(cwFrontX + (k === 0 ? 2.4 : 1.5) * u, tickY);
    ctx.stroke();
  }

  // Dial-to-body groove separator
  ctx.strokeStyle = '#0E0D0C';
  ctx.lineWidth = 0.8 * u;
  ctx.beginPath();
  ctx.moveTo(cwBodyX, -cwR);
  ctx.lineTo(cwBodyX, cwR);
  ctx.stroke();

  // B. Main turned stainless steel / heavy aluminum cylinder body
  const bodyGrad = ctx.createLinearGradient(0, -cwR, 0, cwR);
  bodyGrad.addColorStop(0, '#55514B');
  bodyGrad.addColorStop(0.18, '#88837A');
  bodyGrad.addColorStop(0.36, '#EAE6DC'); // bright metallic top specular crest
  bodyGrad.addColorStop(0.60, '#666159');
  bodyGrad.addColorStop(0.85, '#2B2925');
  bodyGrad.addColorStop(1, '#161514');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.roundRect(cwBodyX, -cwR, cwBodyW, cwR * 2, [0, 2.2 * u, 2.2 * u, 0]);
  ctx.fill();

  // Subtle knurled rubber grip ring / damper groove
  ctx.fillStyle = '#161514';
  ctx.fillRect(cwBodyX + 2.8 * u, -cwR, 1.6 * u, cwR * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = Math.max(0.4, 0.5 * u);
  ctx.strokeRect(cwBodyX + 2.8 * u, -cwR, 1.6 * u, cwR * 2);

  // Bevel & rim specular highlights on the counterweight
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.lineWidth = Math.max(0.5, 0.7 * u);
  ctx.beginPath();
  ctx.roundRect(cwBodyX, -cwR, cwBodyW, cwR * 2, [0, 2.2 * u, 2.2 * u, 0]);
  ctx.stroke();

  ctx.restore();

  // Machined metallic end-cap on the rear shaft tip
  ctx.save();
  ctx.translate(backX, backY);
  ctx.rotate(rearAngle);
  ctx.fillStyle = '#D4CFC5';
  ctx.beginPath();
  ctx.arc(0, 0, 1.9 * u, -Math.PI / 2, Math.PI / 2);
  ctx.fill();
  ctx.restore();

  // Main tubular aluminum tonearm shaft (base layer + specular crest)
  ctx.strokeStyle = '#6E6A63';
  ctx.lineWidth = 3.6 * u;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pivotX, pivotY);
  ctx.lineTo(elbowX, elbowY);
  ctx.lineTo(targetX, targetY);
  ctx.stroke();

  ctx.strokeStyle = '#D8D3C8';
  ctx.lineWidth = 2.1 * u;
  ctx.beginPath();
  ctx.moveTo(pivotX, pivotY);
  ctx.lineTo(elbowX, elbowY);
  ctx.lineTo(targetX, targetY);
  ctx.stroke();

  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = Math.max(0.5, 0.75 * u);
  ctx.beginPath();
  ctx.moveTo(pivotX - 0.35 * u, pivotY - 0.35 * u);
  ctx.lineTo(elbowX - 0.35 * u, elbowY - 0.35 * u);
  ctx.lineTo(targetX - 0.35 * u, targetY - 0.35 * u);
  ctx.stroke();

  // Gimbal bridge cap over the pivot point
  ctx.save();
  ctx.translate(pivotX, pivotY);
  ctx.rotate(bendAngle);
  const bridgeGrad = ctx.createLinearGradient(-6 * u, -7 * u, 6 * u, 7 * u);
  bridgeGrad.addColorStop(0, '#45433F');
  bridgeGrad.addColorStop(0.5, '#22211F');
  bridgeGrad.addColorStop(1, '#121110');
  ctx.fillStyle = bridgeGrad;
  ctx.beginPath();
  ctx.roundRect(-6 * u, -7.8 * u, 12 * u, 15.6 * u, 2.6 * u);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = Math.max(0.5, 0.7 * u);
  ctx.stroke();
  ctx.fillStyle = '#C8C3B9';
  ctx.beginPath();
  ctx.arc(0, 0, 1.9 * u, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Braun / SME perforated black anodized headshell at stylus tip (scaled with u)
  const headAngle = Math.atan2(targetY - elbowY, targetX - elbowX);
  ctx.save();
  ctx.translate(targetX, targetY);
  ctx.rotate(headAngle);

  ctx.fillStyle = '#D8D3C8';
  ctx.fillRect(-13.8 * u, -2.2 * u, 3 * u, 4.4 * u);

  // Curved Finger Lift lever
  ctx.strokeStyle = '#DFDBD0';
  ctx.lineWidth = Math.max(0.8, 1.15 * u);
  ctx.beginPath();
  ctx.moveTo(-6 * u, -3.9 * u);
  ctx.quadraticCurveTo(-4.3 * u, -9 * u, -0.8 * u, -9 * u);
  ctx.stroke();

  // Main black anodized headshell body (tapered front)
  ctx.fillStyle = '#181715';
  ctx.strokeStyle = 'rgba(255,255,255,0.24)';
  ctx.lineWidth = Math.max(0.5, 0.75 * u);
  ctx.beginPath();
  ctx.moveTo(-11.2 * u, -4.1 * u);
  ctx.lineTo(2.6 * u, -3.6 * u);
  ctx.lineTo(5.2 * u, -2.2 * u);
  ctx.lineTo(5.2 * u, 2.2 * u);
  ctx.lineTo(2.6 * u, 3.6 * u);
  ctx.lineTo(-11.2 * u, 4.1 * u);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Machined weight-relief perforations on headshell
  ctx.fillStyle = '#070706';
  [-8.2 * u, -4.7 * u].forEach((hx) => {
    ctx.beginPath();
    ctx.arc(hx, -1.7 * u, 0.95 * u, 0, TAU);
    ctx.arc(hx, 1.7 * u, 0.95 * u, 0, TAU);
    ctx.fill();
  });

  // Signal-orange cartridge nose & silver cartridge mounting screws
  ctx.fillStyle = '#E8501E';
  ctx.fillRect(0.4 * u, -1.9 * u, 3.6 * u, 3.8 * u);
  ctx.fillStyle = '#E4DFD4';
  ctx.fillRect(-1.9 * u, -2.0 * u, 1.0 * u, 1.0 * u);
  ctx.fillRect(-1.9 * u, 1.0 * u, 1.0 * u, 1.0 * u);

  if (!isParked && s.isPlaying) {
    const tipGlow = ctx.createRadialGradient(4.3 * u, 0, 0, 4.3 * u, 0, 6 * u);
    tipGlow.addColorStop(0, 'rgba(255, 120, 48, 0.55)');
    tipGlow.addColorStop(1, 'rgba(255, 120, 48, 0)');
    ctx.fillStyle = tipGlow;
    ctx.beginPath();
    ctx.arc(4.3 * u, 0, 6 * u, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/* =====================================================================
   5. AETHER-MORPH 3D WEBGL ENGINE (Exact V2 + G2 + H2 Simplex 3D Shaders)
      Supports non-fuzzy smooth Blob mode & High-Aura mode
   ===================================================================== */

const AETHER_SIMPLEX_GLSL = `
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }
`;

const AETHER_VERT = `
  attribute vec3 aPosition;
  attribute vec3 aNormal;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;

  uniform mat4 uProj;
  uniform mat4 uView;
  uniform vec3 uOffset;
  uniform float uScale;
  uniform float uRotY;
  uniform float uTime;
  uniform float uPhase;
  uniform float uBass;
  uniform float uMid;
  uniform float uVocal;
  uniform float uEnergy;
  uniform float uComplexity;
  uniform float uPulseAmp;

  ${AETHER_SIMPLEX_GLSL}

  void main() {
    vec3 pos = aPosition;
    vec3 baseNormal = aNormal;
    float time = uTime + uPhase;

    float motionFactor = smoothstep(0.01, 0.1, uEnergy);

    // 1. Il Respiro (exact V2 from Aether)
    float breath = sin(time * 1.0) * 0.015 * motionFactor;
    pos += baseNormal * breath;

    // 2. Variazioni Omnidirezionali (Chaos Pulse — exact V2 from Aether)
    vec3 randomDir = normalize(vec3(
      sin(time * 2.1 + uPhase),
      cos(time * 1.8 - uPhase * 0.5),
      sin(time * 1.3 + 32.0)
    ));
    float spikeBass = pow(uBass, 2.15);
    float expansion = spikeBass * (0.5 * uPulseAmp) * motionFactor;
    pos += baseNormal * expansion;

    float warpAmount = spikeBass * (0.4 * uPulseAmp) * motionFactor;
    pos += randomDir * warpAmount;

    // 3. Dettaglio Superficiale (exact V2 from Aether: rugosity = 0)
    float noiseFreq = 0.8 * uComplexity;
    float surfaceDetail = snoise(pos * noiseFreq + time * 0.44) * (0.03 + uMid * 0.44) * uPulseAmp;
    pos += baseNormal * surfaceDetail * motionFactor;

    // Rotate Y, Scale & Translate (supports main blob + orbiting child spores)
    float c = cos(uRotY);
    float s = sin(uRotY);
    mat3 rotY = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c);
    vec3 worldP = (rotY * (pos * uScale)) + uOffset;
    vec3 worldN = normalize(rotY * normalize(baseNormal + randomDir * warpAmount * 0.5));

    vec4 mvPos = uView * vec4(worldP, 1.0);
    vNormal = worldN;
    vViewDir = normalize(-mvPos.xyz);
    vWorldPos = worldP;
    gl_Position = uProj * mvPos;
  }
`;

const AETHER_FRAG = `
  precision highp float;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;

  uniform vec3 uColor;
  uniform float uBass;
  uniform float uVocal;
  uniform float uEnergy;
  uniform float uSaturation;

  void main() {
    // Exact G2 fragment shader from Aether
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewDir);
    vec3 lightDir = normalize(vec3(0.5, 0.8, 1.0));
    float dotProd = dot(N, lightDir);
    float diff = max(dotProd, 0.0);

    float lightIntensity = pow(diff, 2.5);
    lightIntensity += pow(diff, 8.0) * uBass * 0.5;

    // Fresnel / Rim Light
    float rimRaw = 1.0 - max(dot(N, V), 0.0);
    float rim = pow(rimRaw, 3.5);

    vec3 baseCol = uColor * (0.1 + 0.9 * lightIntensity);
    vec3 rimCol = uColor * rim * (2.0 + uVocal * 2.0);

    float glowIntensity = smoothstep(0.0, 0.2, uEnergy) * uVocal;
    vec3 innerGlow = uColor * glowIntensity * 0.5;

    vec3 finalCol = baseCol + rimCol + innerGlow;

    float density = 1.0 + (1.0 - smoothstep(0.0, 0.3, uEnergy)) * 0.5;
    finalCol = pow(finalCol, vec3(density));

    // Reinhard tone mapping & contrast
    finalCol = finalCol / (finalCol + vec3(0.5));
    finalCol = (finalCol - 0.5) * 1.3 + 0.5;

    float lum = dot(finalCol, vec3(0.299, 0.587, 0.114));
    finalCol = mix(vec3(lum), finalCol, uSaturation);

    gl_FragColor = vec4(max(vec3(0.0), finalCol), 1.0);
  }
`;

const aetherContexts = new WeakMap();

function createSphereMesh(radius, segs) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (let y = 0; y <= segs; y++) {
    const v = y / segs;
    const phi = v * Math.PI;
    for (let x = 0; x <= segs; x++) {
      const u = x / segs;
      const theta = u * TAU;
      const nx = -Math.cos(theta) * Math.sin(phi);
      const ny = Math.cos(phi);
      const nz = Math.sin(theta) * Math.sin(phi);
      normals.push(nx, ny, nz);
      positions.push(nx * radius, ny * radius, nz * radius);
    }
  }
  for (let y = 0; y < segs; y++) {
    for (let x = 0; x < segs; x++) {
      const i0 = y * (segs + 1) + x;
      const i1 = i0 + 1;
      const i2 = i0 + (segs + 1);
      const i3 = i2 + 1;
      indices.push(i0, i2, i1, i1, i2, i3);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices)
  };
}

function initAetherGL(canvas) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false });
  if (!gl) return null;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, AETHER_VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, AETHER_FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const mesh = createSphereMesh(2.0, 72);

  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPosition');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

  const normBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
  const aNorm = gl.getAttribLocation(prog, 'aNormal');
  gl.enableVertexAttribArray(aNorm);
  gl.vertexAttribPointer(aNorm, 3, gl.FLOAT, false, 0, 0);

  const idxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

  const uniforms = {};
  [
    'uProj', 'uView', 'uOffset', 'uScale', 'uRotY', 'uTime', 'uPhase',
    'uBass', 'uMid', 'uVocal', 'uEnergy', 'uComplexity', 'uPulseAmp',
    'uColor', 'uSaturation'
  ].forEach((name) => {
    uniforms[name] = gl.getUniformLocation(prog, name);
  });

  // View matrix: camera at (0, 0, 7.6) for circular bezels, or (0, 0, 11.0) for fullAura (exact Aether P0 camera)
  const view = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, -7.6, 1
  ]);

  const state = {
    gl,
    prog,
    posBuf,
    normBuf,
    idxBuf,
    aPos,
    aNorm,
    count: mesh.indices.length,
    uniforms,
    view,
    smoothScale: 1.0,
    colorPhase: 0.04,
    curColor: [0.91, 0.31, 0.12], // Braun Signal Orange #E8501E start
    children: [],
    lastSpawnTime: -20,
    nextChildId: 0
  };
  aetherContexts.set(canvas, state);
  return state;
}

// 8 Curated Aether-Morph Presets (Right-Click to Cycle — strictly 0% purple/violet, starts on Braun Orange by default)
const AETHER_PRESETS = [
  {
    id: 'orange',
    name: 'Arancione Braun',
    mode: 'fixed',
    rgb: [0.91, 0.31, 0.12], // #E8501E
    scaleMul: 0.96,
    complexity: 1.05,
    saturation: 1.22,
    pulseMul: 0.95
  },
  {
    id: 'chromatic',
    name: 'Deriva Cromatica',
    mode: 'drift',
    rgb: [0.91, 0.31, 0.12],
    scaleMul: 1.0,
    complexity: 0.90,
    saturation: 1.15,
    pulseMul: 1.0
  },
  {
    id: 'white',
    name: 'Bianco Assoluto',
    mode: 'fixed',
    rgb: [0.95, 0.95, 0.93], // Pure Alabaster White on #000000
    scaleMul: 0.96,
    complexity: 1.05,
    saturation: 0.0,
    pulseMul: 0.95
  },
  {
    id: 'gold',
    name: 'Oro Fuso',
    mode: 'fixed',
    rgb: [0.96, 0.70, 0.20], // Liquid Gold
    scaleMul: 0.90,
    complexity: 0.75,
    saturation: 1.12,
    pulseMul: 0.92
  },
  {
    id: 'phosphor',
    name: 'Fosforo CRT',
    mode: 'fixed',
    rgb: [0.15, 0.88, 0.46], // Tektronix Phosphor Green
    scaleMul: 0.86,
    complexity: 1.32,
    saturation: 1.15,
    pulseMul: 1.05
  },
  {
    id: 'arctic',
    name: 'Ghiaccio Artico',
    mode: 'fixed',
    rgb: [0.32, 0.82, 0.98], // Glacial Cyan
    scaleMul: 1.02,
    complexity: 1.10,
    saturation: 1.10,
    pulseMul: 1.0
  },
  {
    id: 'supernova',
    name: 'Magma Oversize',
    mode: 'fixed',
    rgb: [0.98, 0.24, 0.08], // Incandescent Red-Orange
    scaleMul: 1.22,
    complexity: 0.98,
    saturation: 1.25,
    pulseMul: 1.18
  },
  {
    id: 'micro',
    name: 'Goccia Titanio',
    mode: 'fixed',
    rgb: [0.85, 0.80, 0.72], // Minimal Titanium Pearl
    scaleMul: 0.74,
    complexity: 0.62,
    saturation: 0.35,
    pulseMul: 0.80
  }
];

// HSL to RGB helper that strictly avoids purple/violet hues (starts at Braun Orange, then amber/gold/emerald/teal/cyan/coral)
function aetherWarmPalette(phase, sat, light) {
  const safeHues = [0.04, 0.07, 0.14, 0.42, 0.50, 0.55, 0.02, 0.04]; // Starts at Braun Orange (0.04), amber, gold, emerald, cyan, teal, coral, back to orange (0% purple!)
  const scaled = ((phase % 1) + 1) % 1 * (safeHues.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  const h = safeHues[i] + (safeHues[i + 1] - safeHues[i]) * f;

  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = light - c / 2;
  let r = 0, g = 0, b = 0;
  const sector = Math.floor(h * 6);
  if (sector === 0) { r = c; g = x; b = 0; }
  else if (sector === 1) { r = x; g = c; b = 0; }
  else if (sector === 2) { r = 0; g = c; b = x; }
  else if (sector === 3) { r = 0; g = x; b = c; }
  else if (sector === 4) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [r + m, g + m, b + m];
}

// variant: 'circleSmall' | 'circleMacro' | 'fullAura'
function drawAetherMorph(canvas, s, variant = 'circleSmall', auraGlowEl = null, presetIdx = 0, customParams = null) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  let st = aetherContexts.get(canvas);
  if (!st) st = initAetherGL(canvas);
  if (!st) return;

  const preset = AETHER_PRESETS[((presetIdx % AETHER_PRESETS.length) + AETHER_PRESETS.length) % AETHER_PRESETS.length];
  const cfg = customParams || {};
  const highAura = variant === 'fullAura';
  const isMacro = variant === 'circleMacro';

  const { gl, prog, uniforms, view, count } = st;
  // Exact Aether camera distance (z = -11.0) for fullAura, and z = -7.6 for circle instruments
  view[14] = highAura ? -11.0 : -7.6;

  gl.viewport(0, 0, w, h);
  gl.enable(gl.DEPTH_TEST);
  if (highAura) {
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
  } else {
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
  }
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(prog);

  // Perspective matrix (fov = 38 deg — exact Aether P0 camera fov: 38)
  const aspect = w / h;
  const fovRad = (38 * Math.PI) / 180;
  const f = 1.0 / Math.tan(fovRad / 2);
  const near = 0.1;
  const far = 50.0;
  const nf = 1 / (near - far);
  const proj = new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, (2 * far * near) * nf, 0
  ]);

  const active = !!s.isPlaying;
  // Exact settings from the user's open Aether tab on Chrome:
  // complexity: 0.45, baseSize: 0.5, rugosity: 0, saturation: 1, blur: 100, maxChildren: 10, colorSpeed: 0.3, audioSensitivity: 1.9
  const sens = highAura ? 1.9 : (isMacro ? 1.05 : 1.18);
  const metab = typeof cfg.metabolism === 'number' ? cfg.metabolism : 1.0;
  const biomass = typeof cfg.biomass === 'number' ? cfg.biomass : (highAura ? 0.50 : preset.scaleMul);
  const morphing = typeof cfg.morphing === 'number' ? cfg.morphing : (highAura ? 0.45 : preset.complexity);
  const vibrance = typeof cfg.vibrance === 'number' ? cfg.vibrance : (highAura ? 1.0 : preset.saturation);
  const auraLevel = typeof cfg.aura === 'number' ? cfg.aura : (highAura ? 7.0 : 0.15);
  const pigmentMode = cfg.pigmentMode || preset.mode;

  const bass = active ? Math.min(1.8, (s.bass || 0) * sens) : 0;
  const sub = active ? Math.min(1.8, (s.bass || 0) * sens * 1.15) : 0;
  const mid = active ? Math.min(1.8, (s.mid || 0) * sens) : 0;
  const high = active ? Math.min(1.8, (s.high || 0) * sens * 1.35) : 0;
  const vocal = active ? Math.min(1.8, (mid * 0.65 + high * 0.35) * 1.2) : 0;
  const energy = active ? Math.min(1.5, (s.energy || 0) * sens) : 0;

  let baseScale = 0.56;
  let pulseAmp = 0.78;
  let targetScale;

  if (isMacro) {
    // Macro inside circle: completely fills 100% of the circle even when music is stopped (zero black border!)
    baseScale = 1.76;
    const effectiveBio = Math.max(1.04, biomass);
    pulseAmp = 0.98;
    targetScale = baseScale * effectiveBio * (1 + (active ? (bass * 0.24 + energy * 0.10) : 0));
  } else if (highAura) {
    // Exact Kz scale formula from Aether: T = sub * 0.5 + bass * 0.4; L = baseSize * (1 + (isActive ? T * 0.4 : 0))
    const T = sub * 0.5 + bass * 0.4;
    pulseAmp = 1.0;
    targetScale = biomass * (1 + (active ? T * 0.4 : 0));
  } else {
    // circleSmall: slightly more responsive to the beat while staying compact inside the circle
    targetScale = baseScale * biomass * (1 + (active ? (bass * 0.22 + mid * 0.06 + energy * 0.08) : 0));
  }
  st.smoothScale += (targetScale - st.smoothScale) * 0.22;

  let targetRGB;
  if (pigmentMode === 'fixed') {
    const baseRgb = Array.isArray(cfg.customRgb) ? cfg.customRgb : preset.rgb;
    if (active) {
      const boost = 0.88 + bass * 0.22;
      targetRGB = [
        Math.min(1, baseRgb[0] * boost),
        Math.min(1, baseRgb[1] * boost),
        Math.min(1, baseRgb[2] * boost)
      ];
    } else {
      const idleMul = isMacro ? 0.78 : (highAura ? 0.82 : 0.58);
      targetRGB = [baseRgb[0] * idleMul, baseRgb[1] * idleMul, baseRgb[2] * idleMul];
    }
  } else {
    // Auto color drift starting at Braun Orange #E8501E
    if (!st.auraInitialized && highAura) {
      st.auraInitialized = true;
      st.colorPhase = 0.0; // Starts at Braun Orange in aetherWarmPalette
      st.curColor = [0.91, 0.31, 0.12];
    }
    if (active) {
      const dtApprox = 1 / 60;
      const colorSpeed = 0.3;
      const ue = colorSpeed * colorSpeed;
      const step = dtApprox * ((0.002 + ue * 0.25) + high * (ue * 0.4));
      st.colorPhase = (st.colorPhase + step) % 1;
      const sat = Math.min(1.0, 0.65 + vocal * 0.35);
      const light = Math.min(0.65, 0.42 + bass * 0.2);
      targetRGB = aetherWarmPalette(st.colorPhase, sat, light);
    } else if (highAura) {
      targetRGB = [0.76, 0.26, 0.10];
    } else if (isMacro) {
      targetRGB = [0.72, 0.28, 0.11];
    } else {
      targetRGB = [0.52, 0.20, 0.09];
    }
  }

  const colorLerp = highAura ? 0.10 : 0.055;
  st.curColor[0] += (targetRGB[0] - st.curColor[0]) * colorLerp;
  st.curColor[1] += (targetRGB[1] - st.curColor[1]) * colorLerp;
  st.curColor[2] += (targetRGB[2] - st.curColor[2]) * colorLerp;

  // Exact P0 blur from Aether: filter: blur(${blur}px) directly on the WebGL canvas, NO artificial CSS circle div!
  if (auraGlowEl) {
    auraGlowEl.style.background = 'none';
    const clampedAura = Math.max(0, Math.min(7.5, auraLevel));
    // At 100% Aura (clampedAura = 7.0), blurPx = 100px (exact match with user's Chrome tab "blur": 100!)
    const blurPx = Math.round((clampedAura / 7.0) * 100);
    canvas.style.filter = blurPx > 0 ? `blur(${blurPx}px)` : 'none';
  }

  const nowTime = s.time || 0;
  const floatY = highAura ? Math.sin(nowTime * 0.7) * 0.12 : 0;

  gl.uniformMatrix4fv(uniforms.uProj, false, proj);
  gl.uniformMatrix4fv(uniforms.uView, false, view);
  gl.uniform3f(uniforms.uOffset, 0, floatY, 0);
  gl.uniform1f(uniforms.uScale, st.smoothScale);
  gl.uniform1f(uniforms.uRotY, nowTime * (highAura ? 0.02 : 0.18 * metab));
  gl.uniform1f(uniforms.uTime, nowTime);
  gl.uniform1f(uniforms.uPhase, 0.0);
  gl.uniform1f(uniforms.uBass, bass);
  gl.uniform1f(uniforms.uMid, mid);
  gl.uniform1f(uniforms.uVocal, vocal);
  gl.uniform1f(uniforms.uEnergy, isMacro ? Math.max(0.35, energy) : energy);
  gl.uniform1f(uniforms.uComplexity, morphing);
  gl.uniform1f(uniforms.uPulseAmp, pulseAmp * preset.pulseMul);
  gl.uniform3fv(uniforms.uColor, st.curColor);
  gl.uniform1f(uniforms.uSaturation, vibrance);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, st.idxBuf);
  gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);

  // Orbiting child spores on fullAura (exact match with "maxChildren": 10 from the user's open Chrome tab!)
  if (highAura) {
    const maxChildren = 10;
    const mainR = 2.0 * biomass;
    if (active && sub > 0.65 && st.children.length < maxChildren && nowTime - st.lastSpawnTime > 4.5) {
      st.lastSpawnTime = nowTime;
      const theta = Math.random() * TAU;
      const phi = Math.acos(2 * Math.random() - 1);
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.sin(phi) * Math.sin(theta);
      const nz = Math.cos(phi);
      const dist = mainR + 2.2;
      st.children.push({
        id: st.nextChildId++,
        x: nx * dist,
        y: ny * dist,
        z: nz * dist,
        vx: nx * 0.004,
        vy: ny * 0.004,
        vz: nz * 0.004,
        spawnTime: nowTime,
        radius: 0.05,
        phase: Math.random() * TAU
      });
    }

    const alive = [];
    for (let i = 0; i < st.children.length; i++) {
      const c = st.children[i];
      const age = nowTime - c.spawnTime;
      if (age > 80) continue;
      alive.push(c);

      const targetR = (0.45 + Math.sin(age * 0.08) * 0.05) * biomass;
      c.radius += (targetR - c.radius) * 0.02;

      const dist = Math.sqrt(c.x * c.x + c.y * c.y + c.z * c.z) || 0.001;
      const nx = c.x / dist;
      const ny = c.y / dist;
      const nz = c.z / dist;

      // Gravity pull + tangential orbit around Y axis (exact Qz physics)
      const pull = dist > 7 ? 0.005 : 0.0012;
      c.vx = (c.vx - nx * pull) * 0.94;
      c.vy = (c.vy - ny * pull) * 0.94;
      c.vz = (c.vz - nz * pull) * 0.94;

      const dirSign = c.id % 2 === 0 ? 1 : -1;
      c.vx += -nz * 0.0022 * dirSign;
      c.vz += nx * 0.0022 * dirSign;

      if (active && bass > 0.08) {
        c.vx += nx * bass * 0.004;
        c.vy += ny * bass * 0.004;
        c.vz += nz * bass * 0.004;
      }

      c.x += c.vx;
      c.y += c.vy;
      c.z += c.vz;

      const minDist = mainR + c.radius * 2.0 + 0.3;
      const newDist = Math.sqrt(c.x * c.x + c.y * c.y + c.z * c.z) || 0.001;
      if (newDist < minDist) {
        const sMul = minDist / newDist;
        c.x *= sMul;
        c.y *= sMul;
        c.z *= sMul;
      }

      gl.uniform3f(uniforms.uOffset, c.x, c.y, c.z);
      gl.uniform1f(uniforms.uScale, c.radius);
      gl.uniform1f(uniforms.uPhase, c.phase);
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
    }
    st.children = alive;
  }
}

window.Instruments = {
  drawVU,
  drawScope,
  drawCassette,
  drawVinyl,
  drawAetherMorph,
  AETHER_PRESETS,
  vuDbToPos,
  cassetteGeom
};
