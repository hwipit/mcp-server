import type { HwipApiClient } from './api-client.js';
import { listenerDeviceId } from './config.js';
import { cryptoReady, getKeyPair, getPublicKey, selectRecipients, type DeviceRecipient } from './crypto.js';
import { noteOnce } from './key-changes.js';
import { ensureSelfListed, registerOverClient, registerWhyText } from './self-register.js';
import { observeDevices, TRUST_PATH } from './trust-pins.js';

/** Who a push is sealed for, or why it was not sent. There is no unsealed push. */
export type Audience = { recipients: DeviceRecipient[] } | { refused: string; code: typeof E2E_REQUIRED | typeof NO_APP_DEVICE };

/** The tool error a push that could not be sealed is reported as. */
export const E2E_REQUIRED = 'E2E_REQUIRED';
/** The tool error for an account with no phone app to read what is sent. */
export const NO_APP_DEVICE = 'NO_APP_DEVICE';
export const APP_LOGIN_REQUIRED = 'sign in to the Hwip app on an iPhone or Android phone';

/** Whether the account lists a phone app (hwip DeviceType `ios` | `android`; the macOS app does not count). */
export const hasAppDevice = (devices: { type?: string }[]): boolean =>
  devices.some((d) => d.type === 'ios' || d.type === 'android');

/** The message for a push that could not be sealed. */
export const sealFailed = (why: string): string => `${why}; nothing was sent`;

/**
 * Resolve who a push is sealed for. Every push is sealed (F16): a step that
 * fails ends the send, never turns it into plaintext.
 *
 * Every listed device with a key can read it. Trust never stops a push: a device seen
 * for the first time is pinned, a changed key replaces its pin with one warning.
 *
 * The device list is fetched per send, not cached: a phone that registered its
 * key a minute ago must be able to read the next push.
 */
export const resolveAudience = async (client: Pick<HwipApiClient, 'listDevices' | 'registerDeviceKey'>, { trustPath = TRUST_PATH, selfId = listenerDeviceId() }: { trustPath?: string; selfId?: string } = {}): Promise<Audience> => {
  const refuse = (why: string): Audience => ({ refused: sealFailed(why), code: E2E_REQUIRED });
  // The server connects before crypto has started (index.ts): a first send right away waits.
  await cryptoReady();
  const publicKey = getPublicKey();
  if (!getKeyPair() || !publicKey) return refuse('this machine\'s keys did not load');
  let devices: { deviceId: string; publicKey?: string; type?: string }[];
  try {
    devices = (await client.listDevices()).data;
    if (!Array.isArray(devices)) throw new Error('devices: unexpected response');
  } catch (err) {
    console.error('[Crypto] Could not list devices:', err);
    return refuse('the device list could not be read');
  }
  if (!hasAppDevice(devices)) return { refused: APP_LOGIN_REQUIRED, code: NO_APP_DEVICE };
  // The app checks who sent a push by the key the account lists for this machine. The push is not sealed for this
  // machine, so it is sealed for the list as read, and still sent when registering fails.
  const listing = await ensureSelfListed(devices, { deviceId: selfId, publicKey }, registerOverClient(client));
  if (!listing.ok) {
    const line = `could not register this machine's key (${registerWhyText(listing.why)}) — the app cannot verify who sent this push`;
    console.error(`[hwip] ${line}`);
    // This server's stderr reaches nobody: the result says it, once — the same failure comes back on every send.
    noteOnce(line);
  }
  observeDevices(trustPath, devices, { selfId });
  const recipients = selectRecipients(devices);
  if (recipients.length === 0) return refuse('no device has a per-device public key');
  return { recipients };
};
