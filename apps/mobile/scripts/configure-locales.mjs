/** Add shared strings and complete locale folders to both native targets, including existing hosts. */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const capRequire = createRequire(
  require.resolve("@capacitor/cli/package.json"),
);
const xcode = capRequire("xcode");
const path = fileURLToPath(
  new URL("../ios/App/App.xcodeproj/project.pbxproj", import.meta.url),
);
const project = xcode.project(path);
project.parseSync();
const objects = project.hash.project.objects;
const [groupId, group] = Object.entries(objects.PBXGroup).find(
  ([, value]) => value.name === '"Avid native sources"',
);
const targets = Object.entries(objects.PBXNativeTarget).filter(([, value]) =>
  ["App", "AvidWidgets"].includes(value.name),
);
const reference = (value) => (typeof value === "string" ? value : value.value);
for (const [file, type, section] of [
  ["Shared/AvidStrings.swift", "sourcecode.swift", "PBXSourcesBuildPhase"],
  ...["en", "fi", "fr", "de", "pl", "zh-Hans", "es"].map((locale) => [
    `Shared/Locales/${locale}.lproj`,
    "folder",
    "PBXResourcesBuildPhase",
  ]),
]) {
  let fileId = Object.entries(objects.PBXFileReference).find(
    ([, value]) => String(value.path).replaceAll('"', "") === file,
  )?.[0];
  if (!fileId) {
    fileId = project.generateUuid();
    objects.PBXFileReference[fileId] = {
      isa: "PBXFileReference",
      lastKnownFileType: type,
      path: `"${file}"`,
      sourceTree: '"<group>"',
    };
    objects.PBXFileReference[`${fileId}_comment`] = file;
    group.children.push({ value: fileId, comment: file });
  }
  for (const [, target] of targets) {
    const phase = target.buildPhases
      .map(reference)
      .map((key) => objects[section]?.[key])
      .find(Boolean);
    if (!phase) throw Error(`Missing ${section} in ${target.name}`);
    if (
      phase.files.some(
        (value) => objects.PBXBuildFile[reference(value)]?.fileRef === fileId,
      )
    )
      continue;
    const buildId = project.generateUuid();
    objects.PBXBuildFile[buildId] = {
      isa: "PBXBuildFile",
      fileRef: fileId,
      fileRef_comment: file,
    };
    objects.PBXBuildFile[`${buildId}_comment`] = `${file} in ${section}`;
    phase.files.push({ value: buildId, comment: `${file} in ${section}` });
  }
}
const pbx = Object.values(objects.PBXProject).find(
  (value) => typeof value === "object",
);
pbx.knownRegions = [
  ...new Set([
    ...(pbx.knownRegions ?? []),
    "en",
    "fi",
    "fr",
    "de",
    "pl",
    '"zh-Hans"',
    "es",
  ]),
];
writeFileSync(path, project.writeSync());
console.log(
  `Configured native locales for ${targets.length} targets (${groupId}).`,
);
