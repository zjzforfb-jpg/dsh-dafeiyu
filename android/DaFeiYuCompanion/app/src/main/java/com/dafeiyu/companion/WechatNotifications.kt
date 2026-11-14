package com.dafeiyu.companion

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant

class WechatNotifications : NotificationListenerService() {
    private data class Target(val contactId: String, val intent: PendingIntent, val time: Long)
    companion object {
        var instance: WechatNotifications? = null
        private val targets = mutableMapOf<String, Target>()
        @Synchronized fun open(context: Context, eventId: String, contactId: String): String {
            if (!CommunicationStore.notificationAccess(context) || !CommunicationStore.captureEnabled(context)) return "notification_access_required"
            val target = targets[eventId] ?: return "notification_expired"
            if (target.contactId != contactId || CommunicationStore.contact(context, contactId) == null) return "contact_not_allowed"
            if (System.currentTimeMillis() - target.time > 1800000) { targets.remove(eventId); return "notification_expired" }
            if (MainActivity.resumed == null) return "needs_companion_foreground"
            return try { target.intent.send(); "open_requested" } catch (_: Exception) { "notification_open_failed" }
        }
    }
    override fun onListenerConnected() { super.onListenerConnected(); instance = this; ConnectService.instance?.eventsChanged() }
    override fun onListenerDisconnected() { instance = null; super.onListenerDisconnected(); ConnectService.instance?.eventsChanged() }
    fun scanAllowedActive() {
        if (!CommunicationStore.captureEnabled(this) || !CommunicationStore.notificationAccess(this)) return
        activeNotifications.filter { it.packageName == "com.tencent.mm" }.forEach { onNotificationPosted(it) }
    }
    override fun onDestroy() { if (instance === this) instance = null; super.onDestroy() }
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (!CommunicationStore.captureEnabled(this) || sbn.packageName != "com.tencent.mm" || sbn.user != android.os.Process.myUserHandle()) return
        val note = sbn.notification
        if (note.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        val style = try { Notification.Builder.recoverBuilder(this, note).style as? Notification.MessagingStyle } catch (_: Exception) { null }
        if (style?.isGroupConversation == true || note.extras.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false)) return
        val title = note.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim() ?: return
        val contact = CommunicationStore.contactByTitle(this, title) ?: return
        val latest = style?.messages?.lastOrNull()
        val sender = latest?.senderPerson?.name?.toString()
        if (sender != null && sender != title) return
        val text = (latest?.text ?: note.extras.getCharSequence(Notification.EXTRA_TEXT))?.toString()?.trim() ?: return
        val aggregateCount = WechatPreview.aggregateCount(title, text) ?: return
        val occurred = latest?.timestamp ?: sbn.postTime
        if (kotlin.math.abs(System.currentTimeMillis() - occurred) > 86400000) return
        val rawId = "${sbn.key}|$occurred|$text"
        val id = MessageDigest.getInstance("SHA-256").digest(rawId.toByteArray()).joinToString("") { "%02x".format(it) }
        val intent = note.contentIntent?.takeIf { it.creatorPackage == "com.tencent.mm" }
        synchronized(Companion) {
            targets.entries.removeAll { System.currentTimeMillis() - it.value.time > 1800000 }
            if (intent != null) { if (targets.size >= 200) targets.clear(); targets[id] = Target(contact.getString("id"), intent, System.currentTimeMillis()) }
        }
        val payload = JSONObject().put("contact_id", contact.getString("id")).put("title", title).put("text", text)
            .put("group", false).put("aggregate_count", aggregateCount).put("policy_revision", CommunicationStore.policy(this).optLong("revision"))
            .put("occurred_at", Instant.ofEpochMilli(occurred).toString()).put("can_open", intent != null)
        CommunicationStore.queue(this, JSONObject().put("type", "event").put("id", id).put("event", "wechat.notification").put("payload", payload))
    }
}
