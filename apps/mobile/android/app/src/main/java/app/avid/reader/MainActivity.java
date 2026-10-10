package app.avid.reader;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.content.Intent;
import app.avid.playback.AvidPlaybackPlugin;
import app.avid.playback.AvidSystemSurfacesPlugin;
import app.avid.playback.AvidSessionPlugin;
import app.avid.playback.AvidJournalPlugin;
import app.avid.playback.AvidOidcPlugin;
import app.avid.playback.AvidAppearancePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        AvidOidcPlugin.captureCallback(this, getIntent());
        AvidSystemSurfacesPlugin.captureNavigation(this, getIntent());
        registerPlugin(AvidPlaybackPlugin.class);
        registerPlugin(AvidSystemSurfacesPlugin.class);
        registerPlugin(AvidSessionPlugin.class);
        registerPlugin(AvidJournalPlugin.class);
        registerPlugin(AvidOidcPlugin.class);
        registerPlugin(AvidAppearancePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        AvidOidcPlugin.captureCallback(this, intent);
        AvidSystemSurfacesPlugin.captureNavigation(this, intent);
        setIntent(intent);
        super.onNewIntent(intent);
    }
}
