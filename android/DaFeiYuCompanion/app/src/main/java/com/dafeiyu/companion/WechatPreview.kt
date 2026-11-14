package com.dafeiyu.companion

object WechatPreview {
    /** A WeChat unread summary is still a notification preview, not a verified chat message. */
    fun aggregateCount(title: String, text: String): Int? {
        if (text.isBlank() || text.length > 4000) return null
        if (!Regex("^\\[?\\d+条").containsMatchIn(text)) return 1
        val match = Regex("^\\[(\\d+)条\\]([^:：]+)[:：]\\s*(.+)$").matchEntire(text) ?: return null
        if (match.groupValues[2] != title) return null
        return match.groupValues[1].toIntOrNull()?.takeIf { it in 1..10000 }
    }
}
