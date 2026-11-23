const mockSettings = new Map<string, string>();
jest.mock('../../db/index', () => ({
  expoDb: {
    getFirstSync: (_sql: string, params: string[]) => (mockSettings.has(params[0]) ? { value: mockSettings.get(params[0]) } : null),
    runSync: (_sql: string, params: string[]) => {
      mockSettings.set(params[0], params[1]);
    },
  },
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.3.2', android: { versionCode: 9 } } },
}));

import {
  __resetErrorLogForTests,
  clearErrorLog,
  formatErrorLog,
  getErrorLog,
  installGlobalErrorLogging,
  recordError,
  redactErrorText,
} from '../errorLog';
import { buildTicketPayload, deviceSummary, getSentTickets, submitTicket, validateTicket } from '../tickets';
import { goalProgress, monthsUntil, validateGoal, type Goal } from '../../features/goals/goals';

describe('error log', () => {
  beforeEach(() => {
    mockSettings.clear();
    __resetErrorLogForTests();
  });

  it('masks figures so the log never carries amounts or numbers', () => {
    expect(redactErrorText('Failed to save Rp 1.250.000 for card 4111111111111111')).toBe('Failed to save Rp # for card #');
    expect(redactErrorText('row 42 missing')).toBe('row 42 missing');
  });

  it('keeps the newest 50 entries and survives a reload', () => {
    for (let i = 0; i < 55; i += 1) recordError(new Error(`boom ${i}`), 'error', i);
    __resetErrorLogForTests();
    const log = getErrorLog();
    expect(log).toHaveLength(50);
    expect(log[0].message).toContain('boom 5');
    expect(formatErrorLog(log, 2).split('\n').filter((l) => l.includes('[error]'))).toHaveLength(2);
    clearErrorLog();
    expect(getErrorLog()).toEqual([]);
  });

  it('records uncaught errors and still hands them to the previous handler', () => {
    const previous = jest.fn();
    let handler: any;
    (globalThis as any).ErrorUtils = { getGlobalHandler: () => previous, setGlobalHandler: (h: any) => (handler = h) };
    installGlobalErrorLogging();
    const err = new Error('render failed');
    handler(err, true);
    expect(previous).toHaveBeenCalledWith(err, true);
    expect(getErrorLog()[0]).toMatchObject({ kind: 'crash' });
    delete (globalThis as any).ErrorUtils;
  });
});

describe('tickets: exactly what leaves the phone', () => {
  beforeEach(() => mockSettings.clear());
  const base = { kind: 'bug' as const, title: 'Amount tap', description: 'Nothing happens when I tap Amount' };

  it('sends text, app version and device only, unless the user adds the log or a screenshot', () => {
    const payload = buildTicketPayload(base);
    expect(Object.keys(payload).sort()).toEqual(['appVersion', 'description', 'device', 'kind', 'osVersion', 'title', 'versionCode']);
    expect(payload).toMatchObject({ appVersion: '1.3.2', versionCode: 9 });
    const full = buildTicketPayload({ ...base, errorLog: 'x', screenshotBase64: 'AAAA' });
    expect(full).toMatchObject({ errorLog: 'x', screenshot: 'AAAA' });
  });

  // Seen on the 1.3.2 emulator: "Android Android SDK built for x86_64".
  it('regression: does not repeat the brand when the model name already starts with it', () => {
    expect(deviceSummary({ Brand: 'Android', Model: 'Android SDK built for x86_64', Release: '11' })).toEqual({
      device: 'Android SDK built for x86_64',
      osVersion: '11',
    });
    expect(deviceSummary({ Brand: 'Xiaomi', Model: 'Xiaomi 13', Release: '14' }).device).toBe('Xiaomi 13');
    expect(deviceSummary({ Brand: 'samsung', Model: 'SM-S911B', Release: '14' }).device).toBe('samsung SM-S911B');
  });

  it('validates before sending', () => {
    expect(validateTicket({ ...base, title: 'a' })).toMatch(/title/);
    expect(validateTicket({ ...base, description: 'short' })).toMatch(/detail/);
    expect(validateTicket(base)).toBeNull();
  });

  it('remembers sent tickets and explains failures', async () => {
    const ok = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ticket: 12 }) }));
    const sent = await submitTicket(base, ok as any);
    expect(sent.ticket).toBe(12);
    expect(getSentTickets()[0]).toMatchObject({ ticket: 12, title: 'Amount tap' });
    const body = JSON.parse((ok.mock.calls[0] as any)[1].body);
    expect(body.title).toBe('Amount tap');

    const limited = jest.fn(async () => ({ ok: false, status: 429, json: async () => ({ ok: false, error: 'Too many reports right now.' }) }));
    await expect(submitTicket(base, limited as any)).rejects.toThrow('Too many reports');
    const offline = jest.fn(async () => {
      throw new Error('net');
    });
    await expect(submitTicket(base, offline as any)).rejects.toThrow(/Couldn't reach the server/);
  });
});

describe('savings goals', () => {
  const now = new Date(2026, 10, 23).getTime();
  const goal = (over: Partial<Goal>): Goal => ({
    id: 1,
    name: 'Japan',
    targetAmount: 12_000_000,
    targetDate: null,
    source: 'manual',
    walletId: null,
    savedAmount: 3_000_000,
    archived: false,
    createdAt: 1,
    ...over,
  });
  const wallets: any[] = [
    { id: 1, name: 'Savings', balance: 6_000_000, currency: null, averageRate: null },
    { id: 2, name: 'Yen', balance: 100_000, currency: 'JPY', averageRate: 105 },
  ];

  it('counts whole months to the target date, never fewer than one', () => {
    expect(monthsUntil(new Date(2027, 4, 1).getTime(), now)).toBe(7);
    expect(monthsUntil(new Date(2026, 10, 30).getTime(), now)).toBe(1);
  });

  it('works out progress and the monthly amount needed', () => {
    const p = goalProgress(goal({ targetDate: new Date(2027, 4, 1).getTime() }), wallets, 'IDR', now);
    expect(p).toMatchObject({ current: 3_000_000, remaining: 9_000_000, done: false, monthsLeft: 7, overdue: false });
    expect(p.perMonth).toBe(Math.ceil(9_000_000 / 7));
    expect(p.fraction).toBeCloseTo(0.25);
  });

  it('follows an account balance, converting foreign accounts at their average cost', () => {
    expect(goalProgress(goal({ source: 'account', walletId: 1 }), wallets, 'IDR', now).current).toBe(6_000_000);
    expect(goalProgress(goal({ source: 'account', walletId: 2 }), wallets, 'IDR', now).current).toBe(10_500_000);
    expect(goalProgress(goal({ source: 'account', walletId: 99 }), wallets, 'IDR', now).current).toBe(0);
  });

  it('marks reached and overdue goals', () => {
    expect(goalProgress(goal({ savedAmount: 12_000_000 }), wallets, 'IDR', now)).toMatchObject({ done: true, fraction: 1 });
    const late = goalProgress(goal({ targetDate: new Date(2026, 0, 1).getTime() }), wallets, 'IDR', now);
    expect(late).toMatchObject({ overdue: true, perMonth: null });
  });

  it('validates the editor input', () => {
    expect(validateGoal({ name: '', targetAmount: 5 })).toMatch(/name/);
    expect(validateGoal({ name: 'x', targetAmount: 0 })).toMatch(/target/);
    expect(validateGoal({ name: 'x', targetAmount: 5, source: 'account', walletId: null })).toMatch(/account/);
    expect(validateGoal({ name: 'x', targetAmount: 5, source: 'manual' })).toBeNull();
  });
});
