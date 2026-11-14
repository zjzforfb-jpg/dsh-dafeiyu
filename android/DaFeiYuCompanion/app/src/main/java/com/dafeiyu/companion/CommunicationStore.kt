package com.dafeiyu.companion

import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject

object CommunicationStore {
    @Synchronized fun policy(context: Context): JSONObject = try { JSONObject(context.getSharedPreferences("communication", 0).getString("policy", "{}")!!) } catch (_: Exception) { JSONObject() }
    fun contact(context: Context, id: String): JSONObject? {
        val rows = policy(context).optJSONArray("contacts") ?: JSONArray()
        for (i in 0 until rows.length()) if (rows.getJSONObject(i).optString("id") == id) return rows.getJSONObject(i)
        return null
    }
    fun contactByTitle(context: Context, title: String): JSONObject? {
        val rows = policy(context).optJSONArray("contacts") ?: JSONArray()
        val matches = (0 until rows.length()).map { rows.getJSONObject(it) }.filter { it.optString("wechat_title") == title }
        return matches.singleOrNull()
    }
    @Synchronized fun applyPolicy(context: Context, input: JSONObject): Boolean {
        val rows = input.optJSONArray("contacts") ?: return false
        if (rows.length() > 100 || input.optLong("revision") < policy(context).optLong("revision")) return false
        val ids = mutableSetOf<String>(); val titles = mutableSetOf<String>()
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i)
            if (!Regex("[a-zA-Z0-9_-]{1,100}").matches(row.optString("id")) || row.optString("label").isBlank() || row.optString("wechat_title").isBlank() || row.optString("wechat_title").length > 100 || !ids.add(row.getString("id")) || !titles.add(row.getString("wechat_title"))) return false
        }
        return context.getSharedPreferences("communication", 0).edit().putString("policy", input.toString()).commit()
    }
    fun notificationAccess(context: Context): Boolean = context.getSystemService(NotificationManager::class.java)
        .isNotificationListenerAccessGranted(ComponentName(context, WechatNotifications::class.java))
    fun capabilities(context: Context, deviceId: String): JSONObject = JSONObject().put("type", "policy_ack").put("device_id", deviceId)
        .put("revision", policy(context).optLong("revision")).put("notification_access", notificationAccess(context))
        .put("overlay", Settings.canDrawOverlays(context)).put("listener_connected", WechatNotifications.instance != null).put("version", context.packageManager.getPackageInfo(context.packageName, 0).versionName)
    @Synchronized fun queue(context: Context, event: JSONObject) {
        val prefs = context.getSharedPreferences("event_outbox", 0)
        val seen = context.getSharedPreferences("event_seen", 0)
        val now = System.currentTimeMillis()
        val old = seen.all.filterValues { (it as? Long ?: 0L) < now - 86400000 }.keys
        val edit = seen.edit(); old.forEach { edit.remove(it) }; edit.commit()
        val id = event.getString("id")
        if (seen.contains(id) || prefs.all.size >= 200) return
        event.put("queued_at", now)
        if (prefs.edit().putString(id, event.toString()).commit()) seen.edit().putLong(id, now).commit()
        ConnectService.instance?.eventsChanged()
    }
    @Synchronized fun pending(context: Context): List<JSONObject> {
        val prefs = context.getSharedPreferences("event_outbox", 0)
        val output = mutableListOf<JSONObject>()
        val allowed = captureEnabled(context) && notificationAccess(context)
        for ((id, raw) in prefs.all) try {
            val event = JSONObject(raw as String)
            if (event.optLong("queued_at") < System.currentTimeMillis() - 86400000 || (event.optString("event") == "wechat.notification" && (!allowed || contact(context,event.getJSONObject("payload").getString("contact_id")) == null))) prefs.edit().remove(id).commit()
            else output.add(event)
        } catch (_: Exception) { prefs.edit().remove(id).commit() }
        return output
    }
    @Synchronized fun acknowledge(context: Context, id: String) { context.getSharedPreferences("event_outbox", 0).edit().remove(id).commit() }
    @Synchronized fun clearPending(context: Context) { context.getSharedPreferences("event_outbox", 0).edit().clear().commit() }
    fun setCapture(context: Context, enabled: Boolean) { context.getSharedPreferences("communication", 0).edit().putBoolean("capture", enabled).commit() }
    fun captureEnabled(context: Context) = context.getSharedPreferences("communication", 0).getBoolean("capture", false)
}
