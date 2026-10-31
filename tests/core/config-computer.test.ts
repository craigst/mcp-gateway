import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';

describe('computer-use approval configuration', () => {
  it('defaults to the historical approval gates', () => {
    const config = loadConfig({ MCP_DATA_DIR: '/tmp/gateway-config-test' });
    expect(config.computerUse?.approvalRequiredTools).toEqual(['destroy_computer', 'device_exec']);
  });

  it('honours an explicit comma-separated override', () => {
    const config = loadConfig({
      MCP_DATA_DIR: '/tmp/gateway-config-test',
      MCP_COMPUTER_APPROVAL_REQUIRED_TOOLS: 'destroy_computer',
    });
    expect(config.computerUse?.approvalRequiredTools).toEqual(['destroy_computer']);
  });

  it('lets an explicit empty value disable per-call approvals', () => {
    const config = loadConfig({
      MCP_DATA_DIR: '/tmp/gateway-config-test',
      MCP_COMPUTER_APPROVAL_REQUIRED_TOOLS: '',
    });
    expect(config.computerUse?.approvalRequiredTools).toEqual([]);
  });
});
