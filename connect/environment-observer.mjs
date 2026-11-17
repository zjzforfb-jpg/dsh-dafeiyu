import { randomUUID } from 'node:crypto';
import { recordAgentEvent } from './agent-events.mjs';
import { updateWorkingTask, workingTask } from './working-state.mjs';
import { observeAndroid } from '../device/android.mjs';

export function observeWorkingTask(db, taskId, { sessions = new Map(), now = Date.now() } = {}) {
  const task = workingTask(db, taskId);
  if (!task) return null;
  let environment = {};
  try { environment = JSON.parse(task.environment || '{}'); } catch {}
  const deviceId = environment.device_id ?? environment.device ?? null;
  const device = deviceId ? db.prepare('SELECT id,model,last_seen FROM devices WHERE id=?').get(deviceId) : null;
  const capabilities = deviceId ? db.prepare('SELECT capabilities,updated_at FROM device_capabilities WHERE device_id=?').get(deviceId) : null;
  const hasCommands = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='commands'").get());
  const commands = hasCommands ? db.prepare('SELECT id,action,status,result,created_at FROM commands WHERE id=?').all(taskId) : [];
  const observationId = `observation_${randomUUID()}`;
  const snapshot = {
    observation_id: observationId,
    task_id: taskId,
    online: deviceId ? sessions.has(deviceId) : null,
    device: device ?? null,
    capabilities: capabilities ? parse(capabilities.capabilities) : {},
    capability_updated_at: capabilities?.updated_at ?? null,
    commands: commands.map((row) => ({ ...row, result: row.result ? parse(row.result) : null })),
    observed_at: new Date(now).toISOString(),
  };
  recordAgentEvent(db, { id: observationId, eventType: 'observation_created', channel: 'android', taskId, actor: 'system', payload: snapshot, evidence: { source: 'connect_state' }, dedupeKey: `${taskId}:observation:${observationId}`, at: new Date(now) });
  return snapshot;
}

export function attachObservation(db, taskId, observation, now = Date.now()) {
  if (!observation?.observation_id) throw new Error('observation_required');
  const current = workingTask(db, taskId);
  if (!current) return null;
  return updateWorkingTask(db, taskId, { lastObservationId: observation.observation_id, environment: { ...parse(current.environment), observed: observation } }, now);
}

export async function observeAndroidTask(db, taskId, serial, { now = Date.now() } = {}) {
  const observation = await observeAndroid(serial);
  const task = workingTask(db, taskId);
  if (!task) return null;
  const full = { ...observation, task_id: taskId, observation_id: `observation_${randomUUID()}` };
  recordAgentEvent(db, { id: full.observation_id, eventType: 'observation_created', channel: 'android', taskId, actor: 'system', payload: full, evidence: { source: 'adb' }, dedupeKey: `${taskId}:adb:${full.observation_id}`, at: new Date(now) });
  return attachObservation(db, taskId, full, now);
}

function parse(value) { try { return JSON.parse(value); } catch { return {}; } }
