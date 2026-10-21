import type { RsbuildPlugin } from '@rsbuild/core';

import type { ThirdPartyLicensesConfig } from '../core.js';
import { writeNotices } from '../packageNotices.js';
import { findBundledPackageDirs, type StatsModuleLike } from './modules.js';

/** The part of the context of an Rsbuild environment that is read here. */
export type EnvironmentContextLike = {
  index: number;
  distPath: string;
  config: { output: { target: string } };
};

/** The targets of Rsbuild whose output runs in a browser. */
const BROWSER_TARGETS = new Set(['web', 'web-worker']);

/**
 * The environments that build for a browser, grouped by their output
 * directory, which several of them can share, in the order of their index.
 */
export function browserOutputs<T extends EnvironmentContextLike>(
  environments: Record<string, T>
): { distPath: string; environments: T[] }[] {
  const outputs = new Map<string, T[]>();
  for (const environment of Object.values(environments).sort(
    (a, b) => a.index - b.index
  )) {
    if (BROWSER_TARGETS.has(environment.config.output.target)) {
      outputs.set(environment.distPath, [
        ...(outputs.get(environment.distPath) ?? []),
        environment,
      ]);
    }
  }
  return [...outputs].map(([distPath, grouped]) => ({
    distPath,
    environments: grouped,
  }));
}

/**
 * Writes the third-party license notices of a production build into the
 * root of each output directory of the environments that build for a
 * browser, which Rsbuild empties before each build and an application
 * serves from its root.
 */
export function pluginThirdPartyLicenses(
  config: ThirdPartyLicensesConfig
): RsbuildPlugin {
  return {
    name: 'license-notices:third-party-licenses',
    setup(api) {
      api.onAfterBuild(async ({ stats, environments }) => {
        if (stats === undefined) {
          return;
        }
        const packageDirsOf = (environment: EnvironmentContextLike) => {
          const environmentStats =
            'stats' in stats ? stats.stats[environment.index] : stats;
          const { modules } = environmentStats.toJson({
            all: false,
            modules: true,
            nestedModules: true,
            orphanModules: true,
            ids: true,
            usedExports: true,
          });
          return findBundledPackageDirs(
            api.context.rootPath,
            (modules ?? []) as StatsModuleLike[]
          );
        };
        for (const output of browserOutputs(environments)) {
          await writeNotices({
            projectDir: api.context.rootPath,
            outputDir: output.distPath,
            packageDirs: output.environments.flatMap(packageDirsOf),
            config,
          });
        }
      });
    },
  };
}
