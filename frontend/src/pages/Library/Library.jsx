import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Search, Settings as SettingsIcon, LayoutGrid, List, Cloud, HardDrive, MoreVertical, Star, Trash2, RotateCcw, FileText, Share2, Download, CloudOff, Pencil, ArrowUpDown, CheckCircle2, X } from 'lucide-react';
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

  return (
    <div
      className="flex h-full flex-col bg-neutral-50 dark:bg-neutral-950"
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
      <header className="flex items-center gap-2 border-b border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <img src="/logo.png" alt="" className="h-8 w-8 rounded-lg" />
        <h1 className="hidden text-lg font-semibold sm:block">Quarc Reader</h1>
        <div className="relative mx-2 flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('library.search')}
            className="w-full rounded-lg border border-neutral-200 bg-neutral-50 py-1.5 pl-9 pr-3 text-sm outline-none focus:border-accent dark:border-neutral-700 dark:bg-neutral-800"
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
          className="flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-white hover:bg-accent-dark"
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

      <nav className="flex gap-1 overflow-x-auto px-3 pt-2 [scrollbar-width:none]">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`shrink-0 rounded-full px-3 py-1 text-sm ${filter === f ? 'bg-accent text-white' : 'bg-neutral-200/70 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300'}`}
          >
            {t(`library.filter.${f}`)}
            {f === 'trash' && trashCount > 0 ? ` (${trashCount})` : ''}
          </button>
        ))}
      </nav>

      <main className="min-h-0 flex-1 overflow-y-auto p-3">
        {docs === undefined ? null : items.length === 0 ? (
          <Empty filter={filter} hasAny={(docs || []).some((d) => !d.is_deleted)} onAdd={() => fileInput.current?.click()} />
        ) : view === 'grid' ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {items.map((d) => (
              <DocCard key={d.id} doc={d} layout="grid" cached={cachedShas?.has(d.file_sha256)} transfer={transfers[d.id]} onOpen={() => open(d)} onAction={(kind) => act(kind, d)} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((d) => (
              <DocCard key={d.id} doc={d} layout="list" cached={cachedShas?.has(d.file_sha256)} transfer={transfers[d.id]} onOpen={() => open(d)} onAction={(kind) => act(kind, d)} />
            ))}
          </div>
        )}
      </main>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-accent/10 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-white/90 px-8 py-6 text-lg font-medium dark:bg-neutral-900/90">{t('library.dropHere')}</div>
        </div>
      )}

      {progress && (
        <div className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
          <div className="flex items-center gap-3 rounded-xl bg-neutral-900 px-4 py-3 text-sm text-white shadow-xl">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            <span className="max-w-[60vw] truncate">{t('library.adding', { name: progress.name, n: progress.done + 1, total: progress.total })}</span>
          </div>
        </div>
      )}

      <Popover anchorRef={sortBtn} open={sortOpen} onClose={() => setSortOpen(false)} align="end" className="w-48">
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
          <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-300">
            {dialog.doc.sync === 'cloud' ? t('library.deleteForeverCloud', { title: dialog.doc.title }) : t('library.deleteForeverLocal', { title: dialog.doc.title })}
          </p>
          <div className="flex justify-end gap-2">
            <button className="rounded-lg px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700" onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </button>
            <button
              className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700"
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
    <button type="button" title={title} aria-label={title} onClick={onClick} className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
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

function Empty({ filter, hasAny, onAdd }) {
  const { t } = useTranslation();
  if (filter !== 'all' && hasAny) return <p className="py-20 text-center text-neutral-400">{t(`library.empty.${filter}`)}</p>;
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <FileText size={48} className="text-neutral-300 dark:text-neutral-600" />
      <p className="max-w-sm text-neutral-500">{t('library.empty.all')}</p>
      <button className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 font-medium text-white hover:bg-accent-dark" onClick={onAdd}>
        <Plus size={18} /> {t('library.addPdf')}
      </button>
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
      className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${cloud ? 'bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300' : 'bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300'}`}
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
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-neutral-600 shadow hover:bg-white dark:bg-neutral-800/90 dark:text-neutral-200"
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

  const cover = (
    <div className={`relative overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-800 dark:ring-neutral-700 ${layout === 'grid' ? 'aspect-[3/4] w-full' : 'h-24 w-[4.5rem] shrink-0'}`}>
      {doc.thumb ? <img src={doc.thumb} alt="" className="h-full w-full object-cover" draggable={false} /> : <div className="flex h-full w-full items-center justify-center text-neutral-300"><FileText size={32} /></div>}
      {cloud && !cached && doc.file_ready && (
        <span className="absolute bottom-1 left-1 rounded-full bg-black/50 p-1 text-white" title={t('library.notOnDevice')}>
          <CloudOff size={11} />
        </span>
      )}
      {pct > 0 && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-black/10">
          <div className="h-full bg-accent" style={{ width: `${Math.round(pct * 100)}%` }} />
        </div>
      )}
    </div>
  );

  if (layout === 'list') {
    return (
      <div className="flex cursor-pointer items-center gap-3 rounded-xl bg-white p-2 shadow-sm ring-1 ring-neutral-200 hover:ring-accent dark:bg-neutral-900 dark:ring-neutral-800" onClick={onOpen}>
        {cover}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{doc.title}</p>
          <p className="truncate text-sm text-neutral-500">{doc.author || t('library.unknownAuthor')}</p>
          <div className="mt-1 flex items-center gap-2 text-xs text-neutral-400">
            {badge}
            <span>{doc.page_count} {t('library.pages')}</span>
            {pct > 0 && <span>{Math.round(pct * 100)}%</span>}
            {doc.progress_at && <span>{relativeTime(doc.progress_at, i18n.language)}</span>}
          </div>
        </div>
        {menuEl}
      </div>
    );
  }

  return (
    <div className="group relative cursor-pointer" onClick={onOpen}>
      {cover}
      <div className="absolute right-1.5 top-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100">{menuEl}</div>
      {doc.is_favorite ? <Star size={16} className="absolute left-2 top-2 fill-amber-400 text-amber-400 drop-shadow" /> : null}
      <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug">{doc.title}</p>
      <div className="mt-1 flex items-center gap-1.5 text-xs text-neutral-500">
        {badge}
        {pct > 0 && <span>{Math.round(pct * 100)}%</span>}
      </div>
    </div>
  );
}

function RenameDialog({ doc, onClose }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(doc.title);
  const [author, setAuthor] = useState(doc.author || '');
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
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('library.titleField')} className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 outline-none focus:border-accent dark:border-neutral-600" />
        <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder={t('library.authorField')} className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 outline-none focus:border-accent dark:border-neutral-600" />
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-lg px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-dark">
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
