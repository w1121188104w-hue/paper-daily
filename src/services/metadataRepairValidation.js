import { assertLibrary, stableJson } from './libraryValidation.js';
import { fillMissingMetadata } from './searchMetadata.js';

// Replay only newly appended, identity-verified source evidence. A repair operation
// cannot smuggle unrelated edits through a broad field allowlist.
export function validateMetadataRepairOnlyChange(previous, next) {
  assertLibrary(previous.length === next.length, '字段修复不能添加或删除论文');
  const byId = new Map(next.map(p => [p.id, p]));
  for (const old of previous) {
    const current = byId.get(old.id);
    assertLibrary(current, '字段修复不能改变论文ID');
    if (stableJson(old) === stableJson(current)) continue;
    assertLibrary(current.source_records.length >= old.source_records.length &&
      stableJson(current.source_records.slice(0, old.source_records.length)) === stableJson(old.source_records), '字段修复不能覆盖或重排历史来源');
    let replayed = old;
    for (const record of current.source_records.slice(old.source_records.length)) replayed = fillMissingMetadata(replayed, record,
      { otherPapers: next, identityEvidence: current.source_records }).paper;
    assertLibrary(stableJson(replayed) === stableJson(current), '字段变化必须能够从新追加的原始证据重现');
  }
}
