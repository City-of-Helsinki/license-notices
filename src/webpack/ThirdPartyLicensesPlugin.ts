import type { Compiler } from 'webpack';

import {
  validateDecisions,
  validateFirstPartyPackages,
  type ThirdPartyLicensesConfig,
} from '../core.js';
import { renderNoticeFiles } from '../packageNotices.js';
import {
  findBundledPackageDirs,
  STATS_OPTIONS,
  type StatsModuleLike,
} from '../rsbuild/modules.js';

const NAME = 'ThirdPartyLicensesPlugin';

/**
 * Emits the third-party license notices of a webpack build into its output
 * directory. The bundled packages are read from the module stats of the
 * compilation, as for Rspack, whose stats share their format.
 */
export class ThirdPartyLicensesPlugin {
  private readonly config: ThirdPartyLicensesConfig & { projectDir?: string };

  constructor(config: ThirdPartyLicensesConfig & { projectDir?: string }) {
    validateDecisions(config.licenseDecisions ?? {});
    validateFirstPartyPackages(config.firstPartyPackages);
    this.config = config;
  }

  apply(compiler: Compiler): void {
    // Imported from the compiler, so that the package does not load webpack.
    const { Compilation, WebpackError, sources } = compiler.webpack;
    const projectDir = this.config.projectDir ?? compiler.context;

    compiler.hooks.thisCompilation.tap(NAME, (compilation) => {
      if (compilation.compiler.isChild()) {
        return;
      }
      compilation.hooks.processAssets.tapPromise(
        { name: NAME, stage: Compilation.PROCESS_ASSETS_STAGE_REPORT },
        async () => {
          try {
            const { modules } = compilation.getStats().toJson(STATS_OPTIONS);
            const files = await renderNoticeFiles({
              projectDir,
              packageDirs: findBundledPackageDirs(
                projectDir,
                (modules ?? []) as StatsModuleLike[]
              ),
              config: this.config,
            });
            for (const [fileName, content] of files) {
              compilation.emitAsset(fileName, new sources.RawSource(content));
            }
          } catch (error) {
            compilation.errors.push(
              new WebpackError(
                error instanceof Error ? error.message : String(error)
              )
            );
          }
        }
      );
    });
  }
}
