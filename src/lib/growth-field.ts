// Growth field — pure filter-based material obscuration
// No canvas. No rendered primitives. No visible mechanism.
// backdrop-filter properties create the material condition.
// Theme interpolation provides answer-specific color shift.

type RGB = [number, number, number];

const TOKENS = [
  '--color-neutral-950', '--color-neutral-900', '--color-neutral-850',
  '--color-neutral-800', '--color-neutral-700', '--color-neutral-600',
  '--color-neutral-500', '--color-neutral-400', '--color-neutral-300',
  '--color-neutral-200', '--color-neutral-100',
  '--color-amber-600', '--color-amber-500', '--color-amber-400',
  '--color-dated'
] as const;

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

// ---- Theme cache ----

const _themes = new Map<string, RGB[]>();

function cacheThemes(): void {
  const el = document.documentElement;
  const orig = el.getAttribute('data-theme');
  const read = (): RGB[] => {
    const s = getComputedStyle(el);
    return TOKENS.map(n => h2r(s.getPropertyValue(n)));
  };
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

// ---- Main ----

export function initGrowthField(): void {
  const backdrop = document.getElementById('quiz-backdrop');
  if (!backdrop || backdrop.dataset.fieldInit === '1') return;
  backdrop.dataset.fieldInit = '1';

  cacheThemes();
  const defaultPalette = _themes.get('')!;
  let intensity = 0;
  let themeTarget = '';

  // Per-token interpolation curves. Deep neutrals (background/surface) lag behind
  // accent and lighter tokens. This prevents Q1 from dumping a luminance shift
  // while still letting accent/hue changes register as perceptible.
  // Indices 0-3 = neutral-950 through neutral-800 (the deep background stack).
  // These get t^1.8 curve — at 20% intensity they move only ~5% instead of 20%.
  // Everything else gets linear t — full responsiveness.
  function tokenT(globalT: number, tokenIndex: number): number {
    if (tokenIndex <= 3) return Math.pow(globalT, 1.8); // deep neutrals lag
    return globalT;
  }

  function applyInterp(t: number, key: string) {
    const tv = _themes.get(key);
    if (!tv) return;
    const root = document.documentElement;
    for (let i = 0; i < TOKENS.length; i++) {
      const tt = tokenT(t, i);
      root.style.setProperty(TOKENS[i], r2h(lrgb(defaultPalette[i], tv[i], tt)));
    }
  }

  function clearInterp() {
    const root = document.documentElement;
    for (const n of TOKENS) root.style.removeProperty(n);
  }

  function setFilter(i: number, transition?: string) {
    if (transition) backdrop.style.transition = transition;
    const blur = Math.max(0, 20 * (1 - i));
    const brightness = 0.70 + 0.30 * i;
    const contrast = 0.88 + 0.12 * i;
    const saturate = 0.65 + 0.35 * i;
    const f = `blur(${blur.toFixed(1)}px) brightness(${brightness.toFixed(3)}) contrast(${contrast.toFixed(3)}) saturate(${saturate.toFixed(3)})`;
    backdrop.style.backdropFilter = f;
    (backdrop.style as any).webkitBackdropFilter = f;

    // Dark overlay: top-weighted linear gradient, not centered ellipse.
    // Keeps quiz text readable without creating a circular focus structure.
    const g = i >= 0.99 ? 0 : Math.max(0.12, 0.26 * (1 - i * 0.70));
    backdrop.style.background = i >= 0.99
      ? 'transparent'
      : `linear-gradient(to bottom, rgba(0,0,0,${(g * 1.1).toFixed(3)}) 0%, rgba(0,0,0,${g.toFixed(3)}) 35%, rgba(0,0,0,${(g * 0.7).toFixed(3)}) 65%, rgba(0,0,0,${(g * 0.3).toFixed(3)}) 100%)`;

    // Regional release: top-biased linear mask, not centered radial.
    // Upper content area (hero/heading) clears faster than lower page.
    if (i > 0.01 && i < 0.99) {
      const clarity = i * 0.25;
      const top = (1 - clarity * 1.2).toFixed(3);
      const mid = (1 - clarity * 0.6).toFixed(3);
      const m = `linear-gradient(to bottom, rgba(0,0,0,${top}) 0%, rgba(0,0,0,${mid}) 50%, black 100%)`;
      backdrop.style.maskImage = m;
      (backdrop.style as any).webkitMaskImage = m;
    } else {
      backdrop.style.maskImage = 'none';
      (backdrop.style as any).webkitMaskImage = 'none';
    }
  }

  (window as any).__fieldCondition = (questionIdx: number, _answer: string, theme: string) => {
    const intensityMap: Record<number, number> = { 1: 0.20, 2: 0.40, 3: 0.65, 4: 0.85 };
    intensity = intensityMap[questionIdx] || intensity;
    themeTarget = theme;
    setFilter(intensity, 'backdrop-filter 0.8s ease, -webkit-backdrop-filter 0.8s ease, background 0.8s ease');
    applyInterp(intensity, theme);
  };

  (window as any).__fieldResolve = () => {
    setFilter(1.0, 'backdrop-filter 1.5s ease-out, -webkit-backdrop-filter 1.5s ease-out, background 1.5s ease-out');
    const startI = intensity;
    const t0 = Date.now();
    const dur = 1500;
    function ramp() {
      const p = Math.min(1, (Date.now() - t0) / dur);
      applyInterp(startI + (1 - startI) * p, themeTarget);
      if (p < 1) requestAnimationFrame(ramp);
    }
    requestAnimationFrame(ramp);
  };

  (window as any).__fieldStop = () => {
    clearInterp();
    backdrop.style.transition = 'none';
    backdrop.style.backdropFilter = 'none';
    (backdrop.style as any).webkitBackdropFilter = 'none';
    backdrop.style.background = 'transparent';
    backdrop.style.maskImage = 'none';
    (backdrop.style as any).webkitMaskImage = 'none';
    backdrop.dataset.fieldInit = '';
  };
}
