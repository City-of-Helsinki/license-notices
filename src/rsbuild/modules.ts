import { resolvePackageDirs } from '../packages.js';

/**
 * Finds the packages with code in an Rsbuild build from the modules in the
 * stats of its compilation, instead of from source maps, which Rsbuild does
 * not write for a production build unless configured to.
 */

/** The part of a module in the stats JSON of Rspack that is read here. */
export type StatsModuleLike = {
  nameForCondition?: string;
  orphan?: boolean;
  chunks?: (string | number)[];
  modules?: StatsModuleLike[];
};

/**
 * The paths of the modules in at least one chunk, and of the modules
 * concatenated into them, which are listed inside them without chunks of
 * their own. A module that tree shaking left out is in no chunk.
 */
export function findBundledModulePaths(modules: StatsModuleLike[]): string[] {
  const paths = (module: StatsModuleLike): string[] => [
    ...(module.nameForCondition === undefined ? [] : [module.nameForCondition]),
    ...(module.modules ?? []).flatMap(paths),
  ];
  return modules
    .filter((module) => !module.orphan && (module.chunks?.length ?? 0) > 0)
    .flatMap(paths);
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
