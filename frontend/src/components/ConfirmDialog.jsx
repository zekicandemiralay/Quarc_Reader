import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';

// The app's own "Are you sure?" question. Use it instead of window.confirm for anything that deletes.
// Why: the Windows app shows this page from the server, and Tauri's dialog plugin (there for the Save-as dialog)
// replaces window.confirm with an async function whose native dialog the page is not allowed to open. A Promise is
// truthy, so `if (!window.confirm(...)) return;` went straight on without asking. This dialog works the same in every
// browser and app.
const useConfirm = create(() => ({ ask: null }));

/** Shows the question; resolves true only when the person presses the confirm button. */
export function askConfirm(message, { confirmLabel } = {}) {
  return new Promise((resolve) => {
    useConfirm.getState().ask?.resolve(false); // a new question replaces an unanswered one
    useConfirm.setState({ ask: { message, confirmLabel, resolve } });
  });
}

function answer(value) {
  const { ask } = useConfirm.getState();
  if (!ask) return;
  useConfirm.setState({ ask: null });
  ask.resolve(value);
}

export default function ConfirmDialog() {
  const { t } = useTranslation();
  const ask = useConfirm((s) => s.ask);
  const cancelRef = useRef(null);
  useEffect(() => {
    if (ask) cancelRef.current?.focus(); // Enter or Space right away must not delete anything
  }, [ask]);

  return (
    <Modal open={!!ask} onClose={() => answer(false)}>
      <div className="px-5 pb-5 pt-5">
        <p className="mb-5 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">{ask?.message}</p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className="rounded-xl px-4 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700"
            onClick={() => answer(false)}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            onClick={() => answer(true)}
          >
            {ask?.confirmLabel || t('common.delete')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
