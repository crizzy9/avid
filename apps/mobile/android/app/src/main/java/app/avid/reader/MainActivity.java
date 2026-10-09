package app.avid.reader;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import app.avid.playback.AvidPlaybackPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AvidPlaybackPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
