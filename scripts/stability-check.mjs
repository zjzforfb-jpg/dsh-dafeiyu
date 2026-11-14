import {appendFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {recordObservation} from '../connect/observability.mjs';
const root=resolve(import.meta.dirname,'..');const dir=join(root,'runtime','stability');mkdirSync(dir,{recursive:true,mode:0o700});
const status=(()=>{try{return JSON.parse(execFileSync('node',['scripts/connect.mjs','status'],{cwd:root,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','ignore']}));}catch{return {devices:[]};}})();
const db=new DatabaseSync(join(root,'runtime','connect','connect.sqlite'),{readOnly:true});const sample=recordObservation(join(root,'runtime','connect'),{sessions:{size:(status.devices??[]).filter(d=>d.online).length},db,qq:null,now:Date.now()});db.close();
console.log(JSON.stringify({recorded:true,at:sample.at,connect_online:sample.devices.sessions_online}));
