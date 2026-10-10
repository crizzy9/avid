/** Structural validation only. Xcode compilation/signing must run separately on macOS. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const capRequire = createRequire(require.resolve('@capacitor/cli/package.json'));
const xcode = capRequire('xcode');
const plist = capRequire('plist');
const root = fileURLToPath(new URL('../', import.meta.url));
const project = xcode.project(`${root}ios/App/App.xcodeproj/project.pbxproj`);
project.parseSync();
const objects = project.hash.project.objects;
const entries = Object.entries(objects.PBXNativeTarget).filter(([, value]) => typeof value === 'object');
const [appId, app] = entries.find(([, target]) => target.name === 'App');
const [widgetId, widget] = entries.find(([, target]) => target.name === 'AvidWidgets');
const reference = (value) => typeof value === 'string' ? value : value.value;
const projectTarget = Object.values(objects.PBXProject).find(value => typeof value === 'object');
assert(projectTarget.targets.map(reference).includes(appId));
assert(projectTarget.targets.map(reference).includes(widgetId));
assert(app.dependencies.some(value => objects.PBXTargetDependency[reference(value)]?.target === widgetId));
assert(app.buildPhases.some(value => objects.PBXCopyFilesBuildPhase[reference(value)]?.dstSubfolderSpec === 13));
for (const [, target] of entries) {
  for (const phase of target.buildPhases) {
    const key = reference(phase);
    assert(['PBXSourcesBuildPhase', 'PBXResourcesBuildPhase', 'PBXFrameworksBuildPhase', 'PBXCopyFilesBuildPhase'].some(section => objects[section]?.[key]), `Invalid build phase ${key}`);
  }
}
const nativeGroup = Object.values(objects.PBXGroup).find(value => value.name === '"Avid native sources"');
for (const value of nativeGroup.children) {
  const file = objects.PBXFileReference[reference(value)];
  assert(existsSync(`${root}native/ios/${file.path.replaceAll('"', '')}`), `Missing native source ${file.path}`);
}
const appSourcePhases = app.buildPhases.map(reference).map(key => objects.PBXSourcesBuildPhase[key]).filter(Boolean);
for (const name of ['AvidLibraryStorage.swift', 'AvidLibraryStoragePlugin.swift', 'AvidCrossPointPlugin.swift']) {
  assert(appSourcePhases.some(phase => phase.files.some(value => {
    const build = objects.PBXBuildFile[reference(value)];
    return objects.PBXFileReference[build?.fileRef]?.path?.replaceAll('"', '') === name;
  })), `Missing repository source ${name} in the app target`);
}
const info = plist.parse(readFileSync(`${root}ios/App/App/Info.plist`, 'utf8'));
assert(info.UIBackgroundModes.includes('audio'));
assert(info.CFBundleURLTypes.some(value => value.CFBundleURLSchemes.includes('avid')));
const entitlement = plist.parse(readFileSync(`${root}native/ios/Avid.entitlements`, 'utf8'));
assert(entitlement['com.apple.security.application-groups'].includes('group.app.avid.reader'));
const configurations = app.buildConfigurationList;
const appConfigurations = objects.XCConfigurationList[configurations].buildConfigurations.map(value => objects.XCBuildConfiguration[reference(value)]);
const standard = appConfigurations.find(value => value.name === 'Debug');
assert(!standard.buildSettings.CODE_SIGN_ENTITLEMENTS.includes('CarPlay'));
const car = appConfigurations.find(value => value.name === 'DebugCarPlay');
if (car) {
  assert(car.buildSettings.CODE_SIGN_ENTITLEMENTS.includes('CarPlay'));
  assert(car.buildSettings.SWIFT_ACTIVE_COMPILATION_CONDITIONS.includes('AVID_CARPLAY'));
  const carInfo = plist.parse(readFileSync(`${root}native/ios/CarPlay/Info.plist`, 'utf8'));
  assert(carInfo.UIApplicationSceneManifest.UISceneConfigurations.CPTemplateApplicationSceneSessionRoleApplication.length === 1);
  assert(!info.UIApplicationSceneManifest.UISceneConfigurations.CPTemplateApplicationSceneSessionRoleApplication);
}
console.log('iOS host graph, source paths, widget embedding, background audio, deep links, and App Group declarations pass structural checks. This is not Swift compilation or device validation.');
