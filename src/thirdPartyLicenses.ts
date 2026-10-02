import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createViteLicensePlugin,
  type LicenseMeta,
} from 'rollup-license-plugin';
import type { Plugin } from 'vite';

/**
 * Emits the third-party license notices that ship with the production build.
 *
 * MIT, ISC, BSD and Apache-2.0 all require the copyright notice and the
 * license text to travel with the distributed code, and MPL-2.0 section 3.2
 * additionally requires telling recipients where the source of the
 * MPL-covered files can be obtained. A minified bundle carries none of that,
 * so the notices are written next to it as a plain text file that is served
 * from the application root, accompanied by the same data as JSON for
 * automated license audits.
 *
 * Finding the bundled packages is delegated to rollup-license-plugin; this
 * module only decides what the notices say. Nothing here is specific to this
 * repository -- everything that is comes in through ThirdPartyLicensesConfig.
 */

const DEFAULT_NOTICES_FILE_NAME = 'third-party-licenses.txt';
const DEFAULT_MANIFEST_FILE_NAME = 'oss-licenses.json';
// The package root, whether this module runs from src/ or from dist/.
const LICENSE_TEXT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'licenseTexts'
);
const COPYRIGHT_PLACEHOLDER = '{{copyright}}';
const SEPARATOR = '-'.repeat(78);
const WRAP_COLUMNS = 78;

/** A license identifier that replaces the one a package declares. */
export type LicenseDecision = {
  license: string;
  note: string;
  /**
   * The license the package must declare for the decision to apply. A
   * package the decision matches that declares anything else fails the
   * build, so that a license nobody has read is never replaced. Required
   * for a scope pattern, which may match packages added later.
   */
  declared?: string;
};

export type ThirdPartyLicensesConfig = {
  /** Browsable URL of this repository, named as the source of the app. */
  repositoryUrl: string;
  /**
   * Packages whose declared license is replaced in the notices, keyed by
   * package name or by a scope pattern such as "@ckeditor/*". Used to elect
   * one license of a dual-licensed package, or to record the SPDX identifier
   * matching the license file of a package that declares an ambiguous one.
   * The note says why, since a reader cannot check either from the bundle.
   * An exact name takes precedence over a pattern.
   */
  licenseDecisions?: Record<string, LicenseDecision>;
  /**
   * Distributed packages that stay invisible to the bundler, because Sass
   * resolves and inlines them while compiling the stylesheets.
   */
  sassResolvedPackages?: string[];
  /** Name of the human-readable notices file in the build output. */
  noticesFileName?: string;
  /**
   * Name of the machine-readable manifest in the build output, for license
   * audit tooling. Set to false to emit only the notices file.
   */
  manifestFileName?: string | false;
};

/** One bundled package, after the configured decisions have been applied. */
export type ResolvedPackage = {
  name: string;
  version: string;
  /** The license this distribution relies on. */
  license: string;
  /** Only present when it differs from the license above. */
  declaredLicense?: string;
  /** Why the two differ. */
  licenseNote?: string;
  author?: string;
  repository?: string;
  /** Package tarball on the npm registry. */
  source: string;
  licenseText?: string;
  /**
   * Whether the license text was rebuilt from the canonical text of the
   * declared license, because the package ships no license file.
   */
  licenseTextReconstructed: boolean;
};

/**
 * Wraps generated prose so the notices stay readable in a plain text file.
 * Quoted text, such as a command to run, is never split across lines.
 */
export function wrapText(text: string, columns = WRAP_COLUMNS): string {
  const lines: string[] = [];
  let line = '';

  for (const word of text.match(/(?:[^\s"]|"[^"]*")+|\S+/g) ?? []) {
    if (line.length === 0) {
      line = word;
    } else if (`${line} ${word}`.length <= columns) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) {
    lines.push(line);
  }
  return lines.join('\n');
}

/** The author of a package, as a plain "Name <email>" string. */
export function formatAuthor(
  author: LicenseMeta['author']
): string | undefined {
  if (typeof author === 'string') {
    return author.trim() || undefined;
  }
  if (author && typeof author === 'object' && typeof author.name === 'string') {
    return author.email
      ? `${author.name} <${author.email}>`
      : author.name || undefined;
  }
  return undefined;
}

const canonicalTextCache = new Map<string, string | undefined>();

/**
 * The canonical text of a license, kept in licenseTexts/ so that a package
 * shipping no license file of its own can still be given one.
 */
function readCanonicalText(license: string): string | undefined {
  if (!canonicalTextCache.has(license)) {
    // The identifier comes from a package.json and ends up in a path, so
    // anything that is not a plain SPDX identifier is refused.
    const safe = /^[\w.-]+$/.test(license);
    let text: string | undefined;
    try {
      // Leading blank lines only, as in the official Apache-2.0 file, so that
      // its centred title keeps its indentation.
      text = safe
        ? fs
            .readFileSync(path.join(LICENSE_TEXT_DIR, `${license}.txt`), 'utf8')
            .replace(/^\n+/, '')
        : undefined;
    } catch {
      text = undefined;
    }
    canonicalTextCache.set(license, text);
  }
  return canonicalTextCache.get(license);
}

/**
 * Rebuilds the notice of a package that ships no license file, from the
 * license it declares and the author it names. Returns undefined when no
 * canonical text is available for that license.
 */
export function reconstructLicenseText(
  license: string,
  author?: string
): string | undefined {
  const canonical = readCanonicalText(license);
  if (!canonical) {
    return undefined;
  }

  const copyright = author ? `Copyright (c) ${author}` : undefined;
  if (canonical.includes(COPYRIGHT_PLACEHOLDER)) {
    return copyright
      ? canonical.replace(`Copyright (c) ${COPYRIGHT_PLACEHOLDER}`, copyright)
      : // Without an author there is no copyright line to state, so the
        // canonical text is given without one.
        canonical
          .split('\n')
          .filter((line) => !line.includes(COPYRIGHT_PLACEHOLDER))
          .join('\n')
          .replace(/\n{3,}/g, '\n\n');
  }
  return copyright ? `${copyright}\n\n${canonical}` : canonical;
}

/** The license field of a package.json, in any of the shapes npm accepts. */
function readLicenseField(manifest: {
  license?: unknown;
  licenses?: unknown;
}): string | undefined {
  const { license, licenses } = manifest;
  if (typeof license === 'string') {
    return license;
  }
  if (license && typeof license === 'object' && 'type' in license) {
    return String(license.type);
  }
  if (Array.isArray(licenses) && licenses.length > 0) {
    return licenses
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter((type): type is string => typeof type === 'string')
      .join(' OR ');
  }
  return undefined;
}

const SCOPE_PATTERN = /^@[^/*]+\/\*$/;

/**
 * Refuses decisions that could replace a license nobody has read: a pattern
 * other than a whole scope, or a scope pattern without the guard.
 */
function validateDecisions(decisions: Record<string, LicenseDecision>): void {
  for (const [key, decision] of Object.entries(decisions)) {
    if (!key.includes('*')) {
      continue;
    }
    if (!SCOPE_PATTERN.test(key)) {
      throw new Error(
        `License decision "${key}" is neither a package name nor a scope ` +
          'pattern such as "@scope/*".'
      );
    }
    if (decision.declared === undefined) {
      throw new Error(
        `License decision "${key}" is a pattern, so it must state the ` +
          'license the packages it replaces declare, as "declared".'
      );
    }
  }
}

/**
 * The decision that applies to a package, with the key it is configured
 * under. An exact name takes precedence over the pattern of its scope.
 */
export function findDecision(
  name: string,
  decisions: Record<string, LicenseDecision> = {}
): [key: string, decision: LicenseDecision] | undefined {
  if (Object.hasOwn(decisions, name)) {
    return [name, decisions[name]];
  }
  const pattern = name.startsWith('@') ? `${name.split('/')[0]}/*` : undefined;
  if (pattern && Object.hasOwn(decisions, pattern)) {
    return [pattern, decisions[pattern]];
  }
  return undefined;
}

export type InstalledPackage = {
  name: string;
  version: string;
  declaredLicense?: string;
};

function readDirectory(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The package names installed directly in a node_modules directory. */
function packageNamesIn(nodeModules: string): string[] {
  return readDirectory(nodeModules)
    .filter((entry) => !entry.startsWith('.'))
    .flatMap((entry) =>
      entry.startsWith('@')
        ? readDirectory(path.join(nodeModules, entry)).map(
            (name) => `${entry}/${name}`
          )
        : [entry]
    );
}

/**
 * The installed packages whose name passes the filter, with the license
 * each one declares in its own package.json.
 *
 * Only packages with a decision need this: rollup-license-plugin rejects a
 * declared license that is not a valid SPDX expression, so a decision is
 * handed to it as a license override, and it then reports the package with
 * the decided license already in place. It also turns a scope pattern into
 * the names the plugin needs. Packages are looked up where npm, Yarn and a
 * hoisting pnpm install them, and in the pnpm virtual store.
 */
export function findInstalledPackages(
  root: string,
  include: (name: string) => boolean
): InstalledPackage[] {
  const nodeModules = path.join(root, 'node_modules');
  const store = path.join(nodeModules, '.pnpm');
  const directories = [
    nodeModules,
    ...readDirectory(store).map((entry) =>
      path.join(store, entry, 'node_modules')
    ),
  ];

  const found = new Map<string, InstalledPackage>();
  for (const directory of directories) {
    for (const name of packageNamesIn(directory).filter(include)) {
      let manifest;
      try {
        manifest = JSON.parse(
          fs.readFileSync(path.join(directory, name, 'package.json'), 'utf8')
        );
      } catch {
        continue;
      }
      if (typeof manifest.version === 'string') {
        found.set(`${name}@${manifest.version}`, {
          name,
          version: manifest.version,
          declaredLicense: readLicenseField(manifest),
        });
      }
    }
  }
  return [...found.values()];
}

/** Packages already warned about, so a warning is printed only once. */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[third-party-licenses] ${message}`);
  }
}

/**
 * Applies the configured decisions to one package, so that the notices and
 * the manifest describe it identically. The license a decided package
 * declares comes from lookupDeclaredLicense, see findInstalledPackages.
 */
export function resolvePackage(
  pkg: LicenseMeta,
  config: ThirdPartyLicensesConfig,
  lookupDeclaredLicense: (
    name: string,
    version: string
  ) => string | undefined = () => undefined
): ResolvedPackage {
  const [decisionKey, decision] =
    findDecision(pkg.name, config.licenseDecisions) ?? [];
  const license = decision?.license ?? pkg.license;
  const author = formatAuthor(pkg.author);
  const id = `${pkg.name}@${pkg.version}`;

  const declaredLicense = decision
    ? lookupDeclaredLicense(pkg.name, pkg.version)
    : undefined;
  if (
    decision?.declared !== undefined &&
    declaredLicense !== decision.declared
  ) {
    throw new Error(
      `${id} declares ` +
        (declaredLicense === undefined
          ? 'a license that could not be read'
          : `"${declaredLicense}"`) +
        `, but the license decision "${decisionKey}" applies only to ` +
        `packages declaring "${decision.declared}". Read the license of ` +
        `${id} and update the decisions.`
    );
  }
  if (decision && declaredLicense === undefined) {
    warnOnce(
      `${id}:declared`,
      `the package.json of ${id} was not found, so the notices state the ` +
        'license decided for it but not the one it declares.'
    );
  }
  if (COPYLEFT_LICENSE.test(license) && !isGpl2(license)) {
    throw new Error(
      `${id} is distributed under "${license}", and there are no notice ` +
        'rules for that license yet, so the notices could not meet its ' +
        'terms. Elect a license the notices support with a license ' +
        'decision, or add rules for this one to license-notices.'
    );
  }

  const resolved: ResolvedPackage = {
    name: pkg.name,
    version: pkg.version,
    license,
    declaredLicense,
    licenseNote: decision?.note,
    author,
    repository: pkg.repository || undefined,
    source: pkg.source,
    licenseTextReconstructed: false,
  };

  if (pkg.licenseText) {
    // Leading blank lines only, so that an indented first line such as the
    // centred Apache-2.0 title keeps its indentation.
    resolved.licenseText = pkg.licenseText.replace(/^\n+/, '').trimEnd();
    return resolved;
  }

  const reconstructed = reconstructLicenseText(license, author);
  if (!reconstructed) {
    warnOnce(
      id,
      `${id} ships no license file and no canonical text for "${license}" ` +
        'is available, so only the license it declares can be stated.'
    );
    return resolved;
  }
  if (!author) {
    warnOnce(
      id,
      `${id} ships no license file and names no author, so its notice ` +
        'carries no copyright line.'
    );
  }

  resolved.licenseText = reconstructed.trimEnd();
  resolved.licenseTextReconstructed = true;
  return resolved;
}

/**
 * Any GPL, LGPL, AGPL or EUPL identifier, including inside an expression.
 * Their terms go beyond attribution, so a package under one of them is only
 * distributed when the notices have rules for exactly that license.
 */
const COPYLEFT_LICENSE = /\b([AL]?GPL|EUPL)-\d/;

/** GPL-2.0 alone, in its current and deprecated SPDX spellings. */
function isGpl2(license: string): boolean {
  return /^\(?GPL-2\.0(-only|-or-later|\+)?\)?$/.test(license.trim());
}

function renderGnuGeneralPublicLicenseNotice(
  pkg: ResolvedPackage,
  config: ThirdPartyLicensesConfig
): string {
  // Section 3 counts offering the source from a place of its own as
  // distributing it, and section 1 requires a copy of the license, which is
  // given once at the end of the notices instead of once per component.
  return [
    wrapText(
      'GPL-2.0 section 3 notice: this component is distributed here in ' +
        'object code form as part of the application bundle. Its complete ' +
        'source code, in exactly the version listed above, is available at ' +
        `${pkg.repository ?? pkg.source} and from the npm registry with ` +
        `"npm pack ${pkg.name}@${pkg.version}". The source code of the rest ` +
        'of the application is available at:'
    ),
    config.repositoryUrl,
    '',
    wrapText(
      'The full text of the GNU General Public License, version 2, is ' +
        'reproduced at the end of this file.'
    ),
  ].join('\n');
}

/** The license text given once, at the end of notices with GPL components. */
function renderGnuGeneralPublicLicenseAppendix(): string {
  const text = readCanonicalText('GPL-2.0');
  if (!text) {
    throw new Error(
      'The text of GPL-2.0 is missing from license-notices, so the notices ' +
        'of GPL-2.0 components cannot carry it.'
    );
  }
  return [
    SEPARATOR,
    'GNU General Public License, version 2',
    '',
    wrapText(
      'The components above that are listed under GPL-2.0 are distributed ' +
        'under the terms of this license.'
    ),
    '',
    text.trimEnd(),
  ].join('\n');
}

function renderMozillaPublicLicenseNotice(pkg: ResolvedPackage): string {
  return wrapText(
    'MPL-2.0 section 3.2 notice: this component is distributed here in ' +
      'executable form as part of the application bundle. The complete ' +
      'source code of its MPL-covered files, in exactly the version listed ' +
      `above, is available at ${pkg.repository ?? pkg.source} and from the ` +
      `npm registry with "npm pack ${pkg.name}@${pkg.version}".`
  );
}

function renderEntry(
  pkg: ResolvedPackage,
  config: ThirdPartyLicensesConfig
): string {
  const lines = [
    SEPARATOR,
    `${pkg.name}@${pkg.version}`,
    `License: ${pkg.license}`,
  ];
  if (pkg.declaredLicense) {
    lines.push(`Declared as: ${pkg.declaredLicense}`);
  }
  lines.push('');

  if (pkg.licenseNote) {
    lines.push(wrapText(pkg.licenseNote), '');
  }
  if (/\bMPL-2\.0\b/.test(pkg.license)) {
    lines.push(renderMozillaPublicLicenseNotice(pkg), '');
  }
  if (isGpl2(pkg.license)) {
    lines.push(renderGnuGeneralPublicLicenseNotice(pkg, config), '');
  }

  if (!pkg.licenseText) {
    lines.push(
      wrapText(
        'This package ships no license file. The identifier above is the ' +
          `one ${pkg.name} declares in its package.json, and the canonical ` +
          'text of that license applies.'
      )
    );
  } else if (pkg.licenseTextReconstructed) {
    lines.push(
      wrapText(
        'This package ships no license file. The notice below was ' +
          `reconstructed from the ${pkg.license} license it declares in its ` +
          (pkg.author
            ? 'package.json and the author it names there.'
            : 'package.json. It names no author, so no copyright holder is ' +
              'stated.')
      ),
      '',
      pkg.licenseText
    );
  } else {
    lines.push(pkg.licenseText);
  }

  return lines.join('\n');
}

function byNameAndVersion(a: ResolvedPackage, b: ResolvedPackage): number {
  return a.name === b.name
    ? a.version.localeCompare(b.version)
    : a.name.localeCompare(b.name);
}

/**
 * Renders the human-readable notices. The output is sorted and free of
 * timestamps, so an unchanged dependency set produces an unchanged file.
 */
export function renderNotices(
  packages: ResolvedPackage[],
  config: ThirdPartyLicensesConfig,
  projectLicenseText?: string
): string {
  // The license of the application requires its own permission notice to
  // travel with the code as well, and the deployed image carries nothing but
  // the build output.
  const header = [
    'Third-party license notices',
    '===========================',
    '',
    'The application itself is distributed under the following license.',
    // Kept on an unwrapped line of its own so the link stays clickable.
    `Source: ${config.repositoryUrl}`,
    ...(projectLicenseText ? ['', projectLicenseText.trimEnd()] : []),
  ].join('\n');

  return [
    header,
    ...[...packages]
      .sort(byNameAndVersion)
      .map((pkg) => renderEntry(pkg, config)),
    ...(packages.some((pkg) => isGpl2(pkg.license))
      ? [renderGnuGeneralPublicLicenseAppendix()]
      : []),
    SEPARATOR,
    '',
  ].join('\n\n');
}

/**
 * Renders the same packages as JSON, for license audit tooling. The shape
 * follows the manifest rollup-license-plugin emits by default, with the
 * decisions of this build recorded in the additional fields.
 */
export function renderManifest(packages: ResolvedPackage[]): string {
  const entries = [...packages].sort(byNameAndVersion).map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    author: pkg.author,
    repository: pkg.repository,
    source: pkg.source,
    license: pkg.license,
    declaredLicense: pkg.declaredLicense,
    licenseNote: pkg.licenseNote,
    licenseText: pkg.licenseText,
    licenseTextReconstructed: pkg.licenseTextReconstructed || undefined,
  }));
  return `${JSON.stringify(entries, null, 2)}\n`;
}

/** Reads the license file of the project itself, when it has one. */
function readProjectLicenseText(root: string): string | undefined {
  const fileName = fs
    .readdirSync(root)
    .filter((name) => /^(licen[cs]e|copying)([.-].*)?$/i.test(name))
    .sort()[0];
  if (!fileName) {
    warnOnce(
      'project-license',
      'the project has no license file, so the notices cannot carry the ' +
        'license of the application itself.'
    );
    return undefined;
  }
  return fs.readFileSync(path.join(root, fileName), 'utf8');
}

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
  let declaredLicenses = new Map<string, string | undefined>();

  const resolveAll = (packages: LicenseMeta[]) =>
    packages.map((pkg) =>
      resolvePackage(pkg, config, (name, version) =>
        declaredLicenses.get(`${name}@${version}`)
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
      (config.sassResolvedPackages ?? []).map((name) => {
        const packageDir = path.resolve(root, 'node_modules', name);
        if (!fs.existsSync(packageDir)) {
          throw new Error(
            `Distributed package "${name}" was not found in node_modules, ` +
              'so its license would be missing from the third-party notices.'
          );
        }
        return packageDir;
      }),
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
      declaredLicenses = new Map(
        installed.map((pkg) => [
          `${pkg.name}@${pkg.version}`,
          pkg.declaredLicense,
        ])
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
