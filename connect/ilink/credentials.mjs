import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
export function accountStore(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  const path = join(root, 'accounts.json');
  return {
    list() { if (!existsSync(path)) return []; const rows = JSON.parse(readFileSync(path, 'utf8')); if (!Array.isArray(rows)) throw new Error('invalid_account_store'); return rows; },
    save(account) {
      const rows = this.list().filter(row => row.id !== account.id); rows.push(account);
      const temp = path + '.tmp'; writeFileSync(temp, JSON.stringify(rows, null, 2), { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, path);
    },
  };
}
