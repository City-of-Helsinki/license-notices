import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type TempProject = { root: string; remove: () => void };

/**
 * Writes the given files, keyed by path relative to the project root, into a
 * fresh temporary directory. Objects are written as JSON.
 */
export function createTempProject(
  files: Record<string, string | object>
): TempProject {
  // Resolved, because the bundler reports module paths through symlinks such
  // as the /var -> /private/var of macOS.
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'license-notices-'))
  );
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      typeof content === 'string' ? content : JSON.stringify(content)
    );
  }
  return {
    root,
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
