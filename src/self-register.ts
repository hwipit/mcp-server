/**
 * This machine's key on the account's device list (twin of the cli's `src/self-register.ts`). The phone seals an answer,
 * and a listener admits a command, by the key the account lists for this machine: a machine missing from the list, or listed
 * under an old key, puts its own there with one `PUT /devices/{id}/public-key` before it sends.
 */

import { hostname } from 'node:os';
import { ApiError, type HwipApiClient } from './api-client.js';
import { samePublicKey } from './crypto.js';

export type SelfKey = { deviceId: string; publicKey: string };

/** Why registering failed. `replace-forbidden`: the list holds another key for this machine and only a push:read key may replace it. */
export type RegisterWhy = `http ${number}` | 'network' | 'timeout' | 'replace-forbidden';

/** Puts this machine's key on the account's list; `null` when the server took it. */
export type Register = (self: SelfKey) => Promise<RegisterWhy | null>;

export type SelfListing<D> = { ok: true; devices: D[] } | { ok: false; why: RegisterWhy };

/**
 * The device list with this machine under its key: as read when it is there already (no request), else after one
 * registration, with this machine's entry patched in so the list is not read again.
 */
export const ensureSelfListed = async <D extends { deviceId: string; publicKey?: string }>(
  devices: D[],
  self: SelfKey,
  register: Register,
): Promise<SelfListing<D>> => {
  const listed = devices.find((d) => d.deviceId === self.deviceId);
  if (listed?.publicKey && samePublicKey(listed.publicKey, self.publicKey)) return { ok: true, devices };
  const why = await register(self);
  if (why !== null) return { ok: false, why: why === 'http 403' && listed?.publicKey ? 'replace-forbidden' : why };
  if (listed) return { ok: true, devices: devices.map((d) => (d === listed ? { ...d, publicKey: self.publicKey } : d)) };
  return { ok: true, devices: [...devices, { deviceId: self.deviceId, publicKey: self.publicKey, type: 'cli' } as unknown as D] };
};

/** Registers through the API client, which never follows a redirect with the API key. */
export const registerOverClient = (client: Pick<HwipApiClient, 'registerDeviceKey'>): Register => async ({ deviceId, publicKey }) => {
  try {
    await client.registerDeviceKey(deviceId, publicKey, hostname() || 'listener');
    return null;
  } catch (err) {
    if (!(err instanceof ApiError)) return 'network';
    if (err.code === 'API_TIMEOUT') return 'timeout';
    if (err.code === 'NETWORK_ERROR' || err.code === 'REDIRECT_REFUSED' || err.status <= 0) return 'network';
    return `http ${err.status}`;
  }
};

export const registerWhyText = (why: RegisterWhy): string =>
  why === 'replace-forbidden' ? 'the account lists another key for it, and only an API key with push:read may replace it'
    : why === 'network' ? 'could not reach the server'
      : why === 'timeout' ? 'the server did not answer in time'
        : `the server answered HTTP ${why.slice(5)}`;

export const unregisteredText = (what: string, why?: RegisterWhy): string =>
  `could not register this machine's key in the account's device list${why ? ` (${registerWhyText(why)})` : ''}; the ${what} was not sent`;
