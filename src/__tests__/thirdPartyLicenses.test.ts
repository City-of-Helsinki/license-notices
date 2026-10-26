import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LicenseMeta } from 'rollup-license-plugin';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compareCodeUnits,
  formatAuthor,
  findDecision,
  isFirstParty,
  isLicenseFileFor,
  findInstalledPackages,
  findSassResolvedPackages,
  readProjectLicenseText,
  reconstructLicenseText,
  renderManifest,
  renderNotices,
  resolvePackage,
  thirdPartyLicenses,
  validateFirstPartyPackages,
  wrapText,
  type ThirdPartyLicensesConfig,
} from '../thirdPartyLicenses.js';
import { createTempProject, type TempProject } from './tempProject.js';

const config = (
  overrides: Partial<ThirdPartyLicensesConfig> = {}
): ThirdPartyLicensesConfig => ({
  repositoryUrl: 'https://github.com/example/app',
  ...overrides,
});

const pkg = (overrides: Partial<LicenseMeta> = {}): LicenseMeta =>
  ({
    name: 'example',
    version: '1.0.0',
    license: 'MIT',
    licenseText: 'MIT License, Copyright (c) Example',
    repository: 'https://github.com/example/example',
    source: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
    ...overrides,
  }) as LicenseMeta;

// Mirrors rollup-license-plugin, which reports a decided package with the
// decided license already in place, while the package itself still declares
// the license given in the overrides.
const resolve = (
  overrides: Partial<LicenseMeta> = {},
  configOverrides: Partial<ThirdPartyLicensesConfig> = {}
) => {
  const declared = pkg(overrides);
  const resolvedConfig = config(configOverrides);
  const decided = resolvedConfig.licenseDecisions?.[declared.name]?.license;

  return resolvePackage(
    decided ? { ...declared, license: decided } : declared,
    resolvedConfig,
    (name, version) =>
      name === declared.name && version === declared.version
        ? { declaredLicense: declared.license }
        : undefined
  );
};

const dompurifyDecision = {
  licenseDecisions: {
    dompurify: {
      license: 'Apache-2.0',
      note: 'This distribution elects Apache-2.0.',
    },
  },
};

describe('formatAuthor', () => {
  it('reads the string and object forms', () => {
    expect(formatAuthor('Jane Doe <jane@example.test>')).toBe(
      'Jane Doe <jane@example.test>'
    );
    expect(formatAuthor({ name: 'Jane Doe', email: 'jane@example.test' })).toBe(
      'Jane Doe <jane@example.test>'
    );
    expect(formatAuthor({ name: 'Jane Doe' })).toBe('Jane Doe');
  });

  it('reports nothing when no author is named', () => {
    expect(formatAuthor(undefined)).toBeUndefined();
    expect(formatAuthor('')).toBeUndefined();
  });
});

describe('reconstructLicenseText', () => {
  it('puts the author into the copyright line of the canonical text', () => {
    const text = reconstructLicenseText('MIT', 'Jane Doe <jane@example.test>');

    expect(text).toContain('Copyright (c) Jane Doe <jane@example.test>');
    expect(text).toContain('Permission is hereby granted, free of charge');
    expect(text).not.toContain('{{copyright}}');
  });

  it('leaves out the copyright line when no author is known', () => {
    const text = reconstructLicenseText('MIT');

    expect(text).toContain('Permission is hereby granted, free of charge');
    expect(text).not.toContain('Copyright');
    expect(text).not.toContain('{{copyright}}');
  });

  it('puts the copyright above texts that carry no placeholder', () => {
    const text = reconstructLicenseText('Apache-2.0', 'Jane Doe');

    const [copyright, blank, title] = text?.split('\n') ?? [];
    expect(copyright).toBe('Copyright (c) Jane Doe');
    expect(blank).toBe('');
    // The centred title keeps its indentation.
    expect(title).toMatch(/^ {10,}Apache License$/);
    expect(text).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION');
  });

  it('has no canonical text for a license it does not carry', () => {
    expect(reconstructLicenseText('MPL-2.0', 'Jane Doe')).toBeUndefined();
  });

  it('refuses an identifier that is not a plain SPDX id', () => {
    expect(reconstructLicenseText('../../etc/passwd')).toBeUndefined();
    expect(
      reconstructLicenseText('(MIT AND ../../etc/passwd)')
    ).toBeUndefined();
  });

  it('puts the author above the OFL-1.1 text, which has no copyright line', () => {
    const text = reconstructLicenseText('OFL-1.1', 'Dave Gandy');

    expect(text?.split('\n').slice(0, 4)).toEqual([
      'Copyright (c) Dave Gandy',
      '',
      '-'.repeat(59),
      'SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007',
    ]);
    // Neither the template header nor a Reserved Font Name is carried.
    expect(text).not.toContain('with Reserved Font Name');
    expect(text).not.toContain('This Font Software is licensed under');
  });

  it('gives the OFL-1.1 text alone when no author is known', () => {
    const text = reconstructLicenseText('OFL-1.1');

    expect(text?.startsWith(`${'-'.repeat(59)}\nSIL OPEN FONT LICENSE`)).toBe(
      true
    );
    expect(text).not.toContain('Copyright (c)');
  });

  it('gives each license of an AND expression its own labelled text', () => {
    const text = reconstructLicenseText('(OFL-1.1 AND MIT)', 'Dave Gandy');

    expect(text?.startsWith('License text 1 of 2: OFL-1.1\n\n')).toBe(true);
    expect(text).toContain(
      'License text 2 of 2: MIT\n\nMIT License\n\nCopyright (c) Dave Gandy'
    );
    // Both full texts, OFL-1.1 first, as the expression names them.
    expect(text?.indexOf('SIL OPEN FONT LICENSE Version 1.1')).toBeLessThan(
      text?.indexOf('Permission is hereby granted, free of charge') ?? -1
    );
    expect(text).toContain('OTHER DEALINGS IN THE FONT SOFTWARE.');
    expect(text).not.toContain('{{copyright}}');
  });

  it('flattens a longer AND chain in the order of the expression', () => {
    const text = reconstructLicenseText('MIT AND (ISC AND Apache-2.0)');

    expect(text?.match(/^License text .*$/gm)).toEqual([
      'License text 1 of 3: MIT',
      'License text 2 of 3: ISC',
      'License text 3 of 3: Apache-2.0',
    ]);
  });

  it('does not pick a license out of an OR expression', () => {
    expect(reconstructLicenseText('(MIT OR Apache-2.0)')).toBeUndefined();
    expect(
      reconstructLicenseText('MIT AND (ISC OR Apache-2.0)')
    ).toBeUndefined();
  });

  it('rebuilds nothing when one license of an AND has no canonical text', () => {
    expect(reconstructLicenseText('(OFL-1.1 AND MPL-2.0)')).toBeUndefined();
  });

  it('does not take a license with an exception for the bare license', () => {
    expect(
      reconstructLicenseText('Apache-2.0 WITH LLVM-exception')
    ).toBeUndefined();
  });
});

describe('the OFL-1.1 text', () => {
  const file = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../licenseTexts/OFL-1.1.txt'
  );

  // The official text is https://openfontlicense.org/documents/OFL.txt, as
  // fetched on 2026-10-19 (Last-Modified 2026-01-12). The file keeps it from
  // the rule line above "SIL OPEN FONT LICENSE Version 1.1" to the end, byte
  // for byte, leaving out only the template header for font authors. The OFL
  // is to be reproduced unmodified, so any edit or re-wrap must fail here.
  it('is the body of the official text, byte for byte', () => {
    expect(
      createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    ).toBe('ebc109078c06f79af74cf2b27454c262830d12a65749f0e2bf25d1ac1db7a02a');
  });

  it('is carried into a rebuilt notice unchanged', () => {
    const resolved = resolve({
      license: 'OFL-1.1',
      licenseText: undefined,
      author: 'Dave Gandy',
    });

    expect(resolved.licenseText).toBe(
      `Copyright (c) Dave Gandy\n\n${fs.readFileSync(file, 'utf8').trimEnd()}`
    );
  });
});

describe('resolvePackage', () => {
  it('keeps the declared license when no decision applies', () => {
    const resolved = resolve();

    expect(resolved.license).toBe('MIT');
    expect(resolved.declaredLicense).toBeUndefined();
    expect(resolved.licenseTextReconstructed).toBe(false);
  });

  it('records both licenses when a decision applies', () => {
    const resolved = resolve(
      { name: 'dompurify', license: '(MPL-2.0 OR Apache-2.0)' },
      dompurifyDecision
    );

    expect(resolved.license).toBe('Apache-2.0');
    expect(resolved.declaredLicense).toBe('(MPL-2.0 OR Apache-2.0)');
    expect(resolved.licenseNote).toContain('elects Apache-2.0');
  });

  it('states only the decided license when the declared one is not found', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = resolvePackage(
      pkg({ name: 'dompurify', version: '9.9.9', license: 'Apache-2.0' }),
      config(dompurifyDecision),
      () => undefined
    );

    expect(resolved.license).toBe('Apache-2.0');
    expect(resolved.declaredLicense).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('package.json of dompurify@9.9.9 was not found')
    );
    warn.mockRestore();
  });

  it('tells a package.json without a license from a missing one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = resolvePackage(
      pkg({ name: 'dompurify', version: '9.9.8', license: 'Apache-2.0' }),
      config(dompurifyDecision),
      () => ({ declaredLicense: undefined })
    );

    expect(resolved.declaredLicense).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'package.json of dompurify@9.9.8 declares no license'
      )
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('was not found')
    );
    warn.mockRestore();
  });

  it('reconstructs the text of a package shipping no license file', () => {
    const resolved = resolve({
      name: 'tiny-case',
      licenseText: undefined,
      author: 'Jason Quense',
    });

    expect(resolved.licenseTextReconstructed).toBe(true);
    expect(resolved.licenseText).toContain('Copyright (c) Jason Quense');
  });

  it('rebuilds the notice of a package declaring an AND expression', () => {
    const resolved = resolve({
      name: 'font-awesome',
      version: '4.7.0',
      license: '(OFL-1.1 AND MIT)',
      licenseText: undefined,
      author: { name: 'Dave Gandy', email: 'dave@fontawesome.io' },
    });

    expect(resolved.license).toBe('(OFL-1.1 AND MIT)');
    expect(resolved.licenseTextReconstructed).toBe(true);
    expect(resolved.licenseText).toContain('License text 1 of 2: OFL-1.1');
    expect(resolved.licenseText).toContain('License text 2 of 2: MIT');
  });

  it('asks for a decision instead of rebuilding an OR expression', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = resolve({
      name: 'either',
      license: '(MIT OR Apache-2.0)',
      licenseText: undefined,
    });

    expect(resolved.licenseText).toBeUndefined();
    expect(resolved.licenseTextReconstructed).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'either@1.0.0 ships no license file and declares a choice between ' +
          'licenses, "(MIT OR Apache-2.0)"'
      )
    );
    warn.mockRestore();
  });

  it('names the license of an AND expression that has no text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = resolve({
      name: 'half-known',
      license: '(OFL-1.1 AND MPL-2.0)',
      licenseText: undefined,
    });

    expect(resolved.licenseText).toBeUndefined();
    expect(resolved.licenseTextReconstructed).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no canonical text for "MPL-2.0" is available')
    );
    warn.mockRestore();
  });

  it('leaves the text out when nothing can reconstruct it', () => {
    const resolved = resolve({
      name: 'odd',
      license: 'SEE LICENSE IN FILE',
      licenseText: undefined,
    });

    expect(resolved.licenseText).toBeUndefined();
    expect(resolved.licenseTextReconstructed).toBe(false);
  });
});

describe('isLicenseFileFor', () => {
  it('matches a license file named for a license', () => {
    for (const name of [
      'LICENSE.MIT',
      'LICENSE-MIT',
      'licence.mit.txt',
      'License-Apache-2.0.md',
      'LICENCE.MPL-2.0',
    ]) {
      const license = name.match(/MIT|Apache-2\.0|MPL-2\.0/i)![0];
      expect(isLicenseFileFor(name, license), name).toBe(true);
    }
  });

  it('matches no other file', () => {
    expect(isLicenseFileFor('LICENSE', 'MIT')).toBe(false);
    expect(isLicenseFileFor('LICENSE.MIT.bak', 'MIT')).toBe(false);
    expect(isLicenseFileFor('LICENSE-MPL', 'MPL-2.0')).toBe(false);
    expect(isLicenseFileFor('LICENSE.MPL-2.0', 'MIT')).toBe(false);
    expect(isLicenseFileFor('NOTICE.MIT', 'MIT')).toBe(false);
  });
});

describe('a license elected from a choice', () => {
  let project: TempProject;

  afterEach(() => project.remove());

  const MIT_TEXT =
    'MIT License\n\nCopyright (c) Saša Jovanić\n\nPermission is hereby ' +
    'granted, free of charge, to any person obtaining a copy\n';
  const APACHE_TEXT =
    '\n                                 Apache License\n' +
    '                           Version 2.0, January 2004\n';
  const MPL_TEXT = 'Mozilla Public License Version 2.0\n==================\n';

  /** Resolves a package installed with the given files, as decided. */
  const resolveInstalled = ({
    name,
    declared,
    files,
    decision,
    reportedText,
  }: {
    name: string;
    declared: string;
    files: Record<string, string>;
    decision: { license: string; licenseFile?: string };
    reportedText?: string;
  }) => {
    project = createTempProject(
      Object.fromEntries(
        Object.entries(files).map(([file, text]) => [
          `node_modules/${name}/${file}`,
          text,
        ])
      )
    );
    const dir = path.join(project.root, 'node_modules', name);
    return resolvePackage(
      pkg({
        name,
        license: decision.license,
        author: 'Saša Jovanić',
        licenseText: reportedText,
      }),
      config({
        licenseDecisions: { [name]: { ...decision, note: 'Elected.' } },
      }),
      () => ({ declaredLicense: declared, dir })
    );
  };

  it('uses the file named for the elected license', () => {
    const resolved = resolveInstalled({
      name: 'ibantools',
      declared: 'MIT or MPL-2.0',
      files: {
        LICENSE: 'MIT OR MPL-2.0',
        'LICENSE.MIT': MIT_TEXT,
        'LICENSE.MPL-2.0': MPL_TEXT,
      },
      decision: { license: 'MIT' },
      reportedText: 'MIT OR MPL-2.0',
    });

    expect(resolved.licenseText).toContain('Copyright (c) Saša Jovanić');
    expect(resolved.licenseTextReconstructed).toBe(false);
  });

  it('uses the license file whose text is the elected license', () => {
    // As if the directory listed LICENSE-MPL first, which the order of a
    // directory listing allows.
    const resolved = resolveInstalled({
      name: 'dompurify',
      declared: '(MPL-2.0 OR Apache-2.0)',
      files: { LICENSE: APACHE_TEXT, 'LICENSE-MPL': MPL_TEXT },
      decision: { license: 'Apache-2.0' },
      reportedText: MPL_TEXT,
    });

    expect(resolved.licenseText).toContain('Apache License');
    expect(resolved.licenseText).not.toContain('Mozilla');
  });

  it('uses the license file the decision names', () => {
    const resolved = resolveInstalled({
      name: 'dompurify',
      declared: '(MPL-2.0 OR Apache-2.0)',
      files: { LICENSE: APACHE_TEXT, 'LICENSE-MPL': MPL_TEXT },
      decision: { license: 'MPL-2.0', licenseFile: 'LICENSE-MPL' },
      reportedText: APACHE_TEXT,
    });

    expect(resolved.licenseText).toContain('Mozilla Public License');
  });

  it('fails when the license file the decision names is missing', () => {
    expect(() =>
      resolveInstalled({
        name: 'dompurify',
        declared: '(MPL-2.0 OR Apache-2.0)',
        files: { LICENSE: APACHE_TEXT },
        decision: { license: 'MPL-2.0', licenseFile: 'LICENSE-MPL' },
        reportedText: APACHE_TEXT,
      })
    ).toThrow('dompurify@1.0.0 has no file LICENSE-MPL');
  });

  it('rebuilds the notice when no license file holds the elected text', () => {
    const resolved = resolveInstalled({
      name: 'ibantools',
      declared: 'MIT or MPL-2.0',
      files: { LICENSE: 'MIT OR MPL-2.0' },
      decision: { license: 'MIT' },
      reportedText: 'MIT OR MPL-2.0',
    });

    expect(resolved.licenseTextReconstructed).toBe(true);
    expect(resolved.licenseText).toContain('Copyright (c) Saša Jovanić');
    expect(renderNotices([resolved], config(), undefined)).toContain(
      'The license files of this package do not hold the text of the license'
    );
  });

  it('fails when no license file holds the elected text and none is kept', () => {
    expect(() =>
      resolveInstalled({
        name: 'ibantools',
        declared: 'MIT or MPL-2.0',
        files: { LICENSE: 'MIT OR MPL-2.0', 'LICENSE.MIT': MIT_TEXT },
        decision: { license: 'MPL-2.0' },
        reportedText: 'MIT OR MPL-2.0',
      })
    ).toThrow(
      'No license file of ibantools@1.0.0 holds the text of MPL-2.0, the ' +
        'license elected for it: LICENSE, LICENSE.MIT.'
    );
  });

  it('keeps the license file of a package declaring no choice', () => {
    const resolved = resolveInstalled({
      name: 'old-bsd',
      declared: 'BSD',
      files: { LICENSE: 'Redistribution and use, Copyright Old' },
      decision: { license: 'BSD-3-Clause' },
      reportedText: 'Redistribution and use, Copyright Old',
    });

    expect(resolved.licenseText).toBe('Redistribution and use, Copyright Old');
    expect(resolved.licenseTextReconstructed).toBe(false);
  });

  it('keeps the license file of a license with "or" in its identifier', () => {
    const resolved = resolveInstalled({
      name: 'gpl-lib',
      declared: 'GPL-2.0-or-later',
      files: { LICENSE: 'GNU GENERAL PUBLIC LICENSE, Copyright Gpl' },
      decision: { license: 'GPL-2.0-only' },
      reportedText: 'GNU GENERAL PUBLIC LICENSE, Copyright Gpl',
    });

    expect(resolved.licenseText).toBe(
      'GNU GENERAL PUBLIC LICENSE, Copyright Gpl'
    );
    expect(resolved.licenseTextReconstructed).toBe(false);
  });
});

describe('isFirstParty', () => {
  it('matches names and whole scopes', () => {
    const firstParty = config({ firstPartyPackages: ['hds-core', '@hds/*'] });

    expect(isFirstParty('hds-core', firstParty)).toBe(true);
    expect(isFirstParty('@hds/x', firstParty)).toBe(true);
    // The directory of an archived copy, never the name of a package.
    expect(isFirstParty('hds-core-4.10.0', firstParty)).toBe(false);
    expect(isFirstParty('hds-react', firstParty)).toBe(false);
    expect(isFirstParty('hds-core', config())).toBe(false);
  });

  it('refuses a pattern other than a whole scope', () => {
    expect(() => validateFirstPartyPackages(['hds-*'])).toThrow(
      'First-party package "hds-*" is neither a package name nor a scope ' +
        'pattern such as "@scope/*".'
    );
  });
});

describe('findDecision', () => {
  const decisions = {
    '@ckeditor/*': {
      declared: 'SEE LICENSE IN LICENSE.md',
      license: 'GPL-2.0-or-later',
      note: 'Pattern.',
    },
    '@ckeditor/ckeditor5-react': { license: 'MIT', note: 'Exact.' },
  };

  it('matches every package of a scope pattern', () => {
    expect(findDecision('@ckeditor/ckeditor5-core', decisions)?.[0]).toBe(
      '@ckeditor/*'
    );
  });

  it('prefers an exact name over the pattern of its scope', () => {
    expect(findDecision('@ckeditor/ckeditor5-react', decisions)?.[0]).toBe(
      '@ckeditor/ckeditor5-react'
    );
  });

  it('does not match an unscoped package of the same name', () => {
    expect(findDecision('ckeditor', decisions)).toBeUndefined();
    expect(findDecision('@ckeditorx/core', decisions)).toBeUndefined();
  });
});

describe('the license decision guard', () => {
  const guarded = {
    licenseDecisions: {
      '@vendor/*': {
        declared: 'SEE LICENSE IN LICENSE.md',
        license: 'GPL-2.0-or-later',
        note: 'Offered under the GPL.',
      },
    },
  };

  it('replaces the license a package declares as expected', () => {
    const resolved = resolve(
      { name: '@vendor/core', license: 'SEE LICENSE IN LICENSE.md' },
      guarded
    );

    expect(resolved.license).toBe('GPL-2.0-or-later');
    expect(resolved.declaredLicense).toBe('SEE LICENSE IN LICENSE.md');
  });

  it('fails on a package declaring anything else', () => {
    expect(() =>
      resolve({ name: '@vendor/new', license: 'BUSL-1.1' }, guarded)
    ).toThrow(
      '@vendor/new@1.0.0 declares "BUSL-1.1", but the license decision ' +
        '"@vendor/*" applies only to packages declaring ' +
        '"SEE LICENSE IN LICENSE.md"'
    );
  });

  it('fails when the package.json of the package is not found', () => {
    expect(() =>
      resolvePackage(
        pkg({ name: '@vendor/core', license: 'GPL-2.0-or-later' }),
        config(guarded),
        () => undefined
      )
    ).toThrow(
      '@vendor/core@1.0.0 has a package.json that could not be found, but ' +
        'the license decision "@vendor/*" applies only'
    );
  });

  it('fails when the package.json declares no license', () => {
    expect(() =>
      resolvePackage(
        pkg({ name: '@vendor/core', license: 'GPL-2.0-or-later' }),
        config(guarded),
        () => ({ declaredLicense: undefined })
      )
    ).toThrow(
      '@vendor/core@1.0.0 declares no license, but the license decision ' +
        '"@vendor/*" applies only'
    );
  });

  it('refuses a pattern without the guard', () => {
    expect(() =>
      thirdPartyLicenses(
        config({
          licenseDecisions: {
            '@vendor/*': { license: 'MIT', note: 'Unguarded.' },
          },
        })
      )
    ).toThrow('must state the license the packages it replaces declare');
  });

  it('refuses a pattern other than a whole scope', () => {
    expect(() =>
      thirdPartyLicenses(
        config({
          licenseDecisions: {
            'ckeditor5-*': {
              declared: 'SEE LICENSE IN LICENSE.md',
              license: 'MIT',
              note: 'Prefix.',
            },
          },
        })
      )
    ).toThrow('is neither a package name nor a scope pattern');
  });
});

describe('readProjectLicenseText', () => {
  let project: TempProject;

  afterEach(() => project.remove());

  it('reads the license file the config names', () => {
    project = createTempProject({
      'site/LICENSE': 'Gatsby',
      LICENSE: 'City of Helsinki',
    });

    expect(
      readProjectLicenseText(path.join(project.root, 'site'), '../LICENSE')
    ).toBe('City of Helsinki');
  });

  it('fails when the license file the config names is missing', () => {
    project = createTempProject({ 'site/LICENSE': 'Gatsby' });

    expect(() =>
      readProjectLicenseText(path.join(project.root, 'site'), '../NOPE')
    ).toThrow('The project license file "../NOPE" was not found');
  });
});

describe('findSassResolvedPackages', () => {
  let project: TempProject;

  afterEach(() => project.remove());

  it('finds a package installed in a directory above the project', () => {
    project = createTempProject({
      'node_modules/tokens/package.json': { name: 'tokens', version: '1.0.0' },
      'site/package.json': { name: 'site' },
    });

    expect(
      findSassResolvedPackages(path.join(project.root, 'site'), ['tokens'])
    ).toEqual([path.join(project.root, 'node_modules/tokens')]);
  });
});

describe('findInstalledPackages', () => {
  let project: TempProject;

  afterEach(() => project.remove());

  const all = () => true;

  it('reads packages installed at the top of node_modules', () => {
    project = createTempProject({
      'node_modules/ckeditor5/package.json': {
        version: '47.6.1',
        license: 'SEE LICENSE IN LICENSE.md',
      },
      'node_modules/@ckeditor/ckeditor5-core/package.json': {
        version: '47.6.1',
        license: 'SEE LICENSE IN LICENSE.md',
      },
    });

    expect(findInstalledPackages(project.root, all)).toEqual(
      expect.arrayContaining([
        {
          name: 'ckeditor5',
          version: '47.6.1',
          declaredLicense: 'SEE LICENSE IN LICENSE.md',
          dir: path.join(project.root, 'node_modules/ckeditor5'),
        },
        {
          name: '@ckeditor/ckeditor5-core',
          version: '47.6.1',
          declaredLicense: 'SEE LICENSE IN LICENSE.md',
          dir: path.join(project.root, 'node_modules/@ckeditor/ckeditor5-core'),
        },
      ])
    );
  });

  it('finds every version in the pnpm virtual store', () => {
    project = createTempProject({
      'node_modules/.pnpm/@scope+dual@2.0.0_react@19.2.6/node_modules/@scope/dual/package.json':
        { version: '2.0.0', license: '(MPL-2.0 OR Apache-2.0)' },
      'node_modules/.pnpm/@scope+dual@1.0.0/node_modules/@scope/dual/package.json':
        { version: '1.0.0', license: 'MIT' },
    });

    expect(
      findInstalledPackages(project.root, all).sort((a, b) =>
        a.version.localeCompare(b.version)
      )
    ).toEqual([
      expect.objectContaining({
        name: '@scope/dual',
        version: '1.0.0',
        declaredLicense: 'MIT',
        dir: expect.stringContaining(
          '@scope+dual@1.0.0/node_modules/@scope/dual'
        ),
      }),
      expect.objectContaining({
        name: '@scope/dual',
        version: '2.0.0',
        declaredLicense: '(MPL-2.0 OR Apache-2.0)',
        dir: expect.stringContaining(
          '@scope+dual@2.0.0_react@19.2.6/node_modules/@scope/dual'
        ),
      }),
    ]);
  });

  it('finds packages installed in a directory above the project', () => {
    project = createTempProject({
      'node_modules/dompurify/package.json': {
        version: '3.2.7',
        license: '(MPL-2.0 OR Apache-2.0)',
      },
      'node_modules/.pnpm/ckeditor5@47.6.1/node_modules/ckeditor5/package.json':
        { version: '47.6.1', license: 'SEE LICENSE IN LICENSE.md' },
      'site/package.json': { name: 'site' },
    });

    expect(findInstalledPackages(path.join(project.root, 'site'), all)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'dompurify',
          dir: path.join(project.root, 'node_modules/dompurify'),
        }),
        expect.objectContaining({ name: 'ckeditor5', version: '47.6.1' }),
      ])
    );
  });

  it('prefers the package installed nearest to the project', () => {
    project = createTempProject({
      'node_modules/dompurify/package.json': { version: '3.2.7' },
      'site/node_modules/dompurify/package.json': {
        version: '3.2.7',
        license: '(MPL-2.0 OR Apache-2.0)',
      },
    });

    expect(
      findInstalledPackages(
        path.join(project.root, 'site'),
        (name) => name === 'dompurify'
      )
    ).toEqual([
      {
        name: 'dompurify',
        version: '3.2.7',
        declaredLicense: '(MPL-2.0 OR Apache-2.0)',
        dir: path.join(project.root, 'site/node_modules/dompurify'),
      },
    ]);
  });

  it('reads only the packages the filter includes', () => {
    project = createTempProject({
      'node_modules/dompurify/package.json': {
        version: '3.2.7',
        license: '(MPL-2.0 OR Apache-2.0)',
      },
      // Unreadable, so reading it would throw.
      'node_modules/react/package.json': '{',
    });

    expect(
      findInstalledPackages(project.root, (name) => name === 'dompurify')
    ).toEqual([
      {
        name: 'dompurify',
        version: '3.2.7',
        declaredLicense: '(MPL-2.0 OR Apache-2.0)',
        dir: path.join(project.root, 'node_modules/dompurify'),
      },
    ]);
  });

  it('reads the legacy object and array forms of the field', () => {
    project = createTempProject({
      'node_modules/legacy-object/package.json': {
        version: '1.0.0',
        license: { type: 'BSD', url: 'https://example.com' },
      },
      'node_modules/legacy-array/package.json': {
        version: '1.0.0',
        licenses: [{ type: 'MIT' }, { type: 'GPL-2.0' }],
      },
    });

    const declared = Object.fromEntries(
      findInstalledPackages(project.root, all).map((pkg) => [
        pkg.name,
        pkg.declaredLicense,
      ])
    );
    expect(declared).toEqual({
      'legacy-object': 'BSD',
      'legacy-array': 'MIT OR GPL-2.0',
    });
  });
});

describe('compareCodeUnits', () => {
  it('orders the same way on every machine, whatever its locale', () => {
    // By code unit, as the default sort does: upper case before lower case,
    // and letters outside ASCII last. An order by locale would interleave
    // them differently depending on where the build runs.
    expect(['b', 'ä', 'a', 'B'].sort(compareCodeUnits)).toEqual([
      'B',
      'a',
      'b',
      'ä',
    ]);
    expect(compareCodeUnits('x', 'x')).toBe(0);
  });
});

describe('wrapText', () => {
  it('wraps at the given column without splitting words', () => {
    const wrapped = wrapText('aaa bbb ccc ddd', 7);
    expect(wrapped).toBe('aaa bbb\nccc ddd');
    wrapped.split('\n').forEach((line) => {
      expect(line.length).toBeLessThanOrEqual(7);
    });
  });

  it('keeps quoted text, such as a command, on one line', () => {
    expect(wrapText('run "npm pack a@1.0.0" now.', 12)).toBe(
      'run\n"npm pack a@1.0.0"\nnow.'
    );
    expect(wrapText('with "npm pack a@1.0.0".', 12)).toBe(
      'with\n"npm pack a@1.0.0".'
    );
  });

  it('wraps a stray quotation mark like any other character', () => {
    expect(wrapText('a "b c d', 3)).toBe('a\n"b\nc d');
  });
});

describe('renderNotices', () => {
  it('sorts entries and stays byte-identical between runs', () => {
    const packages = [
      resolve({ name: 'zod' }),
      resolve({ name: 'react', version: '19.2.6' }),
      resolve({ name: 'react', version: '18.0.0' }),
    ];

    const output = renderNotices(packages, config());

    expect(output.indexOf('react@18.0.0')).toBeLessThan(
      output.indexOf('react@19.2.6')
    );
    expect(output.indexOf('react@19.2.6')).toBeLessThan(output.indexOf('zod@'));
    expect(renderNotices([...packages].reverse(), config())).toBe(output);
  });

  it('includes the license text of a package verbatim', () => {
    const output = renderNotices(
      [
        resolve({
          licenseText: 'Copyright (c) Someone\nPermission is granted.\n',
        }),
      ],
      config()
    );

    expect(output).toContain('Copyright (c) Someone\nPermission is granted.');
  });

  it('marks a reconstructed notice as reconstructed', () => {
    const output = renderNotices(
      [resolve({ licenseText: undefined, author: 'Jason Quense' })],
      config()
    );

    expect(output).toContain('ships no license file');
    expect(output).toContain('Copyright (c) Jason Quense');
    expect(output).toContain('Permission is hereby granted, free of charge');
  });

  it('marks a notice rebuilt from an AND expression as such', () => {
    const packages = [
      resolve({
        name: 'font-awesome',
        version: '4.7.0',
        license: '(OFL-1.1 AND MIT)',
        licenseText: undefined,
        author: 'Dave Gandy',
      }),
    ];
    const output = renderNotices(packages, config());
    const unwrapped = output.replace(/\s+/g, ' ');

    expect(unwrapped).toContain(
      'reconstructed from the canonical text of each license in the ' +
        '(OFL-1.1 AND MIT) expression it declares'
    );
    // The package.json cannot say which license covers what, so the notice
    // must not claim to know.
    expect(unwrapped).toContain(
      'does not say which part of the package each license covers'
    );
    expect(output).toContain('License text 1 of 2: OFL-1.1');
    expect(renderNotices(packages, config())).toBe(output);
  });

  it('states the elected license and what the package declares', () => {
    const output = renderNotices(
      [
        resolve(
          { name: 'dompurify', license: '(MPL-2.0 OR Apache-2.0)' },
          dompurifyDecision
        ),
      ],
      config()
    );

    expect(output).toContain('License: Apache-2.0');
    expect(output).toContain('Declared as: (MPL-2.0 OR Apache-2.0)');
    // The election is what removes the MPL obligation, so the notice for it
    // must not be emitted for this component.
    expect(output).not.toContain('MPL-2.0 section 3.2 notice');
  });

  it('gives MPL-2.0 components a section 3.2 source notice', () => {
    const output = renderNotices(
      [
        resolve({
          name: '@jonkoops/matomo-tracker',
          version: '0.7.0',
          license: 'MPL-2.0',
          repository: 'https://github.com/jonkoops/matomo-tracker',
        }),
      ],
      config()
    );
    // The notice is wrapped, so phrases are matched without its line breaks.
    const unwrapped = output.replace(/\s+/g, ' ');

    expect(unwrapped).toContain('MPL-2.0 section 3.2 notice');
    expect(unwrapped).toContain('https://github.com/jonkoops/matomo-tracker');
    expect(unwrapped).toContain('npm pack @jonkoops/matomo-tracker@0.7.0');
  });

  it('falls back to the npm tarball when a package names no repository', () => {
    const output = renderNotices(
      [resolve({ license: 'MPL-2.0', repository: '' })],
      config()
    );

    expect(output.replace(/\s+/g, ' ')).toContain(
      'https://registry.npmjs.org/example/-/example-1.0.0.tgz'
    );
  });

  it('does not add an MPL notice to permissive components', () => {
    expect(renderNotices([resolve()], config())).not.toContain('section 3.2');
  });

  it('carries the license of the application itself', () => {
    const output = renderNotices(
      [resolve()],
      config(),
      'MIT License\n\nCopyright (c) 2024 City of Helsinki\n'
    );

    expect(output).toContain('distributed under the following license');
    expect(output).toContain('Copyright (c) 2024 City of Helsinki');
    expect(output).toContain('Source: https://github.com/example/app');
  });
});

describe('GPL-2.0 components', () => {
  const gpl = (name: string, license = 'GPL-2.0-or-later') =>
    resolve({
      name,
      license,
      licenseText: `${name} is licensed under the GPL, see COPYING.GPL.`,
      repository: `https://github.com/example/${name}`,
    });

  const countOf = (text: string, part: string) => text.split(part).length - 1;

  it('get a section 3 notice naming their source and that of the app', () => {
    const output = renderNotices([gpl('editor')], config());

    expect(output).toContain(
      'GPL-2.0 section 3 notice: this component is distributed here in'
    );
    expect(output).toContain('https://github.com/example/editor');
    expect(output).toContain('"npm pack editor@1.0.0"');
    expect(output).toContain(
      'of the application is available at:\nhttps://github.com/example/app\n'
    );
    // The package's own notice, with its copyright, is kept as well.
    expect(output).toContain('editor is licensed under the GPL');
  });

  it('share one copy of the license text at the end', () => {
    const output = renderNotices(
      [gpl('editor'), gpl('editor-core', 'GPL-2.0-only'), resolve()],
      config()
    );

    // The heading line is the one part the license text holds only once.
    expect(countOf(output, 'Version 2, June 1991')).toBe(1);
    expect(countOf(output, 'GPL-2.0 section 3 notice')).toBe(2);
    expect(output.indexOf('Version 2, June 1991')).toBeGreaterThan(
      output.indexOf('editor-core@1.0.0')
    );
    expect(
      output.endsWith(
        `Public License instead of this License.\n\n${'-'.repeat(78)}\n\n`
      )
    ).toBe(true);
  });

  it('recognise the deprecated identifiers of the license', () => {
    for (const license of ['GPL-2.0', 'GPL-2.0+', '(GPL-2.0-or-later)']) {
      expect(renderNotices([gpl('editor', license)], config())).toContain(
        'GPL-2.0 section 3 notice'
      );
    }
  });

  it('leave notices without them unchanged', () => {
    const output = renderNotices([resolve()], config());

    expect(output).not.toContain('GNU GENERAL PUBLIC LICENSE');
    expect(output).not.toContain('section 3 notice');
  });
});

describe('copyleft licenses without notice rules', () => {
  it.each([
    'GPL-3.0-only',
    'GPL-3.0-or-later',
    'LGPL-2.1-or-later',
    'AGPL-3.0-only',
    '(MIT OR GPL-3.0-only)',
    'GPL-2.0-only WITH Classpath-exception-2.0',
    'EUPL-1.2',
  ])('fail the build for %s', (license) => {
    expect(() => resolve({ name: 'copyleft', license })).toThrow(
      `copyleft@1.0.0 is distributed under "${license}", and there are no ` +
        'notice rules for that license yet'
    );
  });

  it('can be elected away with a license decision', () => {
    const resolved = resolve(
      { name: 'dual', license: '(MIT OR GPL-3.0-only)' },
      { licenseDecisions: { dual: { license: 'MIT', note: 'Elects MIT.' } } }
    );

    expect(resolved.license).toBe('MIT');
  });

  it('leave MPL-2.0, which has notice rules of its own, alone', () => {
    expect(() => resolve({ license: 'MPL-2.0' })).not.toThrow();
  });
});

describe('renderManifest', () => {
  it('describes a package the same way the notices do', () => {
    const resolved = resolve(
      { name: 'dompurify', license: '(MPL-2.0 OR Apache-2.0)' },
      dompurifyDecision
    );
    const [entry] = JSON.parse(renderManifest([resolved]));

    expect(entry).toMatchObject({
      name: 'dompurify',
      version: '1.0.0',
      license: 'Apache-2.0',
      declaredLicense: '(MPL-2.0 OR Apache-2.0)',
      source: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
    });
    expect(entry.licenseNote).toContain('elects Apache-2.0');
  });

  it('flags a reconstructed license text so an audit can tell', () => {
    const [reconstructed] = JSON.parse(
      renderManifest([resolve({ licenseText: undefined, author: 'Jane Doe' })])
    );
    const [shipped] = JSON.parse(renderManifest([resolve()]));

    expect(reconstructed.licenseTextReconstructed).toBe(true);
    expect(reconstructed.licenseText).toContain('Copyright (c) Jane Doe');
    expect(shipped.licenseTextReconstructed).toBeUndefined();
  });

  it('flags a text rebuilt from an AND expression as reconstructed', () => {
    const [entry] = JSON.parse(
      renderManifest([
        resolve({ license: '(OFL-1.1 AND MIT)', licenseText: undefined }),
      ])
    );

    expect(entry.license).toBe('(OFL-1.1 AND MIT)');
    expect(entry.licenseTextReconstructed).toBe(true);
    expect(entry.licenseText).toContain('License text 2 of 2: MIT');
  });

  it('sorts entries and stays byte-identical between runs', () => {
    const packages = [
      resolve({ name: 'zod' }),
      resolve({ name: 'react', version: '19.2.6' }),
      resolve({ name: 'react', version: '18.0.0' }),
    ];
    const output = renderManifest(packages);

    expect(
      JSON.parse(output).map((entry: { name: string }) => entry.name)
    ).toEqual(['react', 'react', 'zod']);
    expect(renderManifest([...packages].reverse())).toBe(output);
  });
});
