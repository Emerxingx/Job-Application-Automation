/** What the sign-in tells the server about this device: a name to recognise it by in the device list, and the platform. Nothing that identifies the person. */
import type { DeviceSignIn } from '@/api/client';

export type DeviceDescriptor = Extract<DeviceSignIn, { method: 'password' }>['device'];

export function describeDevice(platform: string, deviceName: string | null | undefined): DeviceDescriptor {
  const p = platform === 'ios' || platform === 'android' || platform === 'web' ? platform : 'other';
  const fallback = p === 'ios' ? 'iPhone' : p === 'android' ? 'Android phone' : p === 'web' ? 'Browser' : 'Device';
  const name = (deviceName ?? '').trim().slice(0, 80) || fallback;
  return { name, platform: p };
}
