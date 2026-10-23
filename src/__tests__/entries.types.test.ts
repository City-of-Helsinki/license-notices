import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { beforeAll, expect, it } from 'vitest';

const SOURCE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
// Emitting the declarations of the whole source takes seconds on a CI runner.
const EMIT_TIMEOUT = 60_000;
// The packages whose types each bundler brings, Vite through Rollup.
const VITE_TYPES = ['vite', 'rollup', 'rollup-license-plugin'];
const NEXT_TYPES = ['next'];
const WEBPACK_TYPES = ['webpack'];

/** The declaration files the build emits, by path relative to src/. */
function emitDeclarations(): Map<string, string> {
  const configFile = ts.findConfigFile(SOURCE_DIR, ts.sys.fileExists);
  const { config } = ts.readConfigFile(configFile!, ts.sys.readFile);
  const { options, fileNames } = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    path.dirname(configFile!)
  );
  const declarations = new Map<string, string>();
  ts.createProgram(
    fileNames.filter((file) => !file.includes('__tests__')),
    {
      ...options,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      rootDir: SOURCE_DIR,
      outDir: SOURCE_DIR,
    }
  ).emit(undefined, (file, text) => {
    declarations.set(path.relative(SOURCE_DIR, file), text);
  });
  return declarations;
}

/** The modules a declaration file imports or re-exports from. */
function importsOf(text: string): string[] {
  return [...text.matchAll(/\bfrom '([^']+)'|import\('([^']+)'\)/g)].map(
    (match) => match[1] ?? match[2]
  );
}

/** The packages outside of this one whose types a declaration reaches. */
function findExternalTypes(
  declarations: Map<string, string>,
  entry: string
): string[] {
  const reached = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string) => {
    if (reached.has(file)) {
      return;
    }
    reached.add(file);
    for (const specifier of importsOf(declarations.get(file)!)) {
      if (specifier.startsWith('.')) {
        visit(
          path.join(path.dirname(file), specifier.replace(/\.js$/, '.d.ts'))
        );
      } else {
        external.add(specifier);
      }
    }
  };
  visit(entry);
  return [...external];
}

let declarations: Map<string, string>;

beforeAll(() => {
  declarations = emitDeclarations();
}, EMIT_TIMEOUT);

// Each entry point is for an application built with one bundler, which need
// not have installed the others.
it.each([
  ['index.d.ts', [...NEXT_TYPES, ...WEBPACK_TYPES]],
  ['next.d.ts', [...VITE_TYPES, ...WEBPACK_TYPES]],
  ['webpack.d.ts', [...VITE_TYPES, ...NEXT_TYPES]],
])('declares %s without the types of other bundlers', (entry, others) => {
  const external = findExternalTypes(declarations, entry);

  expect(external.filter((name) => others.includes(name))).toEqual([]);
});
