import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import parseSpdx from 'spdx-expression-parse';

/**
 * Decides what the third-party license notices of a production build say,
 * whichever bundler produced it.
 *
 * MIT, ISC, BSD and Apache-2.0 all require the copyright notice and the
 * license text to travel with the distributed code, and MPL-2.0 section 3.2
 * additionally requires telling recipients where the source of the
 * MPL-covered files can be obtained. A minified bundle carries none of that,
 * so the notices are written next to it as a plain text file that is served
 * from the application root, accompanied by the same data as JSON for
 * automated license audits.
 *
 * Finding the bundled packages is left to the entry point of each bundler;
 * this module only decides what the notices say. Nothing here is specific to
 * an application -- everything that is comes in through
 * ThirdPartyLicensesConfig.
 */

export const DEFAULT_NOTICES_FILE_NAME = 'third-party-licenses.txt';
export const DEFAULT_MANIFEST_FILE_NAME = 'oss-licenses.json';
// The package root, whether this module runs from src/ or from dist/.
const LICENSE_TEXT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'licenseTexts'
);
const COPYRIGHT_PLACEHOLDER = '{{copyright}}';
const SEPARATOR = '-'.repeat(78);
const WRAP_COLUMNS = 78;

/**
 * Orders strings by their UTF-16 code units, as the default sort does. Used
 * where the order only has to be stable, since an order by locale would
 * depend on the machine the build runs on.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

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
  /**
   * The file of the package that holds the text of the elected license, for
   * a package that declares a choice of licenses and ships the text of each
   * in a file whose name does not say which license it holds.
   */
  licenseFile?: string;
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
   * Packages that are part of the application itself, such as the workspace
   * packages of a monorepo, under the license of the application. Package
   * names, or a whole scope such as "@scope/*". They are left out of the
   * notices and the manifest.
   */
  firstPartyPackages?: string[];
  /**
   * The license file of the application, relative to the project directory,
   * for a project whose own directory holds none or the wrong one, such as
   * an app in a monorepo. Found in the project directory by default.
   */
  projectLicenseFile?: string;
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

/**
 * One bundled package, as rollup-license-plugin describes it. Declared here
 * instead of imported, since the types of rollup-license-plugin import those
 * of Vite and Rollup, which an application built with Next need not have.
 */
export type BundledPackage = {
  name: string;
  version: string;
  author?: string | { name: string; email?: string; url?: string };
  license: string;
  licenseText: string;
  repository: string;
  source: string;
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
   * Whether the license text was rebuilt from the canonical texts of the
   * declared licenses, because the package ships no license file.
   */
  licenseTextReconstructed: boolean;
  /**
   * Whether the package ships license files, but none holds the text of the
   * license elected for it, so that the text was rebuilt anyway.
   */
  electedTextMissing?: boolean;
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
  author: BundledPackage['author']
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

type LicenseTerms = {
  /** The licenses the expression names, in its order, without repeats. */
  parts: string[];
  /** Whether it offers a choice between them, with OR. */
  choice: boolean;
};

/**
 * The licenses a license expression names, or undefined when it is not a
 * valid SPDX expression. A license with an exception or a "+" stays one
 * part, so that it never matches the canonical text of the bare license.
 */
function parseLicenseTerms(license: string): LicenseTerms | undefined {
  let expression: parseSpdx.Info;
  try {
    expression = parseSpdx(license);
  } catch {
    return undefined;
  }

  const terms: LicenseTerms = { parts: [], choice: false };
  const collect = (node: parseSpdx.Info): void => {
    if ('conjunction' in node) {
      terms.choice ||= node.conjunction === 'or';
      collect(node.left);
      collect(node.right);
      return;
    }
    const part =
      node.license +
      (node.plus ? '+' : '') +
      (node.exception ? ` WITH ${node.exception}` : '');
    if (!terms.parts.includes(part)) {
      terms.parts.push(part);
    }
  };
  collect(expression);
  return terms;
}

/**
 * Rebuilds the notice of a package that ships no license file, from the
 * license it declares and the author it names. An expression joining
 * licenses with AND gets the text of each one, since all of them apply.
 * Returns undefined when the expression offers a choice, which is a license
 * decision to make, or when any of its licenses has no canonical text.
 */
export function reconstructLicenseText(
  license: string,
  author?: string
): string | undefined {
  const terms = parseLicenseTerms(license);
  if (!terms || terms.choice) {
    return undefined;
  }
  const texts = terms.parts.map((part) => reconstructOne(part, author));
  if (!texts.every((text): text is string => text !== undefined)) {
    return undefined;
  }
  if (texts.length === 1) {
    return texts[0];
  }
  return texts
    .map(
      (text, i) =>
        `License text ${i + 1} of ${texts.length}: ${terms.parts[i]}\n\n` +
        text.trimEnd()
    )
    .join('\n\n');
}

function reconstructOne(license: string, author?: string): string | undefined {
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
export function readLicenseField(manifest: {
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
/** A license file, as rollup-license-plugin finds one. */
const LICENSE_FILE = /^licen[cs]e/i;
/**
 * Words only the text of each license contains, matched with whitespace
 * collapsed, so that the license file holding the text of an elected
 * license can be told from the others a package ships.
 */
const LICENSE_TEXT_MARKERS: Record<string, (text: string) => boolean> = {
  MIT: (text) => text.includes('Permission is hereby granted, free of charge'),
  ISC: (text) =>
    text.includes('Permission to use, copy, modify, and/or distribute') &&
    text.includes('provided that the above copyright notice'),
  'Apache-2.0': (text) => /Apache License,? Version 2\.0/.test(text),
  'MPL-2.0': (text) => /Mozilla Public License,? [Vv]ersion 2\.0/.test(text),
  'BSD-2-Clause': (text) =>
    text.includes('Redistribution and use in source and binary forms') &&
    !text.includes('Neither the name'),
  'BSD-3-Clause': (text) =>
    text.includes('Redistribution and use in source and binary forms') &&
    text.includes('Neither the name'),
  'OFL-1.1': (text) => /SIL OPEN FONT LICENSE,? Version 1\.1/i.test(text),
};

/**
 * Whether a file is named for a license, such as LICENSE.MIT or
 * licence-Apache-2.0.txt.
 */
export function isLicenseFileFor(fileName: string, license: string): boolean {
  const id = license.replaceAll(/[.+]/g, (char) => `\\${char}`);
  return new RegExp(`^licen[cs]e[.-]${id}(\\.(txt|md))?$`, 'i').test(fileName);
}

/** The license files a package ships, in a stable order. */
function readLicenseFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareCodeUnits);
  } catch {
    return [];
  }
}

/**
 * The text of the license a decision elects from the choice a package
 * declares: the file the decision names, a file named for the license, or
 * a license file holding its text. A package often ships the text of each
 * license of the choice, next to a file that names only the choice, so the
 * first license file found cannot be relied on. Undefined when none holds
 * the text, and the files that were looked at.
 */
function findElectedLicenseText(
  id: string,
  license: string,
  decision: LicenseDecision,
  dir: string | undefined,
  reportedText: string | undefined
): { text?: string; files: string[] } {
  const files = dir === undefined ? [] : readLicenseFiles(dir);
  const read = (file: string) => fs.readFileSync(path.join(dir!, file), 'utf8');

  if (decision.licenseFile !== undefined) {
    if (
      dir === undefined ||
      !fs.existsSync(path.join(dir, decision.licenseFile))
    ) {
      throw new Error(
        `${id} has no file ${decision.licenseFile}, which its license ` +
          'decision names as the text of the elected license.'
      );
    }
    return { text: read(decision.licenseFile), files };
  }
  const named = files.find((file) => isLicenseFileFor(file, license));
  if (named !== undefined) {
    return { text: read(named), files };
  }
  const holdsText = LICENSE_TEXT_MARKERS[license];
  const texts = dir === undefined ? [reportedText ?? ''] : files.map(read);
  return {
    text:
      holdsText &&
      texts.find((text) => holdsText(text.replaceAll(/\s+/g, ' '))),
    files,
  };
}

/**
 * Refuses decisions that could replace a license nobody has read: a pattern
 * other than a whole scope, or a scope pattern without the guard.
 */
export function validateDecisions(
  decisions: Record<string, LicenseDecision>
): void {
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
/**
 * Fails on a first-party entry that is neither a package name nor a whole
 * scope, which would otherwise silently match nothing.
 */
export function validateFirstPartyPackages(names: string[] = []): void {
  for (const name of names) {
    if (name.includes('*') && !SCOPE_PATTERN.test(name)) {
      throw new Error(
        `First-party package "${name}" is neither a package name nor a ` +
          'scope pattern such as "@scope/*".'
      );
    }
  }
}

/** Whether a package is part of the application, by its package name. */
export function isFirstParty(
  name: string,
  config: ThirdPartyLicensesConfig
): boolean {
  const names = config.firstPartyPackages ?? [];
  const scope = name.startsWith('@') ? `${name.split('/')[0]}/*` : undefined;
  return names.includes(name) || (scope !== undefined && names.includes(scope));
}

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
  /** The directory the package is installed in. */
  dir?: string;
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
          dir: path.join(directory, name),
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
 * declares comes from lookupInstalled, see findInstalledPackages, which
 * finds nothing when the package.json of the package was not found.
 */
export function resolvePackage(
  pkg: BundledPackage,
  config: ThirdPartyLicensesConfig,
  lookupInstalled: (
    name: string,
    version: string
  ) => Pick<InstalledPackage, 'declaredLicense' | 'dir'> | undefined = () =>
    undefined
): ResolvedPackage {
  const [decisionKey, decision] =
    findDecision(pkg.name, config.licenseDecisions) ?? [];
  const license = decision?.license ?? pkg.license;
  const author = formatAuthor(pkg.author);
  const id = `${pkg.name}@${pkg.version}`;

  const installed = decision
    ? lookupInstalled(pkg.name, pkg.version)
    : undefined;
  const declaredLicense = installed?.declaredLicense;
  if (
    decision?.declared !== undefined &&
    declaredLicense !== decision.declared
  ) {
    let declares = `declares "${declaredLicense}"`;
    if (!installed) {
      declares = 'has a package.json that could not be found';
    } else if (declaredLicense === undefined) {
      declares = 'declares no license';
    }
    throw new Error(
      `${id} ${declares}, but the license decision "${decisionKey}" ` +
        `applies only to packages declaring "${decision.declared}". Read ` +
        `the license of ${id} and update the decisions.`
    );
  }
  if (decision && !installed) {
    warnOnce(
      `${id}:declared`,
      `the package.json of ${id} was not found, so the notices state the ` +
        'license decided for it but not the one it declares.'
    );
  } else if (decision && declaredLicense === undefined) {
    warnOnce(
      `${id}:declared`,
      `the package.json of ${id} declares no license, so the notices ` +
        'state only the license decided for it.'
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

  let licenseText: string | undefined = pkg.licenseText;
  let electedFrom: string[] | undefined;
  // OR as an operator, between spaces, so that the "or" in an identifier
  // such as GPL-2.0-or-later does not count as a choice.
  if (
    decision &&
    declaredLicense !== undefined &&
    /\sOR\s/i.test(declaredLicense)
  ) {
    const elected = findElectedLicenseText(
      id,
      license,
      decision,
      installed?.dir,
      pkg.licenseText
    );
    licenseText = elected.text;
    electedFrom = elected.files;
  }

  if (licenseText) {
    // Leading blank lines only, so that an indented first line such as the
    // centred Apache-2.0 title keeps its indentation.
    resolved.licenseText = licenseText.replace(/^\n+/, '').trimEnd();
    return resolved;
  }

  const reconstructed = reconstructLicenseText(license, author);
  if (!reconstructed && electedFrom !== undefined) {
    throw new Error(
      `No license file of ${id} holds the text of ${license}, the license ` +
        `elected for it: ${electedFrom.join(', ') || 'it ships none'}. Name ` +
        'the file that does as licenseFile in its license decision.'
    );
  }
  if (!reconstructed) {
    warnOnce(id, `${id} ships no license file and ${whyNotRebuilt(license)}`);
    return resolved;
  }
  if (!author) {
    warnOnce(
      id,
      `${id} ships no license file ` +
        (electedFrom?.length ? `with the text of ${license} ` : '') +
        'and names no author, so its notice carries no copyright line.'
    );
  }

  resolved.licenseText = reconstructed.trimEnd();
  resolved.licenseTextReconstructed = true;
  resolved.electedTextMissing = (electedFrom?.length ?? 0) > 0 || undefined;
  return resolved;
}

/** Why the notice of a package shipping no license file was not rebuilt. */
function whyNotRebuilt(license: string): string {
  const terms = parseLicenseTerms(license);
  if (terms?.choice) {
    return (
      `declares a choice between licenses, "${license}", so only that ` +
      'choice can be stated. A license decision electing one of them gives ' +
      'it a rebuilt notice.'
    );
  }
  const missing = terms?.parts.filter((part) => !readCanonicalText(part)) ?? [
    license,
  ];
  return (
    `no canonical text for "${missing.join('", "')}" is available, so only ` +
    'the license it declares can be stated.'
  );
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
  } else if (pkg.electedTextMissing) {
    lines.push(
      wrapText(
        'The license files of this package do not hold the text of the ' +
          'license elected above. The notice below was reconstructed from ' +
          `the canonical text of the ${pkg.license} license and ` +
          (pkg.author
            ? 'the author its package.json names.'
            : 'names no copyright holder, since its package.json names no ' +
              'author.')
      ),
      '',
      pkg.licenseText
    );
  } else if (pkg.licenseTextReconstructed) {
    const combined = (parseLicenseTerms(pkg.license)?.parts.length ?? 0) > 1;
    lines.push(
      wrapText(
        'This package ships no license file. The notice below was ' +
          'reconstructed from ' +
          (combined
            ? `the canonical text of each license in the ${pkg.license} ` +
              'expression'
            : `the ${pkg.license} license`) +
          ' it declares in its ' +
          (pkg.author
            ? 'package.json and the author it names there.'
            : 'package.json. It names no author, so no copyright holder is ' +
              'stated.') +
          (combined
            ? ' Its package.json does not say which part of the package ' +
              'each license covers.'
            : '')
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
export function readProjectLicenseText(
  root: string,
  licenseFile?: string
): string | undefined {
  if (licenseFile !== undefined) {
    const file = path.resolve(root, licenseFile);
    if (!fs.existsSync(file)) {
      throw new Error(
        `The project license file "${licenseFile}" was not found in ${root}.`
      );
    }
    return fs.readFileSync(file, 'utf8');
  }
  const fileName = fs
    .readdirSync(root)
    .filter((name) => /^(licen[cs]e|copying)([.-].*)?$/i.test(name))
    .sort(compareCodeUnits)[0];
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
 * The directories of the packages listed in sassResolvedPackages. The
 * bundler never sees them, so a missing one fails the build rather than
 * dropping out of the notices.
 */
export function findSassResolvedPackages(
  root: string,
  names: string[] = []
): string[] {
  // The project and each directory above it, nearest first, as Node resolves
  // a package, so that a package hoisted to the root of a workspace is found.
  const dirs = [path.resolve(root)];
  while (path.dirname(dirs.at(-1)!) !== dirs.at(-1)) {
    dirs.push(path.dirname(dirs.at(-1)!));
  }
  return names.map((name) => {
    const packageDir = dirs
      .map((dir) => path.join(dir, 'node_modules', name))
      .find((candidate) => fs.existsSync(candidate));
    if (packageDir === undefined) {
      throw new Error(
        `Distributed package "${name}" was not found in node_modules, ` +
          'so its license would be missing from the third-party notices.'
      );
    }
    return packageDir;
  });
}
