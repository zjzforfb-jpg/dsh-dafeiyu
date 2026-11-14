import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../runtime/connect');
const { adminToken } = JSON.parse(readFileSync(resolve(root, 'credentials.json'), 'utf8'));
console.log(`http://127.0.0.1:8765/messages?token=${adminToken}`);
