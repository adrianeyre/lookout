import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    include: ['{src,test,test-support}/**/*.test.ts'],
    environment: 'node',
  },
});
