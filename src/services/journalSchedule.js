// The scheduler's arrival time is not trustworthy. Gate expensive work by the
// runner's actual Beijing clock, with at most one automatic claim per time slot.
export const SCHEDULE_WAKE_CRON = '7,17,27,37,47,57 * * * *';
export const SCHEDULE_STATE_PATH = 'data/schedule-state.json';
export const SCHEDULE_SLOTS = Object.freeze([{ name: 'morning', time: '08:17' }, { name: 'afternoon', time: '13:17' }]);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value,k));
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const check = condition => { if (!condition) throw new Error('INVALID_SCHEDULE_STATE'); };
export const emptyScheduleState = () => ({ schema_version: 1, slots: {} });

export function scheduleSlot(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_CLOCK');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(p => [p.type,p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return SCHEDULE_SLOTS.map(slot => ({ key: `${date}:${slot.name}`, name: slot.name,
    planned_at: new Date(`${date}T${slot.time}:00+08:00`).toISOString() }))
    .filter(slot => Date.parse(slot.planned_at) <= now.getTime()).at(-1) || null;
}

export function validateScheduleState(state) {
  check(exact(state,['schema_version','slots']) && state.schema_version === 1 && state.slots &&
    typeof state.slots === 'object' && !Array.isArray(state.slots) && Object.keys(state.slots).length <= 100);
  for (const [key, item] of Object.entries(state.slots)) {
    check(/^\d{4}-\d{2}-\d{2}:(morning|afternoon)$/.test(key) &&
      exact(item,['planned_at','claimed_at','github_run_id']) && validTime(item.planned_at) && validTime(item.claimed_at) &&
      typeof item.github_run_id === 'string' && /^\d{1,20}$/.test(item.github_run_id) && scheduleSlot(new Date(item.planned_at))?.key === key &&
      item.planned_at === scheduleSlot(new Date(item.planned_at)).planned_at && item.claimed_at >= item.planned_at);
  }
  return state;
}

export function planJournalSchedule({ now = new Date(), manual = false, state = emptyScheduleState(), lastCollectionAt = null } = {}) {
  validateScheduleState(state);
  const slot = scheduleSlot(now);
  if (manual) return { run: true, reason: 'MANUAL_REQUEST', slot: null, delay_minutes: null };
  if (!slot) return { run: false, reason: 'BEFORE_MORNING', slot: null, delay_minutes: null };
  const result = { run: false, reason: '', slot, delay_minutes: Math.floor((now.getTime()-Date.parse(slot.planned_at))/60000) };
  if (state.slots[slot.key]) return { ...result, reason: 'SLOT_ALREADY_CLAIMED' };
  if (lastCollectionAt !== null) {
    if (!validTime(lastCollectionAt) || Date.parse(lastCollectionAt) > now.getTime()) throw new Error('INVALID_COLLECTION_CLOCK');
    if (lastCollectionAt >= slot.planned_at) return { ...result, reason: 'ALREADY_COLLECTED_IN_SLOT' };
  }
  return { ...result, run: true, reason: 'SLOT_DUE' };
}

export function claimScheduleSlot(state, plan, { now = new Date(), runId } = {}) {
  validateScheduleState(state);
  if (!plan.run || plan.reason !== 'SLOT_DUE' || !plan.slot || !/^\d{1,20}$/.test(runId || '') ||
    state.slots[plan.slot.key] || scheduleSlot(now)?.key !== plan.slot.key) throw new Error('INVALID_SCHEDULE_CLAIM');
  const minimum = new Date(now.getTime()-45*86400000).toISOString();
  const slots = Object.fromEntries(Object.entries(state.slots).filter(([,item]) => item.claimed_at >= minimum));
  slots[plan.slot.key] = { planned_at: plan.slot.planned_at, claimed_at: now.toISOString(), github_run_id: runId };
  return validateScheduleState({ schema_version: 1, slots });
}
