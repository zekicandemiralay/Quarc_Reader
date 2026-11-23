import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Maximize2, Minimize2, Minus, Plus } from 'lucide-react';
import Popover from '../components/Popover';

function RoundButton({ children, title, onClick, disabled, testId }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-neutral-600 transition hover:bg-neutral-200/60 disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
    >
      {children}
    </button>
  );
}

// The floating bar at the bottom of the page: turn pages, jump anywhere (click the counter), zoom,
// and hide the toolbars. Replaces Excalidraw's own zoom footer.
export default function PageBar({ mode, index, n, zoomPct, onPrev, onNext, onGoTo, onZoom, chrome, onToggleChrome }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(index + 1);
  const counter = useRef(null);
  useEffect(() => {
    if (!open) setValue(index + 1);
  }, [index, open]);

  const commit = (v) => {
    const page = Math.min(Math.max(1, Math.round(Number(v) || 1)), n);
    setValue(page);
    onGoTo(page - 1);
  };
  const fill = n > 1 ? ((value - 1) / (n - 1)) * 100 : 0;

  return (
    <div data-overlay className="pointer-events-none absolute inset-x-0 bottom-4 z-[4] flex justify-center px-3">
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-neutral-200/80 bg-surface/90 p-1 text-sm shadow-float backdrop-blur-xl dark:border-neutral-700/80 dark:bg-neutral-800/90">
        <RoundButton title={t('canvas.prevPage')} disabled={index === 0} onClick={onPrev}>
          {mode === 'book' ? <ChevronLeft size={18} /> : <ChevronUp size={18} />}
        </RoundButton>
        <button
          ref={counter}
          type="button"
          data-testid="page-counter"
          title={t('reader.goToPage')}
          onClick={() => setOpen((o) => !o)}
          className="min-w-[5rem] rounded-full px-2 py-1.5 text-center font-medium text-neutral-800 hover:bg-neutral-200/60 dark:text-neutral-100 dark:hover:bg-neutral-700/60"
        >
          <span className="tabular-nums">
            {index + 1} / {n}
          </span>
        </button>
        <RoundButton title={t('canvas.nextPage')} disabled={index >= n - 1} onClick={onNext}>
          {mode === 'book' ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
        </RoundButton>
        <div className="mx-1 h-5 w-px bg-neutral-300/70 dark:bg-neutral-600/70" />
        <RoundButton title={t('reader.zoomOut')} testId="zoom-out" onClick={() => onZoom(1 / 1.25)}>
          <Minus size={16} />
        </RoundButton>
        <span data-testid="zoom-level" className="w-11 text-center text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
          {zoomPct}%
        </span>
        <RoundButton title={t('reader.zoomIn')} testId="zoom-in" onClick={() => onZoom(1.25)}>
          <Plus size={16} />
        </RoundButton>
        {onToggleChrome && (
          <>
            <div className="mx-1 h-5 w-px bg-neutral-300/70 dark:bg-neutral-600/70" />
            <RoundButton title={chrome ? t('reader.hideBars') : t('reader.showBars')} testId="toggle-chrome" onClick={onToggleChrome}>
              {chrome ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
            </RoundButton>
          </>
        )}
      </div>

      <Popover anchorRef={counter} open={open} onClose={() => setOpen(false)} align="center" className="w-72 p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="font-serif text-base font-semibold">{t('reader.goToPage')}</span>
          <span className="text-xs text-neutral-400">{t('reader.ofPages', { n })}</span>
        </div>
        <input
          type="range"
          className="quarc-range mb-4 w-full"
          min={1}
          max={Math.max(1, n)}
          value={value}
          style={{ '--fill': `${fill}%` }}
          onChange={(e) => setValue(Number(e.target.value))}
          onPointerUp={(e) => commit(e.currentTarget.value)}
          onKeyUp={(e) => commit(e.currentTarget.value)}
        />
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            commit(value);
            setOpen(false);
          }}
        >
          <input
            type="number"
            min={1}
            max={n}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-24 rounded-xl border border-neutral-300 bg-transparent px-3 py-1.5 text-center tabular-nums outline-none focus:border-accent dark:border-neutral-600"
          />
          <button type="submit" className="flex-1 rounded-xl bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-dark">
            {t('reader.go')}
          </button>
        </form>
      </Popover>
    </div>
  );
}
