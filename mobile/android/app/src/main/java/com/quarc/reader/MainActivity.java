package com.quarc.reader;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UpdaterPlugin.class);
        // "Open with" and the share sheet: PDFs handed to the app by other apps.
        registerPlugin(OpenWithPlugin.class);
        // Quarc Store single sign-on (see Quarc_Store/sso-kit/README.md).
        registerPlugin(QuarcSsoPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
