// P1-A · 统一记忆检索入口（R-05/R-07 收口）。
// 以前四处各自调 recall、各自决定范围，群聊记忆漏进主人私聊。现在只留这一个入口：
// 调用方必须给 scope，范围过滤在这里统一做，别的地方别再自造检索。
import { recall, remember, MEMORY_TYPES, MEMORY_SCOPES, typeForKind } from '../../brain/memory.mjs';

export { MEMORY_TYPES, MEMORY_SCOPES, remember, typeForKind };

const DEFAULT_SCOPE = 'private';

function normalizeScope(scope) {
  return MEMORY_SCOPES.includes(scope) ? scope : DEFAULT_SCOPE;
}

/**
 * 统一检索：recall() + 强制范围过滤。
 * query=检索词；opts.scope=private|friend|group|public（默认 private）；
 * opts.types=七类数组；opts.kinds=老 kind 数组；opts.limit。
 */
export function search(db, query, { scope = DEFAULT_SCOPE, types = [], kinds = [], limit = 8 } = {}) {
  const finalScope = normalizeScope(scope);
  const typeList = (Array.isArray(types) ? types : [types]).filter((t) => MEMORY_TYPES.includes(t));
  const kindList = (Array.isArray(kinds) ? kinds : [kinds]).filter(Boolean);
  // type/kind 各取第一个做主过滤（recall 支持单 type / 单 kind）；多值时逐个召回合去重。
  const results = [];
  const seen = new Set();
  const typeFilters = typeList.length ? typeList : [null];
  for (const type of typeFilters) {
    for (const kind of (kindList.length ? kindList : [null])) {
      const rows = recall(db, query, limit, {
        scope: finalScope, ...(type ? { type } : {}), ...(kind ? { kind } : {}),
      });
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        results.push(row);
      }
    }
  }
  results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.id - a.id);
  return results.slice(0, Math.max(1, Number(limit) || 8));
}

/** 显式写一条带范围的记忆（唯一写入口，别处别再裸 INSERT memories）。 */
export function rememberScoped(db, entry) {
  return remember(db, { ...entry, scope: normalizeScope(entry?.scope) });
}
