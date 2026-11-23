import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pipette } from 'lucide-react';
import { normalizeHex, hexToHsv, hsvToHex } from '../lib/color';

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window;

// A colour picker that is easy on a screen: drag in the square (saturation across, brightness down), slide the hue,
// or type / paste a hex code — or, where the browser has one, pick a colour from anywhere on the screen.
// `onCommit(hex)` is called when a choice is made (the pointer is let go, Enter, leaving the box), not on every
// pixel of a drag.
export default function ColorPicker({ value, onCommit }) {
  const { t } = useTranslation();
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [hex, setHex] = useState(() => normalizeHex(value) || '#000000');
  const cur = useRef(hsv);
  const area = useRef(null);
  const dragging = useRef(false);
  const typed = useRef(false); // the hex box holds something the person typed (not just what the picker shows)
  const timer = useRef(null);
  const pending = useRef(false);

  // A choice is made: when the pointer is let go, or (for keys) a moment after the last one, so that holding an arrow
  // key down is one colour in the history, not twenty. Anything still waiting when the picker closes is made then.
  const commitNow = () => {
    clearTimeout(timer.current);
    pending.current = false;
    onCommit(hsvToHex(cur.current));
  };
  const commitSoon = () => {
    pending.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(commitNow, 600);
  };
  const flush = useRef(commitNow);
  flush.current = commitNow;
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (pending.current) flush.current();
    },
    []
  );

  // A colour chosen somewhere else (a swatch, the recent list) moves the picker to it. Not when it is the one the
  // picker itself just produced — a grey would otherwise lose the hue the person was in the middle of choosing.
  useEffect(() => {
    const n = normalizeHex(value);
    if (n && n !== hsvToHex(cur.current)) {
      const next = hexToHsv(n);
      cur.current = next;
      setHsv(next);
      setHex(n);
    }
  }, [value]);

  const set = (next) => {
    cur.current = next;
    typed.current = false;
    setHsv(next);
    setHex(hsvToHex(next));
  };

  const pick = (e) => {
    const r = area.current.getBoundingClientRect();
    set({ ...cur.current, s: clamp01((e.clientX - r.left) / r.width), v: 1 - clamp01((e.clientY - r.top) / r.height) });
  };

  const commitHex = () => {
    if (!typed.current) return; // leaving the box after dragging in the square is not a new choice
    typed.current = false;
    const n = normalizeHex(hex);
    if (!n) {
      setHex(hsvToHex(cur.current)); // not a colour: back to the one in use
      return;
    }
    const next = hexToHsv(n);
    cur.current = next;
    setHsv(next);
    setHex(n);
    onCommit(n);
  };

  const dropper = async () => {
    try {
      const { sRGBHex } = await new window.EyeDropper().open();
      const n = normalizeHex(sRGBHex);
      if (!n) return;
      const next = hexToHsv(n);
      cur.current = next;
      setHsv(next);
      setHex(n);
      onCommit(n);
    } catch {
      /* cancelled with Escape */
    }
  };

  const shown = hsvToHex(hsv);
  return (
    <div data-testid="color-picker">
      <div
        ref={area}
        data-testid="color-area"
        className="relative h-36 w-full cursor-crosshair touch-none select-none rounded-xl"
        style={{ background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(${Math.round(hsv.h)}, 100%, 50%))` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          pick(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) pick(e);
        }}
        onPointerUp={() => {
          if (!dragging.current) return;
          dragging.current = false;
          commitNow();
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        <span
          className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.35)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: shown }}
        />
      </div>
      <input
        type="range"
        data-testid="color-hue"
        aria-label={t('canvas.hue')}
        min={0}
        max={360}
        step={1}
        value={Math.round(hsv.h)}
        className="quarc-hue mt-3 block w-full"
        onChange={(e) => {
          set({ ...cur.current, h: Number(e.target.value) });
          commitSoon();
        }}
        onPointerUp={commitNow}
      />
      <div className="mt-3 flex items-center gap-2">
        <span className="h-8 w-8 shrink-0 rounded-full ring-1 ring-black/15" style={{ backgroundColor: shown }} />
        <input
          type="text"
          data-testid="color-hex"
          aria-label={t('canvas.hexColor')}
          value={hex}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            const text = e.target.value;
            typed.current = true;
            setHex(text);
            const n = normalizeHex(text);
            if (n) {
              const next = hexToHsv(n);
              cur.current = next;
              setHsv(next);
            }
          }}
          onBlur={commitHex}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitHex();
            }
          }}
          className="min-w-0 flex-1 rounded-xl border border-neutral-300 bg-transparent px-3 py-1.5 font-mono text-sm uppercase outline-none focus:border-accent focus-visible:outline-none dark:border-neutral-600"
        />
        {hasEyeDropper && (
          <button
            type="button"
            data-testid="color-dropper"
            title={t('canvas.pickFromScreen')}
            aria-label={t('canvas.pickFromScreen')}
            onClick={dropper}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
          >
            <Pipette size={17} />
          </button>
        )}
      </div>
    </div>
  );
}
