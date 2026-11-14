# 桌面消息中心（Connect M4）

大肥鱼在桌面上只显示短气泡（前 40 字），完整对话在消息中心页里看。这让「桌宠不挡桌面」和「信息不丢」同时成立。

## 打开

```bash
npm run connect:messages
# 打印 http://127.0.0.1:8765/messages?token=<adminToken>
```

- `GET /messages` 是静态页，不鉴权；页面里的数据请求带 `?token=` 换来的 `Authorization: Bearer`。
- `GET /messages/feed?limit=60` 需要 admin token，返回微信（iLink）+ QQ 两条通道合并后的时间流。

## 数据口径

| 来源 | 表 |
| --- | --- |
| QQ 私聊/群聊 | `qq_messages`（含 held/ignored/failed 状态） |
| 微信 iLink | `ilink_messages` |
| 通话 | 暂不落库（CallService 内存里保留最近 16 轮） |

每条入站消息显示「谁 → 大肥鱼」，`status` 原样展示（`sent`/`held`/`ignored`/`failed`），出站是 17:xx 的蓝色气泡。语音输入会带 🎤 标记。

## 气泡可点开

桌宠广播的 `broadcast` 接口支持 `url` 字段：气泡会变成可点链接，点了用系统浏览器打开消息中心（`desktop/activity.mjs` 只放行 http/https，最长 500 字符）。

- 「爸爸：…」气泡 → 点开看全文；
- 「大肥鱼：…」气泡 → 同样可点。

限制：40 字是气泡里的展示截断，消息中心里是原文；微信通道的气泡暂时还没挂 url（要改 `connect/ilink` 的发布点），QQ 通道已经生效。

## 排障

| 现象 | 处理 |
| --- | --- |
| 页面一直「加载中」 | token 不对，重新 `npm run connect:messages` |
| 点气泡没反应 | 确认 dsh-pet 在运行、`broadcast` 返回 `ok:true`；看 `desktop_activity_events.delivery_error` |
| 消息中心没有微信消息 | 微信 iLink 未登录或没有新消息；先 `npm run connect.mjs ilink status` |
