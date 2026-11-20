import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { assertPrivateStorage, createDevFileDeny } from './server/dev-policy.js';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const directories = [env.PGLITE_DIR || '.data/postgres', env.BOARD_DIR || '.data/boards'];
  assertPrivateStorage(directories);
  return {
    plugins: [react()],
    build: { outDir: 'dist/client', sourcemap: false },
    server: {
      host: '127.0.0.1',
      allowedHosts: ['localhost'],
      fs: { strict: true, deny: createDevFileDeny(directories) },
    },
  };
});
