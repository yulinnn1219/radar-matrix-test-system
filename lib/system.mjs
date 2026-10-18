import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { METRICS, DEFAULT_METRIC_IDS, metricById, defaultThresholds, metricCatalog, simulatedResult, round } from './metrics.mjs';
import { importMeasurements } from './csv.mjs';

const now = () => new Date().toISOString();
const activeStatuses = new Set(['queued', 'running', 'paused']);
const priorityRank = { high: 0, normal: 1, low: 2 };
const clone = value => structuredClone(value);

export class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function textValue(value, name, fallback, max = 100) {
  const result = value === undefined ? fallback : String(value).trim();
  if (!result || result.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(result)) throw new ApiError(`${name}不能为空，且不能超过 ${max} 个字符`);
  return result;
}

function numberValue(value, name, fallback, min, max, integer = false) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) throw new ApiError(`${name}必须为 ${min}–${max} 范围内的${integer ? '整数' : '数值'}`);
  return result;
}

function defaultDevices() {
  return [
    { id: 'rf', name: '射频信号源', type: 'signal-generator', address: '127.0.0.1', port: 5025 },
    { id: 'analyzer', name: '综合射频分析仪', type: 'rf-analyzer', address: '127.0.0.1', port: 5026 },
    { id: 'power', name: '射频功率计', type: 'power-meter', address: '127.0.0.1', port: 5027 },
    { id: 'supply', name: '直流电源', type: 'power-supply', address: '127.0.0.1', port: 5028 },
    { id: 'matrix', name: '射频开关矩阵', type: 'switch-matrix', address: '127.0.0.1', port: 5029 },
  ].map(device => ({ ...device, enabled: true, status: 'connected', simulation: true, driver: '内置模拟驱动', lastConnectedAt: now() }));
}

export class TestSystem extends EventEmitter {
  constructor({ dbPath = ':memory:', seed = true, durationScale = 1, autoStart = true } = {}) {
    super();
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);');
    this.settings = this.readMeta('settings') ?? { maxChannels: 36, concurrency: 6, simulation: true, thresholds: defaultThresholds(), thresholdSource: '演示阈值，请按产品规范配置', frequencyUnit: 'GHz' };
    this.settings.thresholds = { ...defaultThresholds(), ...this.settings.thresholds };
    this.settings.simulation = true;
    this.devices = this.readMeta('devices') ?? defaultDevices();
    if (!this.devices.some(device => device.id === 'matrix')) this.devices.push(defaultDevices().find(device => device.id === 'matrix'));
    this.tasks = this.db.prepare('SELECT data FROM tasks').all().map(row => JSON.parse(row.data));
    this.logs = this.db.prepare('SELECT id, data FROM logs ORDER BY id DESC LIMIT 300').all().reverse().map(row => ({ ...JSON.parse(row.data), id: row.id }));
    this.jobs = new Map();
    this.locks = new Map();
    this.leaseQueue = [];
    this.durationScale = durationScale;
    this.autoStart = autoStart;
    this.closed = false;
    this.schedulePending = false;
    let recovered = 0;
    for (const task of this.tasks) {
      task.checkpoints ??= {};
      if (task.status === 'running') { task.status = 'queued'; recovered++; this.saveTask(task); }
    }
    if (!this.readMeta('initialized')) {
      if (seed) this.seedDemo();
      this.writeMeta('initialized', true);
    }
    this.writeMeta('settings', this.settings);
    this.writeMeta('devices', this.devices);
    this.log('info', `本地模拟引擎已启动；${this.settings.maxChannels} 通道 / ${this.settings.concurrency} 并发；判定方式为规则阈值`, 'system');
    if (recovered) this.log('warn', `已恢复 ${recovered} 个未完成任务，保留已采集的指标检查点`, 'scheduler');
    if (autoStart) this.requestSchedule();
  }

  readMeta(key) { const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key); return row ? JSON.parse(row.value) : null; }
  writeMeta(key, value) { this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  saveTask(task) { this.db.prepare('INSERT INTO tasks(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(task.id, JSON.stringify(task)); }

  log(level, message, source = 'scheduler', extra = {}) {
    const item = { time: now(), level, message, source, simulation: true, ...extra };
    const result = this.db.prepare('INSERT INTO logs(data) VALUES(?)').run(JSON.stringify(item));
    this.logs.push({ ...item, id: Number(result.lastInsertRowid) });
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
    this.db.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 300)').run();
  }

  seedDemo() {
    const time = Date.now();
    for (let index = 0; index < 2; index++) {
      const task = {
        id: `demo-${index + 1}`, name: index === 0 ? '演示 · T/R 组件出厂测试' : '演示 · 六通道接收性能测试',
        model: 'TR-0606', serialPrefix: `DEMO-${index + 1}`, channelIds: Array.from({ length: 6 }, (_, i) => i + 1 + index * 6),
        priority: 'normal', metricIds: [...DEFAULT_METRIC_IDS], frequencyStart: 0.5, frequencyEnd: 6, points: 51, dwellMs: 500,
        thresholds: clone(this.settings.thresholds), status: 'completed', progress: 100, origin: 'demo', simulation: true,
        seed: `demonstration-${index + 1}`, createdAt: new Date(time - (2 - index) * 3600000).toISOString(),
        startedAt: new Date(time - (2 - index) * 3600000 + 2000).toISOString(),
        completedAt: new Date(time - (2 - index) * 3600000 + 63000).toISOString(), results: [], checkpoints: {},
      };
      task.results = task.channelIds.map(id => ({ ...simulatedResult(task, id), completedAt: task.completedAt }));
      this.tasks.push(task); this.saveTask(task);
    }
  }

  validateTask(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('任务参数必须是对象');
    const name = textValue(input.name, '任务名称', 'T/R 组件矩阵测试');
    const model = textValue(input.model, '产品型号', 'TR-0606', 80);
    const serialPrefix = textValue(input.serialPrefix, '序列号前缀', 'TR', 80);
    if (!Array.isArray(input.channelIds) || !input.channelIds.length || input.channelIds.length > this.settings.maxChannels) throw new ApiError(`请选择 1–${this.settings.maxChannels} 个通道`);
    const channelIds = input.channelIds.map(value => numberValue(value, '通道编号', undefined, 1, this.settings.maxChannels, true));
    if (new Set(channelIds).size !== channelIds.length) throw new ApiError('通道编号不能重复');
    channelIds.sort((a, b) => a - b);
    const priority = input.priority ?? 'normal';
    if (typeof priority !== 'string' || !Object.hasOwn(priorityRank, priority)) throw new ApiError('优先级必须为 high、normal 或 low');
    const metricIds = input.metricIds ?? DEFAULT_METRIC_IDS;
    if (!Array.isArray(metricIds) || !metricIds.length || metricIds.length > METRICS.length || new Set(metricIds).size !== metricIds.length || metricIds.some(id => !metricById.has(id))) throw new ApiError('请选择有效且不重复的测试指标');
    const frequencyStart = numberValue(input.frequencyStart, '起始频率 GHz', 0.5, 0.001, 6);
    const frequencyEnd = numberValue(input.frequencyEnd, '结束频率 GHz', 6, 0.001, 6);
    if (frequencyEnd <= frequencyStart) throw new ApiError('结束频率必须大于起始频率，且不超过 6 GHz');
    const points = numberValue(input.points, '扫描点数', 51, 2, 1001, true);
    const dwellMs = numberValue(input.dwellMs, '每指标采集驻留时间 ms', 500, 200, 10000, true);
    return { name, model, serialPrefix, channelIds, priority, metricIds: [...metricIds], frequencyStart, frequencyEnd, points, dwellMs };
  }

  createTask(input) {
    const value = this.validateTask(input);
    const task = { ...value, id: randomUUID(), status: 'queued', progress: 0, createdAt: now(), startedAt: null, completedAt: null, results: [], checkpoints: {}, thresholds: clone(this.settings.thresholds), seed: randomUUID(), simulation: true, origin: 'simulator' };
    this.tasks.push(task); this.saveTask(task);
    this.log('info', `任务“${task.name}”已入队，${task.channelIds.length} 个通道，${task.metricIds.length} 项指标，优先级 ${task.priority}`, 'scheduler', { taskId: task.id });
    this.changed(); this.requestSchedule(); return this.publicTask(task);
  }

  findTask(id) { const task = this.tasks.find(item => item.id === id); if (!task) throw new ApiError('任务不存在', 404); return task; }

  actOnTask(id, action) {
    const task = this.findTask(id);
    if (action === 'pause') {
      if (!['queued', 'running'].includes(task.status)) throw new ApiError('只有排队或运行中的任务可以暂停', 409);
      task.status = 'paused';
      this.stopTaskJobs(task.id);
      this.log('warn', `已暂停“${task.name}”；已保存指标检查点并释放共享仪器`, 'scheduler', { taskId: task.id });
    } else if (action === 'resume') {
      if (!['paused', 'failed'].includes(task.status)) throw new ApiError('只有暂停或失败的任务可以恢复', 409);
      task.status = 'queued'; task.error = null; task.completedAt = null;
      this.log('info', `“${task.name}”已恢复排队，将从检查点继续`, 'scheduler', { taskId: task.id });
    } else if (action === 'cancel') {
      if (!activeStatuses.has(task.status)) throw new ApiError('该任务已结束，不能取消', 409);
      task.status = 'cancelled'; task.completedAt = now();
      this.stopTaskJobs(task.id);
      this.log('warn', `已取消“${task.name}”；保留 ${task.results.length} 份已完成通道结果`, 'scheduler', { taskId: task.id });
    } else throw new ApiError('不支持的任务操作');
    this.updateProgress(task); this.saveTask(task); this.changed(); this.requestSchedule(); return this.publicTask(task);
  }

  updateSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('设置参数必须是对象');
    if (input.simulation === false) throw new ApiError('当前版本仅支持模拟采集；真实仪器须接入经验证的设备驱动');
    const maxChannels = numberValue(input.maxChannels, '通道数', this.settings.maxChannels, 1, 36, true);
    if (![6, 12, 18, 24, 30, 36].includes(maxChannels)) throw new ApiError('通道数必须为 6、12、18、24、30 或 36（每级 6 通道）');
    const concurrency = numberValue(input.concurrency, '并发数', this.settings.concurrency, 1, maxChannels, true);
    if (this.tasks.some(task => activeStatuses.has(task.status) && task.channelIds.some(id => id > maxChannels))) throw new ApiError('未结束任务使用了超出新配置的通道，请先结束这些任务', 409);
    const thresholds = clone(this.settings.thresholds);
    if (input.thresholds !== undefined) {
      if (!input.thresholds || typeof input.thresholds !== 'object' || Array.isArray(input.thresholds)) throw new ApiError('阈值参数必须是对象');
      for (const [id, range] of Object.entries(input.thresholds)) {
        if (!metricById.has(id) || !range || typeof range !== 'object') throw new ApiError(`无效指标阈值: ${id}`);
        const min = numberValue(range.min, `${id} 下限`, thresholds[id].min, -1000000, 1000000);
        const max = numberValue(range.max, `${id} 上限`, thresholds[id].max, -1000000, 1000000);
        if (max < min) throw new ApiError(`${id} 上限不能小于下限`);
        thresholds[id] = { min, max };
      }
    }
    this.settings = { ...this.settings, maxChannels, concurrency, thresholds, simulation: true };
    for (const job of [...this.jobs.values()].reverse()) {
      if (this.jobs.size <= concurrency) break;
      this.stopJob(job);
    }
    this.writeMeta('settings', this.settings);
    this.log('info', `配置已保存：${maxChannels} 通道，${concurrency} 并发；阈值对新任务和新导入生效`, 'system');
    this.changed(); this.requestSchedule(); return clone(this.settings);
  }

  configureDevice(id, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('设备参数必须是对象');
    const device = this.devices.find(item => item.id === id);
    if (!device) throw new ApiError('设备不存在', 404);
    const address = textValue(input.address, '仪器地址', device.address, 253);
    if (!/^[a-zA-Z0-9.:[\]_-]+$/.test(address)) throw new ApiError('设备地址仅支持 IP 地址或主机名');
    const port = numberValue(input.port, '端口', device.port, 1, 65535, true);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new ApiError('enabled 必须是布尔值');
    Object.assign(device, { address, port, enabled: input.enabled ?? device.enabled });
    if (!device.enabled) { device.status = 'disconnected'; this.pauseForDevice(device); }
    this.writeMeta('devices', this.devices);
    this.log('info', `已保存 ${device.name} 的模拟设备配置 ${address}:${port}；未建立真实网络连接`, 'communication', { deviceId: id });
    this.changed(); this.requestSchedule(); return clone(device);
  }

  connectDevice(id, connected = true) {
    const device = this.devices.find(item => item.id === id);
    if (!device) throw new ApiError('设备不存在', 404);
    if (typeof connected !== 'boolean') throw new ApiError('connected 必须是布尔值');
    if (connected && !device.enabled) throw new ApiError('请先启用该设备', 409);
    device.status = connected ? 'connected' : 'disconnected';
    if (connected) device.lastConnectedAt = now(); else this.pauseForDevice(device);
    this.writeMeta('devices', this.devices);
    this.log(connected ? 'info' : 'warn', `${device.name} 模拟连接${connected ? '已就绪' : '已断开'}（${device.address}:${device.port}，未建立真实网络连接）`, 'communication', { deviceId: id });
    this.changed(); this.requestSchedule(); return clone(device);
  }

  pauseForDevice(device) {
    for (const task of this.tasks.filter(item => item.status === 'running' && (device.id === 'matrix' || item.metricIds.some(id => metricById.get(id).resources.includes(device.id))))) {
      task.status = 'paused'; task.pauseReason = `${device.name} 已断开`;
      this.stopTaskJobs(task.id); this.updateProgress(task); this.saveTask(task);
      this.log('warn', `“${task.name}”因 ${device.name} 断开而暂停，请连接后手动恢复`, 'scheduler', { taskId: task.id });
    }
  }

  importCsv(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('导入参数必须是对象');
    const name = textValue(input.name, '导入名称', '外部 CSV 数据分析');
    let imported;
    try { imported = importMeasurements(input.csv, this.settings.thresholds, this.settings.maxChannels); }
    catch (error) { throw new ApiError(error.message); }
    const stamp = now();
    const task = { ...imported, id: randomUUID(), name, model: 'CSV 数据', serialPrefix: 'IMPORT', priority: 'normal', dwellMs: 0, status: 'completed', progress: 100, createdAt: stamp, startedAt: stamp, completedAt: stamp, thresholds: clone(this.settings.thresholds), checkpoints: {}, simulation: false, origin: 'imported', evaluation: 'threshold' };
    this.tasks.push(task); this.saveTask(task);
    this.log('info', `已导入“${name}”：${task.channelIds.length} 通道，${task.metricIds.length} 项指标；仅进行规则阈值分析`, 'import', { taskId: task.id, simulation: false });
    this.changed(); return this.publicTask(task);
  }

  clearHistory() {
    const removable = this.tasks.filter(task => !activeStatuses.has(task.status));
    const statement = this.db.prepare('DELETE FROM tasks WHERE id = ?');
    this.db.exec('BEGIN');
    try { for (const task of removable) statement.run(task.id); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.tasks = this.tasks.filter(task => activeStatuses.has(task.status));
    this.log('warn', `已清理 ${removable.length} 条已结束任务及其报告`, 'system'); this.changed(); return { removed: removable.length };
  }

  clearLogs() { this.db.prepare('DELETE FROM logs').run(); this.logs = []; this.changed(); return { cleared: true }; }

  readyForTask(task) {
    const required = new Set(['matrix', ...task.metricIds.flatMap(id => metricById.get(id).resources)]);
    return [...required].every(id => this.devices.some(device => device.id === id && device.enabled && device.status === 'connected'));
  }

  requestSchedule() {
    if (!this.autoStart || this.closed || this.schedulePending) return;
    this.schedulePending = true;
    queueMicrotask(() => { this.schedulePending = false; if (!this.closed) this.schedule(); });
  }

  schedule() {
    if (this.closed) return;
    const candidates = this.tasks.filter(task => ['queued', 'running'].includes(task.status) && this.readyForTask(task)).sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.createdAt.localeCompare(b.createdAt));
    let didStart = false;
    while (this.jobs.size < this.settings.concurrency) {
      let task, channelId;
      for (const candidate of candidates) {
        const pending = candidate.channelIds.find(id => !candidate.results.some(result => result.channelId === id) && ![...this.jobs.values()].some(job => job.channelId === id));
        if (pending !== undefined) { task = candidate; channelId = pending; break; }
      }
      if (!task) break;
      if (task.status !== 'running') { task.status = 'running'; task.startedAt ??= now(); task.pauseReason = null; }
      this.startJob(task, channelId); didStart = true;
    }
    this.grantLeases();
    if (didStart) this.changed();
  }

  startJob(task, channelId) {
    const key = `${task.id}:${channelId}`;
    const workerTask = { seed: task.seed, metricIds: task.metricIds, frequencyStart: task.frequencyStart, frequencyEnd: task.frequencyEnd, points: task.points, dwellMs: task.dwellMs, thresholds: task.thresholds, serialPrefix: task.serialPrefix };
    const worker = new Worker(new URL('./acquisition-worker.mjs', import.meta.url), { workerData: { task: workerTask, channelId, checkpoint: task.checkpoints[channelId], durationScale: this.durationScale } });
    const job = { key, taskId: task.id, channelId, worker, metricId: null, waiting: false, startedAt: now() };
    this.jobs.set(key, job); this.saveTask(task);
    this.log('info', `CH-${String(channelId).padStart(2, '0')} 开始独立线程采集：${task.name}`, 'worker', { taskId: task.id, channelId });
    worker.on('message', message => {
      if (this.closed || this.jobs.get(key) !== job) return;
      if (message.type === 'lease') {
        job.waiting = true; job.metricId = message.metricId;
        this.leaseQueue.push({ job, requestId: message.requestId, resources: message.resources, metricId: message.metricId });
        this.grantLeases(); this.changed();
      } else if (message.type === 'release') {
        this.releaseJobLocks(job, message.requestId); this.grantLeases();
      } else if (message.type === 'checkpoint') {
        task.checkpoints[channelId] = message.checkpoint; job.metricId = message.metricId;
        this.updateProgress(task); this.saveTask(task); this.changed();
      } else if (message.type === 'result') {
        this.stopJob(job, false);
        task.results.push(message.result); task.results.sort((a, b) => a.channelId - b.channelId); delete task.checkpoints[channelId];
        this.updateProgress(task);
        this.log(message.result.pass ? 'success' : 'warn', `CH-${String(channelId).padStart(2, '0')} 完成，${message.result.pass ? '全部指标通过' : '存在超限指标'}`, 'worker', { taskId: task.id, channelId });
        if (task.results.length === task.channelIds.length) { task.status = 'completed'; task.completedAt = now(); task.progress = 100; this.log('success', `任务“${task.name}”已完成，${task.results.filter(result => result.pass).length}/${task.results.length} 通道通过`, 'scheduler', { taskId: task.id }); }
        this.saveTask(task); this.changed(); this.requestSchedule();
      } else if (message.type === 'error') this.failJob(job, message.message);
    });
    worker.on('error', error => { if (!this.closed && this.jobs.get(key) === job) this.failJob(job, error.message); });
    worker.on('exit', code => { if (!this.closed && this.jobs.get(key) === job) this.failJob(job, `采集线程意外退出 (${code})`); });
  }

  failJob(job, message) {
    const task = this.findTask(job.taskId);
    task.status = 'failed'; task.error = String(message).slice(0, 500); task.completedAt = now();
    this.stopTaskJobs(task.id); this.updateProgress(task); this.saveTask(task);
    this.log('error', `任务“${task.name}”已停止：${task.error}；其他任务继续运行，可恢复本任务`, 'worker', { taskId: task.id, channelId: job.channelId });
    this.changed(); this.requestSchedule();
  }

  grantLeases() {
    for (let index = 0; index < this.leaseQueue.length;) {
      const lease = this.leaseQueue[index];
      if (this.jobs.get(lease.job.key) !== lease.job) { this.leaseQueue.splice(index, 1); continue; }
      if (lease.resources.some(id => this.locks.has(id))) { index++; continue; }
      for (const id of lease.resources) this.locks.set(id, { job: lease.job, requestId: lease.requestId, metricId: lease.metricId });
      this.leaseQueue.splice(index, 1); lease.job.waiting = false;
      lease.job.worker.postMessage({ type: 'grant', requestId: lease.requestId });
      this.log('debug', `[SIM] CH-${String(lease.job.channelId).padStart(2, '0')} 采集 ${metricById.get(lease.metricId).name}，独占资源 ${lease.resources.join(' + ')}`, 'communication', { taskId: lease.job.taskId, channelId: lease.job.channelId });
    }
  }

  releaseJobLocks(job, requestId) {
    for (const [id, lock] of this.locks) if (lock.job === job && (requestId === undefined || lock.requestId === requestId)) this.locks.delete(id);
  }

  stopJob(job, terminate = true) {
    this.jobs.delete(job.key);
    this.leaseQueue = this.leaseQueue.filter(lease => lease.job !== job);
    this.releaseJobLocks(job);
    if (terminate) void job.worker.terminate();
    this.grantLeases();
  }

  stopTaskJobs(taskId) { for (const job of [...this.jobs.values()]) if (job.taskId === taskId) this.stopJob(job); }

  updateProgress(task) {
    const partial = Object.values(task.checkpoints).reduce((total, checkpoint) => total + checkpoint.progress, 0);
    task.progress = round((task.results.length * 100 + partial) / task.channelIds.length, 1);
  }

  publicTask(task) {
    const { checkpoints, seed, ...value } = task;
    const runningChannels = [...this.jobs.values()].filter(job => job.taskId === task.id).map(job => job.channelId);
    const passedChannels = task.results.filter(result => result.pass).length;
    return { ...clone(value), runningChannels, completedChannels: task.results.length, passedChannels, failedChannels: task.results.length - passedChannels, waitingReason: task.status === 'queued' && !this.readyForTask(task) ? '等待模拟仪器连接' : null, evaluation: 'threshold' };
  }

  state() {
    const tasks = [...this.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(task => this.publicTask(task));
    const channels = Array.from({ length: this.settings.maxChannels }, (_, index) => {
      const id = index + 1;
      const job = [...this.jobs.values()].find(item => item.channelId === id);
      const candidate = job ? this.findTask(job.taskId) : [...this.tasks].filter(task => activeStatuses.has(task.status) && task.channelIds.includes(id) && !task.results.some(result => result.channelId === id)).sort((a, b) => (a.status === 'paused') - (b.status === 'paused') || priorityRank[a.priority] - priorityRank[b.priority] || a.createdAt.localeCompare(b.createdAt))[0];
      const lastResult = this.tasks.flatMap(task => task.results.filter(result => result.channelId === id).map(result => ({ ...result, taskId: task.id, taskName: task.name }))).sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0] ?? null;
      const checkpoint = candidate?.checkpoints[id];
      const status = candidate ? (candidate.status === 'paused' ? 'paused' : job ? 'running' : 'queued') : lastResult ? (lastResult.pass ? 'passed' : 'failed') : 'idle';
      return { id, name: `CH-${String(id).padStart(2, '0')}`, status, taskId: candidate?.id ?? null, taskName: candidate?.name ?? null, progress: checkpoint?.progress ?? (candidate ? 0 : lastResult ? 100 : 0), temperature: round(32 + Math.sin(id) * 1.8 + (job ? 5 : 0), 1), currentMetric: job?.metricId ?? null, waiting: job?.waiting ?? false, serial: `${candidate?.serialPrefix ?? 'TR'}-${String(id).padStart(2, '0')}`, module: Math.ceil(id / 6), port: (id - 1) % 6 + 1, lastResult };
    });
    const results = this.tasks.flatMap(task => task.results);
    const passedChannels = results.filter(result => result.pass).length;
    const resourceLocks = [...this.locks].map(([deviceId, lock]) => ({ deviceId, deviceName: this.devices.find(device => device.id === deviceId)?.name, taskId: lock.job.taskId, channelId: lock.job.channelId, metricId: lock.metricId }));
    const stats = {
      totalTasks: tasks.length, runningTasks: tasks.filter(task => task.status === 'running').length, queuedTasks: tasks.filter(task => task.status === 'queued').length,
      pausedTasks: tasks.filter(task => task.status === 'paused').length, completedTasks: tasks.filter(task => task.status === 'completed').length, cancelledTasks: tasks.filter(task => task.status === 'cancelled').length,
      failedTasks: tasks.filter(task => task.status === 'failed').length, activeTasks: tasks.filter(task => activeStatuses.has(task.status)).length, totalResults: results.length,
      passedChannels, failedChannels: results.length - passedChannels, passRate: results.length ? round(passedChannels / results.length * 100, 1) : 0,
      activeChannels: this.jobs.size, completedChannels: results.length, queueLength: tasks.filter(task => ['running', 'queued'].includes(task.status)).reduce((sum, task) => sum + task.channelIds.length - task.results.length - task.runningChannels.length, 0),
      resourceLocks, resourceWaiting: this.leaseQueue.length, maxChannels: this.settings.maxChannels, concurrency: this.settings.concurrency,
    };
    return { settings: clone(this.settings), metrics: metricCatalog(this.settings.thresholds), channels, tasks, devices: clone(this.devices), logs: clone(this.logs), stats, history: tasks.filter(task => !activeStatuses.has(task.status)), serverTime: now(), mode: 'simulation', evaluation: { method: 'threshold', name: '规则阈值判定', description: '模拟采集与外部 CSV 数据按配置上下限判定；未接入训练模型或真实仪器。' } };
  }

  changed() { if (!this.closed) this.emit('change'); }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const jobs = [...this.jobs.values()];
    this.jobs.clear(); this.locks.clear(); this.leaseQueue = [];
    await Promise.all(jobs.map(job => job.worker.terminate()));
    this.db.close();
  }
}
