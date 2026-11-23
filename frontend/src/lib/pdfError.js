// Why a PDF would not open, in terms a person can act on — plus the technical detail, for the screen and the console.
//
// `err` is what pdf.js threw (its exceptions carry a name, and `status` for an HTTP answer); `local` says the bytes came
// from this device rather than the server; `online` is navigator.onLine. Resolves to { code, detail }:
//
//   password       the PDF is password-protected
//   engine         the PDF engine (pdf.js' worker script) could not be loaded from the server — nothing to do with the file;
//                  typically a web server sending ".mjs" files with the wrong type, or a stale cached copy of the app
//   invalid-local  the copy kept on this device is damaged (or was never a PDF)
//   signin         the server said 401/403: the sign-in has expired
//   gone           the server has no such file (404)
//   server         the server failed (5xx)
//   network        the request never completed (status 0): the server could not be reached
//   offline        the browser says it is offline
//   invalid        the server sent something that is not a valid PDF
//   unknown        anything else
export function describeOpenError(err, { local = false, online = true } = {}) {
  const name = String(err?.name || 'Error');
  const status = Number.isFinite(err?.status) ? err.status : null;
  const detail = [name, status !== null ? `HTTP ${status}` : '', String(err?.message || '')]
    .filter(Boolean)
    .join(' · ')
    .slice(0, 300);
  const damaged = name === 'InvalidPDFException' || name === 'FormatError';
  // pdf.js falls back to running its worker on the page when the real one will not load, and says so when that fails too.
  const engineDown = /Setting up fake worker failed|dynamically imported module|module script failed|Failed to load module script/i.test(String(err?.message || ''));

  let code;
  if (name === 'PasswordException') code = 'password';
  else if (engineDown) code = 'engine';
  else if (local) code = damaged ? 'invalid-local' : 'unknown';
  else if (status === 401 || status === 403) code = 'signin';
  else if (status === 404 || name === 'MissingPDFException') code = 'gone';
  else if (status !== null && status >= 500) code = 'server';
  else if (status === 0) code = 'network';
  else if (!online) code = 'offline';
  else if (damaged) code = 'invalid';
  else code = 'unknown';
  return { code, detail };
}
