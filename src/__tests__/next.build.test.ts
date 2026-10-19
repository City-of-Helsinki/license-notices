import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeThirdPartyLicenses } from '../next/writeThirdPartyLicenses.js';
import { createTempProject, type TempProject } from './tempProject.js';

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
// Inside the repository, so that the Turbopack root covers both the fixture
// and the next, react and react-dom it resolves from the repository.
const FIXTURE_PARENT = path.join(REPOSITORY_ROOT, '.test-tmp');
const NEXT_BIN = path.join(
  path.dirname(createRequire(import.meta.url).resolve('next/package.json')),
  'dist/bin/next'
);
const BUILD_TIMEOUT = 180_000;

/** A package in node_modules whose code is marked by its name. */
const dependency = (name: string, files: Record<string, string>) => ({
  [`node_modules/${name}/package.json`]: {
    name,
    version: '1.0.0',
    license: 'MIT',
    sideEffects: false,
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

// Installed in a pnpm virtual store, and built from a source file that its
// own source map names outside of the package, so that Turbopack, which
// follows such source maps, names a file that belongs to no package.
const CHAINED_STORE = 'node_modules/.pnpm/chained@1.0.0/node_modules';
const chained = {
  [`${CHAINED_STORE}/chained/package.json`]: {
    name: 'chained',
    version: '1.0.0',
    license: 'MIT',
    main: 'dist/index.js',
  },
  [`${CHAINED_STORE}/chained/LICENSE`]: 'License of chained',
  [`${CHAINED_STORE}/chained/dist/index.js`]:
    "export const chained = () => 'chained';\n" +
    '//# sourceMappingURL=index.js.map\n',
  [`${CHAINED_STORE}/chained/dist/index.js.map`]: {
    version: 3,
    file: 'index.js',
    sources: ['../../src/index.ts'],
    sourcesContent: ["export const chained = (): string => 'chained';\n"],
    // Turbopack ignores a source map without names.
    names: [],
    mappings: 'AAAA',
  },
};

const packages = {
  ...dependency('used', {
    'index.js':
      "export const used = () => 'used';\n" +
      "export { unused } from './unused.js';\n",
    'unused.js': "export const unused = () => 'shaken';\n",
  }),
  ...dependency('imported-unused', {
    'index.js': "export const importedUnused = () => 'imported-unused';\n",
  }),
  ...dependency('ssg-only', {
    'index.js': "export const ssgOnly = () => 'ssg-only';\n",
  }),
  ...dependency('styles', { 'style.css': '.styles { color: teal; }\n' }),
  ...chained,
};

/** A Next project that records how Next calls the post-compile hook. */
const project = (files: Record<string, string>) => ({
  'package.json': { name: 'fixture', private: true },
  LICENSE: 'MIT License\n\nCopyright (c) Fixture App\n',
  'next.config.mjs': `
import fs from 'node:fs';
export default {
  productionBrowserSourceMaps: true,
  turbopack: { root: ${JSON.stringify(REPOSITORY_ROOT)} },
  compiler: {
    async runAfterProductionCompile(metadata) {
      fs.writeFileSync('hook.json', JSON.stringify(metadata));
    },
  },
};
`,
  ...packages,
  ...files,
});

const pagesRouter = project({
  'pages/_app.js': `
import 'styles/style.css';
export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />;
}
`,
  'pages/index.js': `
import { used } from 'used';
import { importedUnused } from 'imported-unused';
import { ssgOnly } from 'ssg-only';
import { chained } from 'chained';
export default function Home({ text }) {
  return <p className="styles">{used()}{chained()}{text}</p>;
}
export async function getStaticProps() {
  return { props: { text: ssgOnly() } };
}
`,
});

const appRouter = project({
  'app/layout.js': `
import 'styles/style.css';
export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}
`,
  'app/page.js': `
import { ssgOnly } from 'ssg-only';
import Client from './client';
export default function Page() {
  return <Client text={ssgOnly()} />;
}
`,
  'app/client.js': `
'use client';
import { used } from 'used';
import { chained } from 'chained';
export default function Client({ text }) {
  return <p className="styles">{used()}{chained()}{text}</p>;
}
`,
});

type Built = {
  names: string[];
  notices: string;
  hook: { projectDir: string; distDir: string };
};

/** Builds a fixture with next build, then writes its notices. */
async function buildFixture(
  fixture: TempProject,
  args: string[]
): Promise<Built> {
  fs.symlinkSync(
    path.join(fixture.root, CHAINED_STORE, 'chained'),
    path.join(fixture.root, 'node_modules/chained'),
    'dir'
  );
  await promisify(execFile)(process.execPath, [NEXT_BIN, 'build', ...args], {
    cwd: fixture.root,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  await writeThirdPartyLicenses({
    projectDir: fixture.root,
    distDir: '.next',
    config: { repositoryUrl: 'https://example.com/app' },
  });
  const read = (file: string) =>
    fs.readFileSync(path.join(fixture.root, file), 'utf8');
  return {
    names: JSON.parse(read('public/oss-licenses.json')).map(
      (pkg: { name: string }) => pkg.name
    ),
    notices: read('public/third-party-licenses.txt'),
    hook: JSON.parse(read('hook.json')),
  };
}

const FIXTURE_PACKAGES = ['used', 'styles', 'chained', 'next'];

describe.each([
  {
    label: 'Turbopack, Pages Router',
    files: pagesRouter,
    args: [],
    expected: [...FIXTURE_PACKAGES, 'react', 'react-dom'],
  },
  {
    label: 'webpack, Pages Router',
    files: pagesRouter,
    args: ['--webpack'],
    expected: [...FIXTURE_PACKAGES, 'react', 'react-dom'],
  },
  {
    label: 'Turbopack, App Router',
    files: appRouter,
    args: [],
    // The App Router runs the copy of React that Next bundles in
    // next/dist/compiled, so React is part of the next package here.
    expected: FIXTURE_PACKAGES,
  },
])('notices of a Next build with $label', ({ files, args, expected }) => {
  let fixture: TempProject;
  let built: Built;

  beforeAll(async () => {
    fixture = createTempProject(files, FIXTURE_PARENT);
    built = await buildFixture(fixture, args);
  }, BUILD_TIMEOUT);

  afterAll(() => fixture?.remove());

  it('list the packages with code or styles in the client build', () => {
    expect(built.names).toEqual(expect.arrayContaining(expected));
    expect(built.notices).toContain('used@1.0.0\nLicense: MIT\n');
    expect(built.notices).toContain('License of chained');
    expect(built.notices).toContain('Copyright (c) Fixture App');
  });

  it('leave out packages with no output in the client build', () => {
    expect(built.names).not.toContain('imported-unused');
    // Run during static generation only, so never sent to a browser.
    expect(built.names).not.toContain('ssg-only');
  });

  it('come from the hook Next calls with the project and build dirs', () => {
    expect(built.hook).toEqual({
      projectDir: fixture.root,
      distDir: path.join(fixture.root, '.next'),
    });
  });
});
