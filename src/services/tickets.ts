import { Platform } from 'react-native';

import { expoDb } from '../db/index';
import { getInstalledVersion } from './updates';

/** Relay on the download site; it posts reports to the developer's Discord. No secrets in the app. */
export const TICKETS_URL = 'https://cuang.dev/projects/silo/api/tickets';
const SENT_KEY = 'sentTickets';
/** Which consent text the user saw above Send (UU PDP Art. 22: consent must be recorded). */
export const REPORT_CONSENT_VERSION = 'report-form-2026-11-23';
const MAX_SENT = 30;

export type TicketKind = 'bug' | 'feature';

export interface TicketInput {
  kind: TicketKind;
  title: string;
  description: string;
  /** Plain text from the on-phone error log, only when the user ticked the box. */
  errorLog?: string;
  /** Base64 JPEG/PNG, only when the user picked a screenshot. */
  screenshotBase64?: string;
}

export interface SentTicket {
  ticket: number;
  kind: TicketKind;
  title: string;
  sentAt: number;
}

/** "samsung SM-S911B", "Xiaomi 13" (not "Xiaomi Xiaomi 13"), and the Android release. */
export function deviceSummary(constants: any = (Platform as any).constants ?? {}): { device: string; osVersion: string } {
  const brand = String(constants.Brand ?? constants.Manufacturer ?? '').trim();
  const model = String(constants.Model ?? '').trim();
  const device = brand && !model.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${model}`.trim() : model || brand;
  return { device: device.slice(0, 80) || Platform.OS, osVersion: String(constants.Release ?? Platform.Version ?? '').slice(0, 20) };
}

export function validateTicket(input: TicketInput): string | null {
  if (input.title.trim().length < 3) return 'Add a short title (3 characters or more).';
  if (input.description.trim().length < 10) return 'Describe it in a bit more detail (10 characters or more).';
  return null;
}

/** Exactly what leaves the phone. */
export function buildTicketPayload(input: TicketInput): Record<string, unknown> {
  const installed = getInstalledVersion();
  const { device, osVersion } = deviceSummary();
  const payload: Record<string, unknown> = {
    kind: input.kind,
    title: input.title.trim().slice(0, 120),
    description: input.description.trim().slice(0, 4000),
    appVersion: installed.version,
    versionCode: installed.versionCode,
    device,
    osVersion,
    consent: REPORT_CONSENT_VERSION,
  };
  if (input.errorLog?.trim()) payload.errorLog = input.errorLog.trim().slice(-20000);
  if (input.screenshotBase64) payload.screenshot = input.screenshotBase64;
  return payload;
}

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export async function submitTicket(input: TicketInput, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<SentTicket> {
  const problem = validateTicket(input);
  if (problem) throw new Error(problem);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(TICKETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTicketPayload(input)),
    });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again; your text is kept.");
  }
  let body: any = {};
  try {
    body = await response.json();
  } catch {
    // keep the generic message below
  }
  if (response.status === 429) throw new Error(body?.error || 'Too many reports right now. Please try again later.');
  if (!response.ok || !body?.ok) {
    throw new Error(typeof body?.detail === 'string' ? body.detail : `The server could not take the report (${response.status}).`);
  }
  const sent: SentTicket = { ticket: Number(body.ticket) || 0, kind: input.kind, title: input.title.trim().slice(0, 120), sentAt: Date.now() };
  rememberSentTicket(sent);
  return sent;
}

export function getSentTickets(): SentTicket[] {
  try {
    const row = expoDb.getFirstSync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [SENT_KEY]);
    const parsed = row?.value ? JSON.parse(row.value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rememberSentTicket(sent: SentTicket) {
  try {
    const next = [sent, ...getSentTickets()].slice(0, MAX_SENT);
    expoDb.runSync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?);', [SENT_KEY, JSON.stringify(next)]);
  } catch {
    // the ticket was sent; losing the local list is harmless
  }
}
