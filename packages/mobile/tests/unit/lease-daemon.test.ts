/** Against the installed agent-device: the daemon stop a lease's release relies on, and the report it checks. */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentDeviceClient, isAgentDeviceError } from 'agent-device';
import { afterAll, expect, it, vi } from 'vitest';
import { assertSessionsEnded, releaseLease, stopDriver } from '../../src/lease/daemon.ts';

vi.mock('agent-device', async (original) => {
  const actual = await original<typeof import('agent-device')>();
  return { ...actual, createAgentDeviceClient: vi.fn(actual.createAgentDeviceClient) };
});

const dir = mkdtempSync(path.join(tmpdir(), 'lease-daemon-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('stops a daemon that is not running without error before a lease was granted', async () => {
  await expect(stopDriver(path.join(dir, 'state'), { PATH: process.env['PATH'], HOME: dir }, undefined, 'BrowserStack', AbortSignal.timeout(30_000))).resolves.toBeUndefined();
});

it('refuses to confirm a granted lease ended when no daemon is running to release it', async () => {
  await expect(stopDriver(path.join(dir, 'state'), { PATH: process.env['PATH'], HOME: dir }, 'lease-1', 'BrowserStack', AbortSignal.timeout(30_000))).rejects.toThrow(
    'agent-device found no daemon running for lease lease-1, so nothing confirms its BrowserStack session ended',
  );
});

const report = (data: unknown) => JSON.stringify({ success: true, data });
const graceful = (released: unknown[], pending: unknown[] = []) => report({ stopped: true, mode: 'graceful', providerReleases: { status: 'completed', released, pending }, warnings: [] });
const notRunning = report({ stopped: false, mode: 'not-running', providerReleases: { status: 'completed', released: [], pending: [] }, warnings: [] });

it('accepts a graceful stop that released the lease, and any graceful stop before a grant', () => {
  expect(() => assertSessionsEnded(graceful([{ leaseId: 'l1', provider: 'browserstack' }]), 'l1', 'BrowserStack')).not.toThrow();
  expect(() => assertSessionsEnded(graceful([]), undefined, 'BrowserStack')).not.toThrow();
});

it('accepts no running daemon only before a lease was granted', () => {
  expect(() => assertSessionsEnded(notRunning, undefined, 'BrowserStack')).not.toThrow();
  expect(() => assertSessionsEnded(notRunning, 'l1', 'BrowserStack')).toThrow('agent-device found no daemon running for lease l1, so nothing confirms its BrowserStack session ended');
});

it('refuses a graceful stop that did not release the granted lease, as from a daemon started after the granting one died', () => {
  expect(() => assertSessionsEnded(graceful([{ leaseId: 'l2', provider: 'browserstack' }]), 'l1', 'BrowserStack')).toThrow(
    'agent-device stopped without listing lease l1 as released, so nothing confirms its BrowserStack session ended',
  );
});

it('refuses a report with sessions still pending', () => {
  expect(() => assertSessionsEnded(graceful([], [{ leaseId: 'l1' }, { leaseId: 'l2' }]), undefined, 'BrowserStack')).toThrow('agent-device stopped without ending 2 BrowserStack session(s)');
});

it('refuses a forced stop whose cleanup is unknown, with the daemon\'s warning', () => {
  const forced = report({ stopped: true, mode: 'forced', providerReleases: { status: 'unknown', released: [], pending: null }, warnings: ['The daemon was force-killed before provider lease state could be finalized. Provider allocations may remain active.'] });
  expect(() => assertSessionsEnded(forced, 'l1', 'BrowserStack')).toThrow('agent-device could not confirm its BrowserStack sessions ended: The daemon was force-killed before provider lease state could be finalized. Provider allocations may remain active.');
});

it('refuses a report without provider releases, and one that is not JSON', () => {
  expect(() => assertSessionsEnded(report({ stopped: true }), undefined, 'BrowserStack')).toThrow('agent-device could not confirm its BrowserStack sessions ended');
  expect(() => assertSessionsEnded('killed', undefined, 'BrowserStack')).toThrow('agent-device stopped without a readable shutdown report; BrowserStack sessions may still be running');
});

it('accepts an unconfirmed or missing-lease stop report when leases.release already ended the session, while still rejecting pending or unreadable reports', () => {
  const unknown = report({ stopped: true, mode: 'graceful', providerReleases: { status: 'unknown', released: [], pending: null }, warnings: ['The graceful shutdown report is unavailable.'] });
  expect(() => assertSessionsEnded(graceful([]), 'l1', 'BrowserStack', { sessionEnded: true })).not.toThrow();
  expect(() => assertSessionsEnded(notRunning, 'l1', 'BrowserStack', { sessionEnded: true })).not.toThrow();
  expect(() => assertSessionsEnded(unknown, 'l1', 'BrowserStack', { sessionEnded: true })).not.toThrow();
  expect(() => assertSessionsEnded(graceful([], [{ leaseId: 'l1' }]), 'l1', 'BrowserStack', { sessionEnded: true })).toThrow('agent-device stopped without ending 1 BrowserStack session(s)');
  expect(() => assertSessionsEnded(report({ stopped: true }), 'l1', 'BrowserStack', { sessionEnded: true })).toThrow('agent-device could not confirm its BrowserStack sessions ended');
  expect(() => assertSessionsEnded('killed', 'l1', 'BrowserStack', { sessionEnded: true })).toThrow('agent-device stopped without a readable shutdown report; BrowserStack sessions may still be running');
});

it('attaches to release a lease without spawning a daemon when none is running', async () => {
  const emptyState = path.join(dir, 'empty-state');
  let caught: unknown;
  try {
    await releaseLease(emptyState, { leaseId: 'lease-1', tenant: 'browserstack', runId: 'run-1', leaseBackend: 'ios-instance', leaseProvider: 'browserstack' }, AbortSignal.timeout(10_000));
  } catch (error) {
    caught = error;
  }
  expect(isAgentDeviceError(caught) && caught.details?.reason).toBe('daemon-not-running');
  expect(existsSync(path.join(emptyState, 'daemon.json'))).toBe(false);
});

it('rejects when leases.release reports provider cleanup warnings even if released is true', async () => {
  const mockedClient = vi.mocked(createAgentDeviceClient);
  const realClient = createAgentDeviceClient({ stateDir: path.join(dir, 'warn-state'), daemonLifecycle: 'attach' });
  mockedClient.mockReturnValueOnce({
    ...realClient,
    leases: {
      ...realClient.leases,
      release: async () => ({
        released: true,
        provider: {
          provider: 'browserstack',
          providerSessionId: 'wd-1',
          warnings: [{ code: 'WEBDRIVER_SESSION_DELETE_FAILED', message: 'HTTP 500 on DELETE /session/wd-1' }],
        },
      }),
    },
  });
  await expect(
    releaseLease(path.join(dir, 'warn-state'), { leaseId: 'lease-1', tenant: 'browserstack', runId: 'run-1', leaseBackend: 'ios-instance', leaseProvider: 'browserstack' }, AbortSignal.timeout(10_000)),
  ).rejects.toThrow('WEBDRIVER_SESSION_DELETE_FAILED: HTTP 500 on DELETE /session/wd-1');
});
