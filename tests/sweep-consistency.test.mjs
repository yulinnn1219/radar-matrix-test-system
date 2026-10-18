import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { defaultThresholds, evaluateMetric, simulatedResult, simulatedValue, evaluateTraceMetrics } from '../lib/metrics.mjs';

function sweepTask(metricIds = ['gain', 'outputPower', 'phaseError']) {
  const task = { seed: 'sweep-consistency-regression', metricIds, frequencyStart: 0.5, frequencyEnd: 6, points: 51, serialPrefix: 'REG', dwellMs: 200, thresholds: defaultThresholds() };
  for (const id of metricIds) {
    const center = simulatedValue(task, 1, id);
    task.thresholds[id] = { min: center - 0.05, max: center + 0.05 };
  }
  return task;
}

test('simulated sweep fails when a passing center has any out-of-range trace sample', () => {
  const task = sweepTask();
  const result = simulatedResult(task, 1);
  assert.equal(result.pass, false);
  for (const id of task.metricIds) {
    assert.equal(evaluateMetric(id, simulatedValue(task, 1, id), task.thresholds).pass, true);
    const observed = result.trace.map(point => point[id]);
    const metric = result.metrics.find(item => item.id === id);
    assert.equal(metric.pass, false);
    assert.equal(metric.minObserved, Math.min(...observed));
    assert.equal(metric.maxObserved, Math.max(...observed));
    assert.equal(metric.samples, task.points);
    assert.ok(metric.value < metric.min || metric.value > metric.max);
    const distance = value => Math.max(metric.min - value, value - metric.max);
    assert.equal(distance(metric.value), Math.max(...observed.map(distance)));
  }
});

test('passing sweeps report the observed mean and scalar-only metrics retain one sample', () => {
  const thresholds = defaultThresholds();
  const metrics = evaluateTraceMetrics([{ id: 'gain', value: 35 }, { id: 'voltage', value: 12 }], [{ frequency: 1, gain: 30 }, { frequency: 2, gain: 34 }], thresholds);
  assert.deepEqual(metrics.map(({ id, value, pass, minObserved, maxObserved, samples }) => ({ id, value, pass, minObserved, maxObserved, samples })), [
    { id: 'gain', value: 32, pass: true, minObserved: 30, maxObserved: 34, samples: 2 },
    { id: 'voltage', value: 12, pass: true, minObserved: 12, maxObserved: 12, samples: 1 },
  ]);
});

test('simulated traces contain only selected sweep measurements', () => {
  const task = sweepTask(['gain']);
  const result = simulatedResult(task, 1);
  for (const point of result.trace) assert.deepEqual(Object.keys(point).sort(), ['frequency', 'gain']);
  const scalarTask = sweepTask(['voltage']);
  for (const point of simulatedResult(scalarTask, 1).trace) assert.deepEqual(Object.keys(point), ['frequency']);
});

test('acquisition workers use the same complete-sweep verdict as seeded reports', async () => {
  const task = sweepTask();
  const worker = new Worker(new URL('../lib/acquisition-worker.mjs', import.meta.url), { workerData: { task, channelId: 1, durationScale: 0.01 } });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.on('message', message => {
        if (message.type === 'lease') worker.postMessage({ type: 'grant', requestId: message.requestId });
        if (message.type === 'result') resolve(message.result);
        if (message.type === 'error') reject(new Error(message.message));
      });
      worker.on('error', reject);
      worker.on('exit', code => { if (code !== 0) reject(new Error(`Unexpected worker exit: ${code}`)); });
    });
    const expected = simulatedResult(task, 1);
    assert.deepEqual(result.metrics, expected.metrics);
    assert.deepEqual(result.trace, expected.trace);
    assert.equal(result.pass, expected.pass);
    assert.equal(result.pass, false);
  } finally { await worker.terminate(); }
});
