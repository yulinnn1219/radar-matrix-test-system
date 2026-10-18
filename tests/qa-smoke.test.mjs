import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsv, importMeasurements, reportCsv } from '../lib/csv.mjs';
import { defaultThresholds, evaluateMetric } from '../lib/metrics.mjs';

const thresholds = defaultThresholds();

test('CSV parser preserves quoted commas, escaped quotes and embedded lines', () => {
  assert.deepEqual(parseCsv('\uFEFFchannelId,serial,gain\r\n1,"TR, ""A""\nB",32\r\n'), [
    ['channelId', 'serial', 'gain'], ['1', 'TR, "A"\nB', '32'],
  ]);
});

test('CSV parser rejects malformed data before importing records', () => {
  for (const csv of ['channelId,gain\n1,"32', 'channelId,gain\n1,"32"x', 'channelId,gain\n1,32,4', 'gain,gain\n1,2']) {
    assert.throws(() => parseCsv(csv));
  }
});

test('imported sweep fails when any frequency point violates snapshot thresholds', () => {
  const data = importMeasurements('channelId,serial,frequency,gain\n1,TR-001,1,31\n1,TR-001,2,37\n1,TR-001,3,32', thresholds);
  assert.equal(data.results[0].pass, false);
  assert.equal(data.results[0].metrics[0].value, 37);
  assert.equal(data.results[0].metrics[0].samples, 3);
  assert.equal(data.results[0].metrics[0].maxObserved, 37);
  assert.equal(data.results[0].simulation, false);
});

test('import validates finite values, channel bounds, consistent identity and known columns', () => {
  const invalid = [
    'channelId,gain\n0,32',
    'channelId,gain\n37,32',
    'channelId,gain\n1.5,32',
    'channelId,gain\n1,NaN',
    'channelId,gain\n1,Infinity',
    'channelId,gain\n1,',
    'channelId,frequency,gain\n1,6.1,32',
    'channelId,serial,gain\n1,A,32\n1,B,32',
    'channelId,unknown\n1,32',
  ];
  for (const csv of invalid) assert.throws(() => importMeasurements(csv, thresholds), csv);
});

test('metric threshold endpoints are inclusive', () => {
  assert.equal(evaluateMetric('gain', thresholds.gain.min, thresholds).pass, true);
  assert.equal(evaluateMetric('gain', thresholds.gain.max, thresholds).pass, true);
  assert.equal(evaluateMetric('gain', thresholds.gain.max + 1, thresholds).pass, false);
  assert.throws(() => evaluateMetric('gain', NaN, thresholds));
});

test('CSV exported text safely escapes punctuation and spreadsheet formulas', () => {
  const results = ['TR,"A"', '=1+1', '+SUM(1,2)', '@SUM(1,2)', '-SUM(1,2)'].map((serial, i) => ({
    channelId: i + 1, serial, metrics: [evaluateMetric('gain', 32, thresholds)], pass: true, completedAt: '2026-10-18T00:00:00Z',
  }));
  const csv = reportCsv({ metricIds: ['gain'], origin: 'imported', results });
  const rows = parseCsv(csv);
  assert.equal(rows[1][1], 'TR,"A"');
  for (const row of rows.slice(2)) assert.equal(row[1][0], "'");
  assert.ok(rows.every(row => row.length === rows[0].length));
});

import { TestSystem } from '../lib/system.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function until(predicate, label, timeout = 7000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

function fixture(options = {}) { return new TestSystem({ seed: false, durationScale: 0.02, ...options }); }
const input = (overrides = {}) => ({ channelIds: [1], metricIds: ['gain'], dwellMs: 200, points: 3, ...overrides });

test('task validation rejects invalid priorities, channels, scans and non-object payloads', async () => {
  const system = fixture({ autoStart: false });
  try {
    for (const value of [null, [], input({ priority: 'constructor' }), input({ priority: 'toString' }), input({ priority: '__proto__' }), input({ priority: {} }), input({ channelIds: [0] }), input({ channelIds: [37] }), input({ channelIds: [1, 1] }), input({ frequencyStart: 5, frequencyEnd: 4 }), input({ frequencyEnd: 6.01 }), input({ points: 1 }), input({ dwellMs: Infinity }), input({ metricIds: ['gain', 'gain'] })]) {
      assert.throws(() => system.createTask(value), error => error.status === 400);
    }
    assert.throws(() => system.configureDevice('rf', null), error => error.status === 400);
    assert.throws(() => system.importCsv(null), error => error.status === 400);
    assert.equal(system.tasks.length, 0);
  } finally { await system.close(); }
});

test('scheduler dispatches high priority first and prevents duplicate physical channel jobs', async () => {
  const system = fixture({ autoStart: false });
  try {
    system.updateSettings({ concurrency: 3 });
    const low = system.createTask(input({ priority: 'low', channelIds: [1, 2] }));
    const high = system.createTask(input({ priority: 'high', channelIds: [1, 3] }));
    system.schedule();
    const jobs = [...system.jobs.values()];
    assert.equal(jobs[0].taskId, high.id);
    assert.equal(jobs[1].taskId, high.id);
    assert.equal(jobs[2].taskId, low.id);
    assert.deepEqual(jobs.map(job => job.channelId), [1, 3, 2]);
    assert.equal(new Set(jobs.map(job => job.channelId)).size, jobs.length);
  } finally { await system.close(); }
});

test('shared instruments serialize conflicting measurements while independent resources run together', async () => {
  const system = fixture({ durationScale: 1 });
  try {
    system.updateSettings({ concurrency: 3 });
    system.createTask(input({ channelIds: [1, 2], metricIds: ['gain'], dwellMs: 1000 }));
    system.createTask(input({ channelIds: [3], metricIds: ['voltage'], dwellMs: 1000 }));
    await until(() => system.locks.has('rf') && system.locks.has('analyzer') && system.locks.has('supply') && system.leaseQueue.some(lease => lease.resources.includes('analyzer')), 'two independent resource sets active');
    const rf = system.locks.get('rf'), analyzer = system.locks.get('analyzer'), supply = system.locks.get('supply');
    assert.ok(rf && analyzer && supply);
    assert.equal(rf.job, analyzer.job);
    assert.notEqual(rf.job, supply.job);
    assert.equal(system.leaseQueue[0].resources.includes('analyzer'), true);
    assert.notEqual(system.leaseQueue[0].job, analyzer.job);
    assert.equal(system.jobs.size, 3);
  } finally { await system.close(); }
});

test('pause preserves checkpoints, releases resources, and resume completes each selected metric once', async () => {
  const system = fixture({ durationScale: 0.2 });
  try {
    const created = system.createTask(input({ channelIds: [1, 2], metricIds: ['gain', 'voltage', 'outputPower'] }));
    const task = system.findTask(created.id);
    await until(() => Object.keys(task.checkpoints).length > 0, 'first metric checkpoint');
    system.actOnTask(task.id, 'pause');
    const snapshot = JSON.stringify({ results: task.results, checkpoints: task.checkpoints });
    assert.equal(task.status, 'paused');
    assert.equal(system.jobs.size, 0);
    assert.equal(system.locks.size, 0);
    assert.equal(system.leaseQueue.length, 0);
    await delay(100);
    assert.equal(JSON.stringify({ results: task.results, checkpoints: task.checkpoints }), snapshot);
    system.actOnTask(task.id, 'resume');
    await until(() => task.status === 'completed', 'resumed batch completion');
    assert.equal(task.results.length, 2);
    assert.equal(task.progress, 100);
    for (const result of task.results) {
      assert.equal(result.metrics.length, 3);
      assert.deepEqual(new Set(result.metrics.map(metric => metric.id)), new Set(task.metricIds));
    }
    assert.equal(system.locks.size, 0);
  } finally { await system.close(); }
});

test('cancellation frees all leases and later work can complete', async () => {
  const system = fixture({ durationScale: 0.2 });
  try {
    const first = system.createTask(input({ channelIds: [1, 2, 3], metricIds: ['gain', 'voltage', 'outputPower'], dwellMs: 1000 }));
    await until(() => system.locks.size > 0, 'resource acquisition');
    system.actOnTask(first.id, 'cancel');
    assert.equal(system.findTask(first.id).status, 'cancelled');
    assert.equal(system.jobs.size, 0);
    assert.equal(system.locks.size, 0);
    assert.equal(system.leaseQueue.length, 0);
    const second = system.createTask(input());
    await until(() => system.findTask(second.id).status === 'completed', 'subsequent task completion');
    assert.equal(system.findTask(second.id).results.length, 1);
  } finally { await system.close(); }
});

test('device disconnect pauses affected tasks and reconnect requires explicit resume', async () => {
  const system = fixture({ durationScale: 1 });
  try {
    const first = system.createTask(input({ dwellMs: 1000 }));
    await until(() => system.locks.has('rf'), 'measurement acquisition');
    system.connectDevice('rf', false);
    assert.equal(system.findTask(first.id).status, 'paused');
    assert.equal(system.jobs.size, 0);
    assert.equal(system.locks.size, 0);
    system.connectDevice('rf', true);
    assert.equal(system.findTask(first.id).status, 'paused');
    system.actOnTask(first.id, 'resume');
    await until(() => system.findTask(first.id).status === 'completed', 'explicitly resumed device task');
  } finally { await system.close(); }
});

test('reducing concurrency preserves pending work and enforces new cap immediately', async () => {
  const system = fixture({ durationScale: 0.2 });
  try {
    const created = system.createTask(input({ channelIds: [1, 2, 3, 4, 5, 6], metricIds: ['gain', 'voltage'] }));
    await until(() => system.jobs.size === 6, 'six workers active');
    system.updateSettings({ concurrency: 2 });
    assert.ok(system.jobs.size <= 2);
    await until(() => system.findTask(created.id).status === 'completed', 'completion after concurrency reduction');
    assert.equal(system.findTask(created.id).results.length, 6);
  } finally { await system.close(); }
});

test('settings, devices, reports and threshold snapshots persist across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-matrix-qa-'));
  const dbPath = join(directory, 'qa.sqlite');
  let system = fixture({ dbPath, autoStart: false });
  try {
    const imported = system.importCsv({ csv: 'channelId,serial,gain\n1,TR-A,32' });
    system.updateSettings({ maxChannels: 12, concurrency: 2, thresholds: { gain: { min: 30, max: 31 } } });
    system.configureDevice('rf', { address: '192.168.0.10', port: 1234 });
    await system.close();
    system = fixture({ dbPath, autoStart: false });
    assert.equal(system.settings.maxChannels, 12);
    assert.equal(system.settings.concurrency, 2);
    assert.equal(system.devices.find(device => device.id === 'rf').port, 1234);
    const task = system.findTask(imported.id);
    assert.equal(task.results[0].pass, true);
    assert.equal(task.thresholds.gain.max, 36);
    assert.equal(task.results[0].metrics[0].max, 36);
    assert.equal(system.settings.thresholds.gain.max, 31);
  } finally { await system.close(); await rm(directory, { recursive: true, force: true }); }
});

test('all 36 channels complete through bounded workers and keep result identities unique', async () => {
  const system = fixture();
  let maxWorkers = 0;
  system.on('change', () => { maxWorkers = Math.max(maxWorkers, system.jobs.size); });
  try {
    const created = system.createTask(input({ channelIds: Array.from({ length: 36 }, (_, i) => i + 1), metricIds: ['gain', 'voltage'] }));
    const task = system.findTask(created.id);
    await until(() => task.status === 'completed', '36 channel batch', 15000);
    assert.equal(task.results.length, 36);
    assert.equal(new Set(task.results.map(result => result.channelId)).size, 36);
    assert.ok(maxWorkers <= system.settings.concurrency);
    assert.equal(system.jobs.size, 0);
    assert.equal(system.locks.size, 0);
  } finally { await system.close(); }
});

test('CSV exports include thresholds and units and can be re-imported without losing measured values', () => {
  const result = { channelId: 1, serial: '\n=1+1', metrics: [evaluateMetric('gain', 32, thresholds)], pass: true, completedAt: '2026-10-18T00:00:00Z' };
  const csv = reportCsv({ metricIds: ['gain'], origin: 'imported', results: [result] });
  const rows = parseCsv(csv);
  assert.ok(rows[0].includes('gain_min'));
  assert.ok(rows[0].includes('gain_max'));
  assert.ok(rows[0].includes('gain_unit'));
  assert.equal(rows[1][1][0], "'");
  const imported = importMeasurements(csv, thresholds);
  assert.equal(imported.results[0].metrics[0].value, 32);
  assert.equal(imported.results[0].pass, true);
});


test('unexpected worker exit releases resources and failed tasks can resume', async () => {
  const system = fixture({ durationScale: 0.2 });
  try {
    const created = system.createTask(input({ metricIds: ['gain', 'voltage'], dwellMs: 1000 }));
    await until(() => system.locks.has('rf'), 'worker resource acquisition');
    const job = [...system.jobs.values()][0];
    await job.worker.terminate();
    const task = system.findTask(created.id);
    await until(() => task.status === 'failed', 'worker failure state');
    assert.equal(system.jobs.size, 0);
    assert.equal(system.locks.size, 0);
    assert.ok(task.error);
    system.actOnTask(task.id, 'resume');
    await until(() => task.status === 'completed', 'recovery from failed worker');
    assert.equal(task.results.length, 1);
    assert.equal(task.results[0].metrics.length, 2);
  } finally { await system.close(); }
});

test('interrupted active tasks recover from persisted checkpoints after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-matrix-recovery-'));
  const dbPath = join(directory, 'qa.sqlite');
  let system = fixture({ dbPath, durationScale: 0.5 });
  try {
    const created = system.createTask(input({ metricIds: ['gain', 'voltage', 'outputPower'], dwellMs: 1000 }));
    await until(() => Object.keys(system.findTask(created.id).checkpoints).length > 0, 'persisted partial acquisition');
    await system.close();
    system = fixture({ dbPath });
    const task = system.findTask(created.id);
    assert.notEqual(task.status, 'running');
    assert.ok(Object.keys(task.checkpoints).length > 0);
    await until(() => task.status === 'completed', 'restart recovery completion');
    assert.equal(task.results.length, 1);
    assert.equal(task.results[0].metrics.length, 3);
  } finally { await system.close(); await rm(directory, { recursive: true, force: true }); }
});

import { createApplication } from '../server.mjs';
import { request as httpRequest } from 'node:http';

async function application() {
  const app = createApplication({ dbPath: ':memory:', seed: false, durationScale: 0.01 });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  app.baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  app.fetch = (path, options = {}) => fetch(app.baseUrl + path, { signal: AbortSignal.timeout(5000), ...options });
  app.post = (path, payload, options = {}) => app.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify(payload), ...options });
  return app;
}

test('HTTP health/static/state endpoints identify simulation and serve valid content', async () => {
  const app = await application();
  try {
    const health = await app.fetch('/api/health');
    assert.equal(health.status, 200);
    const healthData = await health.json();
    assert.equal(healthData.ok, true);
    assert.equal(healthData.mode, 'simulation');
    assert.equal(healthData.storage, 'sqlite');
    assert.equal(healthData.evaluation, 'threshold');
    const html = await app.fetch('/');
    assert.match(html.headers.get('Content-Type'), /^text\/html/);
    assert.match(await html.text(), /<title>.*T\/R/);
    const icon = await app.fetch('/favicon.svg', { method: 'HEAD' });
    assert.equal(icon.status, 200);
    assert.equal(await icon.text(), '');
    const state = await (await app.fetch('/api/state')).json();
    assert.equal(state.channels.length, 36);
    assert.equal(state.mode, 'simulation');
    assert.equal(state.tasks.length, 0);
    assert.ok(state.devices.every(device => device.simulation));
  } finally { await app.close(); }
});

test('HTTP validation rejects malformed bodies, nonexistent IDs, unsafe origins and traversal', async () => {
  const app = await application();
  try {
    for (const body of ['{broken', 'null', '[]', '"text"']) {
      const response = await app.fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, 400);
      assert.ok((await response.json()).error);
    }
    assert.equal((await app.post('/api/tasks', input({ priority: 'constructor' }))).status, 400);
    assert.equal((await app.post('/api/tasks', input(), { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await app.fetch('/api/tasks/missing')).status, 404);
    assert.equal((await app.fetch('/api/not-a-real-route')).status, 404);
    assert.equal((await app.fetch('/%ZZ')).status, 400);
    assert.equal((await app.fetch('/..%5cserver.mjs')).status, 403);
    assert.equal((await app.fetch('/server.mjs')).status, 404);
    assert.equal(app.system.tasks.length, 0);
  } finally { await app.close(); }
});

test('HTTP import, detailed results and downloadable CSV agree on measurement values', async () => {
  const app = await application();
  try {
    const response = await app.post('/api/import', { name: '外部验收数据', csv: 'channelId,serial,gain\n1,TR-A,32\n2,TR-B,40' });
    assert.equal(response.status, 201);
    const task = await response.json();
    assert.equal(task.simulation, false);
    assert.equal(task.passedChannels, 1);
    assert.equal(task.failedChannels, 1);
    const detailed = await (await app.fetch(`/api/results/${task.id}`)).json();
    assert.equal(detailed.results[1].metrics[0].value, 40);
    const report = await app.fetch(`/api/tasks/${task.id}/report.csv`);
    assert.equal(report.status, 200);
    assert.match(report.headers.get('Content-Type'), /^text\/csv/);
    assert.match(report.headers.get('Content-Disposition'), /attachment/);
    const csv = await report.text();
    const imported = importMeasurements(csv, thresholds);
    assert.deepEqual(imported.results.map(result => result.metrics[0].value), [32, 40]);
    assert.deepEqual(imported.results.map(result => result.pass), [true, false]);
  } finally { await app.close(); }
});

test('HTTP task actions and settings persist through server state', async () => {
  const app = await application();
  try {
    const settings = await app.post('/api/settings', { maxChannels: 12, concurrency: 2 });
    assert.equal(settings.status, 200);
    const created = await app.post('/api/tasks', input({ channelIds: [1, 12] }));
    assert.equal(created.status, 201);
    const task = await created.json();
    const paused = await app.post(`/api/tasks/${task.id}/action`, { action: 'pause' });
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).status, 'paused');
    const cancelled = await app.post(`/api/tasks/${task.id}/action`, { action: 'cancel' });
    assert.equal((await cancelled.json()).status, 'cancelled');
    const state = await (await app.fetch('/api/state')).json();
    assert.equal(state.settings.maxChannels, 12);
    assert.equal(state.settings.concurrency, 2);
    assert.equal(state.tasks[0].status, 'cancelled');
  } finally { await app.close(); }
});

test('SSE sends initial state and subsequent task changes', async () => {
  const app = await application();
  let reader;
  try {
    const response = await app.fetch('/api/events');
    assert.match(response.headers.get('Content-Type'), /^text\/event-stream/);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    assert.match(first, /retry: 1500/);
    assert.match(first, /"tasks":\[\]/);
    const created = await app.post('/api/import', { name: 'SSE验收', csv: 'channelId,gain\n1,32' });
    assert.equal(created.status, 201);
    const next = await Promise.race([reader.read(), delay(2500).then(() => { throw new Error('SSE change event timeout'); })]);
    const packet = decoder.decode(next.value);
    assert.match(packet, /SSE验收/);
    assert.match(packet, /"origin":"imported"/);
  } finally { if (reader) await reader.cancel(); await app.close(); }
});

test('HTTP JSON preserves Chinese characters across TCP chunk boundaries', async () => {
  const app = await application();
  try {
    const payload = Buffer.from(JSON.stringify(input({ name: '中文分块任务' })));
    const firstChineseByte = payload.indexOf(Buffer.from('中'));
    const port = app.server.address().port;
    const result = await new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/tasks', headers: { 'Content-Type': 'application/json' } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      request.on('error', reject);
      request.write(payload.subarray(0, firstChineseByte + 1));
      setTimeout(() => request.end(payload.subarray(firstChineseByte + 1)), 20);
    });
    assert.equal(result.status, 201);
    assert.equal(result.json.name, '中文分块任务');
  } finally { await app.close(); }
});
