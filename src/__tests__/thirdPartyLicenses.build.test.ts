import fs from 'fs';
import path from 'path';

import { build, type Rollup } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  thirdPartyLicenses,
  type ThirdPartyLicensesConfig,
} from '../thirdPartyLicenses.js';
import { createTempProject, type TempProject } from './tempProject.js';

/**
 * A package in a fixture app, installed at the top of node_modules unless
 * another directory is given.
 */
const dependency = (
  name: string,
  license: string,
  licenseFile: [string, string],
  directory = `node_modules/${name}`
) => ({
  [`${directory}/package.json`]: {
    name,
    version: '1.0.0',
    license,
    type: 'module',
    main: 'index.js',
  },
  [`${directory}/index.js`]: `export default () => '${name}';`,
  [`${directory}/${licenseFile[0]}`]: licenseFile[1],
});

/**
 * The entry of a fixture app, importing and using the default export of each
 * package. An index.html is the entry every supported Vite version finds by
 * itself, so no version-specific build options are needed.
 */
const entry = (names: string[]) => ({
  'index.html': '<script type="module" src="/main.js"></script>',
  'main.js': [
    ...names.map((name, i) => `import dependency${i} from '${name}';`),
    `console.log(${names.map((_, i) => `dependency${i}()`).join(', ')});`,
  ].join('\n'),
});

const VENDOR_LICENSE = 'SEE LICENSE IN LICENSE.md';
const VENDOR_STORE_DIR = 'node_modules/.pnpm/@vendor+two@1.0.0/node_modules';

const decisions: ThirdPartyLicensesConfig['licenseDecisions'] = {
  'dual-licensed': {
    license: 'Apache-2.0',
    note: 'This distribution elects Apache-2.0.',
  },
  'custom-licensed': {
    license: 'BSD-3-Clause',
    note: 'Its license file is the three-clause BSD license.',
  },
  '@vendor/*': {
    declared: VENDOR_LICENSE,
    license: 'GPL-2.0-or-later',
    note: 'Offered by the vendor under the GPL.',
  },
};

let project: TempProject;

beforeAll(() => {
  project = createTempProject({
    LICENSE: 'MIT License\n\nCopyright (c) Fixture App\n',
    ...entry([
      'dual-licensed',
      'custom-licensed',
      'plain',
      '@vendor/one',
      '@vendor/two',
    ]),
    ...dependency('dual-licensed', '(MPL-2.0 OR Apache-2.0)', [
      'LICENSE',
      'Dual license text',
    ]),
    ...dependency('custom-licensed', VENDOR_LICENSE, [
      'LICENSE.md',
      'Custom license text',
    ]),
    ...dependency('plain', 'MIT', ['LICENSE', 'Plain license text']),
    ...dependency('@vendor/one', VENDOR_LICENSE, ['LICENSE.md', 'Vendor']),
    // Installed only in the virtual store and linked to, as pnpm does it.
    ...dependency(
      '@vendor/two',
      VENDOR_LICENSE,
      ['LICENSE.md', 'Vendor'],
      `${VENDOR_STORE_DIR}/@vendor/two`
    ),
  });
  fs.symlinkSync(
    path.join(project.root, VENDOR_STORE_DIR, '@vendor/two'),
    path.join(project.root, 'node_modules/@vendor/two'),
    'dir'
  );
});

afterAll(() => project.remove());

/** Builds a fixture app in memory and returns the emitted files by name. */
async function buildFixture(
  root: string,
  config: ThirdPartyLicensesConfig
): Promise<Map<string, string>> {
  const result = (await build({
    root,
    configFile: false,
    logLevel: 'silent',
    build: { write: false },
    plugins: [thirdPartyLicenses(config)],
  })) as Rollup.RollupOutput;

  return new Map(
    result.output.map((file) => [
      file.fileName,
      file.type === 'asset' ? String(file.source) : file.code,
    ])
  );
}

describe('thirdPartyLicenses in a Vite build', () => {
  it('emits notices and a manifest for every bundled package', async () => {
    const files = await buildFixture(project.root, {
      repositoryUrl: 'https://example.com/app',
      licenseDecisions: decisions,
    });
    const notices = files.get('third-party-licenses.txt') ?? '';
    const manifest = JSON.parse(files.get('oss-licenses.json') ?? '[]');

    expect(notices).toContain(
      'dual-licensed@1.0.0\nLicense: Apache-2.0\n' +
        'Declared as: (MPL-2.0 OR Apache-2.0)'
    );
    expect(notices).toContain(
      'custom-licensed@1.0.0\nLicense: BSD-3-Clause\n' +
        `Declared as: ${VENDOR_LICENSE}`
    );
    expect(notices).toContain('Custom license text');
    expect(notices).toContain('plain@1.0.0\nLicense: MIT\n');
    // Read from the Vite root, which is not the working directory here.
    expect(notices).toContain('Copyright (c) Fixture App');
    expect(manifest.map((pkg: { name: string }) => pkg.name).sort()).toEqual([
      '@vendor/one',
      '@vendor/two',
      'custom-licensed',
      'dual-licensed',
      'plain',
    ]);
  });

  it('applies a scope pattern to every package of the scope', async () => {
    const files = await buildFixture(project.root, {
      repositoryUrl: 'https://example.com/app',
      licenseDecisions: decisions,
    });
    const notices = files.get('third-party-licenses.txt') ?? '';

    for (const name of ['@vendor/one', '@vendor/two']) {
      expect(notices).toContain(
        `${name}@1.0.0\nLicense: GPL-2.0-or-later\n` +
          `Declared as: ${VENDOR_LICENSE}`
      );
    }
    // The GPL they are decided under travels with them, exactly once.
    expect(notices.split('GPL-2.0 section 3 notice').length - 1).toBe(2);
    expect(notices.split('Version 2, June 1991').length - 1).toBe(1);
  });

  // A license that is not a valid SPDX expression has to be read by a person
  // before the app can be distributed, so the build must not pass silently.
  it('fails on a declared license nobody has made a decision about', async () => {
    await expect(
      buildFixture(project.root, {
        repositoryUrl: 'https://example.com/app',
        licenseDecisions: {
          'dual-licensed': decisions['dual-licensed'],
          '@vendor/*': decisions['@vendor/*'],
        },
      })
    ).rejects.toThrow(/custom-licensed@1\.0\.0 is not a valid SPDX expression/);
  });

  it('fails on a package of the scope that declares another license', async () => {
    const rogue = createTempProject({
      ...entry(['@vendor/rogue']),
      ...dependency('@vendor/rogue', 'BUSL-1.1', ['LICENSE', 'Business']),
    });
    try {
      await expect(
        buildFixture(rogue.root, {
          repositoryUrl: 'https://example.com/app',
          licenseDecisions: decisions,
        })
      ).rejects.toThrow(
        '@vendor/rogue@1.0.0 declares "BUSL-1.1", but the license decision ' +
          '"@vendor/*" applies only to packages declaring'
      );
    } finally {
      rogue.remove();
    }
  });
});
