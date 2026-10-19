import {
  createViteLicensePlugin,
  type LicenseMeta,
} from 'rollup-license-plugin';
import type { Plugin } from 'vite';

import {
  DEFAULT_MANIFEST_FILE_NAME,
  DEFAULT_NOTICES_FILE_NAME,
  findDecision,
  findInstalledPackages,
  findSassResolvedPackages,
  readProjectLicenseText,
  renderManifest,
  renderNotices,
  resolvePackage,
  validateDecisions,
  type InstalledPackage,
  type ThirdPartyLicensesConfig,
} from './core.js';

export * from './core.js';

/**
 * Emits the third-party license notices that ship with a Vite production
 * build. Finding the bundled packages is delegated to rollup-license-plugin,
 * which reports every package with rendered output in the bundle.
 */

/**
 * Collects the licenses of every npm package that contributes code to the
 * build and emits them as a text file, and optionally a JSON manifest, in
 * the build output.
 */
export function thirdPartyLicenses(config: ThirdPartyLicensesConfig): Plugin {
  const decisions = config.licenseDecisions ?? {};
  validateDecisions(decisions);

  // The project files are looked up from the Vite root, which is only known
  // once the config has been resolved, and not from the working directory.
  let root = process.cwd();
  // Both are filled in at the start of each build, see buildStart below.
  const licenseOverrides: Record<string, string> = {};
  let installedPackages = new Map<string, InstalledPackage>();

  const resolveAll = (packages: LicenseMeta[]) =>
    packages.map((pkg) =>
      resolvePackage(pkg, config, (name, version) =>
        installedPackages.get(`${name}@${version}`)
      )
    );

  const manifestFileName =
    config.manifestFileName ?? DEFAULT_MANIFEST_FILE_NAME;

  const plugin = createViteLicensePlugin({
    outputFilename: false,
    // A package declaring a license that is not a valid SPDX expression fails
    // the build unless a decision replaces it, see findInstalledPackages.
    licenseOverrides,
    additionalFiles: {
      [config.noticesFileName ?? DEFAULT_NOTICES_FILE_NAME]: (packages) =>
        renderNotices(
          resolveAll(packages),
          config,
          readProjectLicenseText(root)
        ),
      ...(manifestFileName
        ? {
            [manifestFileName]: (packages) =>
              renderManifest(resolveAll(packages)),
          }
        : {}),
    },
    includePackages: () =>
      findSassResolvedPackages(root, config.sassResolvedPackages),
  });

  return {
    ...plugin,
    configResolved(resolvedConfig) {
      root = resolvedConfig.root;
    },
    // rollup-license-plugin reads the overrides only when it generates the
    // bundle, so a scope pattern can be expanded here into the names of the
    // packages that are actually installed.
    buildStart() {
      const installed = findInstalledPackages(
        root,
        (name) => findDecision(name, decisions) !== undefined
      );
      installedPackages = new Map(
        installed.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg])
      );

      for (const name of Object.keys(licenseOverrides)) {
        delete licenseOverrides[name];
      }
      for (const [key, decision] of Object.entries(decisions)) {
        if (!key.includes('*')) {
          licenseOverrides[key] = decision.license;
        }
      }
      for (const { name } of installed) {
        const [, decision] = findDecision(name, decisions) ?? [];
        if (decision) {
          licenseOverrides[name] = decision.license;
        }
      }
    },
  };
}
