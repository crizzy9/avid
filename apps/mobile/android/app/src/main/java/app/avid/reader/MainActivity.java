package app.avid.reader;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import app.avid.playback.AvidPlaybackPlugin;
import app.avid.playback.AvidSystemSurfacesPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AvidPlaybackPlugin.class);
        registerPlugin(AvidSystemSurfacesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
