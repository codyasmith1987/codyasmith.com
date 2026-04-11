// Growth field — page-owned occluding layer conditioned by quiz answers
// Replaces vortex particle system with topology-distributed marks
// that are born where they belong and resolve in place

type RGB = [number, number, number];

const TOKENS = [
  '--color-neutral-950', '--color-neutral-900', '--color-neutral-850',
  '--color-neutral-800', '--color-neutral-700', '--color-neutral-600',
  '--color-neutral-500', '--color-neutral-400', '--color-neutral-300',
  '--color-neutral-200', '--color-neutral-100',
  '--color-amber-600', '--color-amber-500', '--color-amber-400',
  '--color-dated'
] as const;

interface Mark {
  x: number; y: number;
  homeX: number; homeY: number;
  size: number;    // blob: diameter; stroke: length
  width: number;   // stroke width (unused for blobs)
  angle: number;
  curve: number;   // bezier control (unused for blobs)
  baseOp: number;
  op: number;
  color: RGB;
  np: number;      // noise phase seed
  na: number;      // noise amplitude (1.0 = full drift, ~0 = settled)
  ri: number;      // region index (-1 = unaffiliated)
  cond: number;    // conditioning level 0-1
  ro: number;      // resolve order (lower = resolves earlier in alpha phase)
  blob: boolean;   // true = filled shape for coverage, false = stroke for texture
}

interface Region {
  x: number; y: number; w: number; h: number;
  weight: number;
  axis: string;
}

// ---- Utilities ----

function h2r(hex: string): RGB {
  hex = hex.trim();
  if (hex.length < 7) return [128, 128, 128];
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function r2h([r, g, b]: RGB): string {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}

function lrgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t | 0, a[1] + (b[1] - a[1]) * t | 0, a[2] + (b[2] - a[2]) * t | 0];
}

function noise(x: number, y: number, t: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + t * 43.4321) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

// ---- Theme cache ----
// Populated at init by reading computed CSS for all 16 themes + default

const _themes = new Map<string, RGB[]>();

function cacheThemes(): void {
  const el = document.documentElement;
  const orig = el.getAttribute('data-theme');
  const read = (): RGB[] => {
    const s = getComputedStyle(el);
    return TOKENS.map(n => h2r(s.getPropertyValue(n)));
  };

  // Default (no theme)
  if (orig) el.removeAttribute('data-theme');
  _themes.set('', read());

  for (const a of ['sun', 'moon'])
    for (const b of ['beach', 'mountain'])
      for (const c of ['spring', 'fall'])
        for (const d of ['stars', 'clouds']) {
          const k = `${a}-${b}-${c}-${d}`;
          el.setAttribute('data-theme', k);
          _themes.set(k, read());
        }

  if (orig) el.setAttribute('data-theme', orig);
  else el.removeAttribute('data-theme');
}

// ---- Density model ----
// Queries live DOM to build a visual-density grid weighted by content type

function buildModel(vw: number, vh: number) {
  const regions: Region[] = [];
  const maxY = vh + 80;

  const queries: [string, number, string, string][] = [
    ['main h1', 1.0, 'heading', ''],
    ['main h2', 0.95, 'heading', ''],
    ['main h3', 0.85, 'heading', ''],
    ['main p', 0.7, 'text', ''],
    ['.glow-card', 0.6, 'card', ''],
    ['nav', 0.65, 'nav', ''],
    ['[data-vibe]', 0.72, 'text', 'vibe'],
    ['[data-frame]', 0.72, 'text', 'frame'],
    ['[data-phase]', 0.72, 'text', 'phase'],
    ['[data-processing]', 0.72, 'text', 'processing'],
    ['main a', 0.4, 'link', ''],
  ];

  for (const [sel, wt, tp, ax] of queries) {
    document.querySelectorAll(sel).forEach(e => {
      const r = e.getBoundingClientRect();
      if (r.width < 5 || r.height < 5 || r.bottom < -20 || r.top > maxY) return;
      regions.push({ x: r.x, y: r.y, w: r.width, h: r.height, weight: wt, axis: ax });
      // Card edges get higher weight — structural silhouettes
      if (tp === 'card') {
        const ed = 10;
        regions.push({ x: r.x, y: r.y, w: r.width, h: ed, weight: 0.88, axis: '' });
        regions.push({ x: r.x, y: r.bottom - ed, w: r.width, h: ed, weight: 0.88, axis: '' });
        regions.push({ x: r.x, y: r.y, w: ed, h: r.height, weight: 0.88, axis: '' });
        regions.push({ x: r.right - ed, y: r.y, w: ed, h: r.height, weight: 0.88, axis: '' });
      }
    });
  }

  // Adaptive grid — cells ~65px on desktop, wider on mobile
  const gc = Math.max(6, Math.min(24, Math.round(vw / 65)));
  const cw = vw / gc;
  const gr = Math.max(4, Math.ceil(vh / cw));
  const ch = vh / gr;
  const grid = new Float32Array(gc * gr);

  for (let gy = 0; gy < gr; gy++) {
    for (let gx = 0; gx < gc; gx++) {
      const cx = gx * cw + cw / 2;
      const cy = gy * ch + ch / 2;
      let w = 0.08; // whitespace baseline
      for (const r of regions) {
        // Direct containment
        if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
          w = Math.max(w, r.weight);
        }
        // Proximity falloff — nearby content boosts density
        const dx = Math.max(0, r.x - cx, cx - r.x - r.w);
        const dy = Math.max(0, r.y - cy, cy - r.y - r.h);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 0 && dist < 45) {
          w = Math.max(w, w + (1 - dist / 45) * r.weight * 0.2);
        }
      }
      grid[gy * gc + gx] = Math.min(1, w);
    }
  }

  return { regions, grid, gc, gr };
}

// ---- Mark seeding ----
// Two layers: veil blobs (coverage) + structure strokes (texture)
// Blobs use near-background color so they occlude by matching the page surface
// Strokes add structural detail concentrated on content edges

function findRegion(x: number, y: number, regions: Region[]): number {
  let bestIdx = -1, bestW = 0;
  for (let ri = 0; ri < regions.length; ri++) {
    const r = regions[ri];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h && r.weight > bestW) {
      bestW = r.weight; bestIdx = ri;
    }
  }
  return bestIdx;
}

function seedMarks(vw: number, vh: number, grid: Float32Array, gc: number, gr: number, regions: Region[]): Mark[] {
  const marks: Mark[] = [];
  const cw = vw / gc, ch = vh / gr;

  let totalWeight = 0;
  for (let i = 0; i < grid.length; i++) totalWeight += grid[i];

  // Layer 1: Veil blobs — near-circular filled shapes that overlap heavily
  // Near-background color, low individual opacity, high overlap count
  // Near-circular shapes (low noise perturbation) so overlapping edges blend
  // into continuous density gradients instead of distinct blob boundaries
  const BLOB_COUNT = 700;
  for (let i = 0; i < grid.length; i++) {
    // Ensure minimum coverage even in whitespace — creates continuous base veil
    const adjustedW = Math.max(0.25, grid[i]);
    const count = Math.max(0, Math.round((adjustedW / (totalWeight + grid.length * 0.17)) * BLOB_COUNT));
    const gx = i % gc, gy = (i / gc) | 0;
    for (let j = 0; j < count; j++) {
      const x = gx * cw + Math.random() * cw;
      const y = gy * ch + Math.random() * ch;
      const ri = findRegion(x, y, regions);
      const wScale = grid[i];
      const baseOp = 0.03 + Math.random() * 0.09;
      marks.push({
        x, y, homeX: x, homeY: y,
        size: 35 + wScale * 35 + Math.random() * 20, // 35-90px diameter
        width: 0, angle: Math.random() * Math.PI * 2, curve: 0,
        baseOp, op: baseOp,
        color: [15, 14, 13], // near default background (#0a0a0a)
        np: Math.random() * 1000, na: 1.0,
        ri, cond: 0, ro: Math.random(), blob: true,
      });
    }
  }

  // Layer 2: Structure strokes — texture on high-density areas only
  // Slightly lighter than background for visible structural detail
  const STROKE_COUNT = 200;
  const sortedWeights = Array.from(grid).sort();
  const medianW = sortedWeights[Math.floor(sortedWeights.length / 2)];
  let strokeTotalW = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > medianW) strokeTotalW += grid[i];
  }
  if (strokeTotalW === 0) strokeTotalW = 1;

  for (let i = 0; i < grid.length; i++) {
    if (grid[i] <= medianW) continue;
    const count = Math.max(0, Math.round((grid[i] / strokeTotalW) * STROKE_COUNT));
    const gx = i % gc, gy = (i / gc) | 0;
    for (let j = 0; j < count; j++) {
      const x = gx * cw + Math.random() * cw;
      const y = gy * ch + Math.random() * ch;
      const ri = findRegion(x, y, regions);
      const baseOp = 0.10 + Math.random() * 0.20;
      marks.push({
        x, y, homeX: x, homeY: y,
        size: 12 + Math.random() * 22, // 12-34px length
        width: 2 + Math.random() * 3,  // 2-5px width
        angle: Math.random() * Math.PI,
        curve: (Math.random() - 0.5) * 5,
        baseOp, op: baseOp,
        color: [45, 42, 38], // slightly lighter than background for texture
        np: Math.random() * 1000, na: 1.0,
        ri, cond: 0, ro: Math.random(), blob: false,
      });
    }
  }

  return marks;
}

// ---- Main ----

export function initGrowthField(): void {
  const cvs = document.getElementById('quiz-vortex') as HTMLCanvasElement;
  if (!cvs || cvs.dataset.init === '1') return;
  cvs.dataset.init = '1';

  const ctx = cvs.getContext('2d')!;
  let vw = 0, vh = 0, running = true, time = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = cvs.clientWidth;
    vh = cvs.clientHeight;
    cvs.width = vw * dpr;
    cvs.height = vh * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // Build systems
  cacheThemes();
  const defaultPalette = _themes.get('')!;
  const { regions, grid, gc, gr } = buildModel(vw, vh);
  const marks = seedMarks(vw, vh, grid, gc, gr, regions);

  // State
  let intensity = 0;
  let themeTarget = '';
  let wave: { axis: string; t0: number; dur: number; cx: number; cy: number } | null = null;
  let resolving = false;
  let resolveT0 = 0;
  const RESOLVE_DUR = 2200;
  const backdrop = document.getElementById('quiz-backdrop');

  // ---- Theme interpolation ----

  function applyInterp(t: number, key: string) {
    const tv = _themes.get(key);
    if (!tv) return;
    const root = document.documentElement;
    for (let i = 0; i < TOKENS.length; i++) {
      root.style.setProperty(TOKENS[i], r2h(lrgb(defaultPalette[i], tv[i], t)));
    }
  }

  function clearInterp() {
    const root = document.documentElement;
    for (const n of TOKENS) root.style.removeProperty(n);
  }

  // ---- Render loop ----

  function draw() {
    if (!running) return;
    ctx.clearRect(0, 0, vw, vh);
    time += 0.002;
    const now = Date.now();

    // ---- Wave propagation ----
    if (wave) {
      const elapsed = now - wave.t0;
      const prog = Math.min(1, elapsed / wave.dur);
      const maxDist = Math.hypot(vw, vh);
      const waveR = prog * maxDist;

      for (const m of marks) {
        const d = Math.hypot(m.homeX - wave.cx, m.homeY - wave.cy);
        if (d < waveR) {
          // Perturbation strongest at wavefront, fades behind it
          const front = Math.max(0, 1 - (waveR - d) / 100);
          const perturb = front * (1 - prog) * 3.5;
          m.x = m.homeX + noise(m.np, 0, elapsed * 0.002) * perturb;
          m.y = m.homeY + noise(0, m.np, elapsed * 0.002) * perturb;
        }
      }
      if (elapsed > wave.dur) wave = null;
    }

    // ---- Resolution sequence ----
    if (resolving) {
      const elapsed = now - resolveT0;
      const prog = Math.min(1, elapsed / RESOLVE_DUR);

      if (prog < 0.75) {
        // Phase 1: interference collapse — this IS the reveal
        // Blobs shrink (reducing coverage), strokes shrink and align.
        // The page becomes legible through structural change, not alpha.
        const p = prog / 0.75;
        for (const m of marks) {
          const settle = Math.min(1, p + m.cond * 0.25);
          // Noise amplitude decreases — shapes settle, drift stops
          m.na = Math.max(0.02, 1 - settle * 0.98);
          // Position converges to home
          m.x += (m.homeX - m.x) * settle * 0.15;
          m.y += (m.homeY - m.y) * settle * 0.15;

          if (m.blob) {
            // BLOBS SHRINK — primary occlusion reducer in early phase 1
            m.size *= (1 - settle * 0.03);
            // As blobs get small, accelerate opacity drop so they dissolve
            // before the circular polygon outline becomes the visible shape.
            // This keeps the tail reading as "density dissolving" not "circles shrinking"
            const sizeRatio = m.size / (35 + 30); // rough ratio to initial avg size
            const dissolveFactor = sizeRatio < 0.4 ? (1 - sizeRatio) * 0.6 : 0;
            m.op = m.baseOp * (1 - m.cond * 0.45) * (1 - settle * 0.25) * (1 - dissolveFactor);
          } else {
            // Strokes shrink and thin
            m.size *= (1 - settle * 0.025);
            m.width *= (1 - settle * 0.02);
            m.curve *= (1 - settle * 0.04);
            const horiz = Math.round(m.angle / Math.PI) * Math.PI;
            m.angle += (horiz - m.angle) * settle * 0.06;
            m.op = m.baseOp * (1 - m.cond * 0.45) * (1 - settle * 0.25);
          }
        }
      } else {
        // Phase 2: cleanup tail — light alpha fade on whatever marks remain
        // By this point the page is already mostly legible from phase 1.
        // This is just sweeping the last traces, not doing the revealing.
        const p = (prog - 0.75) / 0.25;
        for (const m of marks) {
          m.na = 0.02;
          const delay = m.ro * 0.3;
          const fadeP = Math.max(0, Math.min(1, (p - delay) / Math.max(0.01, 1 - delay)));
          m.op *= (1 - fadeP);
        }
      }

      // Ramp theme intensity from current to 1.0 during phase 1
      const rampedI = intensity + (1 - intensity) * Math.min(1, prog / 0.75);
      if (themeTarget) applyInterp(rampedI, themeTarget);

      if (prog >= 1) {
        resolving = false;
        running = false;
        cvs.dataset.init = '';
        return;
      }
    }

    // ---- Draw marks ----
    for (const m of marks) {
      if (m.op < 0.004) continue;

      const drift = m.na;
      const px = m.x + noise(m.np, time, 0) * drift * 3;
      const py = m.y + noise(time, m.np, 0) * drift * 3;
      if (px < -50 || px > vw + 50 || py < -50 || py > vh + 50) continue;

      if (m.blob) {
        // Skip blobs that have shrunk small enough to read as circular shapes
        if (m.size < 8) continue;
        // Near-circular filled shape — low noise perturbation so overlapping
        // shapes blend into a continuous density field, not distinct blobs
        const radius = m.size / 2;
        ctx.beginPath();
        const steps = 12;
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          // 0.08 noise scale = shapes are 92-108% of base radius = nearly circular
          const rN = 1 + noise(m.np + i * 7.3, time * 0.3, a * 2) * 0.08 * drift;
          const r = radius * rN;
          ctx.lineTo(px + Math.cos(a) * r, py + Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fillStyle = `rgba(${m.color[0]},${m.color[1]},${m.color[2]},${m.op})`;
        ctx.fill();
      } else {
        // Stroked curve — structural texture on content edges
        const aN = noise(m.np * 2, time * 0.4, 0) * drift * 0.3;
        const angle = m.angle + aN;
        const hl = m.size / 2;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        ctx.beginPath();
        ctx.moveTo(px - cos * hl, py - sin * hl);
        ctx.quadraticCurveTo(
          px + sin * m.curve * drift,
          py - cos * m.curve * drift,
          px + cos * hl, py + sin * hl
        );
        ctx.strokeStyle = `rgba(${m.color[0]},${m.color[1]},${m.color[2]},${m.op})`;
        ctx.lineWidth = m.width;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    }

    requestAnimationFrame(draw);
  }

  requestAnimationFrame(draw);

  // ---- Exposed API ----

  // Called per answer: conditions the field + applies interpolated theme
  (window as any).__fieldCondition = (questionIdx: number, _answer: string, theme: string) => {
    const intensityMap: Record<number, number> = { 1: 0.20, 2: 0.40, 3: 0.65, 4: 0.85 };
    intensity = intensityMap[questionIdx] || intensity;
    themeTarget = theme;

    const targetPalette = _themes.get(theme) || defaultPalette;
    const axisMap: Record<number, string> = { 1: 'frame', 2: 'vibe', 3: 'phase', 4: 'processing' };
    const axis = axisMap[questionIdx] || '';

    // Condition marks — whole field shifts, owned regions shift more
    const bg = targetPalette[0];  // neutral-950
    const ac = targetPalette[12]; // amber-500
    for (const m of marks) {
      let strength = 0.30; // global base influence
      if (m.ri >= 0 && regions[m.ri].axis === axis) strength = 0.55;
      m.cond = Math.min(1, m.cond + strength * 0.3);

      // Color shift: blobs track background (stay occluding), strokes show accent
      let markTarget: RGB;
      if (m.blob) {
        // Blobs stay near the page background — they occlude by matching the surface
        markTarget = [bg[0] * 0.9 + ac[0] * 0.1 | 0, bg[1] * 0.9 + ac[1] * 0.1 | 0, bg[2] * 0.9 + ac[2] * 0.1 | 0];
      } else {
        // Strokes pick up more accent color — visible structural detail
        markTarget = [bg[0] * 0.5 + ac[0] * 0.5 | 0, bg[1] * 0.5 + ac[1] * 0.5 | 0, bg[2] * 0.5 + ac[2] * 0.5 | 0];
      }
      m.color = lrgb(m.color, markTarget, intensity * 0.4);

      // More conditioned marks become more transparent — progressive legibility
      m.op = m.baseOp * (1 - m.cond * 0.45);
    }

    // Apply interpolated theme to page behind field
    applyInterp(intensity, theme);

    // Reduce backdrop blur as conditioning builds
    if (backdrop) {
      const blur = Math.max(0, 10 * (1 - intensity * 1.05));
      backdrop.style.backdropFilter = `blur(${blur}px)`;
      (backdrop.style as any).webkitBackdropFilter = `blur(${blur}px)`;
      const gradBase = 0.22 * (1 - intensity * 0.55);
      backdrop.style.background = `radial-gradient(ellipse at 50% 40%, rgba(0,0,0,${gradBase.toFixed(3)}) 0%, rgba(0,0,0,${(gradBase + 0.07).toFixed(3)}) 60%, rgba(0,0,0,${(gradBase + 0.14).toFixed(3)}) 100%)`;
    }

    // Start change wave from axis-region centroid
    const matched = regions.filter(r => r.axis === axis);
    let cx = vw / 2, cy = vh / 2;
    if (matched.length > 0) {
      cx = matched.reduce((s, r) => s + r.x + r.w / 2, 0) / matched.length;
      cy = matched.reduce((s, r) => s + r.y + r.h / 2, 0) / matched.length;
    }
    wave = { axis, t0: Date.now(), dur: 1000, cx, cy };
  };

  // Called at quiz completion — starts resolution sequence
  (window as any).__fieldResolve = () => {
    // Compute resolve order: conditioned marks resolve earlier
    for (const m of marks) {
      m.ro = (1 - m.cond) * 0.55 + Math.random() * 0.45;
    }
    resolving = true;
    resolveT0 = Date.now();

    // Subtle depth collapse — field flattens into page plane
    cvs.style.transition = 'transform 1.8s cubic-bezier(0.16, 1, 0.3, 1)';
    cvs.style.transform = 'perspective(2000px) rotateX(0deg)';
  };

  // Called for quick close (skip without answers)
  (window as any).__fieldStop = () => {
    running = false;
    clearInterp();
    cvs.dataset.init = '';
  };
}
