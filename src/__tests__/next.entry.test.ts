import { expect, it, vi } from 'vitest';

// A Next app does not have to install Vite, so loading it from the Next
// entry point would fail there.
vi.mock('vite', () => {
  throw new Error('The Next entry point loaded vite.');
});

it('loads the Next entry point without vite', async () => {
  // The mock is in place, so loading vite itself fails.
  await expect(import('vite')).rejects.toThrow();

  const entry = await import('../next.js');

  expect(Object.keys(entry)).toEqual(['withThirdPartyLicenses']);
});
