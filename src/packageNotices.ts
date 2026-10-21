import fs from 'node:fs';
import path from 'node:path';

import {
  getLicense,
  getLicenseText,
  getRepository,
  readPackageMeta,
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
  type BundledPackage,
  type InstalledPackage,
  type ThirdPartyLicensesConfig,
} from './core.js';

/**
 * Writes the notices of a build whose bundled packages the entry point of
 * its bundler finds itself, since rollup-license-plugin runs only in Vite.
 * They are described the way rollup-license-plugin describes them, so that
 * the notices of every bundler read alike.
 */

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
 * Reads the license of each package the way rollup-license-plugin does for
 * a Vite build, with the license of a decision in place of the declared one.
 */
export async function readPackages(
  dirs: string[],
  config: ThirdPartyLicensesConfig
): Promise<{
  packages: BundledPackage[];
  installed: Map<string, InstalledPackage>;
}> {
  const packages = new Map<string, BundledPackage>();
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
 * Writes the notices, and the manifest unless it is disabled, of the given
 * packages and of the configured Sass-resolved ones into a directory.
 */
export async function writeNotices({
  projectDir,
  outputDir,
  packageDirs,
  config,
}: {
  projectDir: string;
  outputDir: string;
  packageDirs: string[];
  config: ThirdPartyLicensesConfig;
}): Promise<void> {
  const dirs = [
    ...packageDirs,
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

  // A configured file name can name a subdirectory of the output directory.
  const write = (fileName: string, content: string) => {
    const file = path.join(outputDir, fileName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write(
    config.noticesFileName ?? DEFAULT_NOTICES_FILE_NAME,
    renderNotices(resolved, config, readProjectLicenseText(projectDir))
  );
  const manifestFileName =
    config.manifestFileName ?? DEFAULT_MANIFEST_FILE_NAME;
  if (manifestFileName) {
    write(manifestFileName, renderManifest(resolved));
  }
}
