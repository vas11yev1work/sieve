import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // `SIEVE_API=http://127.0.0.1:PORT bun run dev:ui` to develop against a running `sieve serve`
    proxy: { '/api': process.env.SIEVE_API || 'http://127.0.0.1:4545' },
  },
});
