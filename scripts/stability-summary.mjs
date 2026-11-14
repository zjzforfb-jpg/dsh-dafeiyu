import {existsSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const file=resolve(import.meta.dirname,'../runtime/stability/observations.jsonl');
if(!existsSync(file)){console.log(JSON.stringify({ok:false,error:'no_observations'}));process.exit(1);}
const rows=readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
const samples=rows.filter(r=>r.devices&&typeof r.devices==='object'&&!Array.isArray(r.devices)&&Array.isArray(r.tasks));const times=samples.map(r=>Date.parse(r.at)).filter(Number.isFinite);const first=times.length?Math.min(...times):0,last=times.length?Math.max(...times):0;const online=samples.filter(r=>r.devices?.sessions_online>0).length;
const taskCounts={};let unknownCommands=0,failedCommands=0;const latest=samples.at(-1);for(const item of latest?.tasks??[]){taskCounts[item.status]=(taskCounts[item.status]??0)+Number(item.n??0);}for(const item of latest?.commands??[]){if(item.status==='unknown')unknownCommands+=Number(item.n??0);if(item.status==='failed')failedCommands+=Number(item.n??0);}
console.log(JSON.stringify({ok:true,samples:samples.length,first_at:first?new Date(first).toISOString():null,last_at:last?new Date(last).toISOString():null,coverage_hours:first?Math.max(0,(last-first)/3600000):0,device_online_sample_rate:samples.length?online/samples.length:0,task_counts:taskCounts,unknown_commands:unknownCommands,failed_commands:failedCommands,seven_day_ready:first?last-first>=7*86400000:false},null,2));
