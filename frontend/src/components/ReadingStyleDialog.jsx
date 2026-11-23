import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FileText } from 'lucide-react';

const LAST_KEY = 'quarc_reader_last_style';

export const lastReadingStyle = () => {
  try {
    const v = localStorage.getItem(LAST_KEY);
    return v === 'book' ? 'book' : 'scroll';
  } catch {
    return 'scroll';
  }
};

// Pages running down the screen, with a scroll arrow.
function ScrollArt() {
  return (
    <svg viewBox="0 0 200 130" className="h-full w-full" aria-hidden="true">
      <defs>
        <clipPath id="rs-clip"><rect x="0" y="0" width="200" height="130" rx="14" /></clipPath>
      </defs>
      <g clipPath="url(#rs-clip)">
        <rect width="200" height="130" fill="#eee3c9" />
        {[ -62, 20, 102, 184 ].map((y, i) => (
          <g key={y} transform={`translate(58 ${y})`}>
            <rect width="84" height="74" rx="3" fill="#fffdf9" stroke="#d9cba9" strokeWidth="1.2" />
            {[10, 20, 30, 40, 50, 60].map((ly, k) => (
              <rect key={ly} x="9" y={ly} width={k === 5 ? 36 : k % 3 === 2 ? 52 : 66} height="4" rx="2" fill={i === 1 && k === 2 ? '#ffd02b' : '#d9cfbb'} />
            ))}
          </g>
        ))}
      </g>
      <g fill="none" stroke="#7c3aed" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M168 40 v50" />
        <path d="M160 49 l8 -9 l8 9" />
        <path d="M160 81 l8 9 l8 -9" />
      </g>
    </svg>
  );
}

// One whole page, with a turning corner and page-turn chevrons.
function BookArt() {
  return (
    <svg viewBox="0 0 200 130" className="h-full w-full" aria-hidden="true">
      <rect width="200" height="130" rx="14" fill="#eee3c9" />
      <g transform="translate(62 12)">
        <rect x="4" y="5" width="76" height="106" rx="3" fill="#d9cba9" />
        <path d="M0 0 H76 V92 L58 106 H0 Z" fill="#fffdf9" stroke="#d9cba9" strokeWidth="1.2" />
        {[14, 25, 36, 47, 58, 69, 80].map((ly, k) => (
          <rect key={ly} x="10" y={ly} width={k === 6 ? 30 : k % 3 === 2 ? 46 : 58} height="4" rx="2" fill={k === 3 ? '#ffd02b' : '#d9cfbb'} />
        ))}
        <path d="M76 92 L58 106 L58 90 Q58 92 60 92 Z" fill="#e6dcc3" />
        <path d="M76 92 H60 Q58 92 58 94 V106 Z" fill="#efe6d0" stroke="#d9cba9" strokeWidth="1" />
      </g>
      <g fill="none" stroke="#7c3aed" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M40 58 l-8 7 l8 7" />
        <path d="M160 58 l8 7 l-8 7" />
      </g>
    </svg>
  );
}

// Shown every time a document is opened (unless a default was chosen): how do you want to read it?
export default function ReadingStyleDialog({ doc, onChoose, onBack }) {
  const { t } = useTranslation();
  const [remember, setRemember] = useState(false);
  const last = lastReadingStyle();

  const pick = (mode) => {
    try {
      localStorage.setItem(LAST_KEY, mode);
    } catch {
      /* private mode: the answer still applies */
    }
    onChoose(mode, remember);
  };

  const option = (mode, Art) => (
    <button
      type="button"
      key={mode}
      data-testid={`style-${mode}`}
      autoFocus={mode === last}
      onClick={() => pick(mode)}
      className="group flex flex-1 flex-row items-center gap-3 rounded-3xl border border-neutral-200 bg-white/60 p-3 text-left transition hover:border-accent hover:bg-white hover:shadow-float focus-visible:border-accent sm:flex-col sm:items-stretch sm:hover:-translate-y-0.5 dark:border-neutral-700 dark:bg-neutral-800/60 dark:hover:bg-neutral-800"
    >
      <div className="aspect-[200/130] w-28 shrink-0 overflow-hidden rounded-2xl shadow-soft sm:w-full">
        <Art />
      </div>
      <div className="min-w-0 px-1 sm:pb-1">
        <p className="font-serif text-lg font-semibold">{t(`readingStyle.${mode}.title`)}</p>
        <p className="mt-0.5 text-sm leading-snug text-neutral-500 dark:text-neutral-400">{t(`readingStyle.${mode}.body`)}</p>
      </div>
    </button>
  );

  return (
    // `m-auto` on the card (not centring on the container) keeps the top reachable when the card is taller than the screen.
    <div className="absolute inset-0 z-[20] flex overflow-y-auto bg-neutral-100/80 p-4 backdrop-blur-md dark:bg-neutral-950/80">
      <div role="dialog" aria-modal="true" aria-label={t('readingStyle.title')} className="m-auto w-full max-w-2xl rounded-4xl border border-neutral-200/70 bg-surface p-5 shadow-float sm:p-7 dark:border-neutral-700 dark:bg-neutral-900">
        <div className="mb-5 flex items-center gap-4">
          <div className="book-cover relative h-20 w-14 shrink-0 overflow-hidden rounded-[5px] bg-neutral-200 shadow-cover dark:bg-neutral-700">
            {doc?.thumb ? <img src={doc.thumb} alt="" className="h-full w-full object-cover object-top" draggable={false} /> : <FileText className="m-auto mt-6 text-neutral-400" />}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-widest text-accent">{t('readingStyle.opening')}</p>
            <h2 className="truncate font-serif text-2xl font-semibold leading-tight">{doc?.title}</h2>
            {doc?.author && <p className="truncate text-sm text-neutral-500">{doc.author}</p>}
          </div>
        </div>

        <p className="mb-3 font-serif text-lg text-neutral-700 dark:text-neutral-200">{t('readingStyle.title')}</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          {option('scroll', ScrollArt)}
          {option('book', BookArt)}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-neutral-700 dark:text-neutral-200">
            <input data-testid="style-remember" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4 rounded accent-violet-600" />
            <span>
              {t('readingStyle.remember')}
              <span className="block text-xs text-neutral-400">{t('readingStyle.rememberHint')}</span>
            </span>
          </label>
          <button type="button" onClick={onBack} className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800">
            <ArrowLeft size={15} /> {t('reader.backToLibrary')}
          </button>
        </div>
      </div>
    </div>
  );
}
