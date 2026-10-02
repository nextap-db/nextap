import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function deploymentConfig(urlValue, commit) {
  if (!urlValue) throw new Error('Set NEXTAP_DEPLOY_URL to the public Worker/custom-domain HTTPS origin before deployment.');
  let url;
  try { url = new URL(urlValue); } catch { throw new Error('NEXTAP_DEPLOY_URL is not a valid URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('NEXTAP_DEPLOY_URL must be an HTTPS origin, without credentials, path, query, or fragment.');
  }
  if (!/^[a-f0-9]{40}$/i.test(commit || '')) throw new Error('GITHUB_SHA must be a full 40-character commit hash.');
  return { origin: url.origin, commit };
}

export async function verifyDeployment(config, { fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 12 } = {}) {
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const url = new URL('/__nextap-version', config.origin);
      url.searchParams.set('build_check', config.commit + '-' + attempt);
      const response = await fetchImpl(url, { cache: 'no-store', redirect: 'error', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`version endpoint returned HTTP ${response.status}`);
      const version = await response.json();
      if (version.commit !== config.commit) throw new Error(`active commit ${String(version.commit || '(missing)')} differs from expected ${config.commit}`);
      return version;
    } catch (error) { lastError = error.message; }
    if (attempt < attempts) await sleep(4_000);
  }
  throw new Error(`Active deployment could not be confirmed: ${lastError}`);
}

async function main() {
  const config = deploymentConfig(process.env.NEXTAP_DEPLOY_URL, process.env.GITHUB_SHA);
  if (process.argv.includes('--check-config')) {
    console.log(`Deployment target configuration valid: ${config.origin}`);
    return;
  }
  await verifyDeployment(config);
  console.log(`Confirmed active commit ${config.commit} at ${config.origin}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
