import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeNotices } from '../packageNotices.js';
import { createTempProject, type TempProject } from './tempProject.js';

describe('writeNotices', () => {
  let project: TempProject;

  afterEach(() => project.remove());

  it('writes the notices of the given packages into the output directory', async () => {
    project = createTempProject({
      'node_modules/a/package.json': {
        name: 'a',
        version: '1.0.0',
        license: 'MIT',
      },
      'node_modules/a/LICENSE': 'License of a',
    });
    const packageDir = path.join(project.root, 'node_modules/a');
    const outputDir = path.join(project.root, 'out');

    await writeNotices({
      projectDir: project.root,
      outputDir,
      packageDirs: [packageDir, packageDir],
      config: { repositoryUrl: 'https://example.com/app' },
    });

    const notices = fs.readFileSync(
      path.join(outputDir, 'third-party-licenses.txt'),
      'utf8'
    );
    expect(notices.split('a@1.0.0\nLicense: MIT\n')).toHaveLength(2);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(outputDir, 'oss-licenses.json'), 'utf8')
      )
    ).toHaveLength(1);
  });

  it('uses the text of the license a decision elects', async () => {
    project = createTempProject({
      'node_modules/choice/package.json': {
        name: 'choice',
        version: '1.0.0',
        license: 'MIT or MPL-2.0',
      },
      'node_modules/choice/LICENSE': 'MIT OR MPL-2.0',
      'node_modules/choice/LICENSE.MIT':
        'MIT License\n\nCopyright (c) Choice Author\n',
    });
    const outputDir = path.join(project.root, 'out');

    await writeNotices({
      projectDir: project.root,
      outputDir,
      packageDirs: [path.join(project.root, 'node_modules/choice')],
      config: {
        repositoryUrl: 'https://example.com/app',
        licenseDecisions: {
          choice: { license: 'MIT', note: 'This distribution elects MIT.' },
        },
      },
    });

    expect(
      fs.readFileSync(path.join(outputDir, 'third-party-licenses.txt'), 'utf8')
    ).toContain('Copyright (c) Choice Author');
  });

  it('writes the license file the config names as that of the application', async () => {
    project = createTempProject({
      LICENSE: 'MIT License\n\nCopyright (c) City of Helsinki\n',
      'site/LICENSE': 'The MIT License (MIT)\n\nCopyright (c) Gatsby\n',
    });
    const site = path.join(project.root, 'site');

    await writeNotices({
      projectDir: site,
      outputDir: path.join(site, 'out'),
      packageDirs: [],
      config: {
        repositoryUrl: 'https://example.com/app',
        projectLicenseFile: '../LICENSE',
      },
    });

    const notices = fs.readFileSync(
      path.join(site, 'out/third-party-licenses.txt'),
      'utf8'
    );
    expect(notices).toContain('City of Helsinki');
    expect(notices).not.toContain('Gatsby');
  });

  it('leaves first-party packages out', async () => {
    project = createTempProject({
      'node_modules/a/package.json': {
        name: 'a',
        version: '1.0.0',
        license: 'MIT',
      },
      // A license field that fails the build when read.
      'node_modules/hds-core/package.json': {
        name: 'hds-core',
        version: '9.0.0',
        license: 'SEE LICENSE IN LICENSE',
      },
    });
    const outputDir = path.join(project.root, 'out');

    await writeNotices({
      projectDir: project.root,
      outputDir,
      packageDirs: ['a', 'hds-core'].map((name) =>
        path.join(project.root, 'node_modules', name)
      ),
      config: {
        repositoryUrl: 'https://example.com/app',
        firstPartyPackages: ['hds-core'],
      },
    });

    const notices = fs.readFileSync(
      path.join(outputDir, 'third-party-licenses.txt'),
      'utf8'
    );
    expect(notices).toContain('a@1.0.0');
    expect(notices).not.toContain('hds-core');
    expect(
      JSON.parse(
        fs.readFileSync(path.join(outputDir, 'oss-licenses.json'), 'utf8')
      )
    ).toHaveLength(1);
  });
});
