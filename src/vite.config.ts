import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  envDir: '..',
  build: { target: 'es2022', outDir: '../dist', emptyOutDir: true }
});
