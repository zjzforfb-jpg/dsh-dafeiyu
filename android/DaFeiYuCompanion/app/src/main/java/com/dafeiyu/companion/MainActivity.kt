package com.dafeiyu.companion

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.*

class MainActivity : Activity() {
    companion object { var resumed: MainActivity? = null }
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var status: TextView
    private val refresh = object : Runnable {
        override fun run() {
            status.text = "${ConnectService.status}\n\n后台打开应用：${if (Settings.canDrawOverlays(this@MainActivity)) "已授权" else "需将本页保持前台，或授权悬浮窗"}\n\n微信通知：${if (CommunicationStore.notificationAccess(this@MainActivity)) "已授权" else "等待授权"} · 白名单 ${CommunicationStore.policy(this@MainActivity).optJSONArray("contacts")?.length() ?: 0} 人\n\n白名单由爸爸在 Mac 配置。匹配联系人发来的通知进入本地收件箱，可由爸爸打开对应会话。"
            handler.postDelayed(this, 1000)
        }
    }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
        window.decorView.systemUiVisibility = android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(24), dp(24), dp(24)) }
        layout.addView(TextView(this).apply { text = "大肥鱼 Connect"; textSize = 26f; setTextColor(android.graphics.Color.rgb(23, 50, 74)); setTypeface(null, android.graphics.Typeface.BOLD) })
        layout.addView(TextView(this).apply { text = "通信终端 0.2 · 荣耀 Magic5"; textSize = 14f; setPadding(0, dp(8), 0, dp(24)) })
        status = TextView(this).apply { textSize = 16f; setTextColor(android.graphics.Color.rgb(40, 55, 66)) }
        layout.addView(status)
        layout.addView(Button(this).apply { text = "连接爸爸的 Mac"; setOnClickListener { startForegroundService(Intent(this@MainActivity, ConnectService::class.java)) } })
        layout.addView(Button(this).apply { text = "断开连接"; setOnClickListener { CommunicationStore.setCapture(this@MainActivity, false); CommunicationStore.clearPending(this@MainActivity); stopService(Intent(this@MainActivity, ConnectService::class.java)) } })
        layout.addView(Button(this).apply { text = "允许后台打开应用（可选）"; setOnClickListener { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))) } })
        layout.addView(Button(this).apply { text = "授权读取白名单微信通知"; setOnClickListener {
            if (android.os.Build.VERSION.SDK_INT >= 30) startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, android.content.ComponentName(this@MainActivity, WechatNotifications::class.java).flattenToString()))
            else startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        } })
        layout.addView(Button(this).apply { text = "打开微信"; setOnClickListener {
            val intent = packageManager.getLaunchIntentForPackage("com.tencent.mm")
            if (intent != null) startActivity(intent) else Toast.makeText(this@MainActivity, "微信未安装", Toast.LENGTH_SHORT).show()
        } })
        layout.addView(TextView(this).apply { text = "USB 开发模式：仅连接本机调试隧道。可随时断开。通知仅接收白名单匹配项。电话、麦克风尚未接入；此版本不自动发送微信消息。"; textSize = 15f })
        val scroll = ScrollView(this).apply { setBackgroundColor(android.graphics.Color.rgb(248, 250, 252)); addView(layout) }
        scroll.setOnApplyWindowInsetsListener { view, insets ->
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars())
                view.setPadding(0, bars.top, 0, bars.bottom)
            } else view.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom)
            insets
        }
        setContentView(scroll)
        if (java.io.File(filesDir, "pairing.json").exists()) startForegroundService(Intent(this, ConnectService::class.java))
        if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
    }
    override fun onResume() { super.onResume(); resumed = this; handler.post(refresh); ConnectService.instance?.eventsChanged() }
    override fun onPause() { resumed = null; handler.removeCallbacks(refresh); super.onPause() }
}
