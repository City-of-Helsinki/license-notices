import type { LicenseMeta } from 'rollup-license-plugin';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatAuthor,
  findDecision,
  findInstalledPackages,
  reconstructLicenseText,
  renderManifest,
  renderNotices,
  resolvePackage,
  thirdPartyLicenses,
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
        ? declared.license
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

  it('reconstructs the text of a package shipping no license file', () => {
    const resolved = resolve({
      name: 'tiny-case',
      licenseText: undefined,
      author: 'Jason Quense',
    });

    expect(resolved.licenseTextReconstructed).toBe(true);
    expect(resolved.licenseText).toContain('Copyright (c) Jason Quense');
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

  it('fails when the declared license cannot be read', () => {
    expect(() =>
      resolvePackage(
        pkg({ name: '@vendor/core', license: 'GPL-2.0-or-later' }),
        config(guarded),
        () => undefined
      )
    ).toThrow('declares a license that could not be read');
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
        },
        {
          name: '@ckeditor/ckeditor5-core',
          version: '47.6.1',
          declaredLicense: 'SEE LICENSE IN LICENSE.md',
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
      { name: '@scope/dual', version: '1.0.0', declaredLicense: 'MIT' },
      {
        name: '@scope/dual',
        version: '2.0.0',
        declaredLicense: '(MPL-2.0 OR Apache-2.0)',
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
