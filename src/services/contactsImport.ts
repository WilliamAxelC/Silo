import * as Contacts from 'expo-contacts';

export interface DeviceContactCandidate {
  deviceContactId: string;
  name: string;
  phone: string;
  allPhones: string[];
}

export type LoadDeviceContactsResult =
  | { status: 'granted'; contacts: DeviceContactCandidate[] }
  | { status: 'denied'; contacts: [] };

/**
 * Requests OS Contacts permission on demand and returns contacts that have a non-empty display name.
 * Imported data never leaves the device unless the user explicitly shares a bill message.
 */
export async function requestAndLoadDeviceContacts(): Promise<LoadDeviceContactsResult> {
  const permission = await Contacts.requestPermissionsAsync();
  if (permission.status !== 'granted' && !permission.granted) {
    return { status: 'denied', contacts: [] };
  }

  const response = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
  });

  const candidates: DeviceContactCandidate[] = [];
  for (const contact of response.data ?? []) {
    const name = (contact.name ?? '').trim();
    if (!name) continue;

    const seenPhones = new Set<string>();
    const allPhones: string[] = [];
    for (const phoneEntry of contact.phoneNumbers ?? []) {
      const raw = (phoneEntry.number ?? '').trim();
      if (!raw) continue;
      const key = raw.replace(/\s+/g, '');
      if (!seenPhones.has(key)) {
        seenPhones.add(key);
        allPhones.push(raw);
      }
    }

    const primaryPhone = allPhones[0] ?? '';
    const rawId = typeof (contact as { id?: string }).id === 'string' ? (contact as { id?: string }).id : undefined;
    const deviceContactId = rawId && rawId.trim() ? rawId.trim() : `${name.toLowerCase()}|${primaryPhone}`;

    candidates.push({
      deviceContactId,
      name,
      phone: primaryPhone,
      allPhones,
    });
  }

  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return { status: 'granted', contacts: candidates };
}
