import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Finds the installed package a source of a client source map belongs to.
 *
 * The bundlers name sources differently: Turbopack as
 * "turbopack:///[project]/node_modules/...", relative to its root directory,
 * which may be above the project, webpack as "webpack://_N_E/./node_modules/
 * ...", and CSS sometimes without a scheme at all. Turbopack also follows the
 * source maps that packages ship, so a source can name a file the package was
 * built from, outside the installed package, such as "@apollo/src/...".
 */

const NODE_MODULES = 'node_modules';

/** The path of a source, without the scheme of the bundler that named it. */
export function sourcePathOf(source: string): string {
  if (source.startsWith('file://')) {
    return fileURLToPath(source).replaceAll('\\', '/');
  }
  return source
    .replaceAll('\\', '/')
    .replace(/^[a-z][\w+.-]*:\/\/[^/]*\//i, '')
    .replace(/^\[project\]\//, '');
}

/** Whether a source comes from node_modules rather than from the app. */
export function isDependencySource(source: string): boolean {
  return sourcePathOf(source).split('/').includes(NODE_MODULES);
}

/** The project directory and every directory above it, nearest first. */
export function ancestorsOf(dir: string): string[] {
  const parent = path.dirname(dir);
  return parent === dir ? [dir] : [dir, ...ancestorsOf(parent)];
}

const manifestCache = new Map<string, boolean>();

/** Whether a directory holds a package.json naming a package and version. */
function isPackageDir(dir: string): boolean {
  if (!manifestCache.has(dir)) {
    let isPackage: boolean;
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
      );
      isPackage =
        typeof manifest.name === 'string' &&
        typeof manifest.version === 'string';
    } catch {
      isPackage = false;
    }
    manifestCache.set(dir, isPackage);
  }
  return manifestCache.get(dir) === true;
}

/** The number of path segments a package name takes after node_modules. */
function nameLength(segments: string[], at: number): number {
  return segments[at]?.startsWith('@') ? 2 : 1;
}

/**
 * The package that contains a path in node_modules: the nearest package
 * directory the path is inside of, whichever node_modules it is installed
 * in. A source a package was built from, or bundled from another package,
 * belongs to the package that shipped it.
 */
function findEnclosingPackage(segments: string[]): string | undefined {
  for (let i = segments.lastIndexOf(NODE_MODULES); i >= 0; i -= 1) {
    if (segments[i] !== NODE_MODULES || segments[i + 1]?.startsWith('.')) {
      continue;
    }
    const dir = segments.slice(0, i + 1 + nameLength(segments, i + 1));
    if (isPackageDir(dir.join('/'))) {
      return dir.join('/');
    }
  }
  return undefined;
}

/**
 * The package a path in the pnpm virtual store belongs to, when the path
 * names a file outside of it. Each directory of the store holds one
 * package, next to symbolic links to its dependencies, so the one real
 * package directory in it is the package that shipped the source.
 */
function findStorePackage(segments: string[]): string | undefined {
  const store = segments.lastIndexOf('.pnpm');
  if (store === -1 || segments[store + 2] !== NODE_MODULES) {
    return undefined;
  }
  const storeDir = segments.slice(0, store + 3).join('/');
  const realDirs = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          return [];
        }
        return entry.name.startsWith('@') ? realDirs(entryPath) : [entryPath];
      })
      .filter((entryPath) => isPackageDir(entryPath));

  let candidates: string[];
  try {
    candidates = realDirs(storeDir);
  } catch {
    return undefined;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function findOwner(file: string): string | undefined {
  const segments = file.split(path.sep);
  return findEnclosingPackage(segments) ?? findStorePackage(segments);
}

/**
 * The directory of the installed package a dependency source belongs to, or
 * undefined when it cannot be told. A relative source is relative to the
 * root of the bundler, which can be the project or a directory above it, so
 * it is resolved against the base directory where the file exists, or for a
 * file a package was built from, the first one where it leads to a package.
 */
export function findPackageDir(
  source: string,
  baseDirs: string[]
): string | undefined {
  const sourcePath = sourcePathOf(source);
  const candidates = path.isAbsolute(sourcePath)
    ? [path.normalize(sourcePath)]
    : baseDirs.map((dir) => path.join(dir, path.posix.normalize(sourcePath)));

  const existing = candidates.find((file) => fs.existsSync(file));
  if (existing !== undefined) {
    return findOwner(existing);
  }
  for (const file of candidates) {
    const owner = findOwner(file);
    if (owner !== undefined) {
      return owner;
    }
  }
  return undefined;
}
