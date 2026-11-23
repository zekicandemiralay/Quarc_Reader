import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cloud, HardDrive } from 'lucide-react';
import Modal from './Modal';
import { enableSync, disableSync } from '../lib/library';
import { toast } from './Toasts';

// Switch one document between "this device only" and "synced". Turning sync
// off is the one with consequences, so it says exactly what happens.
export default function SyncModeDialog({ doc, onClose, onDone }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(null);
  const turningOn = doc.sync !== 'cloud';

  async function confirm() {
    setBusy(true);
    try {
      if (turningOn) await enableSync(doc.id);
      else await disableSync(doc.id, { onProgress: setPct });
      toast(turningOn ? t('syncMode.nowSynced', { title: doc.title }) : t('syncMode.nowLocal', { title: doc.title }));
      onDone?.(turningOn ? 'cloud' : 'local');
    } catch (err) {
      toast(`${t('syncMode.failed')} ${err.message}`, { duration: 8000 });
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={busy ? undefined : onClose} title={turningOn ? t('syncMode.turnOnTitle') : t('syncMode.turnOffTitle')}>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-3 rounded-xl bg-neutral-50 p-3 dark:bg-neutral-900/50">
          {turningOn ? <HardDrive size={20} className="text-neutral-500" /> : <Cloud size={20} className="text-sky-600" />}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{doc.title}</span>
        </div>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-neutral-600 dark:text-neutral-300">
          {(turningOn ? ['on1', 'on2', 'on3'] : ['off1', 'off2', 'off3']).map((k) => (
            <li key={k}>{t(`syncMode.${k}`)}</li>
          ))}
        </ul>
        {busy && pct !== null && <p className="text-sm text-neutral-500">{t('syncMode.fetching', { pct: Math.round(pct * 100) })}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" disabled={busy} className="rounded-lg px-3 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-700" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={confirm}
            className={`rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50 ${turningOn ? 'bg-accent hover:bg-accent-dark' : 'bg-red-600 hover:bg-red-700'}`}
          >
            {turningOn ? t('syncMode.turnOn') : t('syncMode.turnOff')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
