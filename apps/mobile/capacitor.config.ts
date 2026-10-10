import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.avid.reader',
  appName: 'Avid',
  webDir: '../../dist',
  backgroundColor: '#f6f4ef',
  ios: { contentInset: 'always' },
  android: { allowMixedContent: false },
  // Official native fetch/XHR transport shares the OS/WebView cookie stores used by media.
  // This does not weaken TLS or permit mixed content.
  plugins: { CapacitorHttp: { enabled: true } },
};

export default config;
