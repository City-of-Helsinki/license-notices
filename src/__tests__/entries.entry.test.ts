import { beforeEach, expect, it, vi } from 'vitest';

const BUNDLERS = ['vite', 'next', '@rsbuild/core'];

beforeEach(() => {
  vi.resetModules();
});

// Each entry point is for an application built with one bundler, which need
// not have installed the others, so loading one of them would fail there.
it.each([
  ['../index.js', 'vite', ['thirdPartyLicenses']],
  ['../next.js', 'next', ['withThirdPartyLicenses']],
  ['../rsbuild.js', '@rsbuild/core', ['pluginThirdPartyLicenses']],
])('loads %s without the other bundlers', async (entry, own, exports) => {
  for (const bundler of BUNDLERS.filter((name) => name !== own)) {
    vi.doMock(bundler, () => {
      throw new Error(`${entry} loaded ${bundler}.`);
    });
  }

  const loaded = await import(/* @vite-ignore */ entry);

  expect(Object.keys(loaded)).toEqual(exports);
});

it('fails to load a bundler that is mocked away', async () => {
  vi.doMock('vite', () => {
    throw new Error('Loaded vite.');
  });

  await expect(import('vite')).rejects.toThrow();
});
