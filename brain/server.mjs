import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMemory, recall, capture, reviseMemory, forgetMemory } from './memory.mjs';
import { classifyConversation, publishDesktopActivity } from '../desktop/activity.mjs';

const MAX_BODY = 1024 * 1024;

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('request-too-large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseSseText(block) {
  const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
  if (!data || data === '[DONE]') return '';
  try {
    return JSON.parse(data).choices?.[0]?.delta?.content ?? '';
  } catch {
    return '';
  }
}

function memoryTime(value) {
  const parsed = new Date(/Z$|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z');
  return Number.isNaN(parsed.getTime()) ? `${value} UTC` : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed) + ' 北京时间';
}

function memorySection(db, question) {
  const found = recall(db, question);
  if (!found.length) return '';
  const labels = { shared_episode: '爸爸明确要求保存的共同回忆', pet_preference: '爸爸告诉你的偏好', user_fact: '爸爸明确要求记住的事实', reflection: '你自己的近期反思' };
  const lines = found.map((row) => `- [${memoryTime(row.created_at)}，${labels[row.kind] ?? '有来源的记忆'}；来源=${row.source}；可信度=${row.confidence}] ${row.content}`);
  return `\n\n以下是带来源标记的长期记忆。用户陈述不代表独立核实；自我反思也不代表外部事实。仅在相关时使用，不要编造记录外的经历：\n${lines.join('\n')}`;
}

function lifeSection(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'life_events'").get();
  if (!exists) return '';
  const rows = db.prepare("SELECT day, kind, content FROM life_events WHERE status = 'done' ORDER BY day DESC, kind DESC LIMIT 2").all();
  if (!rows.length) return '';
  const entries = rows.flatMap((row) => {
    try {
      const data = JSON.parse(row.content);
      const text = row.kind === 'explore' ? `心情：${data.mood}；思考的问题：${data.question}；初步想法：${data.thought}` : `心情：${data.mood}；日记：${data.diary}`;
      return [`- ${row.day} ${row.kind === 'explore' ? '小探索' : '短日记'}：${text}`];
    } catch { return []; }
  });
  return entries.length ? `\n\n以下是你实际保存的近期日常记录。可以自然地延续兴趣和心情，但不要编造记录外的行动：\n${entries.join('\n')}` : '';
}

function userFacingText(raw) {
  return raw.split(/\n\n\[(?:配图|动作)\]/u, 1)[0].trim();
}

export async function startBrain({ home, token, apiKey, personaPath, port = 3110, petPort = null, upstreamUrl = 'https://api.deepseek.com' }) {
  const db = openMemory(join(home, 'dafeiyu-memory.sqlite'));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname;
    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true, modelReady: Boolean(apiKey), memoryCount: db.prepare('SELECT COUNT(*) AS n FROM memories').get().n });
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      sendJson(res, 401, { error: { message: 'Unauthorized', type: 'authentication_error' } });
      return;
    }
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      sendJson(res, 200, { object: 'list', data: [{ id: 'deepseek-flash', object: 'model', owned_by: 'dafeiyu' }] });
      return;
    }
    if (req.method !== 'POST' || !['/v1/chat/completions', '/chat/completions'].includes(path)) {
      sendJson(res, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
      return;
    }
    if (!apiKey) {
      sendJson(res, 503, { error: { message: 'DeepSeek API key is not configured', type: 'configuration_error' } });
      return;
    }
    let body;
    try {
      body = await readJson(req);
      if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error('invalid-messages');
      if (body.messages.some((message) => !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) throw new Error('invalid-messages');
    } catch {
      sendJson(res, 400, { error: { message: 'Invalid request', type: 'invalid_request_error' } });
      return;
    }
    const connectScope = body.metadata?.connect;
    if (connectScope !== undefined && (!connectScope || connectScope.channel !== 'ilink' || !['owner','friend'].includes(connectScope.role) || (connectScope.input_kind !== undefined && !['text','voice'].includes(connectScope.input_kind)) || ['account_id','peer_id'].some(key => typeof connectScope[key] !== 'string' || !connectScope[key] || connectScope[key].length > 256))) {
      sendJson(res, 400, { error: { message: 'Invalid communication scope', type: 'invalid_request_error' } }); return;
    }
    const isFriend = connectScope?.role === 'friend';
    const isVoice = connectScope?.input_kind === 'voice';
    const provenance = isVoice ? {source:'user_voice_transcript',confidence:0.85} : {};
    const scopeNote = connectScope ? (isFriend
      ? '\n\n本轮是微信 Bot 的其他联系人，不是爸爸。只使用当前联系人提供的对话内容；系统没有提供爸爸的私人记忆或日记。不能替该联系人保存、修改或删除爸爸的记忆。不要称呼对方为爸爸。'
      : '\n\n本轮来自已经扫码绑定并获准的爸爸，通过微信 Bot 交流。可使用相关的爸爸记忆；你仍然是大肥鱼AI伙伴。') : '';
    const userText = userFacingText([...body.messages].reverse().find((message) => message.role === 'user')?.content ?? '');
    const correction = isFriend ? null : userText.match(/^(?:爸爸)?(?:请)?更正记忆\s*#?(\d+)[：:,，\s]+(.+)$/u);
    const forget = isFriend ? null : userText.match(/^(?:爸爸)?(?:请)?忘记记忆\s*#?(\d+)\s*$/u);
    let memoryActionNote = '';
    if (isVoice && (correction || forget)) {
      memoryActionNote = '本轮由语音识别得到，没有执行更正或删除记忆；为避免误识别，请爸爸改用文字确认编号与内容。';
    } else if (correction) {
      try {
        const result = reviseMemory(db, Number(correction[1]), correction[2]);
        memoryActionNote = result.changed ? '系统已成功更正指定记忆，并保留修订记录。' : '记忆内容未变化。';
      } catch (error) {
        console.error('[大肥鱼] 记忆纠正未执行：', error.message);
        memoryActionNote = `系统没有更正记忆：${error.message}`;
      }
    } else if (forget) {
      const removed = forgetMemory(db, Number(forget[1]));
      memoryActionNote = removed ? '系统已永久删除指定记忆及其修订记录。' : '系统没有找到该编号，未删除任何记忆。';
    }
    const baseSystem = body.messages.find((message) => message.role === 'system')?.content ?? '';
    const persona = personaPath ? readFileSync(personaPath, 'utf8') : '';
    const messages = [{ role: 'system', content: `${persona}\n\n${baseSystem}${memoryActionNote ? `\n\n本轮记忆操作结果：${memoryActionNote} 请只按此结果向爸爸确认。` : ''}${scopeNote}${isFriend ? '' : memorySection(db, userText)}${isFriend ? '' : lifeSection(db)}` }, ...body.messages.filter((message) => message.role !== 'system')];
    const requestId = randomUUID();
    const activity = classifyConversation(userText);
    const startActivity = !petPort ? Promise.resolve({ok:false}) : publishDesktopActivity({ db, home, port: petPort, eventKey: `${requestId}:start`, event: { source: 'conversation', activity: 'thinking', phase: 'start', bubble: false } }).catch(() => ({ ok: false }));
    const finishActivity = async (phase, selected = activity) => {
      if (!petPort) return;
      await startActivity;
      await publishDesktopActivity({
        db,
        home,
        port: petPort,
        eventKey: `${requestId}:${phase}`,
        event: { source: 'conversation', activity: selected, phase, bubble: false },
      }).catch(() => {});
    };
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const upstream = await fetch(`${upstreamUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ ...body, metadata: undefined, model: 'deepseek-flash', messages }),
        signal: controller.signal,
      });
      if (!upstream.ok) {
        const detail = (await upstream.text()).slice(0, 1000);
        void finishActivity('error', 'error');
        sendJson(res, upstream.status, { error: { message: detail || 'Upstream error', type: 'upstream_error' } });
        return;
      }
      if (!body.stream) {
        const data = await upstream.json();
        const answer = data.choices?.[0]?.message?.content;
        if (!isFriend && typeof answer === 'string' && answer.trim()) capture(db, userText, answer, provenance);
        if (typeof answer === 'string' && answer.trim()) void finishActivity('done');
        else void finishActivity('error', 'error');
        sendJson(res, 200, data);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      let answer = '';
      let pending = '';
      let completed = false;
      const decoder = new TextDecoder();
      for await (const chunk of upstream.body) {
        res.write(chunk);
        pending += decoder.decode(chunk, { stream: true });
        const blocks = pending.split(/\r?\n\r?\n/);
        pending = blocks.pop() ?? '';
        for (const block of blocks) {
          if (block.includes('data: [DONE]')) completed = true;
          answer += parseSseText(block);
        }
      }
      if (!isFriend && completed && answer.trim()) capture(db, userText, answer, provenance);
      if (completed && answer.trim()) void finishActivity('done');
      else void finishActivity('error', 'error');
      res.end();
    } catch (error) {
      void finishActivity('error', 'error');
      if (!res.headersSent) sendJson(res, 502, { error: { message: 'Model request failed', type: 'upstream_error' } });
      else res.end();
      if (error?.name !== 'AbortError') console.error('[大肥鱼] 模型连接失败：', error.message);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actualPort = server.address().port;
  return { port: actualPort, close: async () => { await new Promise((resolve) => server.close(resolve)); db.close(); } };
}
