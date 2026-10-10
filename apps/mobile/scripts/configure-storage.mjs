/** Idempotently add the full repository store to an existing generated app target. */
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const capRequire=createRequire(require.resolve('@capacitor/cli/package.json'));
const project=capRequire('xcode').project(fileURLToPath(new URL('../ios/App/App.xcodeproj/project.pbxproj',import.meta.url)));
project.parseSync();
const objects=project.hash.project.objects;
const group=Object.values(objects.PBXGroup).find(value=>value.name==='"Avid native sources"');
const target=Object.values(objects.PBXNativeTarget).find(value=>value.name==='App');
const reference=value=>typeof value==='string'?value:value.value;
const phase=target?.buildPhases.map(reference).map(key=>objects.PBXSourcesBuildPhase[key]).find(Boolean);
if(!group || !phase)throw new Error('Configure the base Avid native target before repository storage.');
for(const name of ['AvidLibraryStorage.swift','AvidLibraryStoragePlugin.swift']){
  let fileId=Object.entries(objects.PBXFileReference).find(([,value])=>typeof value==='object'&&String(value.path).replaceAll('"','')===name)?.[0];
  if(!fileId){
    fileId=project.generateUuid();
    objects.PBXFileReference[fileId]={isa:'PBXFileReference',lastKnownFileType:'sourcecode.swift',path:`"${name}"`,sourceTree:'"<group>"'};
    objects.PBXFileReference[`${fileId}_comment`]=name;
    group.children.push({value:fileId,comment:name});
  }
  if(phase.files.some(value=>objects.PBXBuildFile[reference(value)]?.fileRef===fileId))continue;
  const buildId=project.generateUuid();
  objects.PBXBuildFile[buildId]={isa:'PBXBuildFile',fileRef:fileId,fileRef_comment:name};
  objects.PBXBuildFile[`${buildId}_comment`]=`${name} in Sources`;
  phase.files.push({value:buildId,comment:`${name} in Sources`});
}
writeFileSync(project.filepath,project.writeSync());
console.log('Configured full native repository storage in the app target.');
