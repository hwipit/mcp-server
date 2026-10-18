/**
 * Which key to believe for a device that signs something with its own key
 * (twin of the cli's `src/peer-key.ts`, same rules).
 *
 * An envelope that opens only shows its sender held *a* key (push v1 carries
 * the sender's public key unsigned), so the reader must say whose key it
 * expects. This answers that for one device id: the key the account's device
 * list registers for it. Trust never refuses (F16): the key is pinned the first
 * time it is seen, and a changed key replaces its pin with one warning
 * (`observeDevices`, `~/.hwip/trusted-devices.json`).
 */

import { samePublicKey } from './crypto.js';
import { DEVICE_ID, observeDevices, TRUST_PATH } from './trust-pins.js';

export type PeerKeyRefusal =
  /** Not a device id, or not in the account's device list. */
  | 'unlisted'
  /** The device list could not be fetched. */
  | 'devices_unavailable';

export type PeerKey = { key: string } | { refused: PeerKeyRefusal };

export interface PeerKeyDeps {
  /** The key the account's device list registers for `deviceId`: null when none is listed, a rejection when the list cannot be had. */
  registeredKey: (deviceId: string) => Promise<string | null>;
  /** The listener's state file. Defaults to `~/.hwip/trusted-devices.json`. */
  trustPath?: string;
  /** This machine. Asking about oneself needs no list. */
  self?: { deviceId: string; publicKey: string };
  /** This machine's id when `self` is left out so its key cannot vouch: it is still never pinned. */
  selfId?: string;
}

export const peerKeyOf = async (deviceId: string, deps: PeerKeyDeps): Promise<PeerKey> => {
  if (!DEVICE_ID.test(deviceId)) return { refused: 'unlisted' };
  if (deps.self?.deviceId === deviceId) return { key: deps.self.publicKey };

  let registered: string | null;
  try {
    registered = await deps.registeredKey(deviceId);
  } catch {
    return { refused: 'devices_unavailable' };
  }
  // A listed key that is no device key in the one spelling is as good as none.
  if (!registered || !samePublicKey(registered, registered)) return { refused: 'unlisted' };

  observeDevices(deps.trustPath ?? TRUST_PATH, [{ deviceId, publicKey: registered }], { selfId: deps.self?.deviceId ?? deps.selfId });
  return { key: registered };
};
