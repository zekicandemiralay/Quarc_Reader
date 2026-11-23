import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';

function RoundButton({ children, title, onClick, disabled, pressed, testId }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition disabled:opacity-30 ${
        pressed ? 'bg-accent-soft text-accent-dark dark:bg-accent/25 dark:text-accent-ring' : 'text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-700/60'
      }`}
    >
      {children}
    </button>
  );
}

// The find-in-text bar (Ctrl+F): a pill at the top of the page, where the tool dock is while writing.
// `find` is what useFind returns.
export default function FindBar({ find }) {
  const { t } = useTranslation();
  const input = useRef(null);
  const { query, setQuery, status, accents, focusTick, toggleAccents, next, prev, closeFind } = find;

  // Ctrl+F again (or the search button) while the bar is open: back to the box, text selected.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusTick]);

  let label = '';
  if (status.phase === 'scanning' && status.total === 0) label = t('find.searching');
  else if (status.total > 0) label = t('find.count', { current: status.rank, total: status.capped ? `${status.total}+` : status.total });
  else if (status.phase === 'done') label = status.hasText ? t('find.noMatches') : t('find.noText');

  return (
    <div data-overlay data-testid="find-bar" className="pointer-events-none absolute inset-x-0 top-3 z-[5] flex justify-center px-3">
      <div className="pointer-events-auto flex w-full max-w-lg items-center gap-0.5 rounded-full border border-neutral-200/80 bg-surface/95 py-1 pl-4 pr-1 shadow-float backdrop-blur-xl focus-within:border-accent dark:border-neutral-700/80 dark:bg-neutral-800/95">
        <Search size={16} className="shrink-0 text-neutral-400" />
        <input
          ref={input}
          data-testid="find-input"
          type="text"
          autoFocus
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          value={query}
          placeholder={t('find.placeholder')}
          aria-label={t('find.title')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.shiftKey ? prev : next)();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeFind();
            }
          }}
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:outline-none placeholder:text-neutral-400"
        />
        <span data-testid="find-count" aria-live="polite" title={status.phase === 'done' && !status.hasText ? t('find.noTextHint') : undefined} className="max-w-[9rem] shrink-0 truncate px-1 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
          {label}
        </span>
        <RoundButton title={t('find.prev')} testId="find-prev" disabled={status.total === 0} onClick={prev}>
          <ChevronUp size={18} />
        </RoundButton>
        <RoundButton title={t('find.next')} testId="find-next" disabled={status.total === 0} onClick={next}>
          <ChevronDown size={18} />
        </RoundButton>
        <RoundButton title={t('find.accents')} testId="find-accents" pressed={accents} onClick={toggleAccents}>
          <span className="text-[15px] font-semibold leading-none">á</span>
        </RoundButton>
        <RoundButton title={t('common.close')} testId="find-close" onClick={closeFind}>
          <X size={17} />
        </RoundButton>
      </div>
    </div>
  );
}
