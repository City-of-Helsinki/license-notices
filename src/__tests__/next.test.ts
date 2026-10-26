import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  ancestorsOf,
  findPackageDir,
  isDependencySource,
  sourcePathOf,
} from '../packages.js';
import {
  findMappedSourceIndices,
  findMappedSources,
  findSourceMapUrl,
} from '../next/sourceMaps.js';
import {
  findClientPackageDirs,
  writeThirdPartyLicenses,
} from '../next/writeThirdPartyLicenses.js';
import { npmTarballUrl } from '../packageNotices.js';
import { createTempProject, type TempProject } from './tempProject.js';

const packageJson = (name: string) => ({ name, version: '1.0.0' });

// Converts file URLs the way Node does on Windows while set.
const platform = vi.hoisted(() => ({ windows: false }));
vi.mock('node:url', async (importOriginal) => {
  const url = await importOriginal<typeof import('node:url')>();
  return {
    ...url,
    fileURLToPath: (source: string | URL) =>
      url.fileURLToPath(source, { windows: platform.windows }),
  };
});

describe('findMappedSourceIndices', () => {
  it('finds the sources that segments map output to', () => {
    // AAAA: source 0. CAAC: column +1, same source. ACAA: source +1.
    expect(findMappedSourceIndices('AAAA,CAAC;ACAA')).toEqual(new Set([0, 1]));
  });

  it('follows source indices that move back across lines', () => {
    // AEAA: source +2. ;ADAA: source -1, on the next line.
    expect(findMappedSourceIndices('AEAA;ADAA')).toEqual(new Set([2, 1]));
  });

  it('ignores segments that map no source', () => {
    // A segment of one value maps output to nothing.
    expect(findMappedSourceIndices('A,C;;')).toEqual(new Set());
  });

  it('decodes values longer than one digit', () => {
    // gBAAA: column +16, source 0. AgBAA: source +16.
    expect(findMappedSourceIndices('gBAAA,AgBAA')).toEqual(new Set([0, 16]));
  });
});

describe('findMappedSources', () => {
  it('leaves out sources listed without any output', () => {
    expect(
      findMappedSources({
        sources: ['used.js', 'shaken.js', null, 'also-used.js'],
        mappings: 'AAAA,AEAA;AAAA',
      })
    ).toEqual(['used.js']);
  });

  it('reads every section of an indexed source map', () => {
    expect(
      findMappedSources({
        sections: [
          { map: { sources: ['a.js'], mappings: 'AAAA' } },
          { map: { sources: ['b.js'], mappings: 'AAAA' } },
        ],
      })
    ).toEqual(['a.js', 'b.js']);
  });

  it('puts the source root in front of each source', () => {
    expect(
      findMappedSources({
        sourceRoot: 'webpack://app/',
        sources: ['a.js'],
        mappings: 'AAAA',
      })
    ).toEqual(['webpack://app/a.js']);
  });

  it('separates a source root without a trailing slash from each source', () => {
    expect(
      findMappedSources({
        sourceRoot: 'webpack://app/node_modules',
        sources: ['a/i.js'],
        mappings: 'AAAA',
      })
    ).toEqual(['webpack://app/node_modules/a/i.js']);
  });
});

describe('findSourceMapUrl', () => {
  it('reads the comment of a JavaScript and of a CSS chunk', () => {
    expect(findSourceMapUrl('x();\n//# sourceMappingURL=a.js.map\n')).toBe(
      'a.js.map'
    );
    expect(findSourceMapUrl('a{}\n/*# sourceMappingURL=a.css.map*/')).toBe(
      'a.css.map'
    );
  });

  it('ignores the words anywhere but in the comment on the last line', () => {
    expect(
      findSourceMapUrl('const s = "//# sourceMappingURL=no.map";\nx();')
    ).toBeUndefined();
    expect(findSourceMapUrl('x();')).toBeUndefined();
  });
});

describe('sourcePathOf', () => {
  it('drops the scheme and the project placeholder of each bundler', () => {
    expect(sourcePathOf('turbopack:///[project]/node_modules/a/i.js')).toBe(
      'node_modules/a/i.js'
    );
    expect(sourcePathOf('turbopack:///src/app.scss')).toBe('src/app.scss');
    expect(sourcePathOf('webpack://_N_E/./node_modules/a/i.js')).toBe(
      './node_modules/a/i.js'
    );
    expect(sourcePathOf('node_modules/a/style.css')).toBe(
      'node_modules/a/style.css'
    );
    expect(sourcePathOf('file:///app/node_modules/a/i.js')).toBe(
      '/app/node_modules/a/i.js'
    );
  });

  it('separates the path of a Windows file URL with slashes', () => {
    platform.windows = true;
    onTestFinished(() => {
      platform.windows = false;
    });

    expect(sourcePathOf('file:///C:/app/node_modules/a/i.js')).toBe(
      'C:/app/node_modules/a/i.js'
    );
    expect(isDependencySource('file:///C:/app/node_modules/a/i.js')).toBe(true);
  });

  it('tells dependency sources from the sources of the app', () => {
    expect(isDependencySource('turbopack:///[project]/src/index.ts')).toBe(
      false
    );
    expect(
      isDependencySource('turbopack:///[project]/node_modules/a/i.js')
    ).toBe(true);
  });
});

describe('findPackageDir', () => {
  let project: TempProject;

  afterEach(() => project.remove());

  const find = (source: string, bases = [project.root]) =>
    findPackageDir(source, bases);
  const dir = (relative: string) => path.join(project.root, relative);

  it('finds the package a source is installed in', () => {
    project = createTempProject({
      'node_modules/@scope/pkg/package.json': packageJson('@scope/pkg'),
      // A nested manifest names no package, so it is not taken for one.
      'node_modules/@scope/pkg/dist/esm/package.json': { type: 'module' },
    });

    expect(
      find('turbopack:///[project]/node_modules/@scope/pkg/dist/esm/i.js')
    ).toBe(dir('node_modules/@scope/pkg'));
  });

  it('gives code bundled into a package to the package that ships it', () => {
    project = createTempProject({
      'node_modules/host/package.json': packageJson('host'),
    });

    expect(find('node_modules/host/node_modules/bundled/index.js')).toBe(
      dir('node_modules/host')
    );
  });

  it('finds a package in the pnpm store from a file outside of it', () => {
    const store = 'node_modules/.pnpm/@vendor+client@3.14.1/node_modules';
    project = createTempProject({
      [`${store}/@vendor/client/package.json`]: packageJson('@vendor/client'),
      'node_modules/.pnpm/peer@16.0.0/node_modules/peer/package.json':
        packageJson('peer'),
    });
    // A dependency of the package, linked next to it as pnpm does.
    fs.symlinkSync(
      dir('node_modules/.pnpm/peer@16.0.0/node_modules/peer'),
      dir(`${store}/peer`),
      'dir'
    );

    expect(find(`turbopack:///[project]/${store}/@vendor/src/core.ts`)).toBe(
      dir(`${store}/@vendor/client`)
    );
  });

  it('cannot tell the package of such a file outside the pnpm store', () => {
    project = createTempProject({
      'node_modules/@vendor/client/package.json': packageJson('@vendor/client'),
    });

    expect(find('node_modules/@vendor/src/core.ts')).toBeUndefined();
  });

  it('resolves a source against a root above the project', () => {
    project = createTempProject({
      'app/node_modules/pkg/package.json': packageJson('pkg'),
    });

    expect(
      find(
        'turbopack:///[project]/app/node_modules/pkg/i.js',
        ancestorsOf(dir('app'))
      )
    ).toBe(dir('app/node_modules/pkg'));
  });

  it('prefers the base directory where the source file exists', () => {
    project = createTempProject({
      // The project has node_modules of its own, but the source is relative
      // to a bundler root above it.
      'app/node_modules/pkg/package.json': packageJson('pkg'),
      'node_modules/pkg/package.json': packageJson('pkg'),
      'node_modules/pkg/i.js': 'export {};',
    });

    expect(
      find(
        'turbopack:///[project]/node_modules/pkg/i.js',
        ancestorsOf(dir('app'))
      )
    ).toBe(dir('node_modules/pkg'));
  });
});

describe('findClientPackageDirs', () => {
  let project: TempProject;

  afterEach(() => project.remove());

  const chunk = (sources: string[]) => ({
    '.next/static/chunks/a.js': 'x();\n//# sourceMappingURL=a.js.map',
    '.next/static/chunks/a.js.map': {
      version: 3,
      sources,
      // Output from every source.
      mappings: sources.map((_, i) => (i === 0 ? 'AAAA' : 'ACAA')).join(','),
    },
  });

  it('lists each package with output once', () => {
    project = createTempProject({
      'node_modules/a/package.json': packageJson('a'),
      'node_modules/b/package.json': packageJson('b'),
      ...chunk([
        'turbopack:///[project]/node_modules/b/i.js',
        'turbopack:///[project]/node_modules/a/i.js',
        'turbopack:///[project]/node_modules/a/j.js',
        'turbopack:///[project]/src/app.js',
      ]),
    });

    expect(
      findClientPackageDirs(project.root, path.join(project.root, '.next'))
    ).toEqual([
      path.join(project.root, 'node_modules/a'),
      path.join(project.root, 'node_modules/b'),
    ]);
  });

  it('fails when no chunk names a source map', () => {
    project = createTempProject({
      '.next/static/chunks/a.js': 'x();',
    });

    expect(() =>
      findClientPackageDirs(project.root, path.join(project.root, '.next'))
    ).toThrow('names a source map, so the packages in the client build');
  });

  it('fails on files in node_modules that belong to no package', () => {
    project = createTempProject({
      'node_modules/@vendor/client/package.json': packageJson('@vendor/client'),
      ...chunk(['turbopack:///[project]/node_modules/@vendor/src/core.ts']),
    });

    expect(() =>
      findClientPackageDirs(project.root, path.join(project.root, '.next'))
    ).toThrow(
      /belong to no installed package[^]*node_modules\/@vendor\/src\/core\.ts[^]*turbopackInputSourceMaps/
    );
  });
});

describe('writeThirdPartyLicenses', () => {
  let project: TempProject;

  afterEach(() => project.remove());

  const build = (license: string) =>
    createTempProject({
      'public/third-party-licenses.txt': 'Notices of an earlier build',
      'public/oss-licenses.json': '[]',
      'node_modules/a/package.json': { ...packageJson('a'), license },
      '.next/static/chunks/a.js': 'x();\n//# sourceMappingURL=a.js.map',
      '.next/static/chunks/a.js.map': {
        version: 3,
        sources: ['turbopack:///[project]/node_modules/a/i.js'],
        mappings: 'AAAA',
      },
    });
  const write = () =>
    writeThirdPartyLicenses({
      projectDir: project.root,
      distDir: '.next',
      config: { repositoryUrl: 'https://example.com/app' },
    });
  const exists = (file: string) =>
    fs.existsSync(path.join(project.root, 'public', file));

  it('replaces the files of an earlier build', async () => {
    project = build('MIT');

    await write();

    expect(
      fs.readFileSync(
        path.join(project.root, 'public/third-party-licenses.txt'),
        'utf8'
      )
    ).toContain('a@1.0.0\nLicense: MIT\n');
  });

  it('writes files named in a subdirectory of the public directory', async () => {
    project = build('MIT');

    await writeThirdPartyLicenses({
      projectDir: project.root,
      distDir: '.next',
      config: {
        repositoryUrl: 'https://example.com/app',
        noticesFileName: 'legal/third-party-licenses.txt',
        manifestFileName: 'legal/data/oss-licenses.json',
      },
    });

    expect(exists('legal/third-party-licenses.txt')).toBe(true);
    expect(exists('legal/data/oss-licenses.json')).toBe(true);
  });

  it('leaves no files of an earlier build behind when it fails', async () => {
    project = build('SEE LICENSE IN LICENSE.md');

    await expect(write()).rejects.toThrow('is not a valid SPDX expression');
    // "next start" would otherwise serve them as the notices of this build.
    expect(exists('third-party-licenses.txt')).toBe(false);
    expect(exists('oss-licenses.json')).toBe(false);
  });
});

describe('npmTarballUrl', () => {
  it('names the tarball the way rollup-license-plugin does', () => {
    expect(npmTarballUrl('framework', '19.2.0')).toBe(
      'https://registry.npmjs.org/framework/-/framework-19.2.0.tgz'
    );
    expect(npmTarballUrl('@scope/pkg', '1.0.0+build.5')).toBe(
      'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz'
    );
  });
});
