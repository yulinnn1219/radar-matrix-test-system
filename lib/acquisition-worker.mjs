import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { metricById, simulatedValue, evaluateMetric, createTrace, evaluateTraceMetrics } from './metrics.mjs';

// Every worker acquires a complete resource set atomically. The parent grants
// exclusive leases, so workers can never deadlock while holding partial sets.
const leases = new Map();
let requestNumber = 0;
parentPort.on('message', message => {
  if (message.type === 'grant') {
    const resolve = leases.get(message.requestId);
    if (resolve) { leases.delete(message.requestId); resolve(); }
  }
});

async function run() {
  const { task, channelId, checkpoint, durationScale = 1 } = workerData;
  const metrics = [...(checkpoint?.metrics ?? [])];
  for (const id of task.metricIds) {
    if (metrics.some(metric => metric.id === id)) continue;
    const switchRequest = ++requestNumber;
    const switched = new Promise(resolve => leases.set(switchRequest, resolve));
    parentPort.postMessage({ type: 'lease', resources: ['matrix'], requestId: switchRequest, metricId: id });
    await switched;
    await delay(Math.max(2, 20 * durationScale));
    parentPort.postMessage({ type: 'release', requestId: switchRequest });
    const resources = metricById.get(id).resources;
    const requestId = ++requestNumber;
    const granted = new Promise(resolve => leases.set(requestId, resolve));
    parentPort.postMessage({ type: 'lease', resources, requestId, metricId: id });
    await granted;
    await delay(Math.max(2, task.dwellMs * durationScale));
    const metric = evaluateMetric(id, simulatedValue(task, channelId, id), task.thresholds);
    metrics.push(metric);
    parentPort.postMessage({ type: 'release', requestId });
    parentPort.postMessage({ type: 'checkpoint', checkpoint: { metrics, progress: Math.round(metrics.length / task.metricIds.length * 100) }, metricId: id });
  }
  const trace = createTrace(task, channelId, metrics);
  const evaluated = evaluateTraceMetrics(metrics, trace, task.thresholds);
  parentPort.postMessage({ type: 'result', result: {
    channelId,
    serial: `${task.serialPrefix}-${String(channelId).padStart(2, '0')}`,
    metrics: evaluated,
    pass: evaluated.every(metric => metric.pass),
    trace,
    completedAt: new Date().toISOString(),
    simulation: true,
    evaluation: 'threshold',
  } });
  parentPort.close();
}
run().catch(error => { parentPort.postMessage({ type: 'error', message: error.message }); parentPort.close(); });
