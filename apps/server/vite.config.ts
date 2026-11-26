import { defineConfig } from 'vite';

/**
 * Compiles the server to plain JavaScript for the Image (`pnpm --filter @lookout/server
 * build`). Running .ts directly needs Node's TypeScript stripper, which costs about 20 MB of
 * memory; the Image runs these files instead, to stay inside NFR-1's 100 MB. Dependencies
 * in node_modules stay external; @lookout/shared is bundled in.
 */
export default defineConfig({
  build: {
    ssr: true,
    target: 'node26',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rolldownOptions: {
      input: {
        main: 'src/main.ts',
        healthcheck: 'src/healthcheck.ts',
        'hash-password': 'src/cli/hash-password.ts',
      },
      output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: '[name].js' },
    },
  },
  ssr: { target: 'node' },
});
