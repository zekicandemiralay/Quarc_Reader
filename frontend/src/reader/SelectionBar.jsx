import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Underline, Strikethrough, Copy, StickyNote, X, Check } from 'lucide-react';
import { MARK_COLORS } from './marks';

const DOCK_CLEAR = 72;

// Floating bar shown over a text selection: pick a colour to highlight it,
// underline, strike through, add a note, or copy.
export function useFloatingPosition(container, anchorRect, { width = 280, height = 46, gap = 10 } = {}) {
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!container || !anchorRect) return;
    const c = container.getBoundingClientRect();
    const cx = (anchorRect.left + anchorRect.right) / 2 - c.left;
    let top = anchorRect.top - c.top - height - gap;
    // Not under the tool dock (it floats over the top ~70 px): below the selection instead.
    if (top < DOCK_CLEAR) top = anchorRect.bottom - c.top + gap;
    const left = Math.min(Math.max(8, cx - width / 2), Math.max(8, c.width - width - 8));
    setPos({ left, top: Math.min(Math.max(8, top), Math.max(8, c.height - height - 70)) });
  }, [container, anchorRect?.left, anchorRect?.top, anchorRect?.right, anchorRect?.bottom, width, height, gap]);
  return pos;
}

export default function SelectionBar({ anchor, container, defaultColor, onMark, onCopy, onClose }) {
  const { t } = useTranslation();
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const inputRef = useRef(null);
  const color = MARK_COLORS.includes(defaultColor) ? defaultColor : MARK_COLORS[0];
  const pos = useFloatingPosition(container, anchor, { width: noting ? 300 : 330, height: noting ? 92 : 46 });

  // A tap on the bar must not clear the selection it is about to act on.
  const keep = (e) => e.preventDefault();

  return (
    <div
      data-selection-bar
      className="absolute z-[6] flex flex-col gap-2 rounded-2xl border border-neutral-200/80 bg-surface/95 p-1.5 shadow-float backdrop-blur-xl dark:border-neutral-700 dark:bg-neutral-800/95"
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={noting ? undefined : keep}
      onMouseDown={noting ? undefined : keep}
    >
      {noting ? (
        <>
          <textarea
            ref={inputRef}
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('reader.notePlaceholder')}
            rows={2}
            className="w-72 resize-none rounded-xl border border-neutral-300 bg-transparent p-2.5 text-sm outline-none focus:border-accent dark:border-neutral-600"
          />
          <div className="flex justify-end gap-1">
            <button type="button" className="rounded-xl px-2.5 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700" onClick={() => setNoting(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="flex items-center gap-1 rounded-xl bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-dark"
              onClick={() => onMark('hl', color, note.trim())}
            >
              <Check size={14} /> {t('common.save')}
            </button>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-1">
          {MARK_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={t('reader.highlight')}
              title={t('reader.highlight')}
              onClick={() => onMark('hl', c)}
              className="h-7 w-7 shrink-0 rounded-full ring-2 ring-transparent ring-offset-1 ring-offset-surface transition hover:scale-110 hover:ring-neutral-300"
              style={{ backgroundColor: c }}
            />
          ))}
          <div className="mx-1 h-6 w-px bg-neutral-300 dark:bg-neutral-600" />
          <button type="button" title={t('reader.underline')} aria-label={t('reader.underline')} className="rounded-xl p-2 hover:bg-neutral-100 dark:hover:bg-neutral-700" onClick={() => onMark('ul', color)}>
            <Underline size={17} />
          </button>
          <button type="button" title={t('reader.strike')} aria-label={t('reader.strike')} className="rounded-xl p-2 hover:bg-neutral-100 dark:hover:bg-neutral-700" onClick={() => onMark('st', color)}>
            <Strikethrough size={17} />
          </button>
          <button type="button" title={t('reader.addNote')} aria-label={t('reader.addNote')} className="rounded-xl p-2 hover:bg-neutral-100 dark:hover:bg-neutral-700" onClick={() => setNoting(true)}>
            <StickyNote size={17} />
          </button>
          <button type="button" title={t('common.copy')} aria-label={t('common.copy')} className="rounded-xl p-2 hover:bg-neutral-100 dark:hover:bg-neutral-700" onClick={onCopy}>
            <Copy size={17} />
          </button>
          <button type="button" title={t('common.close')} aria-label={t('common.close')} className="rounded-xl p-2 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
      )}
    </div>
  );
}
