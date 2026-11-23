import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Search, Settings as SettingsIcon, LayoutGrid, List, Cloud, HardDrive, MoreVertical, Star, Trash2, RotateCcw, Share2, Download, CloudOff, Pencil, ArrowUpDown, CheckCircle2, X, ArrowRight, FileUp } from 'lucide-react';
import { db } from '../../lib/db';
import { importPdf, ImportError, trashDoc, restoreDoc, purgeDoc, updateDoc, removeOfflineCopy, cacheOffline } from '../../lib/library';
import { useTransfers } from '../../lib/files';
import { useSyncStatus } from '../../lib/sync';
import { relativeTime } from '../../lib/time';
import useAuthStore from '../../store/authStore';
import useSettings from '../../store/settingsStore';
import Popover, { MenuItem, MenuSeparator } from '../../components/Popover';
import Modal from '../../components/Modal';
import { toast } from '../../components/Toasts';
import ImportDialog from '../../components/ImportDialog';
import SyncModeDialog from '../../components/SyncModeDialog';
import ShareDialog from '../../components/ShareDialog';

const FILTERS = ['all', 'reading', 'favorites', 'local', 'trash'];

// Covers for documents that have no thumbnail yet: a cloth binding in one of a few deep colours,
// picked from the title so a book always looks the same.
const BINDINGS = [
  ['#5b3fa8', '#34206b'],
  ['#9a3b56', '#5e1f35'],
  ['#2f6b5e', '#183e37'],
  ['#a2602c', '#613413'],
  ['#2c5b8f', '#162f50'],
  ['#6b6b2a', '#3d3d12'],
  ['#7a3f8f', '#46204f'],
  ['#8a4a3a', '#4f241a'],
];
function binding(title) {
  let h = 0;
  for (const ch of title || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BINDINGS[h % BINDINGS.length];
}

export default function Library() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const view = useSettings((s) => s.libraryView);
  const sort = useSettings((s) => s.librarySort);
  const syncChoice = useSettings((s) => s.syncChoice);
  const updatePrefs = useSettings((s) => s.update);
  const syncState = useSyncStatus((s) => s.state);
  const pending = useSyncStatus((s) => s.pending);
  const transfers = useTransfers();

  const docs = useLiveQuery(() => (user ? db.docs.where('owner').equals(user.id).toArray() : []), [user?.id]);
  const cachedShas = useLiveQuery(async () => new Set(await db.blobs.toCollection().primaryKeys()), []);

  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(null); // { files } waiting for the local/sync choice
  const [progress, setProgress] = useState(null); // { done, total, name }
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState(null); // { kind: 'sync' | 'share' | 'rename', doc }
  const fileInput = useRef(null);
  const sortBtn = useRef(null);
  const [sortOpen, setSortOpen] = useState(false);

  // ----- adding PDFs --------------------------------------------------------------------

  function pickFiles(fileList) {
    const files = [...fileList].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (!files.length) {
      toast(t('library.onlyPdf'));
      return;
    }
    if (syncChoice === 'ask') setAdding({ files });
    else runImport(files, syncChoice);
  }

  async function runImport(files, mode) {
    let last = null;
    for (let i = 0; i < files.length; i++) {
      setProgress({ done: i, total: files.length, name: files[i].name });
      try {
        const { doc, duplicate } = await importPdf(files[i], { sync: mode, owner: user.id });
        last = doc;
        if (duplicate) toast(t('library.alreadyHave', { title: doc.title }));
      } catch (err) {
        const code = err instanceof ImportError ? err.code : 'invalid';
        toast(t(`library.importError.${code}`, { name: files[i].name }), { duration: 7000 });
      }
    }
    setProgress(null);
    if (files.length === 1 && last) navigate(`/read/${last.id}`);
    else if (last) toast(t('library.added', { count: files.length }));
  }

  // ----- the list ---------------------------------------------------------------------------

  const items = useMemo(() => {
    let list = (docs || []).filter((d) => (filter === 'trash' ? d.is_deleted : !d.is_deleted));
    if (filter === 'reading') list = list.filter((d) => d.progress && d.progress.pct > 0 && d.progress.pct < 0.98);
    if (filter === 'favorites') list = list.filter((d) => d.is_favorite);
    if (filter === 'local') list = list.filter((d) => d.sync === 'local');
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((d) => `${d.title} ${d.author || ''}`.toLowerCase().includes(q));
    const lastRead = (d) => d.progress_at || d.opened_at || d.created_at || '';
    const cmp =
      sort === 'title'
        ? (a, b) => a.title.localeCompare(b.title)
        : sort === 'added'
          ? (a, b) => (b.created_at || '').localeCompare(a.created_at || '')
          : (a, b) => lastRead(b).localeCompare(lastRead(a));
    return [...list].sort(cmp);
  }, [docs, filter, query, sort]);

  const trashCount = (docs || []).filter((d) => d.is_deleted).length;

  // The book you were in the middle of: the most recently read one that is neither new nor finished.
  const resume = useMemo(() => {
    const started = (docs || []).filter((d) => !d.is_deleted && d.progress && d.progress.pct > 0 && d.progress.pct < 0.98);
    started.sort((a, b) => (b.progress_at || '').localeCompare(a.progress_at || ''));
    return started[0] || null;
  }, [docs]);
  const showResume = resume && filter === 'all' && !query.trim();

  return (
    <div
      className="flex h-full flex-col bg-neutral-50 bg-[radial-gradient(60rem_30rem_at_85%_-10%,theme(colors.accent.soft),transparent)] dark:bg-neutral-950 dark:bg-[radial-gradient(60rem_30rem_at_85%_-10%,rgb(124_58_237/0.14),transparent)]"
      onDragOver={(e) => {
        if ([...(e.dataTransfer?.types || [])].includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer?.files?.length) pickFiles(e.dataTransfer.files);
      }}
    >
      <header className="glass z-20 flex items-center gap-2 border-b border-neutral-200/70 px-3 py-2.5 dark:border-neutral-800 sm:px-5">
        <img src="/logo.png" alt="" className="h-9 w-9 rounded-xl shadow-soft" />
        <h1 className="hidden font-serif text-xl font-semibold tracking-tight sm:block">Quarc Reader</h1>
        <div className="relative mx-2 max-w-xl flex-1 sm:mx-6">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('library.search')}
            className="w-full rounded-full border border-transparent bg-neutral-100 py-2 pl-10 pr-4 text-sm outline-none transition placeholder:text-neutral-400 focus:border-accent focus:bg-surface focus:shadow-soft dark:bg-neutral-800 dark:focus:bg-neutral-900"
          />
        </div>
        <SyncBadge state={syncState} pending={pending} />
        <span ref={sortBtn}>
          <HeaderButton title={t('library.sort')} onClick={() => setSortOpen(true)}>
            <ArrowUpDown size={18} />
          </HeaderButton>
        </span>
        <HeaderButton title={view === 'grid' ? t('library.listView') : t('library.gridView')} onClick={() => updatePrefs({ libraryView: view === 'grid' ? 'list' : 'grid' })}>
          {view === 'grid' ? <List size={18} /> : <LayoutGrid size={18} />}
        </HeaderButton>
        <HeaderButton title={t('settings.title')} onClick={() => navigate('/settings')}>
          <SettingsIcon size={18} />
        </HeaderButton>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="ml-1 flex h-10 items-center gap-1.5 rounded-full bg-accent px-3.5 text-sm font-medium text-white shadow-soft transition hover:bg-accent-dark active:scale-95 sm:px-4"
        >
          <Plus size={18} />
          <span className="hidden sm:inline">{t('library.addPdf')}</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) pickFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-7xl px-4 pb-16 pt-5 sm:px-6">
          {showResume && <Resume doc={resume} cached={cachedShas?.has(resume.file_sha256)} onOpen={() => open(resume)} />}

          <nav className="-mx-1 mb-5 flex gap-1.5 overflow-x-auto px-1 py-1 [scrollbar-width:none]">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
                  filter === f ? 'bg-neutral-900 text-white shadow-soft dark:bg-neutral-100 dark:text-neutral-900' : 'text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800'
                }`}
              >
                {t(`library.filter.${f}`)}
                {f === 'trash' && trashCount > 0 ? ` (${trashCount})` : ''}
              </button>
            ))}
            {docs !== undefined && items.length > 0 && <span className="ml-auto hidden shrink-0 self-center pl-4 text-xs text-neutral-400 sm:block">{t('library.count', { count: items.length })}</span>}
          </nav>

          {docs === undefined ? null : items.length === 0 ? (
            <Empty filter={filter} hasAny={(docs || []).some((d) => !d.is_deleted)} onAdd={() => fileInput.current?.click()} />
          ) : view === 'grid' ? (
            <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {items.map((d) => (
                <DocCard key={d.id} doc={d} layout="grid" cached={cachedShas?.has(d.file_sha256)} transfer={transfers[d.id]} onOpen={() => open(d)} onAction={(kind) => act(kind, d)} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {items.map((d) => (
                <DocCard key={d.id} doc={d} layout="list" cached={cachedShas?.has(d.file_sha256)} transfer={transfers[d.id]} onOpen={() => open(d)} onAction={(kind) => act(kind, d)} />
              ))}
            </div>
          )}
        </div>
      </main>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-accent/15 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-4xl border-2 border-dashed border-accent bg-surface/95 px-12 py-10 text-lg font-medium shadow-float dark:bg-neutral-900/95">
            <FileUp size={36} className="text-accent" />
            {t('library.dropHere')}
          </div>
        </div>
      )}

      {progress && (
        <div className="fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
          <div className="flex items-center gap-3 rounded-2xl bg-neutral-900 px-4 py-3 text-sm text-white shadow-float dark:bg-neutral-100 dark:text-neutral-900">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white dark:border-neutral-900/30 dark:border-t-neutral-900" />
            <span className="max-w-[60vw] truncate">{t('library.adding', { name: progress.name, n: progress.done + 1, total: progress.total })}</span>
          </div>
        </div>
      )}

      <Popover anchorRef={sortBtn} open={sortOpen} onClose={() => setSortOpen(false)} align="end" className="w-52">
        {['recent', 'title', 'added'].map((s) => (
          <MenuItem
            key={s}
            icon={sort === s ? CheckCircle2 : undefined}
            onClick={() => {
              updatePrefs({ librarySort: s });
              setSortOpen(false);
            }}
          >
            {t(`library.sortBy.${s}`)}
          </MenuItem>
        ))}
      </Popover>

      {adding && (
        <ImportDialog
          count={adding.files.length}
          onCancel={() => setAdding(null)}
          onChoose={(mode, remember) => {
            const files = adding.files;
            setAdding(null);
            if (remember) updatePrefs({ syncChoice: mode });
            runImport(files, mode);
          }}
        />
      )}
      {dialog?.kind === 'sync' && <SyncModeDialog doc={dialog.doc} onClose={() => setDialog(null)} onDone={() => setDialog(null)} />}
      {dialog?.kind === 'sync-to-share' && (
        <SyncModeDialog doc={dialog.doc} onClose={() => setDialog(null)} onDone={(m) => setDialog(m === 'cloud' ? { kind: 'share', doc: dialog.doc } : null)} />
      )}
      {dialog?.kind === 'share' && <ShareDialog doc={dialog.doc} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rename' && <RenameDialog doc={dialog.doc} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'purge' && (
        <Modal open onClose={() => setDialog(null)} title={t('library.deleteForever')}>
          <p className="mb-5 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
            {dialog.doc.sync === 'cloud' ? t('library.deleteForeverCloud', { title: dialog.doc.title }) : t('library.deleteForeverLocal', { title: dialog.doc.title })}
          </p>
          <div className="flex justify-end gap-2">
            <button className="rounded-xl px-4 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700" onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </button>
            <button
              className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              onClick={async () => {
                await purgeDoc(dialog.doc.id);
                setDialog(null);
              }}
            >
              {t('common.delete')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );

  function open(d) {
    if (d.is_deleted) return;
    navigate(`/read/${d.id}`);
  }

  async function act(kind, d) {
    switch (kind) {
      case 'favorite':
        await updateDoc(d.id, { is_favorite: d.is_favorite ? 0 : 1 });
        break;
      case 'trash':
        await trashDoc(d.id);
        toast(t('library.movedToTrash', { title: d.title }), { action: { label: t('common.undo'), onClick: () => restoreDoc(d.id) } });
        break;
      case 'restore':
        await restoreDoc(d.id);
        break;
      case 'purge':
        setDialog({ kind: 'purge', doc: d });
        break;
      case 'sync':
        setDialog({ kind: 'sync', doc: d });
        break;
      case 'share':
        setDialog({ kind: d.sync === 'cloud' ? 'share' : 'sync-to-share', doc: d });
        break;
      case 'rename':
        setDialog({ kind: 'rename', doc: d });
        break;
      case 'download':
        try {
          await cacheOffline(d.id);
          toast(t('library.downloaded'));
        } catch {
          toast(t('library.downloadFailed'));
        }
        break;
      case 'free':
        await removeOfflineCopy(d.id);
        break;
      default:
    }
  }
}

function HeaderButton({ children, title, onClick }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-600 transition hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      {children}
    </button>
  );
}

function SyncBadge({ state, pending }) {
  const { t } = useTranslation();
  const label = state === 'offline' ? t('sync.offline') : state === 'syncing' ? t('sync.syncing') : state === 'error' ? t('sync.error') : pending ? t('sync.pending', { count: pending }) : t('sync.synced');
  const color = state === 'offline' || state === 'error' ? 'text-amber-600' : 'text-neutral-400';
  return (
    <span className={`hidden items-center gap-1 text-xs md:flex ${color}`} title={label}>
      {state === 'offline' ? <CloudOff size={14} /> : <Cloud size={14} className={state === 'syncing' ? 'animate-pulse' : ''} />}
      {label}
    </span>
  );
}

// A little shelf of books, for an empty library.
function ShelfArt() {
  return (
    <svg viewBox="0 0 220 120" className="h-28 w-52" aria-hidden="true">
      <rect x="10" y="108" width="200" height="6" rx="3" className="fill-neutral-300 dark:fill-neutral-700" />
      <rect x="28" y="38" width="26" height="70" rx="3" fill="#5b3fa8" />
      <rect x="34" y="50" width="14" height="3" rx="1.5" fill="#fff" opacity=".5" />
      <rect x="58" y="22" width="30" height="86" rx="3" fill="#9a3b56" />
      <rect x="64" y="36" width="18" height="3" rx="1.5" fill="#fff" opacity=".5" />
      <rect x="92" y="44" width="24" height="64" rx="3" fill="#2f6b5e" />
      <rect x="97" y="56" width="14" height="3" rx="1.5" fill="#fff" opacity=".5" />
      <g transform="rotate(14 160 108)">
        <rect x="132" y="30" width="28" height="78" rx="3" fill="#a2602c" />
        <rect x="138" y="44" width="16" height="3" rx="1.5" fill="#fff" opacity=".5" />
      </g>
      <rect x="170" y="52" width="22" height="56" rx="3" fill="#2c5b8f" />
    </svg>
  );
}

function Empty({ filter, hasAny, onAdd }) {
  const { t } = useTranslation();
  if (filter !== 'all' && hasAny) return <p className="py-20 text-center font-serif text-lg text-neutral-400">{t(`library.empty.${filter}`)}</p>;
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-5 rounded-4xl border-2 border-dashed border-neutral-300 px-6 py-14 text-center dark:border-neutral-700">
      <ShelfArt />
      <p className="font-serif text-2xl font-semibold">{t('library.emptyTitle')}</p>
      <p className="max-w-sm text-neutral-500">{t('library.empty.all')}</p>
      <button className="flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 font-medium text-white shadow-soft transition hover:bg-accent-dark active:scale-95" onClick={onAdd}>
        <Plus size={18} /> {t('library.addPdf')}
      </button>
    </div>
  );
}

// The cover: the first page when we have it, otherwise a cloth binding with the title on it.
function Cover({ doc, cached, className = '' }) {
  const { t } = useTranslation();
  const cloud = doc.sync === 'cloud';
  const pct = doc.progress?.pct || 0;
  const [a, b] = binding(doc.title);
  return (
    <div className={`book-cover relative overflow-hidden rounded-l-[4px] rounded-r-[10px] bg-white shadow-cover dark:bg-neutral-800 ${className}`}>
      {doc.thumb ? (
        <img src={doc.thumb} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <div className="flex h-full w-full flex-col justify-between p-[12%] text-[#fbf3e2]" style={{ background: `linear-gradient(150deg, ${a}, ${b})` }}>
          <div className="h-px w-8 bg-[#fbf3e2]/50" />
          <p className="line-clamp-4 font-serif text-[clamp(0.7rem,2.6vw,1rem)] font-semibold leading-tight">{doc.title}</p>
          <p className="truncate text-[0.6rem] uppercase tracking-widest opacity-70">{doc.author || 'PDF'}</p>
        </div>
      )}
      {cloud && !cached && doc.file_ready && (
        <span className="absolute bottom-2 left-2 rounded-full bg-black/55 p-1 text-white backdrop-blur" title={t('library.notOnDevice')}>
          <CloudOff size={11} />
        </span>
      )}
      {pct > 0 && (
        <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/20">
          <div className="h-full bg-accent" style={{ width: `${Math.round(pct * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

// "Continue reading": the one book you were in the middle of, big, at the top.
function Resume({ doc, cached, onOpen }) {
  const { t, i18n } = useTranslation();
  const pct = Math.round((doc.progress?.pct || 0) * 100);
  const page = Math.min((doc.progress?.page ?? 0) + 1, doc.page_count || 1);
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="resume-card"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group relative mb-8 flex items-center gap-5 overflow-hidden rounded-4xl border border-neutral-200/70 bg-gradient-to-br from-sepia-100 via-surface to-surface p-4 shadow-soft transition hover:shadow-float dark:border-neutral-800 dark:from-neutral-900 dark:via-neutral-900 dark:to-neutral-900 sm:gap-8 sm:p-6"
    >
      <Cover doc={doc} cached={cached} className="aspect-[3/4] w-24 shrink-0 transition duration-300 group-hover:-translate-y-0.5 group-hover:shadow-cover-hover sm:w-36" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{t('library.continue')}</p>
        <h2 className="mt-1.5 line-clamp-2 font-serif text-xl font-semibold leading-tight sm:text-3xl">{doc.title}</h2>
        <p className="mt-1 truncate text-sm text-neutral-500">{doc.author || t('library.unknownAuthor')}</p>
        <div className="mt-4 flex items-center gap-3">
          <div className="h-1.5 max-w-xs flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs tabular-nums text-neutral-500">{pct}%</span>
        </div>
        <p className="mt-1.5 text-xs text-neutral-400">
          {t('library.pageOf', { n: page, total: doc.page_count || 1 })}
          {doc.progress_at ? ` · ${relativeTime(doc.progress_at, i18n.language)}` : ''}
        </p>
        <span className="mt-4 hidden items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-medium text-white shadow-soft transition group-hover:bg-accent-dark sm:inline-flex">
          {t('library.resume')} <ArrowRight size={16} />
        </span>
      </div>
    </div>
  );
}

function DocCard({ doc, layout, cached, transfer, onOpen, onAction }) {
  const { t, i18n } = useTranslation();
  const menuBtn = useRef(null);
  const [menu, setMenu] = useState(false);
  const pct = doc.progress?.pct || 0;
  const cloud = doc.sync === 'cloud';
  const uploading = cloud && !doc.file_ready;

  const badge = (
    <span
      className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${cloud ? 'bg-accent-soft text-accent-dark dark:bg-accent/20 dark:text-accent-ring' : 'bg-neutral-200/80 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300'}`}
      title={cloud ? t('library.syncedHint') : t('library.localHint')}
    >
      {cloud ? <Cloud size={11} /> : <HardDrive size={11} />}
      {transfer?.state === 'uploading'
        ? `${Math.round((transfer.pct || 0) * 100)}%`
        : transfer?.state === 'downloading'
          ? `↓ ${Math.round((transfer.pct || 0) * 100)}%`
          : transfer?.state === 'error'
            ? t('sync.error')
            : uploading
              ? t('sync.uploading')
              : cloud
                ? t('library.synced')
                : t('library.localOnly')}
    </span>
  );

  // The menu is a portal, but React events still bubble through it to this card's
  // own onClick (which opens the document) — so every click in here stops at this wrapper.
  const menuEl = (
    <div onClick={(e) => e.stopPropagation()}>
      <span ref={menuBtn}>
        <button
          type="button"
          aria-label={t('common.more')}
          onClick={(e) => {
            e.stopPropagation();
            setMenu(true);
          }}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-surface/90 text-neutral-600 shadow-soft backdrop-blur transition hover:bg-surface dark:bg-neutral-800/90 dark:text-neutral-200"
        >
          <MoreVertical size={16} />
        </button>
      </span>
      <Popover anchorRef={menuBtn} open={menu} onClose={() => setMenu(false)} align="end" className="w-60">
        {doc.is_deleted ? (
          <>
            <MenuItem icon={RotateCcw} onClick={() => { setMenu(false); onAction('restore'); }}>{t('library.restore')}</MenuItem>
            <MenuItem icon={Trash2} danger onClick={() => { setMenu(false); onAction('purge'); }}>{t('library.deleteForever')}</MenuItem>
          </>
        ) : (
          <>
            <MenuItem icon={Star} onClick={() => { setMenu(false); onAction('favorite'); }}>{doc.is_favorite ? t('library.unfavorite') : t('library.favorite')}</MenuItem>
            <MenuItem icon={Pencil} onClick={() => { setMenu(false); onAction('rename'); }}>{t('library.rename')}</MenuItem>
            <MenuSeparator />
            <MenuItem icon={cloud ? HardDrive : Cloud} onClick={() => { setMenu(false); onAction('sync'); }}>{cloud ? t('library.stopSync') : t('library.startSync')}</MenuItem>
            <MenuItem icon={Share2} onClick={() => { setMenu(false); onAction('share'); }}>{t('share.share')}</MenuItem>
            {cloud && !cached && doc.file_ready && <MenuItem icon={Download} onClick={() => { setMenu(false); onAction('download'); }}>{t('library.downloadOffline')}</MenuItem>}
            {cloud && cached && doc.file_ready && <MenuItem icon={X} onClick={() => { setMenu(false); onAction('free'); }}>{t('library.removeDownload')}</MenuItem>}
            <MenuSeparator />
            <MenuItem icon={Trash2} danger onClick={() => { setMenu(false); onAction('trash'); }}>{t('library.moveToTrash')}</MenuItem>
          </>
        )}
      </Popover>
    </div>
  );

  if (layout === 'list') {
    return (
      <div className="group flex cursor-pointer items-center gap-4 rounded-2xl border border-neutral-200/70 bg-surface p-2.5 pr-3 shadow-soft transition hover:border-accent-ring hover:shadow-float dark:border-neutral-800 dark:bg-neutral-900" onClick={onOpen}>
        <Cover doc={doc} cached={cached} className="h-24 w-[4.5rem] shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-serif text-base font-semibold">{doc.title}</p>
          <p className="truncate text-sm text-neutral-500">{doc.author || t('library.unknownAuthor')}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-400">
            {badge}
            <span>{doc.page_count} {t('library.pages')}</span>
            {pct > 0 && <span>{Math.round(pct * 100)}%</span>}
            {doc.progress_at && <span>{relativeTime(doc.progress_at, i18n.language)}</span>}
          </div>
        </div>
        {doc.is_favorite ? <Star size={16} className="shrink-0 fill-amber-400 text-amber-400" /> : null}
        {menuEl}
      </div>
    );
  }

  return (
    <div className="group relative cursor-pointer" onClick={onOpen}>
      <Cover doc={doc} cached={cached} className="aspect-[3/4] w-full transition duration-300 group-hover:-translate-y-1 group-hover:shadow-cover-hover" />
      <div className="absolute right-2 top-2 opacity-100 sm:opacity-0 sm:transition sm:group-hover:opacity-100">{menuEl}</div>
      {doc.is_favorite ? <Star size={17} className="pointer-events-none absolute left-2 top-2 fill-amber-400 text-amber-400 drop-shadow" /> : null}
      <p className="mt-3 line-clamp-2 font-serif text-[15px] font-semibold leading-snug">{doc.title}</p>
      <p className="mt-0.5 truncate text-xs text-neutral-500">{doc.author || t('library.unknownAuthor')}</p>
      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-neutral-500">
        {badge}
        {pct > 0 && <span className="tabular-nums">{Math.round(pct * 100)}%</span>}
      </div>
    </div>
  );
}

function RenameDialog({ doc, onClose }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(doc.title);
  const [author, setAuthor] = useState(doc.author || '');
  const field = 'rounded-xl border border-neutral-300 bg-transparent px-3.5 py-2.5 outline-none focus:border-accent dark:border-neutral-600';
  return (
    <Modal open onClose={onClose} title={t('library.rename')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          await updateDoc(doc.id, { title: title.trim() || doc.title, author: author.trim() || null });
          onClose();
        }}
      >
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('library.titleField')} className={field} />
        <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder={t('library.authorField')} className={field} />
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" className="rounded-xl px-4 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-dark">
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
