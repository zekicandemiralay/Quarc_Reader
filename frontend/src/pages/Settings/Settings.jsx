import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, LogOut } from 'lucide-react';
import useAuthStore from '../../store/authStore';
import useSettings from '../../store/settingsStore';
import { db } from '../../lib/db';
import { apiUrl } from '../../lib/apiUrl';
import i18n from '../../i18n';
import { getPlatform, getCurrentVersion, fetchLatestRelease, getDownloadUrl, installUpdate, semverGt } from '../../lib/updateCheck';
import Modal from '../../components/Modal';
import StorePromo from '../../components/StorePromo';
import { toast } from '../../components/Toasts';

function Section({ title, children }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-neutral-400">{title}</h2>
      <div className="divide-y divide-neutral-100 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-neutral-200 dark:divide-neutral-800 dark:bg-neutral-900 dark:ring-neutral-800">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-neutral-500">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-700">
      {options.map(([key, label]) => (
        <button key={key} type="button" onClick={() => onChange(key)} className={`px-3 py-1.5 text-sm ${value === key ? 'bg-accent text-white' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative h-6 w-11 rounded-full transition ${checked ? 'bg-accent' : 'bg-neutral-300 dark:bg-neutral-600'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[1.375rem]' : 'left-0.5'}`} />
    </button>
  );
}

const formatBytes = (n) => {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

export default function Settings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const s = useSettings();
  const platform = getPlatform();

  const [serverBytes, setServerBytes] = useState(null);
  const [version, setVersion] = useState(null);
  const [update, setUpdate] = useState(null); // { version, url } | 'latest' | 'error'
  const [confirmClear, setConfirmClear] = useState(false);
  const deviceBytes = useLiveQuery(async () => {
    let total = 0;
    await db.blobs.each((b) => (total += b.size || 0));
    return total;
  }, []);
  const localOnly = useLiveQuery(() => (user ? db.docs.where('owner').equals(user.id).filter((d) => d.sync === 'local').count() : 0), [user?.id]);

  useEffect(() => {
    fetch(apiUrl('/api/files/usage'), { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setServerBytes(d.bytes))
      .catch(() => {});
    getCurrentVersion(platform).then(setVersion);
  }, [platform]);

  async function checkUpdate() {
    setUpdate(null);
    try {
      const release = await fetchLatestRelease();
      const latest = (release.tag_name || '').replace(/^v/, '');
      if (version && semverGt(latest, version)) setUpdate({ version: latest, url: getDownloadUrl(release, platform) });
      else setUpdate('latest');
    } catch {
      setUpdate('error');
    }
  }

  async function clearDevice() {
    await Promise.all([db.docs.clear(), db.ann.clear(), db.blobs.clear(), db.outbox.clear(), db.meta.clear()]);
    setConfirmClear(false);
    toast(t('settings.cleared'));
    navigate('/');
  }

  return (
    <div className="h-full overflow-y-auto bg-neutral-50 dark:bg-neutral-950">
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-3">
        <header className="mb-4 flex items-center gap-2">
          <button type="button" onClick={() => navigate('/')} className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-neutral-200/70 dark:hover:bg-neutral-800" aria-label={t('common.back')}>
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-lg font-semibold">{t('settings.title')}</h1>
        </header>

        <Section title={t('settings.account')}>
          <Row label={user?.username || '—'} hint={t('settings.sharedLogin')}>
            <button type="button" onClick={async () => { await logout(); navigate('/login'); }} className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
              <LogOut size={15} /> {t('settings.logout')}
            </button>
          </Row>
        </Section>

        <Section title={t('settings.library')}>
          <Row label={t('settings.syncChoice')} hint={t('settings.syncChoiceHint')}>
            <Segmented
              value={s.syncChoice}
              onChange={(v) => s.update({ syncChoice: v })}
              options={[
                ['ask', t('settings.ask')],
                ['local', t('settings.alwaysLocal')],
                ['cloud', t('settings.alwaysSync')],
              ]}
            />
          </Row>
          <Row label={t('settings.autoCache')} hint={t('settings.autoCacheHint')}>
            <Toggle checked={s.autoCache} onChange={(v) => s.update({ autoCache: v })} />
          </Row>
          <Row label={t('settings.storageDevice')} hint={t('settings.storageDeviceHint', { count: localOnly ?? 0 })}>
            <span className="text-sm tabular-nums text-neutral-500">{formatBytes(deviceBytes)}</span>
          </Row>
          <Row label={t('settings.storageServer')}>
            <span className="text-sm tabular-nums text-neutral-500">{formatBytes(serverBytes)}</span>
          </Row>
        </Section>

        <Section title={t('settings.appearance')}>
          <Row label={t('settings.theme')}>
            <Segmented value={s.theme} onChange={(v) => s.update({ theme: v })} options={[['system', t('settings.system')], ['light', t('settings.light')], ['dark', t('settings.dark')]]} />
          </Row>
          <Row label={t('settings.language')}>
            <Segmented
              value={i18n.language?.startsWith('tr') ? 'tr' : 'en'}
              onChange={(v) => {
                localStorage.setItem('language', v);
                i18n.changeLanguage(v);
              }}
              options={[['en', 'English'], ['tr', 'Türkçe']]}
            />
          </Row>
          <Row label={t('reader.paper')}>
            <Segmented value={s.paperMode} onChange={(v) => s.update({ paperMode: v })} options={[['auto', t('reader.paperAuto')], ['white', t('reader.paperWhite')], ['sepia', t('reader.paperSepia')], ['dark', t('reader.paperDark')]]} />
          </Row>
        </Section>

        <Section title={t('settings.reading')}>
          <Row label={t('reader.readingMode')}>
            <Segmented value={s.readMode} onChange={(v) => s.update({ readMode: v })} options={[['scroll', t('reader.modeScroll')], ['book', t('reader.modeBook')]]} />
          </Row>
          <Row label={t('reader.pageTurn')} hint={t('settings.pageTurnHint')}>
            <Segmented value={s.pageTurn} onChange={(v) => s.update({ pageTurn: v })} options={[['swipe', t('reader.turnSwipe')], ['tap', t('reader.turnTap')], ['both', t('reader.turnBoth')]]} />
          </Row>
        </Section>

        <Section title={t('settings.handwriting')}>
          <Row label={t('settings.finger')} hint={t('settings.fingerHint')}>
            <Segmented value={s.fingerMode} onChange={(v) => s.update({ fingerMode: v })} options={[['auto', t('settings.auto')], ['draw', t('canvas.fingerDrawsShort')], ['scroll', t('canvas.fingerScrollsShort')]]} />
          </Row>
          <Row label={t('canvas.shapeSnap')} hint={t('canvas.shapeSnapHint')}>
            <Toggle checked={s.shapeSnap} onChange={(v) => s.update({ shapeSnap: v })} />
          </Row>
          <Row label={t('reader.snapText')} hint={t('reader.snapTextHint')}>
            <Toggle checked={s.snapText} onChange={(v) => s.update({ snapText: v })} />
          </Row>
        </Section>

        <Section title={t('settings.about')}>
          <Row label="Quarc Reader" hint={version ? `${t('settings.version')} ${version}` : t(`settings.platform.${platform}`)}>
            <button type="button" onClick={checkUpdate} className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
              {t('settings.checkUpdate')}
            </button>
          </Row>
          {update && (
            <div className="px-4 py-3 text-sm">
              {update === 'latest' ? (
                t('settings.upToDate')
              ) : update === 'error' ? (
                t('settings.updateError')
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <span>{t('settings.updateAvailable', { version: update.version })}</span>
                  <button type="button" className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white" onClick={() => installUpdate(platform, update.url, update.version)}>
                    {t('settings.install')}
                  </button>
                </div>
              )}
            </div>
          )}
          <StorePromo />
          <Row label={t('settings.clearDevice')} hint={t('settings.clearDeviceHint')}>
            <button type="button" onClick={() => setConfirmClear(true)} className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/40">
              {t('settings.clear')}
            </button>
          </Row>
        </Section>
      </div>

      {confirmClear && (
        <Modal open onClose={() => setConfirmClear(false)} title={t('settings.clearDevice')}>
          <div className="p-4">
            <p className="mb-2 text-sm text-neutral-600 dark:text-neutral-300">{t('settings.clearConfirm')}</p>
            {(localOnly ?? 0) > 0 && <p className="mb-3 rounded-lg bg-red-50 p-2 text-sm font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300">{t('settings.clearLocalWarning', { count: localOnly })}</p>}
            <div className="flex justify-end gap-2">
              <button className="rounded-lg px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700" onClick={() => setConfirmClear(false)}>
                {t('common.cancel')}
              </button>
              <button className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700" onClick={clearDevice}>
                {t('settings.clear')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
