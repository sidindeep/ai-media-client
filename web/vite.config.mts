import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue()],
  base: '/app/',
  build: {
    outDir: fileURLToPath(new URL('../public/vue', import.meta.url)),
    emptyOutDir: true,
  },
});
