import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentConfig, verifyDeployment } from '../scripts/verify-deployment.mjs';

const commit = 'a'.repeat(40);
const config = deploymentConfig('https://nextap.example.com', commit);

test('deployment configuration is required and validated before mutations', () => {
  for (const url of ['', 'http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?x=1']) assert.throws(() => deploymentConfig(url, commit));
  assert.throws(() => deploymentConfig('https://example.com', 'development'));
  assert.deepEqual(config, { origin: 'https://nextap.example.com', commit });
});

test('deployment verification waits for the exact commit on the serving endpoint', async () => {
  const requested = [];
  const version = await verifyDeployment(config, {
    attempts: 2,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      requested.push({ url, options });
      return Response.json({ commit: requested.length === 1 ? 'b'.repeat(40) : commit });
    }
  });
  assert.equal(version.commit, commit);
  assert.equal(requested.length, 2);
  assert.equal(requested[0].url.pathname, '/__nextap-version');
  assert.equal(requested[0].options.redirect, 'error');
});

test('upload/success response without the expected active commit fails verification', async () => {
  await assert.rejects(verifyDeployment(config, { attempts: 1, fetchImpl: async () => Response.json({ uploaded: true, commit: 'older' }) }), /Active deployment could not be confirmed/);
});
