// Check No Extension Src Imports script supports OpenClaw repository automation.
import fs from "node:fs";
import path from "node:path";
import { collectFilesSync, isCodeFile, relativeToCwd } from "./check-file-utils.js";
import { classifyBundledExtensionSourcePath } from "./lib/extension-source-classifier.mts";

// Only an ancestor-relative specifier can leave the extension, and only one
// that resolves inside the repository's own `src/` is forbidden: a plugin
// directory nested one level below its package root (`extensions/x/browser`)
// reaches its own `extensions/x/src` barrel through `../src/`, which is the
// surface this guard's own message recommends.
const ANCESTOR_RELATIVE_SPECIFIER = /["'](\.\.\/[^"']+)["']/gu;

function importsRepoSrc(content: string, fileDir: string, repoSrcDir: string): boolean {
  for (const match of content.matchAll(ANCESTOR_RELATIVE_SPECIFIER)) {
    const specifier = match[1];
    if (!specifier) {
      continue;
    }
    const resolved = path.resolve(fileDir, specifier);
    if (resolved === repoSrcDir || resolved.startsWith(`${repoSrcDir}${path.sep}`)) {
      return true;
    }
  }
  return false;
}

function collectExtensionSourceFiles(rootDir: string): string[] {
  return collectFilesSync(rootDir, {
    includeFile: (filePath) =>
      isCodeFile(filePath) && classifyBundledExtensionSourcePath(filePath).isProductionSource,
  });
}

function main() {
  const extensionsDir = path.join(process.cwd(), "extensions");
  const repoSrcDir = path.join(process.cwd(), "src");
  const files = collectExtensionSourceFiles(extensionsDir);
  const offenders: string[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    if (importsRepoSrc(content, path.dirname(file), repoSrcDir)) {
      offenders.push(file);
    }
  }

  if (offenders.length > 0) {
    console.error("Production extension files must not import the repo src/ tree directly.");
    for (const offender of offenders.toSorted()) {
      console.error(`- ${relativeToCwd(offender)}`);
    }
    console.error(
      "Publish a focused openclaw/plugin-sdk/<subpath> surface or use the extension's own public barrel instead.",
    );
    process.exit(1);
  }

  console.log(
    `OK: production extension files avoid direct repo src/ imports (${files.length} checked).`,
  );
}

main();
