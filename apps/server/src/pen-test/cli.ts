/**
 * The pen-test deployment's commands (E1, docs/pen-test/deployment.md):
 *
 *   pnpm pen-test:up [default|socket-proxy]   build the round's Images and start Lookout in
 *                                             one shipped configuration (switches if up)
 *   pnpm pen-test:seed                        (re)load the fixtures (E2)
 *   pnpm pen-test:status                      which configuration is running, and what
 *   pnpm pen-test:down                        destroy it, its volumes and its credentials
 */
import { CONFIGURATIONS, down, status, up, type Configuration } from './deployment.ts';
import { seed } from './fixtures/loader.ts';

async function main(command: string | undefined, arg: string | undefined): Promise<void> {
  switch (command) {
    case 'up': {
      const configuration = (arg ?? 'default') as Configuration;
      if (!CONFIGURATIONS.includes(configuration)) {
        throw new Error(`The configuration must be one of ${CONFIGURATIONS.join(', ')}`);
      }
      await up(configuration);
      return;
    }
    case 'seed':
      seed();
      return;
    case 'status':
      status();
      return;
    case 'down':
      down();
      return;
    default:
      throw new Error('Usage: cli.ts up [default|socket-proxy] | seed | status | down');
  }
}

try {
  await main(process.argv[2], process.argv[3]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
