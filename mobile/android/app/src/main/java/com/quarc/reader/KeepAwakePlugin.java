package com.quarc.reader;

import android.app.Activity;
import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps the screen on while a document is open. JS name: KeepAwake (see frontend/src/lib/keepAwake.js).
 *
 * The window flag FLAG_KEEP_SCREEN_ON needs no permission, only counts while this app's window is in front
 * (the phone still dims and locks as usual once the app is left), and is the reliable way to do this from a
 * WebView — the web Screen Wake Lock API is not always honoured there.
 */
@CapacitorPlugin(name = "KeepAwake")
public class KeepAwakePlugin extends Plugin {

    @PluginMethod
    public void enable(PluginCall call) {
        setKeepOn(true);
        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        setKeepOn(false);
        call.resolve();
    }

    private void setKeepOn(boolean on) {
        final Activity activity = getActivity();
        if (activity == null) return;
        // Window flags may only be changed on the UI thread; plugin calls arrive on another one.
        activity.runOnUiThread(() -> {
            if (on) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }
}
