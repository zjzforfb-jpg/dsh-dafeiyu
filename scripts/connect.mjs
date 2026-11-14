import { resolve } from 'node:path';
import { connectBrain } from '../connect/ilink/brain.mjs';
import { execFile } from 'node:child_process';
import { announceConnectEvent } from '../connect/desktop.mjs';
import { maintainUsbTunnel } from '../connect/usb.mjs';
import { randomUUID } from 'node:crypto';
import { loadConnectConfig, startConnect } from '../connect/server.mjs';
const root = resolve(import.meta.dirname, '../runtime/connect');
const command = process.argv[2] ?? 'status';
if (command === 'start') {
  process.umask(0o077);
  const home = resolve(root, '../dsh-home');
  const service = await startConnect({ root, voiceRoot:resolve(root,'../voice'), askIlink: connectBrain(home), onEvent: event => announceConnectEvent(home, event) });
  const stopTunnel = maintainUsbTunnel(root);
  console.log(`DaFeiYu Connect listening on 127.0.0.1:${service.port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { stopTunnel(); await service.close(); process.exit(0); });
} else {
  const config = loadConnectConfig(root);
  const base = 'http://127.0.0.1:8765';
  const headers = { authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' };
  try {
    if (command === 'ilink') {
      const op=process.argv[3]??'status';
      if(op==='login') {
        const r=await fetch(`${base}/ilink/login/start`,{method:'POST',headers,body:'{}'});const value=await r.json();if(!r.ok)throw new Error(value.error);
        console.log(JSON.stringify(value,null,2));if(!process.argv.includes('--no-open'))execFile('/usr/bin/open',[value.page_url],()=>{});
      } else if(['status','peers','messages'].includes(op)) {
        const r=await fetch(`${base}/ilink/${op}`,{headers});console.log(JSON.stringify(await r.json(),null,2));if(!r.ok)process.exitCode=1;
      } else if(op==='voice') {
        const action=process.argv[4]??'status';
        if(action==='status'){const r=await fetch(`${base}/ilink/voice`,{headers});console.log(JSON.stringify(await r.json(),null,2));if(!r.ok)process.exitCode=1;}
        else {
          let value;
          if(action==='trial')value={account_id:process.argv[5]};
          else if(action==='confirm'){if(!['yes','no'].includes(process.argv[6]))throw new Error('voice confirm <id> yes|no');value={id:process.argv[5],visible:process.argv[6]==='yes',playable:process.argv[6]==='yes'};}
          else if(action==='fallback')value={id:process.argv[5]};
          else throw new Error('voice status|trial [account]|confirm <id> yes|no|fallback <id>');
          const r=await fetch(`${base}/ilink/voice/${action}`,{method:'POST',headers,body:JSON.stringify(value)});console.log(JSON.stringify(await r.json(),null,2));if(!r.ok)process.exitCode=1;
        }
      } else if(op==='message') {
        const r=await fetch(`${base}/ilink/messages/${encodeURIComponent(process.argv[4]??'')}`,{headers});console.log(JSON.stringify(await r.json(),null,2));if(!r.ok)process.exitCode=1;
      } else if(op==='peer') {
        if(!['auto','hold','off'].includes(process.argv[7]))throw new Error('peer mode must be auto|hold|off');
        const input={account_id:process.argv[4],peer_id:process.argv[5],label:process.argv[6],enabled:process.argv[7]!=='off',auto_reply:process.argv[7]==='auto'};
        const r=await fetch(`${base}/ilink/peers`,{method:'POST',headers,body:JSON.stringify(input)});console.log(JSON.stringify(await r.json(),null,2));if(!r.ok)process.exitCode=1;
      } else if(['pause','resume'].includes(op)) {
        const r=await fetch(`${base}/ilink/account`,{method:'POST',headers,body:JSON.stringify({id:process.argv[4],enabled:op==='resume'})});console.log(JSON.stringify(await r.json(),null,2));if(!r.ok)process.exitCode=1;
      } else throw new Error('ilink login|status|peers|messages|message <id>|peer <account> <peer> <label> auto|hold|off|pause <account>|resume <account>');
    } else if (command === 'status') {
      const res = await fetch(`${base}/devices`, { headers, signal: AbortSignal.timeout(5000) });
      console.log(JSON.stringify(await res.json(), null, 2));
      if (!res.ok) process.exitCode = 1;
    } else if (command === 'contacts') {
      const op = process.argv[3] ?? 'list';
      if (op === 'list') console.log(JSON.stringify(await (await fetch(`${base}/contacts`, { headers })).json(), null, 2));
      else {
        let input;
        if (op === 'set') input = { id: process.argv[4], device_id: 'honor_magic5', label: process.argv[5], wechat_title: process.argv[6], enabled: true };
        else if (op === 'disable') {
          const rows = await (await fetch(`${base}/contacts`, { headers })).json();
          const old = rows.contacts?.find(c => c.id === process.argv[4]);
          if (!old) throw new Error('contact not found');
          input = { ...old, enabled: false };
        } else throw new Error('contacts list|set <id> <label> <exact-wechat-title>|disable <id>');
        const res = await fetch(`${base}/contacts`, { method: 'POST', headers, body: JSON.stringify(input) });
        console.log(JSON.stringify(await res.json(), null, 2)); if (!res.ok) process.exitCode = 1;
      }
    } else if (['events', 'event'].includes(command)) {
      const res = await fetch(`${base}/events${command === 'event' ? '/' + encodeURIComponent(process.argv[3] ?? '') : ''}`, { headers });
      console.log(JSON.stringify(await res.json(), null, 2)); if (!res.ok) process.exitCode = 1;
    } else if (['ping', 'launch', 'capabilities', 'diagnostic', 'scan', 'open-event'].includes(command)) {
      const id = randomUUID();
      const res = await fetch(`${base}/commands`, { method: 'POST', headers, body: JSON.stringify({ id, device_id: 'honor_magic5', action: ({ping:'device.ping', launch:'app.launch', capabilities:'device.capabilities', diagnostic:'device.diagnostic', scan:'wechat.scan_notifications', 'open-event':'wechat.open_notification'})[command], payload: command === 'launch' ? { app: process.argv[3] } : command === 'open-event' ? { event_id: process.argv[3], contact_id: process.argv[4] } : {}, expires_at: new Date(Date.now() + 20000).toISOString() }) });
      if (!res.ok) throw new Error(JSON.stringify(await res.json()));
      let row;
      for (let i = 0; i < 40; i++) {
        const result = await fetch(`${base}/commands/${id}`, { headers }); row = await result.json();
        if (row.status !== 'dispatched') break;
        await new Promise(r => setTimeout(r, 500));
      }
      console.log(JSON.stringify(row, null, 2));
      if (row.status !== 'succeeded') process.exitCode = 1;
    } else throw new Error('usage: connect start|status|ping|capabilities|diagnostic|contacts|events|event|open-event|launch');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
