// These are demonstration limits, not a product specification or calibrated standard.
export const METRICS = Object.freeze([
  { id: 'frequencyRange', name: '工作带宽', unit: 'GHz', min: 0.1, max: 6, nominal: 5.5, spread: 0, category: '通用指标', resources: ['analyzer'] },
  { id: 'vswr', name: '驻波比', unit: '', min: 1, max: 1.8, nominal: 1.38, spread: 0.32, category: '通用指标', resources: ['analyzer'] },
  { id: 'efficiency', name: '功率附加效率', unit: '%', min: 35, max: 65, nominal: 49, spread: 13, category: '通用指标', resources: ['power', 'supply'] },
  { id: 'outputPower', name: '发射输出功率', unit: 'dBm', min: 28, max: 34, nominal: 31, spread: 2.5, category: '发射指标', resources: ['rf', 'power'] },
  { id: 'inputPower', name: '发射输入功率', unit: 'dBm', min: -2, max: 2, nominal: 0, spread: 1.5, category: '发射指标', resources: ['rf', 'power'] },
  { id: 'txRipple', name: '发射带内波动', unit: 'dB', min: 0, max: 1.5, nominal: 0.65, spread: 0.6, category: '发射指标', resources: ['rf', 'analyzer'] },
  { id: 'spuriousSuppression', name: '杂散抑制', unit: 'dBc', min: 45, max: 80, nominal: 58, spread: 12, category: '发射指标', resources: ['rf', 'analyzer'] },
  { id: 'isolation', name: '收发隔离度', unit: 'dB', min: 45, max: 90, nominal: 62, spread: 15, category: '发射指标', resources: ['rf', 'analyzer'] },
  { id: 'pulseDroop', name: '脉冲顶降', unit: '%', min: 0, max: 5, nominal: 2.1, spread: 2, category: '发射指标', resources: ['analyzer'] },
  { id: 'riseTime', name: '脉冲上升时间', unit: 'ns', min: 0, max: 80, nominal: 38, spread: 28, category: '发射指标', resources: ['analyzer'] },
  { id: 'fallTime', name: '脉冲下降时间', unit: 'ns', min: 0, max: 80, nominal: 42, spread: 28, category: '发射指标', resources: ['analyzer'] },
  { id: 'gain', name: '接收增益', unit: 'dB', min: 28, max: 36, nominal: 32, spread: 3.5, category: '接收指标', resources: ['rf', 'analyzer'] },
  { id: 'rxRipple', name: '接收带内波动', unit: 'dB', min: 0, max: 1.5, nominal: 0.6, spread: 0.6, category: '接收指标', resources: ['rf', 'analyzer'] },
  { id: 'phaseNonlinearity', name: '相位非线性', unit: '°', min: 0, max: 5, nominal: 2, spread: 2.3, category: '接收指标', resources: ['rf', 'analyzer'] },
  { id: 'noiseFigure', name: '噪声系数', unit: 'dB', min: 0, max: 4, nominal: 2.1, spread: 1.5, category: '接收指标', resources: ['rf', 'analyzer'] },
  { id: 'phaseError', name: '移相误差', unit: '°', min: 0, max: 5, nominal: 2.2, spread: 2.3, category: '接收指标', resources: ['rf', 'analyzer'] },
  { id: 'burnoutPeakPower', name: '烧毁峰值功率（仅模拟）', unit: 'dBm', min: 35, max: 45, nominal: 40, spread: 4, category: '接收指标', resources: ['rf', 'power'] },
  { id: 'voltage', name: '工作电压', unit: 'V', min: 11.5, max: 12.5, nominal: 12, spread: 0.35, category: '供电指标', resources: ['supply'] },
  { id: 'current', name: '工作电流', unit: 'A', min: 0.3, max: 1.2, nominal: 0.75, spread: 0.35, category: '供电指标', resources: ['supply'] },
]);

export const DEFAULT_METRIC_IDS = ['gain', 'outputPower', 'phaseError', 'noiseFigure', 'vswr', 'efficiency'];
export const metricById = new Map(METRICS.map(metric => [metric.id, metric]));
export const defaultThresholds = () => Object.fromEntries(METRICS.map(({ id, min, max }) => [id, { min, max }]));
export const metricCatalog = thresholds => METRICS.map(({ resources, nominal, spread, ...metric }) => ({ ...metric, ...thresholds[metric.id] }));
export const round = (value, digits = 3) => Number(value.toFixed(digits));

export function evaluateMetric(id, value, thresholds) {
  const metric = metricById.get(id);
  if (!metric || !Number.isFinite(value)) throw new Error(`无效指标值: ${id}`);
  const { min, max } = thresholds[id];
  return { id, name: metric.name, unit: metric.unit, value, min, max, pass: value >= min && value <= max };
}

export function seededRandom(seed) {
  let state = [...String(seed)].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261);
  return () => { state += 0x6D2B79F5; let n = state; n = Math.imul(n ^ n >>> 15, n | 1); n ^= n + Math.imul(n ^ n >>> 7, n | 61); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
}

export function simulatedValue(task, channelId, metricId) {
  const metric = metricById.get(metricId);
  if (metricId === 'frequencyRange') return round(task.frequencyEnd - task.frequencyStart);
  const rng = seededRandom(`${task.seed}:${channelId}:${metricId}`);
  const isOutlier = rng() > 0.94;
  return round(Math.max(metricId === 'inputPower' ? -10 : 0, metric.nominal + (rng() * 2 - 1) * metric.spread + (isOutlier ? metric.spread * 1.5 : 0)));
}

export function createTrace(task, channelId, values) {
  const lookup = Object.fromEntries(values.map(metric => [metric.id, metric.value]));
  const rng = seededRandom(`${task.seed}:${channelId}:trace`);
  return Array.from({ length: task.points }, (_, index) => {
    const fraction = index / Math.max(1, task.points - 1);
    const wave = Math.sin(fraction * Math.PI * 3 + channelId * 0.2);
    const point = { frequency: round(task.frequencyStart + fraction * (task.frequencyEnd - task.frequencyStart), 4) };
    if (lookup.gain !== undefined) point.gain = round(lookup.gain + wave * 0.35 + (rng() - 0.5) * 0.08);
    if (lookup.outputPower !== undefined) point.outputPower = round(lookup.outputPower + Math.cos(fraction * Math.PI * 2) * 0.3 + (rng() - 0.5) * 0.07);
    if (lookup.phaseError !== undefined) point.phaseError = round(Math.max(0, lookup.phaseError + wave * 0.25));
    return point;
  });
}

// A swept metric passes only when every observed frequency point is in range.
// Keep the worst violation as the reported value; otherwise report the mean.
// This matches imported measurement semantics and keeps the chart and verdict
// consistent even when a simulated center value passes but its ripple does not.
export function evaluateTraceMetrics(centers, trace, thresholds) {
  return centers.map(center => {
    const sampled = trace.map(point => point[center.id]).filter(Number.isFinite);
    const samples = sampled.length ? sampled : [center.value];
    const { min, max } = thresholds[center.id];
    const failed = samples.filter(value => value < min || value > max);
    const violation = value => Math.max(min - value, value - max);
    const value = failed.length
      ? failed.reduce((worst, item) => violation(worst) > violation(item) ? worst : item)
      : samples.reduce((sum, item) => sum + item, 0) / samples.length;
    return { ...evaluateMetric(center.id, value, thresholds), minObserved: Math.min(...samples), maxObserved: Math.max(...samples), samples: samples.length };
  });
}

export function simulatedResult(task, channelId) {
  const centers = task.metricIds.map(id => ({ id, value: simulatedValue(task, channelId, id) }));
  const trace = createTrace(task, channelId, centers);
  const metrics = evaluateTraceMetrics(centers, trace, task.thresholds);
  return { channelId, serial: `${task.serialPrefix}-${String(channelId).padStart(2, '0')}`, metrics, pass: metrics.every(metric => metric.pass), trace, completedAt: new Date().toISOString(), simulation: true, evaluation: 'threshold' };
}
