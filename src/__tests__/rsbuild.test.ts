import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  findBundledModulePaths,
  findBundledPackageDirs,
} from '../rsbuild/modules.js';
import { browserOutputs } from '../rsbuild/pluginThirdPartyLicenses.js';
import { createTempProject, type TempProject } from './tempProject.js';

describe('findBundledModulePaths', () => {
  it('lists modules in a chunk and the modules concatenated into them', () => {
    expect(
      findBundledModulePaths([
        { nameForCondition: '/p/src/a.ts', chunks: [0] },
        {
          nameForCondition: '/p/x.js',
          chunks: [0],
          modules: [{ nameForCondition: '/p/node_modules/b/i.js' }],
        },
      ])
    ).toEqual(['/p/src/a.ts', '/p/x.js', '/p/node_modules/b/i.js']);
  });

  it('leaves out orphan modules and modules in no chunk', () => {
    expect(
      findBundledModulePaths([
        {
          nameForCondition: '/p/node_modules/c/i.js',
          orphan: true,
          chunks: [],
        },
        { nameForCondition: '/p/node_modules/d/i.js', chunks: [] },
      ])
    ).toEqual([]);
  });

  it('skips modules without a file, which webpack names as null', () => {
    expect(
      findBundledModulePaths([
        { nameForCondition: null, chunks: [0] },
        {
          nameForCondition: '/p/x.js',
          chunks: [0],
          modules: [{ nameForCondition: null }],
        },
      ])
    ).toEqual(['/p/x.js']);
  });

  it('lists modules whose used exports were inlined where they are used', () => {
    expect(
      findBundledModulePaths([
        {
          nameForCondition: '/p/node_modules/e/i.js',
          orphan: true,
          chunks: [],
          usedExports: ['e'],
        },
        {
          nameForCondition: '/p/node_modules/f/i.js',
          orphan: true,
          chunks: [],
          usedExports: [],
        },
      ])
    ).toEqual(['/p/node_modules/e/i.js']);
  });

  it('leaves out modules without a path', () => {
    expect(findBundledModulePaths([{ chunks: [0] }])).toEqual([]);
  });
});

describe('findBundledPackageDirs', () => {
  let project: TempProject;

  afterEach(() => project.remove());

  const packageJson = (name: string) => ({ name, version: '1.0.0' });

  it('finds the package of each module in node_modules once', () => {
    project = createTempProject({
      'node_modules/a/package.json': packageJson('a'),
      'node_modules/a/i.js': '',
      'node_modules/a/lib/j.js': '',
      'node_modules/@s/b/package.json': packageJson('@s/b'),
      'node_modules/@s/b/i.css': '',
      'src/app.ts': '',
    });
    const module = (file: string) => ({
      nameForCondition: path.join(project.root, file),
      chunks: [0],
    });

    expect(
      findBundledPackageDirs(project.root, [
        module('node_modules/a/i.js'),
        module('node_modules/a/lib/j.js'),
        module('node_modules/@s/b/i.css'),
        module('src/app.ts'),
      ])
    ).toEqual([
      fs.realpathSync(path.join(project.root, 'node_modules/@s/b')),
      fs.realpathSync(path.join(project.root, 'node_modules/a')),
    ]);
  });

  it('finds linked packages outside node_modules by their real path', () => {
    project = createTempProject({
      'package.json': { name: 'workspace', version: '1.0.0' },
      'shared/util.js': '',
      'packages/core/package.json': packageJson('core'),
      'packages/core/src/i.js': '',
      'packages/internal/package.json': {
        ...packageJson('internal'),
        private: true,
      },
      'packages/internal/i.js': '',
      'packages/draft/package.json': { name: 'draft' },
      'packages/draft/i.js': '',
      'site/package.json': packageJson('site'),
      'site/src/app.ts': '',
    });
    const module = (file: string) => ({
      nameForCondition: path.join(project.root, file),
      chunks: [0],
    });

    expect(
      findBundledPackageDirs(path.join(project.root, 'site'), [
        module('packages/core/src/i.js'),
        module('packages/internal/i.js'),
        module('packages/draft/i.js'),
        module('shared/util.js'),
        module('site/src/app.ts'),
        module('site/src/generated.ts'),
      ])
    ).toEqual([fs.realpathSync(path.join(project.root, 'packages/core'))]);
  });

  it('fails on modules in node_modules that belong to no package', () => {
    project = createTempProject({ 'node_modules/ghost/i.js': '' });
    const ghost = path.join(project.root, 'node_modules/ghost/i.js');

    expect(() =>
      findBundledPackageDirs(project.root, [
        { nameForCondition: ghost, chunks: [0] },
      ])
    ).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          new RegExp(`belong to no installed package[\\s\\S]*${ghost}`)
        ),
      })
    );
  });
});

describe('browserOutputs', () => {
  const environment = (index: number, target: string, distPath: string) => ({
    index,
    distPath,
    config: { output: { target } },
  });

  it('groups the browser environments by their output directory', () => {
    const web = environment(0, 'web', '/d');
    const ssr = environment(1, 'node', '/d/server');
    const worker = environment(2, 'web-worker', '/d');
    const legacy = environment(3, 'web', '/legacy');

    expect(browserOutputs({ worker, legacy, ssr, web })).toEqual([
      { distPath: '/d', environments: [web, worker] },
      { distPath: '/legacy', environments: [legacy] },
    ]);
  });
});
