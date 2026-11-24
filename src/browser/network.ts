import { createConnection } from 'node:net';

export const DEFAULT_NETWORK_HOSTS = ['www.linkedin.com', 'one.one.one.one'] as const;

export type WaitForNetworkOptions = {
  hosts?: readonly string[];
  timeoutMs?: number;
  connect?: (host: string, port: number, timeoutMs: number) => Promise<void>;
};

async function tcpConnect443(host: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port: 443 });
  const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`tcp_timeout:${host}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function waitForNetwork(opts: WaitForNetworkOptions = {}): Promise<{ ok: true; hosts: string[] }> {
  const hosts = opts.hosts?.length ? [...opts.hosts] : [...DEFAULT_NETWORK_HOSTS];
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const connect = opts.connect ?? ((h, _p, t) => tcpConnect443(h, t));
  const failures: string[] = [];
  for (const host of hosts) {
    try {
      await connect(host, 443, timeoutMs);
    } catch {
      failures.push(host);
    }
  }
  if (failures.length === hosts.length) {
    throw new Error(`network_unavailable:${failures.join(',')}`);
  }
  return { ok: true, hosts };
}

export type CaptivePortalResult =
  | { status: 'ok' }
  | { status: 'network_unavailable'; detail: string };

export async function checkCaptivePortal(
  fetchFn: typeof fetch = globalThis.fetch,
  timeoutMs = 5_000,
): Promise<CaptivePortalResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn('http://connectivitycheck.gstatic.com/generate_204', {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.status === 204 && resp.headers.get('location') === null) {
      return { status: 'ok' };
    }
    return { status: 'network_unavailable', detail: `status_${resp.status}` };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'network_unavailable', detail: msg };
  }
}