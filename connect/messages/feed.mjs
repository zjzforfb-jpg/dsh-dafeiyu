const clamp = (value, max) => Math.max(1, Math.min(max, Number(value) || max));

function item(source, kind, label, direction, text, status, error, time, inputKind) {
  return {
    source, kind, label, direction,
    text: String(text ?? '').slice(0, 2000),
    status: status ?? null,
    error: error ?? null,
    time: Number(time) || 0,
    inputKind: inputKind ?? 'text',
  };
}

/** 把微信（iLink）与 QQ 两个通道的消息合并成一条按时间排序的流。 */
export function buildFeed(db, limit = 40) {
  const size = clamp(limit, 200);
  const rows = [];
  try {
    const qq = db.prepare(`SELECT m.conv_kind kind, m.conv_id, m.text, m.reply, m.status, m.error, m.created_ms time, m.input_kind input, COALESCE(p.label, m.conv_id) label
      FROM qq_messages m LEFT JOIN qq_peers p ON p.conv_kind = m.conv_kind AND p.conv_id = m.conv_id
      ORDER BY m.rowid DESC LIMIT ?`).all(size);
    for (const row of qq) {
      const who = row.label || (row.kind === 'group' ? 'QQ群' : 'QQ好友');
      rows.push(item('qq', row.kind === 'group' ? '群聊' : '私聊', who, 'in', row.text, row.status, row.error, row.time, row.input));
      if (row.reply) rows.push(item('qq', row.kind === 'group' ? '群聊' : '私聊', who, 'out', row.reply, row.status, null, row.time + 1, 'text'));
    }
  } catch { /* 表不存在时只显示另一侧 */ }
  try {
    const wechat = db.prepare(`SELECT m.peer_id, m.text, m.reply, m.status, m.error, m.created_ms time, m.input_kind input, COALESCE(p.label, m.peer_id) label
      FROM ilink_messages m LEFT JOIN ilink_peers p ON p.peer_id = m.peer_id
      ORDER BY m.rowid DESC LIMIT ?`).all(size);
    for (const row of wechat) {
      if (!row.text && !row.reply) continue;
      rows.push(item('wechat', '微信', row.label || '微信好友', 'in', row.text, row.status, row.error, row.time, row.input));
      if (row.reply) rows.push(item('wechat', '微信', row.label || '微信好友', 'out', row.reply, row.status, null, row.time + 1, 'text'));
    }
  } catch { /* 同上 */ }
  rows.sort((a, b) => b.time - a.time);
  return rows.slice(0, size);
}
