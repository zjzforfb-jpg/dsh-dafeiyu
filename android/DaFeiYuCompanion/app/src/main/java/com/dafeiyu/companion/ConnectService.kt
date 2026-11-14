package com.dafeiyu.companion

import android.app.*
import android.content.Intent
import android.os.*
import android.provider.Settings
import okhttp3.*
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.concurrent.TimeUnit

class ConnectService : Service() {
    companion object { var status = "尚未连接"; var instance: ConnectService? = null }
    private val handler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build()
    private var socket: WebSocket? = null
    private var stopped = false
    private var retry = 1000L
    private var generation = 0
    private var deviceId = ""
    private var lastAck = 0L
    private val history by lazy { getSharedPreferences("commands", MODE_PRIVATE) }
    private val heartbeat = object : Runnable {
        override fun run() {
            if (stopped) return
            if (socket != null && System.currentTimeMillis() - lastAck > 45000) socket?.cancel()
            socket?.send(JSONObject().put("type", "heartbeat").put("device_id", deviceId).toString())
            flushEvents()
            socket?.send(CommunicationStore.capabilities(this@ConnectService, deviceId).toString())
            handler.postDelayed(this, 10000)
        }
    }
    override fun onBind(intent: Intent?) = null
    override fun onCreate() {
        super.onCreate()
        instance = this
        CommunicationStore.setCapture(this, true)
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("connect", "大肥鱼通信连接", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        startForeground(1, Notification.Builder(this, "connect").setSmallIcon(android.R.drawable.stat_notify_sync).setOngoing(true).setContentTitle("大肥鱼 Connect").setContentText("与爸爸的 Mac 保持连接").setContentIntent(open).build())
        deviceId = try { JSONObject(File(filesDir, "pairing.json").readText()).getString("device_id") } catch (_: Exception) { "" }
        // Never repeat an action that may have executed before a process crash.
        for ((id, value) in history.all) {
            try { if (JSONObject(value as String).optString("state") == "executing") history.edit().putString(id, result(id, false, "unknown_after_restart").toString()).commit() } catch (_: Exception) {}
        }
        if (CommunicationStore.notificationAccess(this)) android.service.notification.NotificationListenerService.requestRebind(android.content.ComponentName(this, WechatNotifications::class.java))
        connect()
        handler.post(heartbeat)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY
    private fun connect() {
        if (stopped) return
        val cfg = try { JSONObject(File(filesDir, "pairing.json").readText()) } catch (_: Exception) { status = "等待 Mac 配对配置"; schedule(); return }
        deviceId = cfg.getString("device_id")
        val url = cfg.getString("url")
        if (url != "ws://127.0.0.1:8765/device") { status = "未允许的连接地址"; return }
        status = "正在连接 Mac…"
        val epoch = ++generation
        socket = client.newWebSocket(Request.Builder().url(url).header("X-Device-Id", deviceId).header("Authorization", "Bearer ${cfg.getString("token")}").build(), object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) { handler.post {
                if (stopped || epoch != generation) { ws.close(1000, null); return@post }
                socket = ws; retry = 1000; lastAck = System.currentTimeMillis(); status = "已连接，等待注册确认"
                ws.send(JSONObject().put("type", "register").put("device_id", deviceId).put("model", "${Build.MANUFACTURER} ${Build.MODEL}").toString())
                for ((_, value) in history.all) try { val row = JSONObject(value as String); if (row.optString("type") == "result") ws.send(row.toString()) } catch (_: Exception) {}
            } }
            override fun onMessage(ws: WebSocket, text: String) { handler.post {
                if (epoch != generation || stopped) return@post
                try {
                    val value = JSONObject(text)
                    when (value.optString("type")) {
                        "ack" -> { lastAck = System.currentTimeMillis(); status = "在线 · 心跳正常" }
                        "policy" -> {
                            if (CommunicationStore.applyPolicy(this@ConnectService, value)) {
                                ws.send(CommunicationStore.capabilities(this@ConnectService, deviceId).toString()); flushEvents()
                            }
                        }
                        "event_ack" -> CommunicationStore.acknowledge(this@ConnectService, value.getString("id"))
                        "result_ack" -> { /* Keep deduplication receipts across reconnect and process restart. */ }
                        "command" -> execute(ws, value)
                    }
                } catch (_: Exception) { status = "收到无效命令" }
            } }
            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) { handler.post { if (epoch == generation && !stopped) { socket = null; status = "连接中断，正在重连"; schedule() } } }
            override fun onClosed(ws: WebSocket, code: Int, reason: String) { handler.post { if (epoch == generation && !stopped) { socket = null; status = "连接已关闭，正在重连"; schedule() } } }
            override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, null) }
        })
    }
    fun eventsChanged() { handler.post { flushEvents(); socket?.send(CommunicationStore.capabilities(this, deviceId).toString()) } }
    private fun flushEvents() {
        for (event in CommunicationStore.pending(this)) socket?.send(event.put("device_id", deviceId).toString())
    }
    private fun schedule() { handler.postDelayed({ connect() }, retry); retry = (retry * 2).coerceAtMost(30000) }
    private fun result(id: String, ok: Boolean, code: String) = JSONObject().put("type", "result").put("id", id).put("device_id", deviceId).put("ok", ok).put("result", JSONObject().put("code", code).put("at", Instant.now().toString()))
    private fun execute(ws: WebSocket, cmd: JSONObject) {
        val id = cmd.getString("id")
        if (!Regex("[a-zA-Z0-9_-]{1,100}").matches(id) || cmd.optString("device_id") != deviceId) return
        val previous = history.getString(id, null)
        if (previous != null) { val cached = JSONObject(previous); ws.send(if (cached.optString("state") == "executing") result(id, false, "unknown_execution").toString() else previous); return }
        var ok = false
        var code = "unsupported_action"
        if (Instant.parse(cmd.getString("expires_at")).toEpochMilli() <= System.currentTimeMillis()) code = "expired"
        else {
            history.edit().putString(id, JSONObject().put("state", "executing").toString()).commit()
            try {
                when (cmd.getString("action")) {
                    "device.diagnostic" -> {
                        CommunicationStore.queue(this, JSONObject().put("type", "event").put("id", java.util.UUID.randomUUID().toString()).put("event", "device.diagnostic").put("payload", JSONObject()))
                        ok = true; code = "diagnostic_queued"
                    }
                    "device.capabilities" -> { ok = true; code = "capabilities" }
                    "wechat.scan_notifications" -> {
                        val listener = WechatNotifications.instance
                        if (listener == null || !CommunicationStore.notificationAccess(this)) code = "notification_listener_unavailable"
                        else { listener.scanAllowedActive(); ok = true; code = "scan_completed" }
                    }
                    "wechat.open_notification" -> {
                        val payload = cmd.getJSONObject("payload")
                        code = WechatNotifications.open(this, payload.getString("event_id"), payload.getString("contact_id"))
                        ok = code == "open_requested"
                    }
                    "device.ping" -> { ok = true; code = "pong" }
                    "app.launch" -> {
                        val apps = mapOf("settings" to "com.android.settings", "wechat" to "com.tencent.mm", "douyin" to "com.ss.android.ugc.aweme", "companion" to packageName)
                        val target = apps[cmd.getJSONObject("payload").getString("app")]
                        if (target == null) code = "app_not_allowed"
                        else {
                            val launch = packageManager.getLaunchIntentForPackage(target)
                            if (launch == null) code = "app_not_installed"
                            else {
                                val activity = MainActivity.resumed
                                if (activity != null) { activity.startActivity(launch); ok = true; code = "launch_requested" }
                                else if (Settings.canDrawOverlays(this)) { launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(launch); ok = true; code = "launch_requested" }
                                else code = "needs_foreground_or_overlay_permission"
                            }
                        }
                    }
                }
            } catch (_: Exception) { code = "execution_failed" }
        }
        val response = result(id, ok, code)
        if (cmd.optString("action") == "device.capabilities") response.getJSONObject("result").put("capabilities", CommunicationStore.capabilities(this, deviceId))
        history.edit().putString(id, response.toString()).commit()
        ws.send(response.toString())
        status = "在线 · 最近结果：$code"
    }
    override fun onDestroy() {
        instance = null; stopped = true; generation++; handler.removeCallbacksAndMessages(null); socket?.close(1000, "user disconnected"); client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll(); status = "已断开"; super.onDestroy()
    }
}
