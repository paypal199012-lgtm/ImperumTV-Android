package tv.imperum.app

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.BitmapFactory
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Support-Chat: Antworten vom Support auch dann melden, wenn ImperumTV zu ist.
 *
 * Ein kleiner Dienst in einem eigenen Prozess (":push", braucht kaum Speicher) hält eine Verbindung zum
 * Sofort-Hinweis des Servers (Supabase Realtime, derselbe Kanal wie in der App). Kommt ein Hinweis,
 * holt er die neuen Nachrichten und zeigt eine Benachrichtigung – auf Fire TV als Banner oben rechts.
 * Zusätzlich wird alle 15 Minuten nachgesehen, falls die Verbindung einmal abreißt.
 * Ist die App gerade offen, zeigt sie die Nachricht selbst (dann keine Benachrichtigung).
 */
object ChatPush {
    const val PREFS = "chatpush"
    const val EXTRA_OPEN_CHAT = "imptv.openChat"
    const val CH_MSG = "chat_msgs"
    const val CH_BG = "chat_bg"
    const val NOTE_BG = 4801
    const val NOTE_MSG = 4802

    fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun configured(ctx: Context): Boolean {
        val p = prefs(ctx)
        return p.getString("mac", "").orEmpty().isNotBlank() && p.getString("key", "").orEmpty().isNotBlank() &&
            p.getString("url", "").orEmpty().isNotBlank() && p.getBoolean("on", true)
    }

    /** Aus der App: Zugangsdaten + Texte übergeben und den Dienst starten (läuft im Prozess :push) */
    fun configure(ctx: Context, cfg: JSONObject) {
        val i = Intent(ctx, ChatPushService::class.java).setAction("config").putExtra("cfg", cfg.toString())
        startService(ctx, i)
        arm(ctx)
    }

    /** Aus der App: Nachrichten bis zu dieser Nummer hat der Kunde in der App gesehen */
    fun seen(ctx: Context, id: Long) {
        startService(ctx, Intent(ctx, ChatPushService::class.java).setAction("seen").putExtra("id", id), quiet = true)
    }

    /** Aus der App: sichtbar ja/nein (sichtbar = keine Benachrichtigung, die App zeigt es selbst) */
    fun visible(ctx: Context, on: Boolean) {
        startService(ctx, Intent(ctx, ChatPushService::class.java).setAction(if (on) "fg" else "bg"), quiet = true)
    }

    fun startService(ctx: Context, i: Intent, quiet: Boolean = false) {
        try {
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        } catch (e: Throwable) {
            // Android 12+: aus dem Hintergrund nicht erlaubt – dann übernimmt der 15-Minuten-Wecker
            if (!quiet) try { if (Build.VERSION.SDK_INT >= 26) ctx.startService(i) } catch (e2: Throwable) { }
        }
    }

    /** Absicherung: alle 15 Minuten wecken (Dienst neu starten bzw. direkt nachsehen) */
    fun arm(ctx: Context) {
        try {
            val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val i = Intent(ctx, ChatPushAlarm::class.java)
            var fl = PendingIntent.FLAG_UPDATE_CURRENT
            if (Build.VERSION.SDK_INT >= 23) fl = fl or PendingIntent.FLAG_IMMUTABLE
            val pi = PendingIntent.getBroadcast(ctx, 4803, i, fl)
            am.setInexactRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + AlarmManager.INTERVAL_FIFTEEN_MINUTES,
                AlarmManager.INTERVAL_FIFTEEN_MINUTES, pi)
        } catch (e: Throwable) { }
    }

    val json = "application/json".toMediaType()

    /** Neue Nachrichten vom Support holen und melden. Läuft im Hintergrund-Thread. */
    fun check(ctx: Context, http: OkHttpClient, appVisible: Boolean) {
        val p = prefs(ctx)
        val url = p.getString("url", "").orEmpty(); val apikey = p.getString("apikey", "").orEmpty()
        val mac = p.getString("mac", "").orEmpty(); val key = p.getString("key", "").orEmpty()
        if (url.isBlank() || mac.isBlank() || key.isBlank()) return
        val after = maxOf(p.getLong("seen", 0L), p.getLong("notified", 0L))
        val body = JSONObject().put("p_mac", mac).put("p_key", key).put("p_after", after).put("p_read", false).toString()
        val req = Request.Builder().url(url.trimEnd('/') + "/rest/v1/rpc/device_chat_get")
            .header("apikey", apikey).header("Content-Type", "application/json")
            .post(body.toRequestBody(json)).build()
        val r = try { http.newCall(req).execute().use { if (it.isSuccessful) JSONObject(it.body?.string() ?: "{}") else null } } catch (e: Throwable) { null } ?: return
        if (!r.optBoolean("ok")) return
        val msgs = r.optJSONArray("msgs") ?: return
        var maxId = after
        val fresh = ArrayList<String>()
        for (i in 0 until msgs.length()) {
            val m = msgs.optJSONObject(i) ?: continue
            val id = m.optLong("id")
            if (id <= after) continue
            if (id > maxId) maxId = id
            if (m.optBoolean("a") && !m.optBoolean("r")) fresh.add(m.optString("t"))
        }
        if (maxId > after) p.edit().putLong("notified", maxId).apply()
        if (fresh.isEmpty() || appVisible) return
        notifyMsg(ctx, fresh)
    }

    private fun notifyMsg(ctx: Context, texts: List<String>) {
        val p = prefs(ctx)
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val title = p.getString("tTitle", null) ?: "Neue Nachricht vom Support"
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH_MSG) == null) {
            val ch = NotificationChannel(CH_MSG, p.getString("tChannel", null) ?: "Support-Chat", NotificationManager.IMPORTANCE_HIGH)
            ch.enableVibration(true)
            nm.createNotificationChannel(ch)
        }
        val text = texts.last()
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, CH_MSG) else @Suppress("DEPRECATION") Notification.Builder(ctx)
        b.setSmallIcon(android.R.drawable.sym_action_chat)
            .setContentTitle(if (texts.size > 1) "$title (${texts.size})" else title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openChatIntent(ctx))
            .setCategory(Notification.CATEGORY_MESSAGE)
        try { b.setLargeIcon(BitmapFactory.decodeResource(ctx.resources, R.drawable.ic_launcher)) } catch (e: Throwable) { }
        if (Build.VERSION.SDK_INT < 26) {
            @Suppress("DEPRECATION") b.setPriority(Notification.PRIORITY_HIGH)
            @Suppress("DEPRECATION") b.setDefaults(Notification.DEFAULT_ALL)
        }
        try { nm.notify(NOTE_MSG, b.build()) } catch (e: Throwable) { }
    }

    fun openChatIntent(ctx: Context): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).putExtra(EXTRA_OPEN_CHAT, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        var fl = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= 23) fl = fl or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getActivity(ctx, 4804, i, fl)
    }

    fun cancelMsg(ctx: Context) {
        try { (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTE_MSG) } catch (e: Throwable) { }
    }
}

/** Läuft dauerhaft im Vordergrund (eigener, kleiner Prozess) und hält die Sofort-Verbindung */
class ChatPushService : Service() {
    private val exec = Executors.newSingleThreadScheduledExecutor()
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true).build()
    private var ws: WebSocket? = null
    private var beat: ScheduledFuture<*>? = null
    private var tries = 0
    private var ref = 1
    @Volatile private var appVisible = false
    @Volatile private var connecting = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        goForeground()
        // Absicherung: alle 15 Minuten nachsehen, auch wenn die Verbindung steht
        exec.scheduleWithFixedDelay({ safeCheck() }, 15, 15, TimeUnit.MINUTES)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        goForeground()
        val p = ChatPush.prefs(this)
        when (intent?.action) {
            "config" -> {
                try {
                    val c = JSONObject(intent.getStringExtra("cfg") ?: "{}")
                    val e = p.edit()
                    val oldDev = p.getString("mac", "") + "|" + p.getString("key", "")
                    for (k in listOf("url", "apikey", "mac", "key", "tTitle", "tChannel", "tBg")) if (c.has(k)) e.putString(k, c.optString(k))
                    if (c.has("on")) e.putBoolean("on", c.optBoolean("on", true))
                    val newDev = c.optString("mac") + "|" + c.optString("key")
                    if (oldDev != newDev) e.putLong("notified", 0L).putLong("seen", 0L)
                    if (c.has("seen")) e.putLong("seen", maxOf(c.optLong("seen"), if (oldDev != newDev) 0L else p.getLong("seen", 0L)))
                    e.apply()
                    if (oldDev != newDev) exec.execute { reconnect(0) }
                } catch (e: Throwable) { }
                appVisible = true
                goForeground()
            }
            "seen" -> {
                val id = intent.getLongExtra("id", 0L)
                if (id > p.getLong("seen", 0L)) p.edit().putLong("seen", id).apply()
                ChatPush.cancelMsg(this)
            }
            "fg" -> { appVisible = true; ChatPush.cancelMsg(this) }
            "bg" -> appVisible = false
            "check" -> exec.execute { safeCheck() }
        }
        if (!ChatPush.configured(this)) { stopSelf(); return START_NOT_STICKY }
        if (ws == null && !connecting) exec.execute { connect() }
        return START_STICKY
    }

    private fun goForeground() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val p = ChatPush.prefs(this)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(ChatPush.CH_BG) == null) {
            val ch = NotificationChannel(ChatPush.CH_BG, p.getString("tBg", null) ?: "Support erreichbar", NotificationManager.IMPORTANCE_MIN)
            ch.setShowBadge(false)
            nm.createNotificationChannel(ch)
        }
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, ChatPush.CH_BG) else @Suppress("DEPRECATION") Notification.Builder(this)
        b.setSmallIcon(android.R.drawable.sym_action_chat)
            .setContentTitle("ImperumTV")
            .setContentText(p.getString("tBg", null) ?: "Support erreichbar")
            .setOngoing(true)
            .setContentIntent(ChatPush.openChatIntent(this))
        if (Build.VERSION.SDK_INT < 26) @Suppress("DEPRECATION") b.setPriority(Notification.PRIORITY_MIN)
        val n = b.build()
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(ChatPush.NOTE_BG, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
            else startForeground(ChatPush.NOTE_BG, n)
        } catch (e: Throwable) { }
    }

    private fun topic(): String {
        val p = ChatPush.prefs(this)
        val mac = p.getString("mac", "").orEmpty().lowercase().replace(Regex("[^0-9a-f]"), "")
        return "realtime:imp-$mac-" + p.getString("key", "").orEmpty().trim()
    }

    private fun connect() {
        if (ws != null || connecting || !ChatPush.configured(this)) return
        connecting = true
        val p = ChatPush.prefs(this)
        val base = p.getString("url", "").orEmpty().trimEnd('/').replaceFirst("http", "ws")
        val req = try {
            Request.Builder().url("$base/realtime/v1/websocket?apikey=" + java.net.URLEncoder.encode(p.getString("apikey", ""), "UTF-8") + "&vsn=1.0.0").build()
        } catch (e: Throwable) { connecting = false; return }
        val t = topic()
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                connecting = false; tries = 0
                send(webSocket, JSONObject().put("topic", t).put("event", "phx_join")
                    .put("payload", JSONObject().put("config", JSONObject().put("broadcast", JSONObject().put("self", false)).put("private", false))))
                beat?.cancel(false)
                beat = exec.scheduleWithFixedDelay({ send(webSocket, JSONObject().put("topic", "phoenix").put("event", "heartbeat").put("payload", JSONObject())) },
                    25, 25, TimeUnit.SECONDS)
                exec.execute { safeCheck() }     // verpasste Nachrichten (während keine Verbindung war)
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = try { JSONObject(text) } catch (e: Throwable) { return }
                if (m.optString("topic") == t && m.optString("event") == "broadcast") {
                    val ev = m.optJSONObject("payload")?.optString("event") ?: ""
                    if (ev != "lic") exec.execute { safeCheck() }
                }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { dropped(webSocket) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { dropped(webSocket) }
        })
    }

    private fun send(w: WebSocket, o: JSONObject) {
        try { w.send(o.put("ref", (ref++).toString()).toString()) } catch (e: Throwable) { }
    }

    private fun dropped(w: WebSocket) {
        if (ws !== w) return
        ws = null; connecting = false
        beat?.cancel(false)
        val wait = minOf(300L, 5L * (1L shl minOf(tries++, 6)))     // 5 s, 10 s, 20 s … höchstens 5 Minuten
        reconnect(wait)
    }

    private fun reconnect(waitSec: Long) {
        try { ws?.cancel() } catch (e: Throwable) { }
        ws = null; connecting = false
        try { exec.schedule({ connect() }, waitSec, TimeUnit.SECONDS) } catch (e: Throwable) { }
    }

    private fun safeCheck() {
        try { ChatPush.check(this, http, appVisible) } catch (e: Throwable) { }
    }

    override fun onDestroy() {
        try { ws?.close(1000, null) } catch (e: Throwable) { }
        try { exec.shutdownNow() } catch (e: Throwable) { }
        super.onDestroy()
    }
}

/** Wecker (alle 15 Minuten) und Neustart des Geräts: Dienst wieder starten, notfalls direkt nachsehen */
class ChatPushAlarm : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!ChatPush.configured(context)) return
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) ChatPush.arm(context)
        val i = Intent(context, ChatPushService::class.java).setAction("check")
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i) else context.startService(i)
        } catch (e: Throwable) {
            // Dienst darf gerade nicht starten (Android 12+ aus dem Hintergrund): direkt hier nachsehen
            val pending = goAsync()
            Thread {
                try { ChatPush.check(context, OkHttpClient(), false) } catch (e2: Throwable) { }
                pending.finish()
            }.start()
        }
    }
}
