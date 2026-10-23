import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import webpack, { type Stats } from 'webpack';

import type { ThirdPartyLicensesConfig } from '../core.js';
import { ThirdPartyLicensesPlugin } from '../webpack.js';
import { createTempProject, type TempProject } from './tempProject.js';

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const FIXTURE_PARENT = path.join(REPOSITORY_ROOT, '.test-tmp');
const BUILD_TIMEOUT = 60_000;

/** A package whose code is marked by its name, in the given directory. */
const dependency = (
  directory: string,
  name: string,
  {
    version = '1.0.0',
    license = 'MIT',
    code = `export const value = () => '${name}';\n`,
  } = {}
) => ({
  [`${directory}/package.json`]: {
    name,
    version,
    license,
    sideEffects: false,
    main: 'index.js',
  },
  [`${directory}/LICENSE`]: `License of ${name}@${version}`,
  [`${directory}/index.js`]: code,
});

// A workspace like that of the HDS site: the app in site/, packages hoisted
// to the root of the workspace, a workspace package linked into
// site/node_modules, an archived copy of it under another directory name,
// and a stale license file of a starter in site/.
const fixture = (usedLicense: string) => ({
  LICENSE: 'MIT License\n\nCopyright (c) City of Helsinki\n',
  ...dependency('node_modules/root-only', 'root-only'),
  ...dependency('packages/core', 'hds-core', { version: '9.0.0' }),
  'site/LICENSE': 'The MIT License (MIT)\n\nCopyright (c) Gatsby\n',
  'site/package.json': { name: 'site', private: true },
  'site/src/index.js': `
import { value as used } from 'used';
import { value as hoisted } from 'hoisted';
import { value as unused } from 'unused';
import { value as rootOnly } from 'root-only';
import { value as core } from 'hds-core';
import { value as archived } from 'hds-core-1.0.0';
document.body.textContent = used() + hoisted() + rootOnly() + core() + archived();
`,
  ...dependency('site/node_modules/used', 'used', { license: usedLicense }),
  'site/node_modules/used/LICENSE.MIT':
    'MIT License\n\nCopyright (c) Used Author\n',
  ...dependency('site/node_modules/hoisted', 'hoisted'),
  ...dependency('site/node_modules/unused', 'unused'),
  ...dependency('site/node_modules/hds-core-1.0.0', 'hds-core'),
});

describe('ThirdPartyLicensesPlugin in a webpack build', () => {
  let project: TempProject;

  afterEach(() => project.remove());

  const build = async ({
    config = {},
    usedLicense = 'MIT',
  }: {
    config?: Partial<ThirdPartyLicensesConfig>;
    usedLicense?: string;
  } = {}): Promise<Stats> => {
    project = createTempProject(fixture(usedLicense), FIXTURE_PARENT);
    fs.symlinkSync(
      '../../packages/core',
      path.join(project.root, 'site/node_modules/hds-core'),
      'dir'
    );
    const site = path.join(project.root, 'site');
    const compiler = webpack({
      mode: 'production',
      context: site,
      entry: './src/index.js',
      output: { path: path.join(site, 'build') },
      resolve: {
        modules: [path.join(site, 'node_modules'), 'node_modules'],
        symlinks: false,
      },
      plugins: [
        new ThirdPartyLicensesPlugin({
          repositoryUrl: 'https://example.com/app',
          projectLicenseFile: '../LICENSE',
          firstPartyPackages: ['hds-core'],
          ...config,
        }),
      ],
    });
    const stats = await new Promise<Stats>((resolve, reject) => {
      compiler.run((error, result) =>
        error || !result ? reject(error) : resolve(result)
      );
    });
    await new Promise<void>((resolve) => compiler.close(() => resolve()));
    return stats;
  };
  const read = (file: string) =>
    fs.readFileSync(path.join(project.root, 'site/build', file), 'utf8');

  it(
    'emits the notices of the bundled packages into the output directory',
    async () => {
      const stats = await build();

      expect(stats.hasErrors()).toBe(false);
      const notices = read('third-party-licenses.txt');
      expect(notices).toContain('used@1.0.0\nLicense: MIT\n');
      expect(notices).toContain('hoisted@1.0.0\nLicense: MIT\n');
      expect(notices).toContain('root-only@1.0.0\nLicense: MIT\n');
      expect(notices).not.toContain('unused@1.0.0');
      expect(read('oss-licenses.json')).toContain('"name": "root-only"');
    },
    BUILD_TIMEOUT
  );

  it(
    'leaves first-party packages out, linked or copied',
    async () => {
      await build();

      expect(read('third-party-licenses.txt')).not.toContain('hds-core');
    },
    BUILD_TIMEOUT
  );

  it(
    'carries the license file the config names',
    async () => {
      await build();

      const notices = read('third-party-licenses.txt');
      expect(notices).toContain('Copyright (c) City of Helsinki');
      expect(notices).not.toContain('Gatsby');
    },
    BUILD_TIMEOUT
  );

  it(
    'applies license decisions',
    async () => {
      await build({
        usedLicense: 'MIT or MPL-2.0',
        config: {
          licenseDecisions: {
            used: { license: 'MIT', note: 'This distribution elects MIT.' },
          },
        },
      });

      const notices = read('third-party-licenses.txt');
      expect(notices).toContain(
        'used@1.0.0\nLicense: MIT\nDeclared as: MIT or MPL-2.0'
      );
      expect(notices).toContain('Copyright (c) Used Author');
    },
    BUILD_TIMEOUT
  );

  it(
    'fails the build on a package with an invalid license',
    async () => {
      const stats = await build({ usedLicense: 'SEE LICENSE IN LICENSE.md' });

      expect(stats.hasErrors()).toBe(true);
      expect(stats.toJson({ all: false, errors: true }).errors).toEqual([
        expect.objectContaining({
          message: expect.stringContaining('is not a valid SPDX expression'),
        }),
      ]);
    },
    BUILD_TIMEOUT
  );
});
