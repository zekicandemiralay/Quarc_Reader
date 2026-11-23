// Gets a generated file (the annotated PDF) out of the app, the way each
// platform does it:
//   Android (Capacitor)  write to the app's cache, then the system share sheet
//                        ("Save to Files", Drive, mail...) — a WebView can't download blobs
//   Desktop (Tauri)      a native "Save as" dialog
//   Browser              an ordinary download
// Resolves to 'saved' | 'shared' | 'downloaded' | 'cancelled'.

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function saveBlob(blob, filename) {
  const cap = window.Capacitor;
  const plugins = cap?.Plugins;
  if (cap?.isNativePlatform?.() && plugins?.Filesystem && plugins?.Share) {
    const data = await blobToBase64(blob);
    const { uri } = await plugins.Filesystem.writeFile({ path: filename, data, directory: 'CACHE' });
    try {
      await plugins.Share.share({ title: filename, url: uri, dialogTitle: filename });
    } catch (err) {
      if (/cancel/i.test(String(err?.message))) return 'cancelled';
      throw err;
    }
    return 'shared';
  }
  const tauri = window.__TAURI__;
  if (tauri?.dialog?.save && tauri?.fs?.writeFile) {
    const path = await tauri.dialog.save({ defaultPath: filename, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!path) return 'cancelled';
    await tauri.fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return 'saved';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  return 'downloaded';
}
