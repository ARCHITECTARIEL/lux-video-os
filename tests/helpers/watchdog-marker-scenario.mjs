import assert from 'node:assert/strict';
import { mock } from 'node:test';

const markers = [];
let requestedLevel;
let selectCount = 0;
const opsEvents = { createdAt: 'createdAt', event: 'event', entityId: 'entityId', code: 'code' };
const tx = {
  execute: async () => {},
  select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => {
    const level = selectCount++ === 0 ? requestedLevel : 'critical';
    return markers.filter(item => item.level === level).slice(-1).map(item => ({ createdAt: item.at }));
  } }) }) }) }),
  insert: () => ({ values: async value => { markers.push({ level: value.code, at: value.createdAt || new Date('2026-10-15T00:00:00Z') }); } }),
};
mock.module('../../db/client.js', { namedExports: { database: () => ({ transaction: callback => {
  selectCount = 0;
  return callback(tx);
} }) } });
mock.module('../../db/schema.js', { namedExports: { opsEvents } });
const { claimWatchdogEscalation } = await import('../../lib/video-os-watchdog-notify.js');
const now = hours => () => new Date(Date.parse('2026-10-15T00:00:00Z') + hours * 60 * 60_000);
const claim = (level, hours) => {
  requestedLevel = level;
  return claimWatchdogEscalation('job-marker', level, { now: now(hours) });
};
assert.equal(await claim('critical', 0), true);
assert.equal(await claim('warn', 0.1), false);
assert.equal(await claim('critical', 24), false);
assert.equal(await claim('warn', 6), true);
assert.deepEqual(markers.map(item => item.level), ['critical', 'warn']);
