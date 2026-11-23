import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export default function Modal({ open, onClose, title, children, className = '', top = false }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      className={`fixed inset-0 z-[1100] flex justify-center bg-neutral-950/45 p-3 backdrop-blur-sm ${top ? 'items-start pt-[10vh]' : 'items-center'}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-neutral-200/70 bg-surface text-neutral-900 shadow-float dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 ${className}`}
      >
        {title && (
          <div className="flex items-center justify-between px-5 pb-1 pt-4">
            <h2 className="font-serif text-xl font-semibold tracking-tight">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-full p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
            >
              <X size={18} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
}
