import { buildExpoMessages, handleNotifyWebhook, isNotificationEventInsert, type NotifyDeps } from './handler.ts';
import type { NotificationEventRecord, NotifyWebhookPayload } from './types.ts';

function record(overrides: Partial<NotificationEventRecord> = {}): NotificationEventRecord {
  return {
    id: 'event-1',
    event_type: 'bill_member_invited',
    bill_id: 'bill-1',
    recipient_user_id: 'user-1',
    payload: {},
    created_at: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

function webhookPayload(overrides: Partial<NotifyWebhookPayload> = {}): NotifyWebhookPayload {
  return {
    type: 'INSERT',
    table: 'notification_events',
    schema: 'public',
    record: record(),
    old_record: null,
    ...overrides,
  };
}

describe('isNotificationEventInsert', () => {
  it('accepts an insert on notification_events', () => {
    expect(isNotificationEventInsert(webhookPayload())).toBe(true);
  });

  it('rejects any other table or type', () => {
    expect(isNotificationEventInsert(webhookPayload({ table: 'bill_people' }))).toBe(false);
    expect(isNotificationEventInsert(webhookPayload({ type: 'UPDATE' }))).toBe(false);
  });
});

describe('buildExpoMessages', () => {
  it('fans out one message per token for a known event type', () => {
    const messages = buildExpoMessages(record(), ['token-a', 'token-b']);
    expect(messages).toEqual([
      { to: 'token-a', title: 'New bill', body: "You've been added to a bill.", data: { billId: 'bill-1' } },
      { to: 'token-b', title: 'New bill', body: "You've been added to a bill.", data: { billId: 'bill-1' } },
    ]);
  });

  it('never puts bill or receipt contents in the message (SPEC 8.8 privacy stance)', () => {
    const messages = buildExpoMessages(record({ payload: { secretItemName: 'should never appear' } }), ['token-a']);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain('secretItemName');
    expect(serialized).not.toContain('should never appear');
  });

  it('returns nothing when there are no tokens', () => {
    expect(buildExpoMessages(record(), [])).toEqual([]);
  });

  it('returns nothing for an event type with no registered builder (a future trigger)', () => {
    expect(buildExpoMessages(record({ event_type: 'claim_conflict' }), ['token-a'])).toEqual([]);
  });
});

describe('handleNotifyWebhook', () => {
  function makeDeps(overrides: Partial<NotifyDeps> = {}): NotifyDeps {
    return {
      fetchPushTokens: jest.fn().mockResolvedValue([]),
      sendExpoPush: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('sends one Expo push per token for a genuine notification_events insert', async () => {
    const deps = makeDeps({ fetchPushTokens: jest.fn().mockResolvedValue(['token-a', 'token-b']) });
    await handleNotifyWebhook(webhookPayload(), deps);
    expect(deps.fetchPushTokens).toHaveBeenCalledWith('user-1');
    expect(deps.sendExpoPush).toHaveBeenCalledWith([
      { to: 'token-a', title: 'New bill', body: "You've been added to a bill.", data: { billId: 'bill-1' } },
      { to: 'token-b', title: 'New bill', body: "You've been added to a bill.", data: { billId: 'bill-1' } },
    ]);
  });

  it('does nothing when the recipient has no push tokens', async () => {
    const deps = makeDeps();
    await handleNotifyWebhook(webhookPayload(), deps);
    expect(deps.sendExpoPush).not.toHaveBeenCalled();
  });

  it('ignores anything that is not a notification_events insert', async () => {
    const deps = makeDeps({ fetchPushTokens: jest.fn().mockResolvedValue(['token-a']) });
    await handleNotifyWebhook(webhookPayload({ table: 'bill_people' }), deps);
    expect(deps.fetchPushTokens).not.toHaveBeenCalled();
    expect(deps.sendExpoPush).not.toHaveBeenCalled();
  });

  it('logs and does not throw when the Expo send fails (a stale or invalid token)', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = makeDeps({
      fetchPushTokens: jest.fn().mockResolvedValue(['stale-token']),
      sendExpoPush: jest.fn().mockRejectedValue(new Error('Expo push API 400: DeviceNotRegistered')),
    });

    await expect(handleNotifyWebhook(webhookPayload(), deps)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
