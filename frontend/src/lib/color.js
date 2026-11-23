// Colour helpers for the pen and highlighter pickers — pure, so they can be tested on their own.

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// '#abc', 'abc', '#AABBCC', ' aabbcc ' → '#aabbcc'; anything else → null.
export function normalizeHex(input) {
  const s = String(input ?? '').trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
  if (/^[0-9a-f]{6}$/.test(s)) return `#${s}`;
  return null;
}

// h in degrees 0–360, s and v 0–1.
export function hexToHsv(hex) {
  const n = normalizeHex(hex);
  if (!n) return { h: 0, s: 0, v: 0 };
  const r = parseInt(n.slice(1, 3), 16) / 255;
  const g = parseInt(n.slice(3, 5), 16) / 255;
  const b = parseInt(n.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }) {
  const hh = (((h % 360) + 360) % 360) / 60;
  const ss = clamp01(s);
  const vv = clamp01(v);
  const c = vv * ss;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = vv - c;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.min(5, Math.floor(hh))];
  const byte = (u) => Math.round((u + m) * 255).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

// The colours used lately, newest first, each once, at most `max`.
export function pushRecent(list, hex, max = 12) {
  const n = normalizeHex(hex);
  if (!n) return list || [];
  return [n, ...(list || []).filter((c) => normalizeHex(c) !== n)].slice(0, max);
}
