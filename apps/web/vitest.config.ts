import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';
import { lookoutVersion } from './vite.config.ts';

export default defineProject({
  plugins: [react()],
  define: { 'import.meta.env.VITE_LOOKOUT_VERSION': JSON.stringify(lookoutVersion()) },
  test: {
    name: 'web',
    include: ['{src,scripts,screenshots}/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
  },
});
