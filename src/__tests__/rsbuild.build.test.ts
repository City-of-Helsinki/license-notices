import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createRsbuild,
  mergeRsbuildConfig,
  type RsbuildConfig,
} from '@rsbuild/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { ThirdPartyLicensesConfig } from '../core.js';
import { pluginThirdPartyLicenses } from '../rsbuild.js';
import { createTempProject, type TempProject } from './tempProject.js';

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const FIXTURE_PARENT = path.join(REPOSITORY_ROOT, '.test-tmp');
const BUILD_TIMEOUT = 60_000;

/** A package in node_modules whose code is marked by its name. */
const dependency = (
  name: string,
  files: Record<string, string>,
  license = 'MIT'
) => ({
  [`node_modules/${name}/package.json`]: {
    name,
    version: '1.0.0',
    license,
    sideEffects: ['*.css'],
    main: 'index.js',
  },
  [`node_modules/${name}/LICENSE`]: `License of ${name}`,
  ...Object.fromEntries(
    Object.entries(files).map(([file, content]) => [
      `node_modules/${name}/${file}`,
      content,
    ])
  ),
});

// The constant of "used" is inlined where it is used, the function of
// "hoisted" concatenated into the module of the entry, and "unused" left out.
// The private field needs a helper of @swc/helpers in an old browser.
const fixture = (usedLicense = 'MIT') => ({
  'package.json': { name: 'fixture', private: true },
  LICENSE: 'MIT License\n\nCopyright (c) Fixture App\n',
  'src/index.js': `
import 'styled/index.css';
import { used } from 'used';
import { hoisted } from 'hoisted';
import { unused } from 'unused';
class Counter {
  #count = 0;
  next() {
    return ++this.#count;
  }
}
document.body.textContent = used + hoisted() + new Counter().next();
`,
  'src/worker.js': `
import { workerOnly } from 'worker-only';
self.postMessage(workerOnly());
`,
  ...dependency(
    'used',
    { 'index.js': "export const used = 'USED';\n" },
    usedLicense
  ),
  ...dependency('hoisted', {
    'index.js': "export const hoisted = () => 'HOISTED';\n",
  }),
  ...dependency('worker-only', {
    'index.js': "export const workerOnly = () => 'WORKER';\n",
  }),
  ...dependency('unused', {
    'index.js': "export const unused = 'UNUSED';\n",
  }),
  ...dependency('styled', {
    'index.js': '',
    'index.css': '.styled { color: teal; }\n',
  }),
});

describe('pluginThirdPartyLicenses', () => {
  let project: TempProject;

  afterEach(() => project.remove());

  const build = async ({
    config = {},
    usedLicense,
    rsbuildConfig = {},
  }: {
    config?: Partial<ThirdPartyLicensesConfig>;
    usedLicense?: string;
    rsbuildConfig?: RsbuildConfig;
  } = {}) => {
    project = createTempProject(fixture(usedLicense), FIXTURE_PARENT);
    const rsbuild = await createRsbuild({
      cwd: project.root,
      rsbuildConfig: mergeRsbuildConfig(
        {
          plugins: [
            pluginThirdPartyLicenses({
              repositoryUrl: 'https://example.com/app',
              ...config,
            }),
          ],
          output: { distPath: { root: 'build' } },
          performance: { printFileSize: false },
        },
        rsbuildConfig
      ),
    });
    const { close } = await rsbuild.build();
    await close();
  };
  const read = (file: string) =>
    fs.readFileSync(path.join(project.root, 'build', file), 'utf8');
  const exists = (file: string) =>
    fs.existsSync(path.join(project.root, 'build', file));

  it(
    'writes the notices of the bundled packages into the dist root',
    async () => {
      await build();

      const notices = read('third-party-licenses.txt');
      expect(notices).toContain('used@1.0.0\nLicense: MIT\n');
      expect(notices).toContain('hoisted@1.0.0\nLicense: MIT\n');
      expect(notices).toContain('styled@1.0.0\nLicense: MIT\n');
      expect(notices).not.toContain('unused@1.0.0');
      expect(exists('oss-licenses.json')).toBe(true);
    },
    BUILD_TIMEOUT
  );

  it(
    'honours the configured file names',
    async () => {
      await build({
        config: {
          noticesFileName: 'legal/notices.txt',
          manifestFileName: false,
        },
      });

      expect(exists('legal/notices.txt')).toBe(true);
      expect(exists('oss-licenses.json')).toBe(false);
    },
    BUILD_TIMEOUT
  );

  it(
    'fails the build on a package with an invalid license',
    async () => {
      await expect(
        build({ usedLicense: 'SEE LICENSE IN LICENSE.md' })
      ).rejects.toThrow('is not a valid SPDX expression');
    },
    BUILD_TIMEOUT
  );

  it(
    'lists the helpers that Rsbuild injects into the build',
    async () => {
      await build({
        rsbuildConfig: { output: { overrideBrowserslist: ['chrome 40'] } },
      });

      expect(read('third-party-licenses.txt')).toContain('@swc/helpers@');
    },
    BUILD_TIMEOUT
  );

  it(
    'writes the packages of every browser environment in a dist root once',
    async () => {
      await build({
        rsbuildConfig: {
          environments: {
            web: {},
            worker: {
              source: { entry: { worker: './src/worker.js' } },
              output: { target: 'web-worker', distPath: { js: 'worker' } },
            },
          },
        },
      });

      const notices = read('third-party-licenses.txt');
      expect(notices).toContain('used@1.0.0\n');
      expect(notices).toContain('worker-only@1.0.0\n');
    },
    BUILD_TIMEOUT
  );
});
