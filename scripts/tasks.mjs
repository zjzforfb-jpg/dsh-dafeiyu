import {resolve} from 'node:path';
import {loadConnectConfig} from '../connect/server.mjs';
const root=resolve(import.meta.dirname,'../runtime/connect');const config=loadConnectConfig(root);const base='http://127.0.0.1:8765';
const [command,arg]=process.argv.slice(2);const headers={authorization:`Bearer ${config.adminToken}`,'content-type':'application/json'};
const path=command==='show'?`/tasks/${arg}`:command==='cancel'?`/tasks/${arg}/cancel`:'/tasks';
const r=await fetch(base+path,{method:command==='cancel'?'POST':'GET',headers,signal:AbortSignal.timeout(10000)});console.log(JSON.stringify(await r.json(),null,2));if(!r.ok)process.exitCode=1;
