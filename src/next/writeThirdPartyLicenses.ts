import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_MANIFEST_FILE_NAME,
  DEFAULT_NOTICES_FILE_NAME,
  type ThirdPartyLicensesConfig,
} from '../core.js';
import { writeNotices } from '../packageNotices.js';
import { resolvePackageDirs } from '../packages.js';
import { readClientSources } from './sourceMaps.js';

/**
 * The directories of the packages with output in the client build, read
 * from the source maps of its chunks.
 */
export function findClientPackageDirs(
  projectDir: string,
  distDir: string
): string[] {
  const { sources, mappedChunks } = readClientSources(
    path.join(distDir, 'static')
  );
  if (mappedChunks === 0) {
    throw new Error(
      `No chunk in ${path.join(distDir, 'static')} names a source map, so ` +
        'the packages in the client build cannot be told. Check that ' +
        'productionBrowserSourceMaps is enabled and that nothing removes ' +
        'the source maps before the third-party notices are written.'
    );
  }

  return resolvePackageDirs(
    projectDir,
    sources,
    'The source maps of the client build',
    'A package that ships source maps of its own can name files outside ' +
      'of it. With Turbopack, setting experimental.turbopackInputSourceMaps ' +
      'to false makes the source maps name the installed files instead.'
  );
}

/**
 * Writes the notices, and the manifest unless it is disabled, into the
 * public directory of a Next project, which both "next start" and the
 * server of a standalone build serve from the root of the application.
 */
export async function writeThirdPartyLicenses({
  projectDir,
  distDir,
  config,
}: {
  projectDir: string;
  distDir: string;
  config: ThirdPartyLicensesConfig;
}): Promise<void> {
  const publicDir = path.join(projectDir, 'public');
  const noticesFile = path.join(
    publicDir,
    config.noticesFileName ?? DEFAULT_NOTICES_FILE_NAME
  );
  const manifestFileName =
    config.manifestFileName ?? DEFAULT_MANIFEST_FILE_NAME;
  const manifestFile = manifestFileName
    ? path.join(publicDir, manifestFileName)
    : undefined;
  // The files of an earlier build would otherwise survive a build that fails
  // here, and be served by "next start" as if they described this one.
  for (const file of [noticesFile, manifestFile]) {
    if (file !== undefined) {
      fs.rmSync(file, { force: true });
    }
  }

  await writeNotices({
    projectDir,
    outputDir: publicDir,
    packageDirs: findClientPackageDirs(
      projectDir,
      path.resolve(projectDir, distDir)
    ),
    config,
  });
}
