import {existsSync,statSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..');const failures=[];const checks=[];
function check(name,ok,detail=''){checks.push({name,ok,detail});if(!ok)failures.push({name,detail});}
check('gitignore-runtime',readFileSync(join(root,'.gitignore'),'utf8').split('\n').includes('runtime/'));
check('capability-matrix',existsSync(join(root,'docs/CAPABILITY_MATRIX.md')));
check('bug-plan',existsSync(join(root,'docs/BUG_REMEDIATION_PLAN.md')));
check('task-api',existsSync(join(root,'scripts/tasks.mjs')));
check('stability-observer',existsSync(join(root,'scripts/stability-check.mjs')));
try{const status=JSON.parse(execFileSync('node',['scripts/connect.mjs','status'],{cwd:root,encoding:'utf8'}));check('magic5-online',status.devices?.some(d=>d.id==='honor_magic5'&&d.online),JSON.stringify(status.devices));}catch(e){check('connect-status',false,'probe_failed');}
try{const tasks=JSON.parse(execFileSync('node',['scripts/tasks.mjs'],{cwd:root,encoding:'utf8'}));check('no-active-unknown-tasks',(tasks.tasks??[]).every(t=>!['running','approved'].includes(t.status)),JSON.stringify(tasks.tasks??[]));}catch{check('task-status',false,'probe_failed');}
try{const db=new DatabaseSync(join(root,'runtime','connect','connect.sqlite'),{readOnly:true});const unresolved=db.prepare("SELECT id,status FROM commands WHERE status IN ('unknown','dispatched') LIMIT 20").all();check('no-unresolved-device-commands',unresolved.length===0,JSON.stringify(unresolved));db.close();}catch{check('device-command-audit',false,'probe_failed');}
try{const file=join(root,'runtime','stability','observations.jsonl');const rows=existsSync(file)?readFileSync(file,'utf8').split('\n').filter(Boolean).map(x=>{try{return JSON.parse(x);}catch{return null;}}).filter(x=>x&&x.devices&&Array.isArray(x.tasks)):[];const times=rows.map(x=>Date.parse(x.at)).filter(Number.isFinite);const hours=times.length>1?(Math.max(...times)-Math.min(...times))/3600000:0;check('stability-window-seven-days',hours>=168,JSON.stringify({samples:rows.length,coverage_hours:hours}));}catch{check('stability-window-seven-days',false,'probe_failed');}
try{const tracked=execFileSync('git',['ls-files'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);let leaked=[];const textFile=/\.(?:mjs|js|cjs|json|jsonc|md|txt|yml|yaml|toml|xml|kt|java|py|sh)$/i;for(const file of tracked){if(/^(runtime|\.env)/.test(file))leaked.push(file);else if(textFile.test(file)){const text=readFileSync(join(root,file),'utf8');if(/sk-[A-Za-z0-9]{20,}/.test(text))leaked.push(file);}}check('tracked-secret-scan',leaked.length===0,leaked.join(','));}catch{check('tracked-secret-scan',false,'scan_failed');}
console.log(JSON.stringify({ok:failures.length===0,checks,failures},null,2));if(failures.length)process.exitCode=1;
