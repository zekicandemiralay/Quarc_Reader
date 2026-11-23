import { useTranslation } from 'react-i18next';
import { Crop, Copy, Download, Type, Layers, X, Loader2 } from 'lucide-react';

// `label` is the full name (tooltip, screen readers); `text` the shorter one shown beside the icon on wide screens.
function Action({ icon: Icon, label, text = label, onClick, disabled, pressed, testId, primary = false }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-xl px-2.5 text-sm font-medium transition disabled:opacity-35 ${
        primary
          ? 'bg-accent text-white shadow-soft hover:bg-accent-dark'
          : pressed
            ? 'bg-accent-soft text-accent-dark dark:bg-accent/25 dark:text-accent-ring'
            : 'text-neutral-700 hover:bg-neutral-200/60 dark:text-neutral-200 dark:hover:bg-neutral-700/60'
      }`}
    >
      <Icon size={17} />
      {text && <span className="hidden md:inline">{text}</span>}
    </button>
  );
}

// The snip tool's bar (it takes the tool dock's place while the tool is on): what to do with the chosen region.
// `snip`: { rect: { w, h } | null, busy, annotations, onToggleAnnotations, onCopy, onSave, onCopyText, onClose }
export default function SnipBar({ snip }) {
  const { t } = useTranslation();
  const { rect, busy, annotations, onToggleAnnotations, onCopy, onSave, onCopyText, onClose } = snip;
  const off = !rect || busy;
  return (
    <div data-overlay data-testid="snip-bar" className="pointer-events-none absolute inset-x-0 top-3 z-[5] flex justify-center px-3">
      <div className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-2xl border border-neutral-200/80 bg-surface/95 p-1.5 shadow-float backdrop-blur-xl [scrollbar-width:none] dark:border-neutral-700/80 dark:bg-neutral-800/95">
        <span className="flex shrink-0 items-center gap-2 pl-2 pr-1 text-sm text-neutral-600 dark:text-neutral-300">
          {busy ? <Loader2 size={17} className="animate-spin text-accent" /> : <Crop size={17} className="text-accent" />}
          <span data-testid="snip-hint" className="hidden max-w-[16rem] truncate sm:inline">
            {rect ? t('snip.size', { w: Math.round(rect.w), h: Math.round(rect.h) }) : t('snip.hint')}
          </span>
        </span>
        <div className="mx-1 h-6 w-px shrink-0 bg-neutral-300/70 dark:bg-neutral-600/70" />
        <Action icon={Copy} label={t('snip.copy')} testId="snip-copy" disabled={off} onClick={onCopy} primary />
        <Action icon={Download} label={t('snip.save')} testId="snip-save" disabled={off} onClick={onSave} />
        <Action icon={Type} label={t('snip.copyText')} testId="snip-text" disabled={off} onClick={onCopyText} />
        <div className="mx-1 h-6 w-px shrink-0 bg-neutral-300/70 dark:bg-neutral-600/70" />
        <Action icon={Layers} label={t('snip.annotations')} text={t('snip.annotationsShort')} testId="snip-annotations" pressed={annotations} onClick={onToggleAnnotations} />
        <Action icon={X} label={t('common.close')} text="" testId="snip-close" onClick={onClose} />
      </div>
    </div>
  );
}
