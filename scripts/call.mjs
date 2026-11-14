import { resolve } from 'node:path';
import { loadConnectConfig } from '../connect/server.mjs';
const root = resolve(import.meta.dirname, '../runtime/connect');
const config = loadConnectConfig(root);
console.log(`在 Mac 浏览器打开：http://127.0.0.1:8765/call?token=${encodeURIComponent(config.adminToken)}`);
