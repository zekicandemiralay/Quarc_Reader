import Dexie from 'dexie';

// Everything the app keeps on the device. It works fully offline: the server
// is only a place to sync to.
//
//  docs    one row per document in the library, local-only or synced.
//          { id, owner (user id), title, author, kind: 'pdf',
//            sync: 'local' | 'cloud'      — the user's choice, changeable later
//            file_sha256, file_size, orig_sha256,
//            file_ready                   — (cloud) the server has the whole file
//            page_count, sizes (run-length), layout (note pages), thumb,
//            progress { page, offset, pct }, progress_at,
//            bookmarks [{ id, u, page, label, del? }], settings {},
//            is_favorite, is_deleted,
//            created_at, updated_at, opened_at   (ISO strings, local)
//            server_updated_at            — the server version this copy is based on }
//  ann     what was drawn/highlighted on one page of a document.
//          { doc_id, page_key, ink_json (string: {elements, files}),
//            marks_json (string), updated_at, server_updated_at }
//  blobs   the PDF files themselves: the only copy for a local-only document,
//          an offline cache for a synced one. { sha256, blob, size, last_used }
//  outbox  changes waiting to reach the server, one entry per document / per
//          annotated page: { key, kind: 'doc' | 'ann', rev, queued_at,
//          base_updated_at, ...}; a doc entry carries only the fields that
//          changed, an ann entry points at the ann row (its content is read
//          when pushing, so big ink is never copied twice).
//  meta    small key/values (sync cursor, who owns this cache).
export const db = new Dexie('quarc-reader');

db.version(1).stores({
  docs: 'id, owner, updated_at, is_deleted',
  ann: '[doc_id+page_key], doc_id',
  blobs: 'sha256',
  outbox: 'key, queued_at',
  meta: 'key',
});
