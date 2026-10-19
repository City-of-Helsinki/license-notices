import { afterEach, describe, expect, it, vi } from 'vitest';

import { withThirdPartyLicenses } from '../next/withThirdPartyLicenses.js';
import { writeThirdPartyLicenses } from '../next/writeThirdPartyLicenses.js';

vi.mock('../next/writeThirdPartyLicenses.js', () => ({
  writeThirdPartyLicenses: vi.fn(async () => {}),
}));

const licensesConfig = { repositoryUrl: 'https://github.com/example/app' };
const metadata = { projectDir: '/app', distDir: '/app/.next' };

describe('withThirdPartyLicenses', () => {
  afterEach(() => vi.mocked(writeThirdPartyLicenses).mockClear());

  it('writes the notices after the production compile', async () => {
    const nextConfig = withThirdPartyLicenses(
      { productionBrowserSourceMaps: true, reactStrictMode: true },
      licensesConfig
    );

    await nextConfig.compiler?.runAfterProductionCompile?.(metadata);

    expect(nextConfig.reactStrictMode).toBe(true);
    expect(writeThirdPartyLicenses).toHaveBeenCalledWith({
      ...metadata,
      config: licensesConfig,
    });
  });

  it('keeps a hook already configured, and runs it afterwards', async () => {
    const calls: string[] = [];
    vi.mocked(writeThirdPartyLicenses).mockImplementationOnce(async () => {
      calls.push('notices');
    });
    const nextConfig = withThirdPartyLicenses(
      {
        productionBrowserSourceMaps: true,
        compiler: {
          removeConsole: true,
          runAfterProductionCompile: async () => {
            calls.push('previous');
          },
        },
      },
      licensesConfig
    );

    await nextConfig.compiler?.runAfterProductionCompile?.(metadata);

    // A hook that uploads and removes the source maps must not run first.
    expect(calls).toEqual(['notices', 'previous']);
    expect(nextConfig.compiler?.removeConsole).toBe(true);
  });

  it('fails the build without production source maps', async () => {
    const nextConfig = withThirdPartyLicenses({}, licensesConfig);

    await expect(
      nextConfig.compiler?.runAfterProductionCompile?.(metadata)
    ).rejects.toThrow('must enable productionBrowserSourceMaps');
    expect(writeThirdPartyLicenses).not.toHaveBeenCalled();
  });

  it('wraps a config given as a function of the phase', async () => {
    const nextConfig = withThirdPartyLicenses(
      async (phase: string) => ({
        productionBrowserSourceMaps: true,
        env: { PHASE: phase },
      }),
      licensesConfig
    );

    const resolved = await nextConfig('phase-production-build', {
      defaultConfig: {},
    });
    await resolved.compiler?.runAfterProductionCompile?.(metadata);

    expect(resolved.env).toEqual({ PHASE: 'phase-production-build' });
    expect(writeThirdPartyLicenses).toHaveBeenCalledOnce();
  });

  it('refuses an unguarded scope pattern when the config is loaded', () => {
    expect(() =>
      withThirdPartyLicenses(
        {},
        {
          ...licensesConfig,
          licenseDecisions: { '@vendor/*': { license: 'MIT', note: 'No.' } },
        }
      )
    ).toThrow('must state the license the packages it replaces declare');
  });
});
