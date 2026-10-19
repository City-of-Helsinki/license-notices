import fs from 'node:fs';
import path from 'node:path';

import {
  getLicense,
  getLicenseText,
  getRepository,
  readPackageMeta,
  type LicenseMeta,
} from 'rollup-license-plugin';

import {
  DEFAULT_MANIFEST_FILE_NAME,
  DEFAULT_NOTICES_FILE_NAME,
  findDecision,
  findSassResolvedPackages,
  readLicenseField,
  readProjectLicenseText,
  renderManifest,
  renderNotices,
  resolvePackage,
  type InstalledPackage,
  type ThirdPartyLicensesConfig,
} from '../core.js';
import { ancestorsOf, findPackageDir, isDependencySource } from './packages.js';
import { readClientSources } from './sourceMaps.js';

/** Unresolved sources named in an error, before the rest are counted. */
const MAX_LISTED_SOURCES = 10;

/**
 * The package tarball on the npm registry, as rollup-license-plugin names it
 * for a Vite build, so that both describe a package identically.
 */
export function npmTarballUrl(name: string, version: string): string {
  const scopeless = name.startsWith('@') ? name.split('/')[1] : name;
  const plus = version.indexOf('+');
  return (
    `https://registry.npmjs.org/${name}/-/${scopeless}-` +
    `${plus === -1 ? version : version.slice(0, plus)}.tgz`
  );
}

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

  const baseDirs = ancestorsOf(projectDir);
  const dirs = new Set<string>();
  const unresolved: string[] = [];
  for (const source of sources.filter(isDependencySource)) {
    const dir = findPackageDir(source, baseDirs);
    if (dir === undefined) {
      unresolved.push(source);
    } else {
      dirs.add(fs.realpathSync(dir));
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      'The source maps of the client build name files in node_modules ' +
        'that belong to no installed package, so their licenses cannot be ' +
        'found:\n' +
        unresolved
          .slice(0, MAX_LISTED_SOURCES)
          .map((source) => `  ${source}\n`)
          .join('') +
        (unresolved.length > MAX_LISTED_SOURCES
          ? `  ...and ${unresolved.length - MAX_LISTED_SOURCES} more\n`
          : '') +
        'A package that ships source maps of its own can name files outside ' +
        'of it. With Turbopack, setting experimental.turbopackInputSourceMaps ' +
        'to false makes the source maps name the installed files instead.'
    );
  }
  return [...dirs].sort();
}

/**
 * Reads the license of each package the way rollup-license-plugin does for
 * a Vite build, with the license of a decision in place of the declared one.
 */
async function readPackages(
  dirs: string[],
  config: ThirdPartyLicensesConfig
): Promise<{
  packages: LicenseMeta[];
  installed: Map<string, InstalledPackage>;
}> {
  const packages = new Map<string, LicenseMeta>();
  const installed = new Map<string, InstalledPackage>();
  for (const dir of dirs) {
    const meta = await readPackageMeta(dir);
    const id = `${meta.name}@${meta.version}`;
    // The same version installed twice, for different peer dependencies in
    // the pnpm virtual store, ships the same license.
    if (packages.has(id)) {
      continue;
    }
    const [, decision] = findDecision(meta.name, config.licenseDecisions) ?? [];
    const license = getLicense(
      id,
      meta,
      decision ? { licenseOverrides: { [meta.name]: decision.license } } : {}
    );
    const licenseText = await getLicenseText(id, license, dir);
    packages.set(id, {
      name: meta.name,
      version: meta.version,
      author: meta.author,
      repository: getRepository(meta) ?? '',
      source: npmTarballUrl(meta.name, meta.version),
      license,
      licenseText: licenseText ?? '',
    });
    installed.set(id, {
      name: meta.name,
      version: meta.version,
      declaredLicense: readLicenseField(meta),
    });
  }
  return { packages: [...packages.values()], installed };
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

  const dirs = [
    ...findClientPackageDirs(projectDir, path.resolve(projectDir, distDir)),
    ...findSassResolvedPackages(projectDir, config.sassResolvedPackages).map(
      (dir) => fs.realpathSync(dir)
    ),
  ];
  const { packages, installed } = await readPackages(
    [...new Set(dirs)],
    config
  );
  const resolved = packages.map((pkg) =>
    resolvePackage(pkg, config, (name, version) =>
      installed.get(`${name}@${version}`)
    )
  );

  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(
    noticesFile,
    renderNotices(resolved, config, readProjectLicenseText(projectDir))
  );
  if (manifestFile !== undefined) {
    fs.writeFileSync(manifestFile, renderManifest(resolved));
  }
}
