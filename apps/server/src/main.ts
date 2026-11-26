import { buildApp } from './app.ts';
import { bindAddressWarning, ConfigError, loadConfig } from './config.ts';
import { EngineDockerClient } from './docker/engine.ts';

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Lookout cannot start. ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const app = await buildApp({
  config,
  docker: new EngineDockerClient(),
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'Shutting down');
    void app.close().then(() => process.exit(0));
  });
}

// A public or every-interface bind address is allowed, but never silently (#122).
const bindWarning = bindAddressWarning(config.bindAddress);
if (bindWarning) app.log.warn({ bindAddress: config.bindAddress }, bindWarning);

try {
  await app.listen({ host: config.bindAddress, port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'Lookout failed to start');
  process.exit(1);
}
