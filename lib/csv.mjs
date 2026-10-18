import { metricById, evaluateMetric } from './metrics.mjs';

export function parseCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('CSV 内容不能为空');
  const input = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], value = '', quoted = false, closedQuote = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closedQuote = true; }
      } else value += char;
    } else if (char === '"') {
      if (value || closedQuote) throw new Error('CSV 引号格式错误');
      quoted = true;
    } else if (char === ',') {
      row.push(value.trim()); value = ''; closedQuote = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(value.trim());
      if (row.some(cell => cell !== '')) rows.push(row);
      row = []; value = ''; closedQuote = false;
    } else {
      if (closedQuote && char.trim()) throw new Error('CSV 闭引号后存在多余内容');
      value += char;
    }
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号');
  if (value || row.length) { row.push(value.trim()); if (row.some(cell => cell !== '')) rows.push(row); }
  if (rows.length < 2) throw new Error('CSV 至少需要表头和一行数据');
  if (rows.length > 10001) throw new Error('CSV 最多支持 10000 行数据');
  if (new Set(rows[0]).size !== rows[0].length) throw new Error('CSV 表头不能重复');
  for (let i = 1; i < rows.length; i++) if (rows[i].length !== rows[0].length) throw new Error(`CSV 第 ${i + 1} 行列数不一致`);
  return rows;
}

export function importMeasurements(csv, thresholds, maxChannels = 36) {
  const [header, ...rows] = parseCsv(csv);
  const channelIndex = header.indexOf('channelId');
  if (channelIndex < 0) throw new Error('CSV 缺少 channelId 列');
  const reserved = new Set(['channelId', 'serial', 'frequency', 'pass', 'source', 'completedAt']);
  const isMetricMetadata = id => /_(min|max|unit)$/.test(id) && metricById.has(id.replace(/_(min|max|unit)$/, ''));
  for (const id of header) if (!reserved.has(id) && !metricById.has(id) && !isMetricMetadata(id)) throw new Error(`不支持的 CSV 列: ${id}`);
  const metricIds = header.filter(id => metricById.has(id));
  if (!metricIds.length) throw new Error('CSV 至少需要一个已知指标列，例如 gain');
  const grouped = new Map();
  const serialIndex = header.indexOf('serial'), frequencyIndex = header.indexOf('frequency');
  const metricIndices = metricIds.map(id => [id, header.indexOf(id)]);
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const channelId = Number(row[channelIndex]);
    if (!Number.isInteger(channelId) || channelId < 1 || channelId > maxChannels) throw new Error(`第 ${rowNumber} 行 channelId 必须为 1–${maxChannels} 的整数`);
    const frequency = frequencyIndex >= 0 && row[frequencyIndex] !== '' ? Number(row[frequencyIndex]) : null;
    if (frequency !== null && (!Number.isFinite(frequency) || frequency <= 0 || frequency > 6)) throw new Error(`第 ${rowNumber} 行频率必须 >0 且 ≤6 GHz`);
    const values = {};
    for (const [id, column] of metricIndices) {
      if (!row[column] || !Number.isFinite(Number(row[column]))) throw new Error(`第 ${rowNumber} 行 ${id} 必须是有限数值`);
      values[id] = Number(row[column]);
    }
    const serial = serialIndex >= 0 ? row[serialIndex].slice(0, 120) : `IMPORT-${String(channelId).padStart(2, '0')}`;
    if (!grouped.has(channelId)) grouped.set(channelId, { channelId, serial, samples: [] });
    const group = grouped.get(channelId);
    if (group.serial !== serial) throw new Error(`通道 ${channelId} 的 serial 不一致`);
    group.samples.push({ frequency, ...values });
  });
  const completedAt = new Date().toISOString();
  const results = [...grouped.values()].sort((a, b) => a.channelId - b.channelId).map(group => {
    const metrics = metricIds.map(id => {
      const values = group.samples.map(sample => sample[id]);
      const failed = values.filter(value => value < thresholds[id].min || value > thresholds[id].max);
      const value = failed.length ? failed.reduce((a, b) => Math.max(thresholds[id].min - a, a - thresholds[id].max) > Math.max(thresholds[id].min - b, b - thresholds[id].max) ? a : b) : values.reduce((sum, item) => sum + item, 0) / values.length;
      return { ...evaluateMetric(id, value, thresholds), minObserved: Math.min(...values), maxObserved: Math.max(...values), samples: values.length };
    });
    return { channelId: group.channelId, serial: group.serial, metrics, pass: metrics.every(metric => metric.pass), trace: group.samples.filter(sample => sample.frequency !== null).sort((a, b) => a.frequency - b.frequency), completedAt, simulation: false, evaluation: 'threshold', origin: 'imported' };
  });
  const frequencies = results.flatMap(result => result.trace.map(point => point.frequency));
  return { metricIds, results, channelIds: results.map(result => result.channelId), frequencyStart: frequencies.length ? Math.min(...frequencies) : 0.5, frequencyEnd: frequencies.length ? Math.max(...frequencies) : 6, points: Math.max(...results.map(result => result.trace.length), 1) };
}

function cell(value) {
  const text = String(value ?? '');
  // Prevent spreadsheet formula execution when user-provided names are exported.
  const safe = (/^[\s\uFEFF]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) && !Number.isFinite(Number(text)) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function reportCsv(task) {
  const header = ['channelId', 'serial', ...task.metricIds.flatMap(id => [id, `${id}_min`, `${id}_max`, `${id}_unit`]), 'pass', 'source', 'completedAt'];
  const rows = task.results.map(result => {
    const values = Object.fromEntries(result.metrics.map(metric => [metric.id, metric]));
    return [result.channelId, result.serial, ...task.metricIds.flatMap(id => { const metric = values[id]; return [metric?.value ?? '', metric?.min ?? task.thresholds[id].min, metric?.max ?? task.thresholds[id].max, metric?.unit ?? metricById.get(id).unit]; }), result.pass ? 'PASS' : 'FAIL', task.origin === 'imported' ? 'IMPORTED' : 'SIMULATED', result.completedAt];
  });
  return '\uFEFF' + [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}
