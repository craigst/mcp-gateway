// Explicitly opt in; never point this smoke test at a writable production brain.
import { strict as assert } from 'node:assert';
import { startServer } from './lib/mcp-client.mjs';

if (process.env.BRAIN_STAGING_TEST !== '1' || process.env.BRAIN_URL !== 'http://mcp-brain-stage-api:8000') {
  throw new Error('This test only runs against the isolated read-only staging service.');
}
const server = startServer({
  BRAIN_URL: process.env.BRAIN_URL,
  BRAIN_API_KEY: 'synthetic-brain-key',
  BRAIN_LOCAL_GRANT: '1',
  BRAIN_LOCAL_AGENT: 'example-agent',
  BRAIN_LOCAL_ACTIONS: 'search,remember,update,knowledge=homelab,knowledge=projects',
}, { timeoutMs: 120000 });
try {
  const identity = await server.callJson('brain_whoami', {});
  assert.equal(identity.isError, false);
  assert.deepEqual(identity.json.documentCategoriesReadable.sort(), ['homelab', 'projects']);
  const documents = await server.call('knowledge_search', { query: 'gateway', top_k: 8 });
  assert.equal(documents.isError, false);
  assert.doesNotMatch(documents.text, /\[financial\]|\[personal\]/);
  const memories = await server.call('brain_search', { query: 'gateway', top_k: 5 });
  assert.equal(memories.isError, false);
  const write = await server.call('brain_remember', { text: 'Synthetic staging-only write', infer: false });
  assert.equal(write.isError, true);
  assert.match(write.text, /503|read.only/i);
  console.log('Staged adapter: identity, category-restricted document search, memory search and read-only write rejection passed.');
} finally {
  await server.stop();
}
