package com.quarc.reader;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * "Open with Quarc Reader" and the share sheet. JS name: OpenWith.
 *
 * Another app (a file manager, a mail app, Drive, the browser's downloads) hands this app a PDF as a
 * VIEW or SEND intent carrying a content:// (or file://) URI that is only valid for a while and that
 * the WebView cannot read. So the PDF is copied into the app's cache first (off the main thread: they
 * can be large), and the web side is told ("incoming"); it then calls takePending() for the list, reads
 * each copy through the WebView's local file server (Capacitor.convertFileSrc) and calls discard().
 *
 * Idempotent on purpose: the web side asks once at start-up and again on every "incoming", so it does
 * not matter whether the intent or the page was first.
 */
@CapacitorPlugin(name = "OpenWith")
public class OpenWithPlugin extends Plugin {

    private static final String DIR = "incoming";
    // Marks an intent this plugin has already dealt with (the launch intent is looked at twice).
    private static final String HANDLED = "com.quarc.reader.OPEN_WITH_HANDLED";
    private static final long KEEP_MS = 24L * 60 * 60 * 1000;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final List<JSObject> ready = new ArrayList<>(); // copied, waiting for the web side
    private int failed = 0; // could not be copied since the web side last asked

    @Override
    public void load() {
        // Copies the web side never collected (the app was killed in between) don't live forever.
        executor.execute(this::sweep);
    }

    /** Called with the launch intent at start-up and with every later one (the activity is singleTask). */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent == null) return;
        // Brought back from the recent-apps list: that is the intent which started the task long ago.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        if (intent.getBooleanExtra(HANDLED, false)) return;
        List<Uri> uris = sharedUris(intent);
        if (uris.isEmpty()) return;
        intent.putExtra(HANDLED, true);
        for (Uri uri : uris) executor.execute(() -> receive(uri));
    }

    /** The PDFs that arrived and are ready to be read: { files: [{ path, name, size }], failed: n }. */
    @PluginMethod
    public void takePending(PluginCall call) {
        JSArray files = new JSArray();
        int lost;
        synchronized (this) {
            for (JSObject f : ready) files.put(f);
            ready.clear();
            lost = failed;
            failed = 0;
        }
        JSObject result = new JSObject();
        result.put("files", files);
        result.put("failed", lost);
        call.resolve(result);
    }

    /** The web side has read these copies: delete them. Only files in this plugin's own folder. */
    @PluginMethod
    public void discard(PluginCall call) {
        final JSArray paths = call.getArray("paths");
        executor.execute(() -> {
            if (paths == null) return;
            try {
                File dir = new File(getContext().getCacheDir(), DIR).getCanonicalFile();
                for (int i = 0; i < paths.length(); i++) {
                    File f = new File(paths.getString(i)).getCanonicalFile();
                    if (dir.equals(f.getParentFile())) f.delete();
                }
            } catch (IOException | JSONException ignored) {
                // Whatever is left is swept on the next start.
            }
        });
        call.resolve();
    }

    // ----- what arrived -------------------------------------------------------------------------

    private static List<Uri> sharedUris(Intent intent) {
        List<Uri> out = new ArrayList<>();
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            if (intent.getData() != null) out.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri one = streamExtra(intent);
            if (one != null) out.add(one);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            out.addAll(streamExtras(intent));
        }
        // Some senders only fill the clip, not EXTRA_STREAM.
        if (out.isEmpty() && (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action))) {
            ClipData clip = intent.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri u = clip.getItemAt(i).getUri();
                    if (u != null) out.add(u);
                }
            }
        }
        return out;
    }

    @SuppressWarnings("deprecation")
    private static Uri streamExtra(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        Object o = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        return o instanceof Uri ? (Uri) o : null;
    }

    @SuppressWarnings("deprecation")
    private static List<Uri> streamExtras(Intent intent) {
        ArrayList<Uri> list = Build.VERSION.SDK_INT >= 33
            ? intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class)
            : intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        return list == null ? new ArrayList<Uri>() : list;
    }

    // ----- copying -------------------------------------------------------------------------------

    private void receive(Uri uri) {
        try {
            JSObject file = copyToCache(uri);
            synchronized (this) {
                ready.add(file);
            }
        } catch (Exception e) {
            synchronized (this) {
                failed++;
            }
        }
        // Retained until the web side is listening (the page may still be starting up).
        notifyListeners("incoming", new JSObject(), true);
    }

    private JSObject copyToCache(Uri uri) throws IOException {
        Context ctx = getContext();
        if ("file".equals(uri.getScheme())) refuseOwnData(ctx, uri);
        ContentResolver resolver = ctx.getContentResolver();

        File dir = new File(ctx.getCacheDir(), DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no cache folder");
        File out = new File(dir, UUID.randomUUID() + ".pdf");
        long size = 0;
        try (InputStream in = resolver.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
            if (in == null) throw new IOException("unreadable");
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) != -1) {
                os.write(buffer, 0, n);
                size += n;
            }
            if (size == 0) throw new IOException("empty");
        } catch (IOException | RuntimeException e) {
            out.delete();
            throw e;
        }

        JSObject file = new JSObject();
        file.put("path", out.getAbsolutePath());
        file.put("name", displayName(resolver, uri));
        file.put("size", size);
        return file;
    }

    /** A file:// URI is a path on the sender's say-so: never one of this app's own private files. */
    private static void refuseOwnData(Context ctx, Uri uri) throws IOException {
        String path = uri.getPath();
        if (path == null) throw new IOException("no path");
        String own = new File(ctx.getApplicationInfo().dataDir).getCanonicalPath();
        String target = new File(path).getCanonicalPath();
        if (target.equals(own) || target.startsWith(own + File.separator)) throw new IOException("private");
    }

    private static String displayName(ContentResolver resolver, Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {
                // fall back to the last path segment
            }
        }
        if (name == null || name.trim().isEmpty()) name = uri.getLastPathSegment();
        if (name == null || name.trim().isEmpty()) name = "document";
        name = name.substring(name.lastIndexOf('/') + 1);
        if (!name.toLowerCase().endsWith(".pdf")) name = name + ".pdf";
        return name;
    }

    private void sweep() {
        File[] old = new File(getContext().getCacheDir(), DIR).listFiles();
        if (old == null) return;
        long cutoff = System.currentTimeMillis() - KEEP_MS;
        for (File f : old) {
            if (f.lastModified() < cutoff) f.delete();
        }
    }
}
