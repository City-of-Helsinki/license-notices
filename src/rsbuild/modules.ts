import { resolvePackageDirs } from '../packages.js';

/**
 * Finds the packages with code in an Rsbuild build from the modules in the
 * stats of its compilation, instead of from source maps, which Rsbuild does
 * not write for a production build unless configured to.
 */

/**
 * The stats a bundled module is told by, in the format Rspack shares with
 * webpack: the modules, those concatenated into them, the chunks of each,
 * and its used exports.
 */
export const STATS_OPTIONS = {
  all: false,
  modules: true,
  nestedModules: true,
  orphanModules: true,
  ids: true,
  usedExports: true,
} as const;

/**
 * The part of a module in the stats JSON of Rspack that is read here.
 * webpack names a module without a file, such as a context or an external
 * module, as null, where Rspack leaves the name out.
 */
export type StatsModuleLike = {
  nameForCondition?: string | null;
  orphan?: boolean;
  chunks?: (string | number)[];
  usedExports?: boolean | string[] | null;
  modules?: StatsModuleLike[];
};

/**
 * Whether a module has code in the build: it is in a chunk, or exports
 * that are used were inlined where they are used, such as a constant,
 * which leaves the module itself in no chunk.
 */
function isBundled(module: StatsModuleLike): boolean {
  const inChunk = !module.orphan && (module.chunks?.length ?? 0) > 0;
  const { usedExports } = module;
  return (
    inChunk ||
    usedExports === true ||
    (Array.isArray(usedExports) && usedExports.length > 0)
  );
}

/**
 * The paths of the modules with code in the build, and of the modules
 * concatenated into them, which are listed inside them without chunks of
 * their own. A module that tree shaking left out is in no chunk and has no
 * used exports.
 */
export function findBundledModulePaths(modules: StatsModuleLike[]): string[] {
  const paths = (module: StatsModuleLike): string[] => [
    ...(module.nameForCondition == null ? [] : [module.nameForCondition]),
    ...(module.modules ?? []).flatMap(paths),
  ];
  return modules.filter(isBundled).flatMap(paths);
}

/** The directories of the packages with modules in the build. */
export function findBundledPackageDirs(
  projectDir: string,
  modules: StatsModuleLike[]
): string[] {
  return resolvePackageDirs(
    projectDir,
    findBundledModulePaths(modules),
    'The modules of the build'
  );
}
