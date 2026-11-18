// git-forge entry point: the one process the trial runs.
//
// The lifecycle is the env's contract (see the kit's starter README):
// the process binds an ephemeral port, registers that port with the env
// at $MAKEFUN_ENV_URL, then polls the env until it reports the trial is
// done, and exits 0. It never binds port 8080 (the env owns that), never
// exits early, and the server itself lives in app.ts — this file only
// wires the server to the env.
//
// Steps:
//   1. MAKEFUN_ENV_URL names the env origin (http://store:8080 in a trial
//      container). Without it there is nothing to talk to, so exit 1.
//   2. Build the server with createApp() and listen(0): the kernel picks
//      a free port.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the
//      request's source address plus N as the base URL and dials it from
//      then on. The first register wins; a 409 means another entry already
//      registered, and this process simply keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers at once ({"done": false} while the suite runs), so this is
//      a poll, not a long-held request. A failed or slow poll is retried
//      with a short exponential backoff; the process never exits before
//      the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.

import { createApp } from './app.ts';

// The env's origin, with any trailing slashes stripped.
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// How long one register or done request may take before it is abandoned.
const REQUEST_TIMEOUT_MS = 30_000;
// Backoff between retries: starts at 250 ms, doubles, caps at 2 s.
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped.
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

// POST the bound port until the env accepts it. 200 is the normal answer;
// 409 means a first register already won, which is not this process's to
// fix. 400 and 405 are contract errors and end the program; a network
// error or another status is retried, since the env may still be starting.
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

// Poll GET /done until it answers {"done": true}; never return before that.
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not
      // done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

// Bind the port, register it, then wait for the env: the whole life of
// the process.
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
