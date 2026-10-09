import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.avid.reader',
  appName: 'Avid',
  webDir: '../../dist',
  backgroundColor: '#f6f4ef',
  ios: { contentInset: 'always' },
  android: { allowMixedContent: false },
};

export default config;
