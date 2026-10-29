import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { createContainer } from './container.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger('gateway', config.logLevel);
  const container = createContainer({ config, logger });

  const address = await container.start();
  logger.info('MCP Gateway ready', {
    url: address.url,
    ui: `${address.url}/`,
    rpc: `${address.url}/mcp/v1`,
    db: config.dbPath,
    vault: config.vaultSecret ? 'enabled' : 'disabled',
    delegationMaxDepth: config.delegationMaxDepth,
    gitImport: config.gitImportAllowedPrefixes.length > 0 ? 'enabled' : 'disabled',
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    const force = setTimeout(() => {
      logger.error('forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
    force.unref?.();
    try {
      await container.stop();
      clearTimeout(force);
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('shutdown error', { error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { error: reason instanceof Error ? reason.message : String(reason) });
  });
}

main().catch((error: unknown) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
