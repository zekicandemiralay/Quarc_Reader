import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft,
  BookOpen,
  Scroll,
  Bookmark,
  BookmarkCheck,
  NotebookPen,
  MoreVertical,
  Share2,
  FilePlus2,
  Trash2,
  Cloud,
  HardDrive,
  Download,
  SlidersHorizontal,
  X,
  FileDown,
  CloudOff,
  Quote,
  Search,
} from 'lucide-react';
import { db } from '../../lib/db';
import { on } from '../../lib/events';
import { openPdf } from '../../lib/pdf';
import { describeOpenError } from '../../lib/pdfError';
import useKeepAwake from '../../lib/useKeepAwake';
import { pdfSource, loadAnnotations, savePageAnnotations, updateDoc, saveProgress, markOpened, cacheOffline, removeOfflineCopy } from '../../lib/library';
import { useSyncStatus } from '../../lib/sync';
import useAuthStore from '../../store/authStore';
import useSettings, { resolvePaper } from '../../store/settingsStore';
import Popover, { MenuItem, MenuSeparator } from '../../components/Popover';
import { toast } from '../../components/Toasts';
import ReaderCanvas from '../../reader/ReaderCanvas';
import { buildPages, layoutItemsFor, NOTE_SIZES, NOTE_STYLES, PX_PER_PT } from '../../reader/geometry';
import { activeMarks } from '../../reader/marks';
import ShareDialog from '../../components/ShareDialog';
import ExportDialog from '../../components/ExportDialog';
import SyncModeDialog from '../../components/SyncModeDialog';
import ReadingStyleDialog from '../../components/ReadingStyleDialog';

const PROGRESS_DELAY_MS = 2500;
// Errors where trying again can help (the server may be back, the upload may have finished).
const RETRYABLE = ['offline', 'not-ready', 'network', 'server', 'gone', 'engine', 'unknown'];

// One reader per document: opening another document starts from scratch (a fresh "how do you want to read?").
export default function ReaderRoute() {
  const { id } = useParams();
  return <Reader key={id} id={id} />;
}

function Reader({ id }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const isDark = useSettings((s) => s.isDark);
  const paperMode = useSettings((s) => s.paperMode);
  const readMode = useSettings((s) => s.readMode);
  const updatePrefs = useSettings((s) => s.update);
  const syncState = useSyncStatus((s) => s.state);

  const doc = useLiveQuery(async () => (await db.docs.get(id)) ?? null, [id]);
  const [status, setStatus] = useState({ phase: 'loading' }); // loading | ready | error
  // Reading can mean minutes on one page: the screen must not dim or lock meanwhile (Settings → Reading).
  const keepAwakeSetting = useSettings((s) => s.keepAwake);
  useKeepAwake(keepAwakeSetting && status.phase === 'ready');
  const [pdf, setPdf] = useState(null);
  const [annotations, setAnnotations] = useState(null);
  const [startPos, setStartPos] = useState(null);
  const [panel, setPanel] = useState(null); // 'notes' | null
  const [chrome, setChrome] = useState(true);
  const [dialog, setDialog] = useState(null); // 'share' | 'export' | 'sync'
  const [marksVersion, setMarksVersion] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [progressPct, setProgressPct] = useState(null);
  const [sessionMode, setSessionMode] = useState(null); // chosen for this opening of the document
  const canvasRef = useRef(null);
  const progressTimer = useRef(null);
  const menuBtn = useRef(null);
  const viewBtn = useRef(null);
  const [menu, setMenu] = useState(null); // 'more' | 'view' | 'note'

  // How to read it: this opening's choice, else the default from Settings. With the default
  // "ask" there is no mode until the person picks one (the dialog below).
  const mode = sessionMode ?? (readMode === 'ask' ? null : readMode);
  const paper = resolvePaper(doc?.settings?.paper || paperMode, isDark);

  // ----- open the document -----------------------------------------------------------

  const openKey = doc ? `${doc.id}:${doc.file_sha256}:${doc.file_ready}` : null;
  useEffect(() => {
    if (!doc) return undefined;
    let cancelled = false;
    let opened = null;
    setStatus({ phase: 'loading' });
    (async () => {
      let source = await pdfSource(doc);
      if (!source) {
        if (!cancelled) setStatus({ phase: 'error', code: doc.sync === 'cloud' ? (navigator.onLine ? 'not-ready' : 'offline') : 'missing' });
        return;
      }
      try {
        opened = await openPdf(source);
      } catch (err) {
        // Say what really went wrong (and keep the evidence in the console): "could not be opened" can be a sign-in that
        // expired, a file the server does not have, a server error, or a damaged copy on this device.
        console.error('[Quarc Reader] could not open the document', { id: doc.id, from: source.local ? 'this device' : 'the server', sha256: doc.file_sha256 }, err);
        let failure = err;
        let failedSource = source;
        // A damaged copy kept on this device of a document that is also on the server: drop the copy, read the server's.
        if (source.local && doc.sync === 'cloud' && doc.file_ready && describeOpenError(err, { local: true }).code === 'invalid-local' && (await removeOfflineCopy(doc.id))) {
          const again = await pdfSource(doc);
          if (again && !again.local) {
            source = again;
            try {
              opened = await openPdf(again);
              failure = null;
            } catch (err2) {
              console.error('[Quarc Reader] the server\'s copy could not be opened either', err2);
              failure = err2;
              failedSource = again;
            }
          }
        }
        if (failure) {
          if (!cancelled) setStatus({ phase: 'error', ...describeOpenError(failure, { local: !!failedSource.local, online: navigator.onLine }) });
          return;
        }
      }
      if (cancelled) {
        opened.dispose();
        return;
      }
      const rows = await loadAnnotations(doc.id);
      if (cancelled) {
        opened.dispose();
        return;
      }
      setAnnotations(rows);
      setStartPos(doc.progress ? { page: doc.progress.page, offset: doc.progress.offset } : null);
      setProgressPct(doc.progress?.pct ?? 0);
      setPdf(opened.pdf);
      setStatus({ phase: 'ready' });
      markOpened(doc.id);
      // Keep a synced book on this device after the first time it is opened.
      if (!source.local && useSettings.getState().autoCache) cacheOffline(doc.id).catch(() => {});
    })();
    return () => {
      cancelled = true;
      setPdf(null);
      setAnnotations(null);
      opened?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  // The window title.
  useEffect(() => {
    if (doc?.title) document.title = `${doc.title} — Quarc Reader`;
    return () => {
      document.title = 'Quarc Reader';
    };
  }, [doc?.title]);

  // ----- pages -----------------------------------------------------------------------------

  const layoutKey = doc ? `${doc.page_count}|${JSON.stringify(doc.sizes)}|${JSON.stringify(doc.layout)}` : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pages = useMemo(() => (doc ? buildPages(doc.page_count, doc.sizes, doc.layout) : []), [layoutKey]);

  // ----- saving what the canvas hands over --------------------------------------------------------

  const onSavePage = useCallback((pageKey, data) => savePageAnnotations(id, pageKey, data), [id]);

  const onPosition = useCallback(
    (pos) => {
      setProgressPct(pos.pct);
      clearTimeout(progressTimer.current);
      progressTimer.current = setTimeout(() => saveProgress(id, pos), PROGRESS_DELAY_MS);
    },
    [id]
  );
  useEffect(
    () => () => {
      clearTimeout(progressTimer.current);
    },
    []
  );

  const onPageChange = useCallback(
    (i) => {
      setCurrentIndex(i);
      if (pages.length > 1) setProgressPct(i / (pages.length - 1));
    },
    [pages.length]
  );

  // Another device changed pages that are open here: merge them in.
  useEffect(
    () =>
      on('ann-changed', async ({ docId, pageKeys, remote }) => {
        if (!remote || docId !== id || !canvasRef.current) return;
        const rows = await db.ann.bulkGet(pageKeys.map((k) => [id, k]));
        const map = new Map();
        for (const row of rows) {
          if (!row) continue;
          try {
            map.set(row.page_key, { ink: JSON.parse(row.ink_json), marks: JSON.parse(row.marks_json) });
          } catch {
            /* damaged row: ignore */
          }
        }
        if (map.size) canvasRef.current.applyRemote(map);
      }),
    [id]
  );

  // ----- note pages ---------------------------------------------------------------------------------

  // The document's page list as layout items, including note-page tombstones.
  function currentItems() {
    const tombstones = (doc.layout || []).filter((it) => it.t === 'n' && it.del);
    return layoutItemsFor(pages, tombstones);
  }

  async function insertNotePage(style) {
    const index = canvasRef.current?.currentIndex() ?? 0;
    const items = currentItems();
    const here = pages[index];
    const size = here ? { w: Math.round(here.w / PX_PER_PT), h: Math.round(here.h / PX_PER_PT) } : NOTE_SIZES.A4;
    const note = { t: 'n', id: crypto.randomUUID(), w: size.w, h: size.h, s: style, u: Date.now() };
    const at = items.findIndex((it) => (it.t === 'p' ? `p${it.i}` : `n${it.id}`) === here?.key);
    items.splice(at + 1, 0, note);
    await updateDoc(id, { layout: items });
    setMenu(null);
    requestAnimationFrame(() => canvasRef.current?.goToPage(index + 1));
  }

  async function deleteNotePage() {
    const index = canvasRef.current?.currentIndex() ?? 0;
    const here = pages[index];
    if (here?.kind !== 'note') return;
    if (!window.confirm(t('reader.deleteNotePageConfirm'))) return;
    const items = currentItems().map((it) => (it.t === 'n' && it.id === here.id ? { ...it, del: true, u: Date.now() } : it));
    await updateDoc(id, { layout: items });
    setMenu(null);
  }

  // ----- bookmarks ----------------------------------------------------------------------------------------

  const bookmarks = useMemo(() => (doc?.bookmarks || []).filter((b) => !b.del), [doc?.bookmarks]);
  const hereKey = pages[currentIndex]?.key;
  const hereBookmark = bookmarks.find((b) => b.page_key === hereKey);

  async function toggleBookmark() {
    if (!hereKey) return;
    const list = doc.bookmarks || [];
    const u = Date.now();
    const next = hereBookmark
      ? list.map((b) => (b.id === hereBookmark.id ? { ...b, del: true, u } : b))
      : [...list, { id: crypto.randomUUID(), u, page_key: hereKey, label: t('reader.pageN', { n: currentIndex + 1 }) }];
    await updateDoc(id, { bookmarks: next });
    toast(hereBookmark ? t('reader.bookmarkRemoved') : t('reader.bookmarkAdded'));
  }

  function openBookmark(b) {
    const i = pages.findIndex((p) => p.key === b.page_key);
    if (i >= 0) canvasRef.current?.goToPage(i);
    setPanel(null);
  }

  // ----- the notes & highlights list -------------------------------------------------------------------------

  const marksList = useMemo(() => {
    const out = [];
    const all = canvasRef.current?.marks();
    if (!all) return out;
    pages.forEach((p, i) => {
      for (const m of activeMarks(all.get(p.key))) out.push({ pageKey: p.key, pageIndex: i, mark: m });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marksVersion, pages, panel]);

  // ----- UI -------------------------------------------------------------------------------------------------

  // Paper is chosen per document (the default lives in Settings).
  function setDocSetting(patch) {
    updateDoc(id, { settings: { ...(doc.settings || {}), ...patch } });
  }

  if (doc === null) {
    return (
      <Centered>
        <p className="font-serif text-xl text-neutral-600 dark:text-neutral-300">{t('reader.notFound')}</p>
        <PrimaryButton onClick={() => navigate('/')}>{t('reader.backToLibrary')}</PrimaryButton>
      </Centered>
    );
  }
  if (!doc || (user && doc.owner && doc.owner !== user.id)) return <Centered>{doc ? <p>{t('reader.notYours')}</p> : <Spinner />}</Centered>;

  if (status.phase === 'error') {
    return (
      <Centered>
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-neutral-100 text-neutral-400 dark:bg-neutral-800">
          <CloudOff size={36} />
        </div>
        <p data-testid="reader-error" className="max-w-sm text-center font-serif text-lg text-neutral-700 dark:text-neutral-200">{t(`reader.error.${status.code}`)}</p>
        {status.detail && (
          <p data-testid="reader-error-detail" className="max-w-sm select-text break-words text-center text-xs text-neutral-400">
            {t('reader.errorDetails')}: {status.detail}
          </p>
        )}
        <div className="flex flex-wrap justify-center gap-2">
          <PrimaryButton onClick={() => navigate('/')}>{t('reader.backToLibrary')}</PrimaryButton>
          {RETRYABLE.includes(status.code) && (
            <button className="rounded-full border border-neutral-300 px-5 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800" onClick={() => window.location.reload()}>
              {t('common.retry')}
            </button>
          )}
          {status.code === 'signin' && (
            <button
              data-testid="reader-signin"
              className="rounded-full border border-neutral-300 px-5 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
              onClick={async () => {
                await useAuthStore.getState().logout();
                navigate('/login');
              }}
            >
              {t('reader.error.signInAgain')}
            </button>
          )}
        </div>
      </Centered>
    );
  }

  const ready = status.phase === 'ready' && pdf && annotations;
  const asking = mode === null;
  const isNotePage = pages[currentIndex]?.kind === 'note';

  return (
    <div className="flex h-full flex-col bg-neutral-100 dark:bg-neutral-950">
      {chrome && !asking && (
        <header className="glass relative z-10 flex items-center gap-0.5 border-b border-neutral-200/70 px-2 py-1.5 dark:border-neutral-800">
          <IconButton title={t('reader.backToLibrary')} onClick={() => navigate('/')}>
            <ArrowLeft size={20} />
          </IconButton>
          <div className="min-w-0 flex-1 px-2">
            <h1 className="truncate font-serif text-[15px] font-semibold leading-tight">{doc.title}</h1>
            <p className="flex items-center gap-1.5 truncate text-xs text-neutral-500">
              {doc.sync === 'cloud' ? <Cloud size={12} className="shrink-0" /> : <HardDrive size={12} className="shrink-0" />}
              <span className="truncate">
                {doc.sync === 'cloud' ? (syncState === 'offline' ? t('sync.offline') : doc.file_ready ? t('sync.synced') : t('sync.uploading')) : t('sync.localOnly')}
                {doc.author ? ` · ${doc.author}` : ''}
              </span>
            </p>
          </div>
          <IconButton title={t('find.title')} onClick={() => canvasRef.current?.openFind()}>
            <Search size={20} />
          </IconButton>
          <IconButton title={hereBookmark ? t('reader.removeBookmark') : t('reader.addBookmark')} onClick={toggleBookmark} active={!!hereBookmark}>
            {hereBookmark ? <BookmarkCheck size={20} /> : <Bookmark size={20} />}
          </IconButton>
          <IconButton title={t('reader.notesAndHighlights')} onClick={() => setPanel((p) => (p ? null : 'notes'))} active={panel === 'notes'}>
            <NotebookPen size={20} />
          </IconButton>
          <span ref={viewBtn}>
            <IconButton title={t('reader.view')} onClick={() => setMenu(menu === 'view' ? null : 'view')} active={menu === 'view'}>
              {mode === 'book' ? <BookOpen size={20} /> : <Scroll size={20} />}
            </IconButton>
          </span>
          <span ref={menuBtn}>
            <IconButton title={t('common.more')} onClick={() => setMenu(menu === 'more' ? null : 'more')} active={menu === 'more'}>
              <MoreVertical size={20} />
            </IconButton>
          </span>
          {/* how far through the book: a thin line along the bottom edge of the bar */}
          <div className="pointer-events-none absolute inset-x-0 -bottom-px h-[3px] bg-transparent">
            <div data-testid="read-progress" className="h-full rounded-r-full bg-accent transition-[width] duration-500" style={{ width: `${Math.round((progressPct || 0) * 100)}%` }} />
          </div>
        </header>
      )}

      <div className="relative min-h-0 flex-1">
        {ready && !asking ? (
          <ReaderCanvas
            key={`${doc.id}`}
            ref={canvasRef}
            docId={doc.id}
            title={doc.title}
            pdf={pdf}
            pages={pages}
            annotations={annotations}
            mode={mode}
            paper={paper}
            initialPosition={startPos}
            onSavePage={onSavePage}
            onPosition={onPosition}
            onPageChange={onPageChange}
            onMarksChange={() => setMarksVersion((v) => v + 1)}
            chrome={chrome}
            onToggleChrome={() => setChrome((c) => !c)}
          />
        ) : !asking ? (
          <Centered>
            <Spinner />
            <p className="text-sm text-neutral-500">{t('reader.opening')}</p>
          </Centered>
        ) : null}

        {asking && (
          <ReadingStyleDialog
            doc={doc}
            onBack={() => navigate('/')}
            onChoose={(choice, remember) => {
              setSessionMode(choice);
              if (remember) updatePrefs({ readMode: choice });
            }}
          />
        )}

        {panel === 'notes' && (
          <aside className="absolute inset-y-0 right-0 z-[6] flex w-full max-w-sm flex-col rounded-l-3xl border-l border-neutral-200/70 bg-surface shadow-float dark:border-neutral-800 dark:bg-neutral-900">
            <div className="flex items-center justify-between px-5 pb-2 pt-4">
              <h2 className="font-serif text-xl font-semibold">{t('reader.notesAndHighlights')}</h2>
              <IconButton title={t('common.close')} onClick={() => setPanel(null)}>
                <X size={18} />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
              {bookmarks.length > 0 && (
                <section className="mb-4">
                  <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">{t('reader.bookmarks')}</h3>
                  {bookmarks.map((b) => {
                    const i = pages.findIndex((p) => p.key === b.page_key);
                    return (
                      <button key={b.id} className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => openBookmark(b)}>
                        <Bookmark size={16} className="shrink-0 fill-accent/20 text-accent" />
                        <span className="min-w-0 flex-1 truncate text-sm">{i >= 0 ? t('reader.pageN', { n: i + 1 }) : b.label}</span>
                      </button>
                    );
                  })}
                </section>
              )}
              <section>
                <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">{t('reader.highlights')}</h3>
                {marksList.length === 0 && (
                  <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-neutral-400">
                    <Quote size={28} />
                    <p className="text-sm">{t('reader.noHighlights')}</p>
                  </div>
                )}
                {marksList.map(({ pageKey, pageIndex, mark }) => (
                  <div key={mark.id} className="group mb-1.5 rounded-2xl border-l-4 bg-neutral-50 px-3 py-2.5 hover:bg-neutral-100 dark:bg-neutral-800/60 dark:hover:bg-neutral-800" style={{ borderLeftColor: mark.color }}>
                    <button
                      className="flex w-full items-start text-left"
                      onClick={() => {
                        canvasRef.current?.revealMark(pageKey, mark);
                        if (window.innerWidth < 640) setPanel(null);
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-3 font-serif text-[15px] leading-snug">{mark.text || t('reader.freehand')}</span>
                        {mark.note && <span className="mt-1.5 block rounded-xl bg-accent-soft px-2.5 py-1.5 text-xs text-accent-dark dark:bg-accent/20 dark:text-accent-ring">{mark.note}</span>}
                        <span className="mt-1 block text-xs text-neutral-400">{t('reader.pageN', { n: pageIndex + 1 })}</span>
                      </span>
                    </button>
                    <button title={t('common.delete')} className="mt-1 hidden text-xs text-red-500 group-hover:inline" onClick={() => canvasRef.current?.removeMark(pageKey, mark.id)}>
                      {t('common.delete')}
                    </button>
                  </div>
                ))}
              </section>
            </div>
          </aside>
        )}
      </div>

      <Popover anchorRef={viewBtn} open={menu === 'view'} onClose={() => setMenu(null)} align="end" className="w-72 p-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">{t('reader.readingMode')}</div>
        <Choice
          options={[
            ['scroll', t('reader.modeScroll'), Scroll],
            ['book', t('reader.modeBook'), BookOpen],
          ]}
          value={mode}
          onChange={(v) => setSessionMode(v)}
        />
        <p className="mt-1.5 text-xs text-neutral-400">{t('reader.modeHint')}</p>
        <div className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">{t('reader.paper')}</div>
        <Choice
          options={[
            ['sepia', t('reader.paperSepia')],
            ['white', t('reader.paperWhite')],
            ['dark', t('reader.paperDark')],
            ['auto', t('reader.paperAuto')],
          ]}
          value={doc.settings?.paper || paperMode}
          onChange={(v) => setDocSetting({ paper: v })}
          cols={2}
        />
        <p className="mt-1.5 text-xs text-neutral-400">{t('reader.paperHint')}</p>
        {mode === 'book' && (
          <>
            <div className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">{t('reader.pageTurn')}</div>
            <Choice
              options={[
                ['swipe', t('reader.turnSwipe')],
                ['tap', t('reader.turnTap')],
                ['both', t('reader.turnBoth')],
              ]}
              value={useSettings.getState().pageTurn}
              onChange={(v) => updatePrefs({ pageTurn: v })}
              cols={3}
            />
          </>
        )}
      </Popover>

      <Popover anchorRef={menuBtn} open={menu === 'more'} onClose={() => setMenu(null)} align="end" className="w-64">
        <MenuItem icon={FilePlus2} onClick={() => setMenu('note')}>
          {t('reader.addNotePage')}
        </MenuItem>
        {isNotePage && (
          <MenuItem icon={Trash2} danger onClick={deleteNotePage}>
            {t('reader.deleteNotePage')}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem
          icon={Share2}
          onClick={() => {
            setMenu(null);
            setDialog(doc.sync === 'cloud' ? 'share' : 'sync-to-share');
          }}
        >
          {t('share.share')}
        </MenuItem>
        <MenuItem
          icon={FileDown}
          onClick={() => {
            setMenu(null);
            canvasRef.current?.flush();
            setDialog('export');
          }}
        >
          {t('export.title')}
        </MenuItem>
        <MenuItem
          icon={doc.sync === 'cloud' ? HardDrive : Cloud}
          onClick={() => {
            setMenu(null);
            setDialog('sync');
          }}
        >
          {doc.sync === 'cloud' ? t('library.stopSync') : t('library.startSync')}
        </MenuItem>
        {doc.sync === 'cloud' && (
          <MenuItem
            icon={Download}
            onClick={() => {
              setMenu(null);
              cacheOffline(doc.id).then(() => toast(t('library.downloaded'))).catch(() => toast(t('library.downloadFailed')));
            }}
          >
            {t('library.downloadOffline')}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon={SlidersHorizontal} onClick={() => setMenu('view')}>
          {t('reader.view')}
        </MenuItem>
      </Popover>

      <Popover anchorRef={menuBtn} open={menu === 'note'} onClose={() => setMenu(null)} align="end" className="w-64 p-4">
        <div className="mb-3 font-serif text-base font-semibold">{t('reader.addNotePageStyle')}</div>
        <div className="grid grid-cols-2 gap-2">
          {NOTE_STYLES.map((s) => (
            <button key={s} type="button" onClick={() => insertNotePage(s)} className="rounded-xl border border-neutral-200 bg-white px-2 py-2.5 text-sm hover:border-accent hover:bg-accent-soft dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-accent/20">
              {t(`canvas.${s}`)}
            </button>
          ))}
        </div>
      </Popover>

      {dialog === 'share' && <ShareDialog doc={doc} onClose={() => setDialog(null)} />}
      {dialog === 'export' && <ExportDialog doc={doc} pdf={pdf} pages={pages} onClose={() => setDialog(null)} />}
      {(dialog === 'sync' || dialog === 'sync-to-share') && (
        <SyncModeDialog
          doc={doc}
          onClose={() => setDialog(null)}
          onDone={(mode2) => {
            if (dialog === 'sync-to-share' && mode2 === 'cloud') setDialog('share');
            else setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function IconButton({ children, title, onClick, active }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition ${
        active ? 'bg-accent-soft text-accent-dark dark:bg-accent/25 dark:text-accent-ring' : 'text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-700/60'
      }`}
    >
      {children}
    </button>
  );
}

function PrimaryButton({ children, onClick }) {
  return (
    <button type="button" onClick={onClick} className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white shadow-soft hover:bg-accent-dark">
      {children}
    </button>
  );
}

function Choice({ options, value, onChange, cols }) {
  const n = cols || options.length;
  return (
    <div className="grid gap-1.5 rounded-2xl bg-neutral-100 p-1 dark:bg-neutral-900/60" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
      {options.map(([key, label, Icon]) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={`flex items-center justify-center gap-1.5 rounded-xl px-2 py-1.5 text-sm transition ${
            value === key ? 'bg-surface font-medium text-accent-dark shadow-soft dark:bg-neutral-700 dark:text-accent-ring' : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-300'
          }`}
        >
          {Icon && <Icon size={15} />}
          {label}
        </button>
      ))}
    </div>
  );
}

function Centered({ children }) {
  return <div className="flex h-full flex-col items-center justify-center gap-4 p-6">{children}</div>;
}

function Spinner() {
  return <div className="h-9 w-9 animate-spin rounded-full border-[3px] border-neutral-200 border-t-accent dark:border-neutral-700" />;
}
