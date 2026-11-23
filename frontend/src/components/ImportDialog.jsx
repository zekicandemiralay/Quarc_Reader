import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HardDrive, Cloud } from 'lucide-react';
import Modal from './Modal';

// Asked when PDFs are added: keep them on this device only, or sync them. The
// answer is per document and can be changed later (document menu → Sync), and
// "remember" only sets the default for the next time (Settings → Library).
export default function ImportDialog({ count, onChoose, onCancel }) {
  const { t } = useTranslation();
  const [remember, setRemember] = useState(false);

  const option = (mode, Icon, accent) => (
    <button
      type="button"
      onClick={() => onChoose(mode, remember)}
      className="flex w-full items-start gap-3 rounded-xl border border-neutral-200 p-3 text-left transition hover:border-accent hover:bg-amber-50/50 dark:border-neutral-700 dark:hover:bg-neutral-700/40"
    >
      <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${accent}`}>
        <Icon size={18} />
      </span>
      <span>
        <span className="block font-medium">{t(`import.${mode}.title`)}</span>
        <span className="mt-0.5 block text-sm text-neutral-500 dark:text-neutral-400">{t(`import.${mode}.body`)}</span>
      </span>
    </button>
  );

  return (
    <Modal open onClose={onCancel} title={t('import.title', { count })}>
      <div className="flex flex-col gap-3 overflow-y-auto p-4">
        <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('import.question')}</p>
        {option('local', HardDrive, 'bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-200')}
        {option('cloud', Cloud, 'bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300')}
        <label className="mt-1 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4 accent-amber-500" />
          {t('import.remember')}
        </label>
        <p className="text-xs text-neutral-400">{t('import.changeLater')}</p>
      </div>
    </Modal>
  );
}
