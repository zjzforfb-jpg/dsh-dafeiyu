import {appendFileSync,mkdirSync,chmodSync} from 'node:fs';
import {join,basename,dirname} from 'node:path';

export function recordObservation(root,{sessions,db,qq,now=Date.now()}){
  const dir=basename(root)==='connect'?join(dirname(root),'stability'):join(root,'stability');mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
  const tasks=db.prepare("SELECT status,COUNT(*) AS n FROM external_tasks GROUP BY status").all();
  const commands=db.prepare("SELECT status,COUNT(*) AS n FROM commands GROUP BY status").all();
  const devices=db.prepare('SELECT id,last_seen FROM devices').all();
  const accounts=db.prepare('SELECT id,status,last_error,last_poll FROM ilink_accounts').all();
  const sample={at:new Date(now).toISOString(),process:{pid:process.pid},devices:{sessions_online:sessions.size,known:devices},tasks,commands,accounts,qq:qq?{running:true,calls:qq.calls.list()}:null};
  const file=join(dir,'observations.jsonl');appendFileSync(file,JSON.stringify(sample)+'\n',{mode:0o600});chmodSync(file,0o600);return sample;
}
