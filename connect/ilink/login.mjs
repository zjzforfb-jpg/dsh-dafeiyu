import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import QRCode from 'qrcode';
import { BASE_URL, trustedBase } from './protocol.mjs';
export class IlinkLogin {
  constructor({ root, client, accounts, onBound = () => {} }) { Object.assign(this, { root, client, accounts, onBound }); this.active = null; }
  async start() {
    this.cancel();
    const session = { key: randomBytes(24).toString('hex'), status: 'loading', expires: Date.now() + 300000, base: BASE_URL, stop: new AbortController() };
    this.active = session;
    try {
      const qr = await this.client.qr(this.accounts.list().slice(-10).map(a => a.token));
      if (this.active !== session) throw new Error('login_replaced');
      if (typeof qr.qrcode !== 'string' || !qr.qrcode || typeof qr.qrcode_img_content !== 'string' || qr.qrcode_img_content.length > 10000) throw new Error('invalid_qrcode');
      const qrUrl = new URL(qr.qrcode_img_content);
      if (qrUrl.protocol !== 'https:' || !qrUrl.hostname.endsWith('.weixin.qq.com') || qrUrl.username || qrUrl.password) throw new Error('untrusted_qrcode');
      session.qr = qr.qrcode; session.image = await QRCode.toDataURL(qr.qrcode_img_content, { width: 420, margin: 2 });
      session.file = join(this.root, 'login-qr.png');
      await QRCode.toFile(session.file, qr.qrcode_img_content, { width: 420, margin: 2 }); chmodSync(session.file, 0o600);
      session.status = 'wait'; session.task = this.poll(session).catch(() => { session.status = 'failed'; session.error = 'login_failed'; });
      return { key: session.key, image_file: session.file, expires_at: new Date(session.expires).toISOString() };
    } catch (error) { session.status = 'failed'; session.error = /^[a-z_0-9]+$/.test(error.message) ? error.message : 'login_failed'; throw new Error(session.error); }
  }
  view(key) {
    const s = this.active;
    if (!s || s.key !== key) return null;
    if (Date.now() > s.expires && !['confirmed','failed'].includes(s.status)) { s.status = 'expired'; s.pin = undefined; s.stop.abort(); }
    return { status: s.status, error: s.error, image: s.image, expires_at: new Date(s.expires).toISOString(), needs_pin: s.status.includes('need_verifycode') };
  }
  pin(key, code) {
    const s = this.active;
    if (!s || s.key !== key || !s.status.includes('need_verifycode') || Date.now() > s.expires || !/^\d{4,12}$/.test(code)) throw new Error('pin_not_accepted');
    s.pin = code; s.status = 'verifying'; s.pollStop?.abort();
  }
  cancel() { if(this.active)this.active.pin=undefined; this.active?.stop.abort(); this.active?.pollStop?.abort(); this.active = null; }
  async poll(s) {
    while (!s.stop.signal.aborted && Date.now() < s.expires && this.active === s) {
      if (s.status.includes('need_verifycode')) { await new Promise(r => setTimeout(r, 500)); continue; }
      s.pollStop = new AbortController();
      let value;
      try { value = await this.client.qrStatus(s.qr, { base: s.base, pin: s.pin, signal: AbortSignal.any([s.stop.signal,s.pollStop.signal]) }); }
      catch (error) { if (s.stop.signal.aborted) return; if (error.code !== 'timeout' && error.message !== 'ilink_network_error') { s.status = 'failed'; s.error = error.message; return; } await new Promise(r => setTimeout(r, 1000)); continue; }
      if (s.stop.signal.aborted) return;
      const status = value.status;
      if (typeof status !== 'string') { s.status = 'failed'; s.error = 'invalid_login_state'; return; }
      if (status.includes('need_verifycode')) { s.status = status; s.pin = undefined; continue; }
      if (status === 'scaned_but_redirect') { try { s.base = trustedBase(`https://${value.redirect_host}`); } catch { s.status = 'failed'; s.error = 'untrusted_ilink_endpoint'; return; } continue; }
      if (status === 'confirmed') {
        if (![value.ilink_bot_id, value.bot_token, value.ilink_user_id].every(v => typeof v === 'string' && v.length > 0 && v.length <= 4096)) { s.status = 'failed'; s.error = 'incomplete_binding'; return; }
        const account = { id: value.ilink_bot_id, ownerPeerId: value.ilink_user_id, token: value.bot_token, baseUrl: trustedBase(value.baseurl || s.base), bindingId: randomUUID() };
        this.accounts.save(account); this.onBound(account); s.status = 'confirmed'; s.pin = undefined; s.qr = undefined; return;
      }
      if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(status)) { s.status = status; s.pin = undefined; return; }
      if (!['wait', 'scaned'].includes(status)) { s.status = 'failed'; s.error = 'unsupported_login_state'; return; }
      s.status = status; if (status === 'scaned') s.pin = undefined;
      await new Promise(r => setTimeout(r, 700));
    }
    if (!s.stop.signal.aborted) s.status = 'expired';
  }
}
export function loginPage(key, nonce) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>绑定大肥鱼微信 Bot</title><style>body{font:17px system-ui;background:#f3f7fa;color:#17324a;max-width:600px;margin:40px auto;padding:24px}img{max-width:100%;display:block}input,button{font:inherit;padding:12px;margin:8px 4px 8px 0}#pin{display:none}.muted{color:#526575;font-size:15px}</style><h1>绑定大肥鱼微信 Bot</h1><p>用你希望与大肥鱼聊天的微信扫码，并在微信中确认。这是独立 Bot 入口。</p><p class="muted">绑定后，扫码账号作为“爸爸”，可以发消息获得 DeepSeek 回复。其他账号需在 Mac 授权。支持文字与语音输入；音频回复和原生语音气泡以当前验证状态为准。PIN 只在这个本机页面输入。</p><img id="qr" alt="微信绑定二维码"><p id="status">正在读取绑定状态…</p><form id="pin"><label>输入微信显示的 PIN：<input id="code" inputmode="numeric" autocomplete="off" type="password" pattern="[0-9]{4,12}" required></label><button>提交验证</button></form><p id="error"></p><script nonce="${nonce}">const base='/ilink/bind/${key}';const labels={wait:'等待扫码',scaned:'已扫码，请在微信确认',verifying:'正在验证 PIN',confirmed:'绑定成功，可以在微信给大肥鱼发消息了',expired:'二维码已过期，请在 Mac 重新发起绑定',failed:'绑定失败',binded_redirect:'此 Bot 已绑定，请检查现有账号',verify_code_blocked:'PIN 验证被限制，请稍后重新绑定'};async function refresh(){try{const r=await fetch(base+'/state');const s=await r.json();document.getElementById('status').textContent=labels[s.status]||(s.needs_pin?'请填写微信显示的 PIN':s.status);document.getElementById('pin').style.display=s.needs_pin?'block':'none';if(s.image)document.getElementById('qr').src=s.image;if(s.error)document.getElementById('error').textContent=s.error;if(!['confirmed','expired','failed','binded_redirect','verify_code_blocked'].includes(s.status))setTimeout(refresh,1000)}catch{document.getElementById('status').textContent='本机连接中断'}}document.getElementById('pin').onsubmit=async e=>{e.preventDefault();const input=document.getElementById('code');const pin=input.value;input.value='';const r=await fetch(base+'/pin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin})});if(!r.ok)document.getElementById('error').textContent='PIN 提交失败，请检查当前绑定状态';};refresh();</script></html>`;
}
