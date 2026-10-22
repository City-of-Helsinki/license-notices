import type { NextConfig } from 'next';

import {
  validateDecisions,
  validateFirstPartyPackages,
  type ThirdPartyLicensesConfig,
} from '../core.js';
import { writeThirdPartyLicenses } from './writeThirdPartyLicenses.js';

type NextConfigFunction = (
  phase: string,
  context: { defaultConfig: NextConfig }
) => NextConfig | Promise<NextConfig>;

function addNoticesHook(
  nextConfig: NextConfig,
  config: ThirdPartyLicensesConfig
): NextConfig {
  const previous = nextConfig.compiler?.runAfterProductionCompile;
  return {
    ...nextConfig,
    compiler: {
      ...nextConfig.compiler,
      async runAfterProductionCompile(metadata) {
        // The notices are read from the source maps, so they are written
        // before a hook that might remove those, such as an upload to an
        // error tracker.
        if (nextConfig.productionBrowserSourceMaps !== true) {
          throw new Error(
            'The third-party license notices are read from the source maps ' +
              'of the client build, so the Next config must enable ' +
              'productionBrowserSourceMaps.'
          );
        }
        await writeThirdPartyLicenses({ ...metadata, config });
        await previous?.(metadata);
      },
    },
  };
}

/**
 * Adds the third-party license notices to the production build of a Next
 * app. They are written into its public directory after the bundler has
 * compiled the client, from the packages its source maps name, and a
 * license the notices cannot meet fails "next build".
 */
export function withThirdPartyLicenses(
  nextConfig: NextConfig,
  config: ThirdPartyLicensesConfig
): NextConfig;
export function withThirdPartyLicenses(
  nextConfig: NextConfigFunction,
  config: ThirdPartyLicensesConfig
): NextConfigFunction;
export function withThirdPartyLicenses(
  nextConfig: NextConfig | NextConfigFunction,
  config: ThirdPartyLicensesConfig
): NextConfig | NextConfigFunction {
  validateDecisions(config.licenseDecisions ?? {});
  validateFirstPartyPackages(config.firstPartyPackages);
  if (typeof nextConfig === 'function') {
    return async (phase, context) =>
      addNoticesHook(await nextConfig(phase, context), config);
  }
  return addNoticesHook(nextConfig, config);
}
