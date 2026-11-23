import { create } from 'zustand';
import { apiUrl } from './apiUrl';

// Moving PDFs to and from the server.
//
// Uploads are chunked and resumable (see backend/src/routes/files.js): ask the
// server how much it already has, send the rest in 8 MB pieces, and the server
// only keeps the file if its SHA-256 matches. A dropped connection on a 300 MB
// book costs one chunk, not the whole upload. Downloads of a whole file report
// progress; opening a document does not need one at all (pdf.js streams it
// with Range requests).

export const CHUNK_BYTES = 8 * 1024 * 1024;

// docId -> { state: 'uploading' | 'downloading' | 'error', pct: 0..1, error? }
export const useTransfers = create(() => ({}));

export function setTransfer(docId, patch) {
  useTransfers.setState((s) => (patch ? { ...s, [docId]: { ...(s[docId] || {}), ...patch } } : Object.fromEntries(Object.entries(s).filter(([k]) => k !== docId))));
}

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fileStatus(sha) {
  const res = await fetch(apiUrl(`/api/files/${sha}/status`), { credentials: 'include' });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

// Uploads `blob` as the file with hash `sha`, resuming whatever the server
// already has. Resolves when the server holds the complete, verified file.
export async function uploadBlob(sha, blob, { onProgress, signal } = {}) {
  const total = blob.size;
  const status = await fileStatus(sha);
  if (status.exists) {
    onProgress?.(1);
    return;
  }
  let offset = status.received || 0;
  let failures = 0;
  while (offset < total) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const end = Math.min(offset + CHUNK_BYTES, total);
    let res;
    try {
      res = await fetch(apiUrl(`/api/files/${sha}?offset=${offset}&total=${total}`), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob.slice(offset, end),
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError' || ++failures > 5) throw err;
      // Connection dropped mid-chunk: find out what arrived and carry on from there.
      await sleep(Math.min(8000, 500 * 2 ** failures));
      try {
        const st = await fileStatus(sha);
        if (st.exists) return;
        offset = st.received || 0;
      } catch {
        /* still offline: the next loop iteration fails again and counts */
      }
      continue;
    }
    if (res.status === 409) {
      offset = (await res.json()).received;
      continue;
    }
    if (res.status === 422) throw new Error('The server rejected the file (it was damaged in transit). Try again.');
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    const body = await res.json();
    if (body.exists) {
      onProgress?.(1);
      return;
    }
    failures = 0;
    offset = end;
    onProgress?.(offset / total);
  }
}

// Downloads a whole file into a Blob, reporting progress.
export async function downloadBlob(url, { onProgress, signal } = {}) {
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body?.getReader) {
    const blob = await res.blob();
    onProgress?.(1);
    return blob;
  }
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onProgress?.(got / total);
  }
  onProgress?.(1);
  return new Blob(parts, { type: 'application/pdf' });
}

export const fileUrl = (sha) => apiUrl(`/api/files/${sha}`);
