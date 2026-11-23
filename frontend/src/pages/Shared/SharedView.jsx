import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BookOpen, Scroll, Library, LogIn, Link2Off, Share2, Search, Crop } from 'lucide-react';
import { apiUrl } from '../../lib/apiUrl';
import { openPdf } from '../../lib/pdf';
import { getClientId } from '../../lib/sync';
import useAuthStore from '../../store/authStore';
import useSettings, { resolvePaper } from '../../store/settingsStore';
import ReaderCanvas from '../../reader/ReaderCanvas';
import { buildPages } from '../../reader/geometry';
import { toast } from '../../components/Toasts';

// What someone sees when they open a share link: the document, read-only, with
// the owner's annotations if the link includes them. No account is needed. A
// signed-in Quarc user can add it to their own library.
export default function SharedView() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const isDark = useSettings((s) => s.isDark);
  const paperMode = useSettings((s) => s.paperMode);
  const readMode = useSettings((s) => s.readMode);
  // A shared link never asks: it opens in your usual style (scroll when you usually get asked),
  // and the button in the bar switches it for this visit only.
  const [mode, setMode] = useState(readMode === 'book' ? 'book' : 'scroll');
  const [state, setState] = useState({ phase: 'loading' });
  const [pdf, setPdf] = useState(null);
  const [adding, setAdding] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let opened = null;
    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/public/shares/${encodeURIComponent(token)}`));
        const meta = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!cancelled) setState({ phase: 'error', message: meta.error || t('shared.unavailable') });
          return;
        }
        opened = await openPdf({ url: apiUrl(`/api/public/shares/${encodeURIComponent(token)}/file`) });
        if (cancelled) {
          opened.dispose();
          return;
        }
        setPdf(opened.pdf);
        setState({ phase: 'ready', meta });
      } catch {
        if (!cancelled) setState({ phase: 'error', message: t('shared.unavailable') });
      }
    })();
    return () => {
      cancelled = true;
      opened?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const meta = state.meta;
  const pages = useMemo(() => (meta ? buildPages(meta.page_count, meta.sizes, meta.layout) : []), [meta]);
  const annotations = useMemo(() => {
    const map = new Map();
    for (const a of meta?.annotations || []) map.set(a.page_key, { ink: a.ink || { elements: [], files: {} }, marks: a.marks || [] });
    return map;
  }, [meta]);

  async function addToLibrary() {
    setAdding(true);
    try {
      const res = await fetch(apiUrl(`/api/shares/${encodeURIComponent(token)}/import`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: getClientId() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast(t('shared.added'));
      navigate('/');
    } catch (err) {
      toast(`${t('shared.addFailed')} ${err.message}`, { duration: 7000 });
      setAdding(false);
    }
  }

  if (state.phase === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-neutral-50 p-6 text-center dark:bg-neutral-950">
        <Link2Off size={44} className="text-neutral-400" />
        <p className="max-w-sm font-serif text-lg text-neutral-600 dark:text-neutral-300">{state.message}</p>
        <Link to="/" className="rounded-full bg-accent px-5 py-2.5 font-medium text-white shadow-soft hover:bg-accent-dark">
          {t('shared.openApp')}
        </Link>
      </div>
    );
  }

  const paper = resolvePaper(paperMode, isDark);

  return (
    <div className="flex h-full flex-col bg-neutral-100 dark:bg-neutral-950">
      <header className="glass z-10 flex items-center gap-2.5 border-b border-neutral-200/70 px-3 py-2 dark:border-neutral-800">
        <img src="/logo.png" alt="" className="h-8 w-8 rounded-xl shadow-soft" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-serif text-base font-semibold leading-tight">{meta?.title || '…'}</h1>
          <p className="flex items-center gap-1 truncate text-xs text-neutral-500">
            <Share2 size={11} /> {t('shared.sharedWithYou')}
            {meta?.author ? ` · ${meta.author}` : ''}
            {meta?.include_annotations ? ` · ${t('shared.withAnnotations')}` : ''}
          </p>
        </div>
        <button
          type="button"
          title={t('find.title')}
          aria-label={t('find.title')}
          onClick={() => canvasRef.current?.openFind()}
          className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-700/70"
        >
          <Search size={20} />
        </button>
        <button
          type="button"
          title={t('snip.title')}
          aria-label={t('snip.title')}
          onClick={() => canvasRef.current?.openSnip()}
          className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-700/70"
        >
          <Crop size={20} />
        </button>
        <button
          type="button"
          title={mode === 'book' ? t('reader.modeScroll') : t('reader.modeBook')}
          onClick={() => setMode(mode === 'book' ? 'scroll' : 'book')}
          className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-700/70"
        >
          {mode === 'book' ? <BookOpen size={20} /> : <Scroll size={20} />}
        </button>
        {user ? (
          <button type="button" disabled={adding || state.phase !== 'ready'} onClick={addToLibrary} className="flex h-10 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-medium text-white shadow-soft hover:bg-accent-dark disabled:opacity-50">
            <Library size={16} /> <span className="hidden sm:inline">{t('shared.addToLibrary')}</span>
          </button>
        ) : (
          <Link to="/login" className="flex h-10 items-center gap-1.5 rounded-full border border-neutral-300 px-4 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800">
            <LogIn size={16} /> <span className="hidden sm:inline">{t('shared.signInToAdd')}</span>
          </Link>
        )}
      </header>
      <div className="min-h-0 flex-1">
        {state.phase === 'ready' && pdf ? (
          <ReaderCanvas ref={canvasRef} docId={`share-${token}`} title={meta?.title} pdf={pdf} pages={pages} annotations={annotations} readOnly mode={mode} paper={paper} initialPosition={null} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-accent" />
          </div>
        )}
      </div>
    </div>
  );
}
