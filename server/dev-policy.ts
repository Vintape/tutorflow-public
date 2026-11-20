// Keep Vite's baseline exclusions when adding application-private paths.
export const DEV_FILE_DENY = [
  '.env',
  '.env.*',
  '*.{crt,pem}',
  '**/.git/**',
  '**/.data/**',
  '**/.codex/**',
  '**/.agents/**',
  '**/docs/**',
  '**/server/**',
  '**/scripts/**',
  '**/tests/**',
  '**/AGENTS.md',
];
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// Resolve existing ancestors too: storage is commonly configured before it exists.
function physicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return resolve(physicalPath(parent), relative(parent, path));
  }
}

function paths(directories: string[], root: string): string[] {
  return [
    ...new Set(
      directories.flatMap((p) => {
        const absolute = resolve(root, p);
        return [absolute, physicalPath(absolute)];
      }),
    ),
  ];
}

export function createDevFileDeny(directories: string[], root = process.cwd()): string[] {
  return [
    ...DEV_FILE_DENY,
    ...paths(directories, root).map(
      (p) =>
        `${p
          .split(sep)
          .join('/')
          .replace(/[\\*?[\]{}()!+@]/g, '\\$&')}/**`,
    ),
  ];
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

// Vite publicDir is copied to the build and served without fs.deny filtering.
// Fail before opening either store; also apply during a standalone Vite build.
export function assertPrivateStorage(directories: string[], root = process.cwd()): void {
  const publicPaths = paths(['public', 'dist/client'], root);
  if (
    paths(directories, root).some((privatePath) =>
      publicPaths.some(
        (publicPath) => contains(publicPath, privatePath) || contains(privatePath, publicPath),
      ),
    )
  ) {
    throw new Error('Private storage must be outside public and dist/client directories');
  }
}
