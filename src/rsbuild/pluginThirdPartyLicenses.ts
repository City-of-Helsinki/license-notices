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

/** The environments that build for the browser, in the order of their index. */
export function webEnvironments<T extends EnvironmentContextLike>(
  environments: Record<string, T>
): T[] {
  return Object.values(environments)
    .filter((environment) => environment.config.output.target === 'web')
    .sort((a, b) => a.index - b.index);
}

/**
 * Writes the third-party license notices of a production build into the
 * root of the output directory of each web environment, which Rsbuild
 * empties before each build and an application serves from its root.
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
        for (const environment of webEnvironments(environments)) {
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
          await writeNotices({
            projectDir: api.context.rootPath,
            outputDir: environment.distPath,
            packageDirs: findBundledPackageDirs(
              api.context.rootPath,
              (modules ?? []) as StatsModuleLike[]
            ),
            config,
          });
        }
      });
    },
  };
}
