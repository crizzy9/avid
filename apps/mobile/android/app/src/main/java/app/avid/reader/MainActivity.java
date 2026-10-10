package app.avid.reader;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import app.avid.playback.AvidPlaybackPlugin;
import app.avid.playback.AvidSystemSurfacesPlugin;
import app.avid.playback.AvidSessionPlugin;
import app.avid.playback.AvidJournalPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AvidPlaybackPlugin.class);
        registerPlugin(AvidSystemSurfacesPlugin.class);
        registerPlugin(AvidSessionPlugin.class);
        registerPlugin(AvidJournalPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
