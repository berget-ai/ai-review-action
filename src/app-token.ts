import { createSign } from 'node:crypto';

/**
 * Minimal GitHub App installation-token minting (no external deps).
 *
 * A GitHub App token (unlike GITHUB_TOKEN / github-actions[bot]) is allowed to
 * APPROVE and REQUEST_CHANGES on pull request reviews. When the `github_app_id`
 * + `github_app_private_key` inputs are set, the action posts reviews as the
 * app instead of github-actions[bot].
 */

function base64Url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iat: now - 60, // allow for clock drift
      exp: now + 9 * 60, // max 10 minutes
      iss: appId,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = base64Url(signer.sign(privateKey));
  return `${unsigned}.${signature}`;
}

async function githubApi<T>({
  jwt,
  method,
  path,
}: {
  jwt: string;
  method: string;
  path: string;
}): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'berget-ai-review-action',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

/**
 * Resolve an installation access token for the GitHub App in the given repo.
 *
 * The installation ID is looked up via the repo installation endpoint unless
 * explicitly provided — this keeps consumer workflows to just two secrets
 * (app id + private key) and works for any repo the app is installed on.
 */
export async function getInstallationToken({
  appId,
  privateKey,
  installationId,
  owner,
  repo,
}: {
  appId: string;
  privateKey: string;
  installationId?: string;
  owner: string;
  repo: string;
}): Promise<string> {
  const jwt = createAppJwt(appId, privateKey);

  let id = installationId;
  if (!id) {
    const installation = await githubApi<{ id: number }>({
      jwt,
      method: 'GET',
      path: `/repos/${owner}/${repo}/installation`,
    });
    id = String(installation.id);
  }

  const token = await githubApi<{ token: string }>({
    jwt,
    method: 'POST',
    path: `/app/installations/${id}/access_tokens`,
  });
  return token.token;
}
