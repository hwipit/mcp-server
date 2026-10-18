/**
 * `hwip agent send` sealed (F2): the message goes to the target listener inside a
 * push-v1 envelope, so the server relays it and reads nothing of what is typed into
 * the other session. Every command is sealed (F16); one that cannot be is refused,
 * never sent in the clear.
 *
 * The receiving listener takes a command only from a device whose key it can check, and the server stamps a send made with
 * an API key `api_<keyId>`, which names no machine. So the sealed label carries `from`, this machine's device id; the listener
 * admits it by the key the account lists for that id and the one it pinned.
 *
 * The target's key is the one the account lists for it (this machine's own when the target is here). Trust never stops a
 * send (F16): every listed device is pinned when first seen, and a changed key replaces its pin with one warning.
 *
 * Nothing here logs or returns a decrypt or encrypt error's message.
 */

import { encryptPushBodyForDevices, selectRecipients, type DeviceRecipient, type PushBodyInput } from './crypto.js';
import { type AskSealDeps, type SealedFields } from './ask-seal.js';
import { nextCommandNumber, type CommandSeqRefusal } from './command-seq.js';
import { peerKeyOf } from './peer-key.js';
import { ensureSelfListed, unregisteredText, type RegisterWhy } from './self-register.js';
import { observeDevices } from './trust-pins.js';

export type CommandSealDeps = Pick<AskSealDeps, 'loadKeys' | 'self' | 'listDevices' | 'register' | 'trustPath'> & {
  /** The next command number from the counter every sender on this machine shares. */
  nextNumber?: () => Promise<number | { refused: CommandSeqRefusal }>;
  seal?: (content: PushBodyInput, recipients: DeviceRecipient[]) => Promise<SealedFields & { isEncrypted: true }>;
};

export type CommandRefusal =
  | 'keystore'
  | 'devices'
  | 'self-unlisted'
  | 'target-unlisted'
  | 'number-locked'
  | 'number-unusable'
  | 'encrypt';

export const COMMAND_REFUSAL_TEXT: Record<CommandRefusal, string> = {
  'keystore': 'this machine\'s encryption keys did not load; the message was not sent',
  'devices': 'the device list could not be fetched; the message was not sent',
  'self-unlisted': unregisteredText('message'),
  'target-unlisted': 'the target computer is not in the account\'s device list with a key (run `hwip listener` on it once); the message was not sent',
  'number-locked': 'another hwip process holds ~/.hwip/command-seq.lock; try again in a moment (the message was not sent)',
  'number-unusable': 'the command counter ~/.hwip/command-seq cannot be read or written; the message was not sent',
  'encrypt': 'sealing the message failed; the message was not sent',
};

export const commandRefusalMessage = (cause: CommandRefusal, why?: RegisterWhy): string =>
  `sealed send: ${cause === 'self-unlisted' ? unregisteredText('message', why) : COMMAND_REFUSAL_TEXT[cause]}`;

export type PreparedCommand =
  | { kind: 'sealed'; fields: SealedFields }
  | { kind: 'refused'; cause: CommandRefusal; why?: RegisterWhy };

/**
 * Decide how `message` reaches `session` on `targetDeviceId`, and seal it when it must be sealed.
 * The caller sends `sealed` with the returned fields (body, key, slots), and tells the user of `refused` without sending.
 */
export const sealedCommand = async (
  command: { targetDeviceId: string; session: string; message: string },
  deps: CommandSealDeps,
): Promise<PreparedCommand> => {
  try {
    await deps.loadKeys();
  } catch {
    return { kind: 'refused', cause: 'keystore' };
  }
  const self = deps.self();
  if (!self) return { kind: 'refused', cause: 'keystore' };

  let devices: { deviceId: string; publicKey?: string }[];
  try {
    devices = await deps.listDevices();
    if (!Array.isArray(devices)) throw new Error('not a list');
  } catch {
    return { kind: 'refused', cause: 'devices' };
  }
  // The listener admits this machine by the key the list holds for it: an unlisted one would be refused there.
  const listing = await ensureSelfListed(devices, self, deps.register);
  if (!listing.ok) return { kind: 'refused', cause: 'self-unlisted', why: listing.why };
  devices = listing.devices;

  observeDevices(deps.trustPath, devices, { selfId: self.deviceId });
  const target = await peerKeyOf(command.targetDeviceId, {
    // The list was read once above: the target is looked up in it, not fetched again.
    registeredKey: async (id) => devices.find((d) => d.deviceId === id)?.publicKey ?? null,
    trustPath: deps.trustPath,
    self,
  });
  if ('refused' in target) return { kind: 'refused', cause: 'target-unlisted' };

  // The target's slot is the listener's own. Besides it, every other listed device with a key can read the message
  // (a phone's bubble opens).
  const readers = selectRecipients(devices).filter((d) => d.deviceId !== self.deviceId && d.deviceId !== command.targetDeviceId);
  const recipients: DeviceRecipient[] = [{ deviceId: command.targetDeviceId, publicKey: target.key }, ...readers];

  const n = await (deps.nextNumber ?? (() => nextCommandNumber()))();
  if (typeof n !== 'number') return { kind: 'refused', cause: n.refused === 'lock' ? 'number-locked' : 'number-unusable' };

  try {
    const sealed = await (deps.seal ?? encryptPushBodyForDevices)(
      { body: command.message, cmd: { n, session: command.session, device: command.targetDeviceId, from: self.deviceId } },
      recipients,
    );
    // A recipient whose key would not import is skipped by the sealer: the send must not go without the target's slot.
    if (!sealed.deviceKeyMap[command.targetDeviceId]) return { kind: 'refused', cause: 'encrypt' };
    return { kind: 'sealed', fields: { body: sealed.body, senderPublicKey: sealed.senderPublicKey, deviceKeyMap: sealed.deviceKeyMap } };
  } catch {
    return { kind: 'refused', cause: 'encrypt' };
  }
};
