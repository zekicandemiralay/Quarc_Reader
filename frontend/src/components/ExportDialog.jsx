import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Replace, Undo2 } from 'lucide-react';
import Modal from './Modal';
import { toast } from './Toasts';
import { buildAnnotatedPdf, describePdf, annotatedName } from '../lib/exportApp';
import { saveBlob } from '../lib/saveFile';
import { replaceFile, revertToOriginal } from '../lib/library';

// Save the PDF with the annotations in it. The original is never touched
// unless "Replace" is chosen (and confirmed) — and even then it is kept as the
// safety copy that "Revert to original" brings back.
export default function ExportDialog({ doc, pdf, pages, onClose }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(null); // 'copy' | 'replace' | 'revert'
  const [pct, setPct] = useState(0);
  const [error, setError] = useState('');
  const [confirmReplace, setConfirmReplace] = useState(false);

  async function build() {
    setPct(0);
    return buildAnnotatedPdf({ doc, pdf, pages, onProgress: setPct });
  }

  async function saveCopy() {
    setBusy('copy');
    setError('');
    try {
      const blob = await build();
      const result = await saveBlob(blob, annotatedName(doc.title));
      if (result !== 'cancelled') {
        toast(result === 'saved' ? t('export.saved') : result === 'shared' ? t('export.shared') : t('export.downloaded'));
        onClose();
      }
    } catch (err) {
      setError(`${t('export.failed')} ${err.message}`);
    } finally {
      setBusy(null);
    }
  }

  async function replace() {
    setBusy('replace');
    setError('');
    try {
      const blob = await build();
      const meta = await describePdf(blob);
      await replaceFile(doc.id, blob, { clearAnnotations: true, meta });
      toast(t('export.replaced'));
      onClose();
    } catch (err) {
      setError(`${t('export.failed')} ${err.message}`);
      setBusy(null);
    }
  }

  async function revert() {
    setBusy('revert');
    setError('');
    try {
      await revertToOriginal(doc.id);
      toast(t('export.reverted'));
      onClose();
    } catch (err) {
      setError(`${t('export.failed')} ${err.message}`);
      setBusy(null);
    }
  }

  return (
    <Modal open onClose={busy ? undefined : onClose} title={t('export.title')}>
      <div className="flex flex-col gap-3 overflow-y-auto p-4">
        <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('export.explain')}</p>

        <button
          type="button"
          disabled={!!busy}
          onClick={saveCopy}
          className="flex items-start gap-3 rounded-xl border border-neutral-200 p-3 text-left transition hover:border-accent disabled:opacity-60 dark:border-neutral-700"
        >
          <Download size={20} className="mt-0.5 shrink-0 text-accent" />
          <span>
            <span className="block font-medium">{t('export.copy.title')}</span>
            <span className="mt-0.5 block text-sm text-neutral-500 dark:text-neutral-400">{t('export.copy.body')}</span>
          </span>
        </button>

        {!confirmReplace ? (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => setConfirmReplace(true)}
            className="flex items-start gap-3 rounded-xl border border-neutral-200 p-3 text-left transition hover:border-red-400 disabled:opacity-60 dark:border-neutral-700"
          >
            <Replace size={20} className="mt-0.5 shrink-0 text-neutral-500" />
            <span>
              <span className="block font-medium">{t('export.replace.title')}</span>
              <span className="mt-0.5 block text-sm text-neutral-500 dark:text-neutral-400">{t('export.replace.body')}</span>
            </span>
          </button>
        ) : (
          <div className="rounded-xl border border-red-300 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30">
            <p className="text-sm text-red-800 dark:text-red-200">{t('export.replace.warning')}</p>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" disabled={!!busy} className="rounded-lg px-3 py-1.5 text-sm hover:bg-white/60 dark:hover:bg-neutral-800" onClick={() => setConfirmReplace(false)}>
                {t('common.cancel')}
              </button>
              <button type="button" disabled={!!busy} className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60" onClick={replace}>
                {t('export.replace.confirm')}
              </button>
            </div>
          </div>
        )}

        {doc.orig_sha256 && (
          <button
            type="button"
            disabled={!!busy}
            onClick={revert}
            className="flex items-start gap-3 rounded-xl border border-neutral-200 p-3 text-left transition hover:border-accent disabled:opacity-60 dark:border-neutral-700"
          >
            <Undo2 size={20} className="mt-0.5 shrink-0 text-neutral-500" />
            <span>
              <span className="block font-medium">{t('export.revert.title')}</span>
              <span className="mt-0.5 block text-sm text-neutral-500 dark:text-neutral-400">{t('export.revert.body')}</span>
            </span>
          </button>
        )}

        {busy && busy !== 'revert' && (
          <div className="h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
            <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(pct * 100)}%` }} />
          </div>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}
