/** Deterministic, opt-in CarPlay scheme. Standard App builds never request the CarPlay entitlement. */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const capRequire = createRequire(require.resolve('@capacitor/cli/package.json'));
const xcode = capRequire('xcode'), plist = capRequire('plist');
const root = fileURLToPath(new URL('../', import.meta.url));
const path = `${root}ios/App/App.xcodeproj/project.pbxproj`;
const project = xcode.project(path); project.parseSync();
const objects = project.hash.project.objects;
const nativeGroup = Object.entries(objects.PBXGroup).find(([, value]) => value.name === '"Avid native sources"')[0];
const app = Object.entries(objects.PBXNativeTarget).find(([, value]) => value.name === 'App')[0];
for (const file of ['AvidCarPlaySceneDelegate.swift', 'AvidPlaybackJournal.swift', 'AvidOidcPlugin.swift', 'AvidAppearancePlugin.swift', 'AvidAuthPlugin.swift']) {
  if (!Object.values(objects.PBXFileReference).some(value => String(value.path).includes(file))) {
    project.addSourceFile(file, { target: app }, nativeGroup);
  }
}
const reference = value => typeof value === 'string' ? value : value.value;
for (const [key, list] of Object.entries(objects.XCConfigurationList)) {
  if (typeof list !== 'object') continue;
  for (const base of ['Debug', 'Release']) {
    const name = `${base}CarPlay`;
    if (list.buildConfigurations.some(value => objects.XCBuildConfiguration[reference(value)]?.name === name)) continue;
    const baseRef = list.buildConfigurations.find(value => objects.XCBuildConfiguration[reference(value)]?.name === base);
    if (!baseRef) throw new Error(`Missing ${base} in ${key}`);
    const config = structuredClone(objects.XCBuildConfiguration[reference(baseRef)]);
    config.name = name;
    if (key === objects.PBXNativeTarget[app].buildConfigurationList) {
      config.buildSettings.INFOPLIST_FILE = '"../../native/ios/CarPlay/Info.plist"';
      config.buildSettings.CODE_SIGN_ENTITLEMENTS = '"../../native/ios/CarPlay/AvidCarPlay.entitlements"';
      config.buildSettings.SWIFT_ACTIVE_COMPILATION_CONDITIONS = `"$(inherited) ${base === 'Debug' ? 'DEBUG ' : ''}AVID_CARPLAY"`;
    }
    const uuid = project.generateUuid(); objects.XCBuildConfiguration[uuid] = config; objects.XCBuildConfiguration[`${uuid}_comment`] = name;
    list.buildConfigurations.push({ value: uuid, comment: name });
  }
}
writeFileSync(path, project.writeSync());
let delegate = readFileSync(`${root}ios/App/App/AppDelegate.swift`, 'utf8');
if (!delegate.includes('import CarPlay')) delegate = delegate.replace('import UIKit', 'import UIKit\nimport CarPlay');
if (!delegate.includes('#if AVID_CARPLAY')) delegate = delegate.replace('        let config = UISceneConfiguration(name:', `        #if AVID_CARPLAY
        if connectingSceneSession.role == .carTemplateApplication {
            let car = UISceneConfiguration(name: "Avid CarPlay", sessionRole: connectingSceneSession.role)
            car.sceneClass = CPTemplateApplicationScene.self
            car.delegateClass = AvidCarPlaySceneDelegate.self
            return car
        }
        #endif
        let config = UISceneConfiguration(name:`);
writeFileSync(`${root}ios/App/App/AppDelegate.swift`, delegate);
const info = plist.parse(readFileSync(`${root}ios/App/App/Info.plist`, 'utf8'));
info.UIApplicationSceneManifest.UIApplicationSupportsMultipleScenes = true;
info.UIApplicationSceneManifest.UISceneConfigurations.CPTemplateApplicationSceneSessionRoleApplication = [{ UISceneClassName: 'CPTemplateApplicationScene', UISceneConfigurationName: 'Avid CarPlay', UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).AvidCarPlaySceneDelegate' }];
writeFileSync(`${root}native/ios/CarPlay/Info.plist`, plist.build(info));
const schemePath = `${root}ios/App/App.xcodeproj/xcshareddata/xcschemes`;
mkdirSync(schemePath, { recursive: true });
const scheme = readFileSync(`${schemePath}/App.xcscheme`, 'utf8').replaceAll('buildConfiguration="Debug"', 'buildConfiguration="DebugCarPlay"').replaceAll('buildConfiguration="Release"', 'buildConfiguration="ReleaseCarPlay"');
writeFileSync(`${schemePath}/App-CarPlay.xcscheme`, scheme);
console.log('Integrated opt-in App-CarPlay scheme; standard entitlements remain unchanged. Apple approval is still required for a signed CarPlay release.');
