import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Underline, Strikethrough, Highlighter, Trash2, Copy, X } from 'lucide-react';
import { MARK_COLORS, markBounds } from './marks';
import { useFloatingPosition } from './SelectionBar';

// What you get when you tap an existing highlight: change its colour or
// style, read/edit its note, copy the text, or delete it.
export default function MarkPopover({ mark, anchor, container, readOnly, onChange, onDelete, onClose }) {
  const { t } = useTranslation();
  const [note, setNote] = useState(mark.note || '');
  useEffect(() => setNote(mark.note || ''), [mark.id, mark.note]);

  const pos = useFloatingPosition(container, { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y }, { width: 300, height: readOnly ? 120 : 170 });
  const commitNote = () => {
    if ((mark.note || '') !== note.trim()) onChange({ note: note.trim() || undefined });
  };

  return (
    <div
      className="absolute z-[6] flex w-[300px] flex-col gap-2 rounded-2xl border border-neutral-200/80 bg-surface/95 p-3 shadow-float backdrop-blur-xl dark:border-neutral-700 dark:bg-neutral-800/95"
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {mark.text && <p className="line-clamp-3 px-1 font-serif text-[13px] italic leading-snug text-neutral-500 dark:text-neutral-400">“{mark.text}”</p>}
      {readOnly ? (
        mark.note && <p className="px-1 text-sm">{mark.note}</p>
      ) : (
        <>
          <div className="flex items-center gap-1">
            {MARK_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onChange({ color: c })}
                className={`h-6 w-6 rounded-full ring-2 ring-offset-1 ring-offset-white dark:ring-offset-neutral-800 ${mark.color === c ? 'ring-accent' : 'ring-transparent'}`}
                style={{ backgroundColor: c }}
                aria-label={c}
              />
            ))}
            <div className="mx-1 h-5 w-px bg-neutral-300 dark:bg-neutral-600" />
            {[
              ['hl', Highlighter],
              ['ul', Underline],
              ['st', Strikethrough],
            ].map(([type, Icon]) => (
              <button
                key={type}
                type="button"
                onClick={() => onChange({ type })}
                className={`rounded-xl p-1.5 ${mark.type === type ? 'bg-accent text-white' : 'hover:bg-neutral-100 dark:hover:bg-neutral-700'}`}
              >
                <Icon size={15} />
              </button>
            ))}
            <div className="flex-1" />
            <button type="button" title={t('common.close')} className="rounded-xl p-1.5 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={commitNote}
            placeholder={t('reader.notePlaceholder')}
            rows={2}
            className="resize-none rounded-xl border border-neutral-300 bg-transparent p-2.5 text-sm outline-none focus:border-accent dark:border-neutral-600"
          />
          <div className="flex items-center justify-between">
            <button
              type="button"
              className="flex items-center gap-1 rounded-xl px-2 py-1 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700"
              onClick={() => navigator.clipboard?.writeText(mark.text || '').catch(() => {})}
            >
              <Copy size={14} /> {t('common.copy')}
            </button>
            <button
              type="button"
              className="flex items-center gap-1 rounded-xl px-2 py-1 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
              onClick={() => {
                commitNote();
                onDelete();
              }}
            >
              <Trash2 size={14} /> {t('common.delete')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export { markBounds };
