import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Link2, Trash2, Check, Eye } from 'lucide-react';
import Modal from './Modal';
import { apiUrl, API_BASE } from '../lib/apiUrl';
import { toast } from './Toasts';

// Share links go through the server: anyone who can reach it (over Tailscale)
// and has the link can read the document — read-only, no account needed. The
// owner chooses whether their pencil annotations are included and for how
// long the link works, and can turn it off at any time.

const EXPIRY = [
  ['never', null],
  ['1d', 1],
  ['7d', 7],
  ['30d', 30],
];

export function shareUrl(token) {
  // The public page lives on the server's address. In the browser that is simply
  // this page's origin; in the Android app (bundled files served from
  // https://localhost) and the desktop app it is the configured server.
  const base = import.meta.env.VITE_PUBLIC_URL || API_BASE || window.location.origin;
  return `${base}/s/${token}`;
}

async function call(method, path, body) {
  const res = await fetch(apiUrl(path), {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export default function ShareDialog({ doc, onClose }) {
  const { t } = useTranslation();
  const [links, setLinks] = useState(null);
  const [include, setInclude] = useState(false);
  const [expiry, setExpiry] = useState('never');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setLinks(await call('GET', `/api/shares?doc_id=${encodeURIComponent(doc.id)}`));
    } catch (err) {
      setError(err.message);
      setLinks([]);
    }
  }, [doc.id]);
  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError('');
    try {
      const days = EXPIRY.find(([k]) => k === expiry)?.[1] ?? null;
      const link = await call('POST', '/api/shares', { doc_id: doc.id, include_annotations: include, expires_days: days });
      await load();
      copy(link.token);
    } catch (err) {
      setError(err.message.includes('finished uploading') ? t('share.notUploaded') : err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(token) {
    const url = shareUrl(token);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(token);
      toast(t('share.copied'));
      setTimeout(() => setCopied((c) => (c === token ? null : c)), 2500);
    } catch {
      window.prompt(t('share.copyManually'), url);
    }
  }

  async function revoke(token) {
    try {
      await call('DELETE', `/api/shares/${encodeURIComponent(token)}`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  const live = (links || []).filter((l) => !l.revoked && !(l.expires_at && Date.parse(`${l.expires_at.replace(' ', 'T')}Z`) < Date.now()));

  return (
    <Modal open onClose={onClose} title={t('share.title')}>
      <div className="flex flex-col gap-4 overflow-y-auto p-4">
        <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('share.explain', { title: doc.title })}</p>

        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-700">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} className="mt-0.5 h-4 w-4 accent-amber-500" />
            <span>
              <span className="font-medium">{t('share.includeAnnotations')}</span>
              <span className="block text-xs text-neutral-500">{t('share.includeHint')}</span>
            </span>
          </label>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-neutral-600 dark:text-neutral-300">{t('share.expires')}</span>
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)} className="rounded-lg border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-600">
              {EXPIRY.map(([k]) => (
                <option key={k} value={k} className="text-neutral-900">
                  {t(`share.expiry.${k}`)}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={create}
            className="flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-dark disabled:opacity-50"
          >
            <Link2 size={16} /> {t('share.createLink')}
          </button>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        {links === null ? null : live.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400">{t('share.activeLinks')}</h3>
            {live.map((l) => (
              <div key={l.token} className="flex items-center gap-2 rounded-lg bg-neutral-50 p-2 text-sm dark:bg-neutral-900/50">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs">{shareUrl(l.token)}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-neutral-400">
                    <span>{l.include_annotations ? t('share.withAnnotations') : t('share.plain')}</span>
                    <span className="flex items-center gap-0.5">
                      <Eye size={11} /> {l.views}
                    </span>
                    {l.expires_at && <span>{t('share.expiresOn', { date: new Date(`${l.expires_at.replace(' ', 'T')}Z`).toLocaleDateString() })}</span>}
                  </p>
                </div>
                <button type="button" title={t('common.copy')} className="rounded-lg p-1.5 hover:bg-neutral-200 dark:hover:bg-neutral-700" onClick={() => copy(l.token)}>
                  {copied === l.token ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}
                </button>
                <button type="button" title={t('share.turnOff')} className="rounded-lg p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40" onClick={() => revoke(l.token)}>
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-center text-sm text-neutral-400">{t('share.noLinks')}</p>
        )}
        <p className="text-xs text-neutral-400">{t('share.tailscaleNote')}</p>
      </div>
    </Modal>
  );
}
