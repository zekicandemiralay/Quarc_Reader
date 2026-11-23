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
  List,
  MoreVertical,
  Share2,
  FilePlus2,
  Trash2,
  Cloud,
  HardDrive,
  Download,
  Palette,
  X,
  FileDown,
  CloudOff,
} from 'lucide-react';
import { db } from '../../lib/db';
import { on } from '../../lib/events';
import { openPdf } from '../../lib/pdf';
import { pdfSource, loadAnnotations, savePageAnnotations, updateDoc, saveProgress, markOpened, cacheOffline } from '../../lib/library';
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

const PROGRESS_DELAY_MS = 2500;

export default function Reader() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const isDark = useSettings((s) => s.isDark);
  const paperMode = useSettings((s) => s.paperMode);
  const readMode = useSettings((s) => s.readMode);
  const autoCache = useSettings((s) => s.autoCache);
  const updatePrefs = useSettings((s) => s.update);
  const syncState = useSyncStatus((s) => s.state);

  const doc = useLiveQuery(async () => (await db.docs.get(id)) ?? null, [id]);
  const [status, setStatus] = useState({ phase: 'loading' }); // loading | ready | error
  const [pdf, setPdf] = useState(null);
  const [annotations, setAnnotations] = useState(null);
  const [startPos, setStartPos] = useState(null);
  const [panel, setPanel] = useState(null); // 'notes' | null
  const [chrome, setChrome] = useState(true);
  const [dialog, setDialog] = useState(null); // 'share' | 'export' | 'sync'
  const [marksVersion, setMarksVersion] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const canvasRef = useRef(null);
  const progressTimer = useRef(null);
  const menuBtn = useRef(null);
  const viewBtn = useRef(null);
  const noteBtn = useRef(null);
  const [menu, setMenu] = useState(null); // 'more' | 'view' | 'note'

  const mode = doc?.settings?.mode || readMode;
  const paper = resolvePaper(doc?.settings?.paper || paperMode, isDark);

  // ----- open the document -----------------------------------------------------------

  const openKey = doc ? `${doc.id}:${doc.file_sha256}:${doc.file_ready}` : null;
  useEffect(() => {
    if (!doc) return undefined;
    let cancelled = false;
    let opened = null;
    setStatus({ phase: 'loading' });
    (async () => {
      const source = await pdfSource(doc);
      if (!source) {
        if (!cancelled) setStatus({ phase: 'error', code: doc.sync === 'cloud' ? (navigator.onLine ? 'not-ready' : 'offline') : 'missing' });
        return;
      }
      try {
        opened = await openPdf(source);
      } catch (err) {
        if (!cancelled) setStatus({ phase: 'error', code: err?.name === 'PasswordException' ? 'password' : navigator.onLine || source.local ? 'invalid' : 'offline' });
        return;
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

  function setDocSetting(patch) {
    updateDoc(id, { settings: { ...(doc.settings || {}), ...patch } });
  }

  if (doc === null) {
    return (
      <Centered>
        <p className="text-neutral-500">{t('reader.notFound')}</p>
        <button className="rounded-lg bg-accent px-4 py-2 text-white" onClick={() => navigate('/')}>
          {t('reader.backToLibrary')}
        </button>
      </Centered>
    );
  }
  if (!doc || (user && doc.owner && doc.owner !== user.id)) return <Centered>{doc ? <p>{t('reader.notYours')}</p> : <Spinner />}</Centered>;

  if (status.phase === 'error') {
    return (
      <Centered>
        <CloudOff size={40} className="text-neutral-400" />
        <p className="max-w-sm text-center text-neutral-600 dark:text-neutral-300">{t(`reader.error.${status.code}`)}</p>
        <div className="flex gap-2">
          <button className="rounded-lg bg-accent px-4 py-2 text-white" onClick={() => navigate('/')}>
            {t('reader.backToLibrary')}
          </button>
          {status.code === 'offline' || status.code === 'not-ready' ? (
            <button className="rounded-lg border border-neutral-300 px-4 py-2 dark:border-neutral-600" onClick={() => setStatus({ phase: 'loading' }) || window.location.reload()}>
              {t('common.retry')}
            </button>
          ) : null}
        </div>
      </Centered>
    );
  }

  const ready = status.phase === 'ready' && pdf && annotations;
  const isNotePage = pages[currentIndex]?.kind === 'note';

  return (
    <div className="flex h-full flex-col bg-neutral-100 dark:bg-neutral-950">
      {chrome && (
        <header className="flex items-center gap-1 border-b border-neutral-200 bg-white/95 px-2 py-1.5 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/95">
          <IconButton title={t('reader.backToLibrary')} onClick={() => navigate('/')}>
            <ArrowLeft size={20} />
          </IconButton>
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate text-sm font-semibold">{doc.title}</h1>
            <p className="flex items-center gap-1 truncate text-xs text-neutral-500">
              {doc.sync === 'cloud' ? <Cloud size={12} /> : <HardDrive size={12} />}
              {doc.sync === 'cloud' ? (syncState === 'offline' ? t('sync.offline') : doc.file_ready ? t('sync.synced') : t('sync.uploading')) : t('sync.localOnly')}
              {doc.author ? ` · ${doc.author}` : ''}
            </p>
          </div>
          <IconButton title={hereBookmark ? t('reader.removeBookmark') : t('reader.addBookmark')} onClick={toggleBookmark} active={!!hereBookmark}>
            {hereBookmark ? <BookmarkCheck size={20} /> : <Bookmark size={20} />}
          </IconButton>
          <IconButton title={t('reader.notesAndHighlights')} onClick={() => setPanel((p) => (p ? null : 'notes'))} active={panel === 'notes'}>
            <List size={20} />
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
        </header>
      )}

      <div className="relative min-h-0 flex-1">
        {ready ? (
          <ReaderCanvas
            key={`${doc.id}`}
            ref={canvasRef}
            docId={doc.id}
            pdf={pdf}
            pages={pages}
            annotations={annotations}
            mode={mode}
            paper={paper}
            initialPosition={startPos}
            onSavePage={onSavePage}
            onPosition={onPosition}
            onPageChange={setCurrentIndex}
            onMarksChange={() => setMarksVersion((v) => v + 1)}
            chrome={chrome}
            onToggleChrome={() => setChrome((c) => !c)}
          />
        ) : (
          <Centered>
            <Spinner />
            <p className="text-sm text-neutral-500">{t('reader.opening')}</p>
          </Centered>
        )}


        {panel === 'notes' && (
          <aside className="absolute inset-y-0 right-0 z-[6] flex w-full max-w-sm flex-col border-l border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900">
            <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <h2 className="font-semibold">{t('reader.notesAndHighlights')}</h2>
              <IconButton title={t('common.close')} onClick={() => setPanel(null)}>
                <X size={18} />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {bookmarks.length > 0 && (
                <section className="mb-3">
                  <h3 className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">{t('reader.bookmarks')}</h3>
                  {bookmarks.map((b) => {
                    const i = pages.findIndex((p) => p.key === b.page_key);
                    return (
                      <button key={b.id} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => openBookmark(b)}>
                        <Bookmark size={16} className="shrink-0 text-accent" />
                        <span className="min-w-0 flex-1 truncate text-sm">{i >= 0 ? t('reader.pageN', { n: i + 1 }) : b.label}</span>
                      </button>
                    );
                  })}
                </section>
              )}
              <section>
                <h3 className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">{t('reader.highlights')}</h3>
                {marksList.length === 0 && <p className="px-2 py-6 text-center text-sm text-neutral-400">{t('reader.noHighlights')}</p>}
                {marksList.map(({ pageKey, pageIndex, mark }) => (
                  <div key={mark.id} className="group rounded-lg px-2 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-800">
                    <button
                      className="flex w-full items-start gap-2 text-left"
                      onClick={() => {
                        canvasRef.current?.revealMark(pageKey, mark);
                        if (window.innerWidth < 640) setPanel(null);
                      }}
                    >
                      <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: mark.color }} />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-3 text-sm">{mark.text || t('reader.freehand')}</span>
                        {mark.note && <span className="mt-1 block rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{mark.note}</span>}
                        <span className="mt-0.5 block text-xs text-neutral-400">{t('reader.pageN', { n: pageIndex + 1 })}</span>
                      </span>
                    </button>
                    <button
                      title={t('common.delete')}
                      className="mt-1 hidden text-xs text-red-500 group-hover:inline"
                      onClick={() => canvasRef.current?.removeMark(pageKey, mark.id)}
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                ))}
              </section>
            </div>
          </aside>
        )}
      </div>

      <Popover anchorRef={viewBtn} open={menu === 'view'} onClose={() => setMenu(null)} align="end" className="w-64 p-3">
        <div className="mb-1.5 text-xs font-medium text-neutral-400">{t('reader.readingMode')}</div>
        <Choice
          options={[
            ['scroll', t('reader.modeScroll'), Scroll],
            ['book', t('reader.modeBook'), BookOpen],
          ]}
          value={mode}
          onChange={(v) => {
            setDocSetting({ mode: v });
            updatePrefs({ readMode: v });
          }}
        />
        <div className="mb-1.5 mt-3 text-xs font-medium text-neutral-400">{t('reader.paper')}</div>
        <Choice
          options={[
            ['auto', t('reader.paperAuto')],
            ['white', t('reader.paperWhite')],
            ['sepia', t('reader.paperSepia')],
            ['dark', t('reader.paperDark')],
          ]}
          value={doc.settings?.paper || paperMode}
          onChange={(v) => {
            setDocSetting({ paper: v });
            updatePrefs({ paperMode: v });
          }}
          cols={2}
        />
        {mode === 'book' && (
          <>
            <div className="mb-1.5 mt-3 text-xs font-medium text-neutral-400">{t('reader.pageTurn')}</div>
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
        <span ref={noteBtn} />
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
          <MenuItem icon={Download} onClick={() => { setMenu(null); cacheOffline(doc.id).then(() => toast(t('library.downloaded'))).catch(() => toast(t('library.downloadFailed'))); }}>
            {t('library.downloadOffline')}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon={Palette} onClick={() => setMenu('view')}>
          {t('reader.view')}
        </MenuItem>
      </Popover>

      <Popover anchorRef={menuBtn} open={menu === 'note'} onClose={() => setMenu(null)} align="end" className="w-60 p-3">
        <div className="mb-2 text-sm font-medium">{t('reader.addNotePageStyle')}</div>
        <div className="grid grid-cols-2 gap-2">
          {NOTE_STYLES.map((s) => (
            <button key={s} type="button" onClick={() => insertNotePage(s)} className="rounded-lg bg-neutral-100 px-2 py-2 text-sm hover:bg-neutral-200 dark:bg-neutral-700 dark:hover:bg-neutral-600">
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
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition ${
        active ? 'bg-accent text-white' : 'text-neutral-600 hover:bg-neutral-200/70 dark:text-neutral-300 dark:hover:bg-neutral-700/70'
      }`}
    >
      {children}
    </button>
  );
}

function Choice({ options, value, onChange, cols }) {
  const n = cols || options.length;
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
      {options.map(([key, label, Icon]) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-sm ${value === key ? 'bg-accent text-white' : 'bg-neutral-100 hover:bg-neutral-200 dark:bg-neutral-700 dark:hover:bg-neutral-600'}`}
        >
          {Icon && <Icon size={15} />}
          {label}
        </button>
      ))}
    </div>
  );
}

function Centered({ children }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 p-6">{children}</div>;
}

function Spinner() {
  return <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-accent" />;
}

