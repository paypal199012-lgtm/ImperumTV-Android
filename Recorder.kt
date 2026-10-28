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
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Environment
import android.os.IBinder
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Aufnahmen: planen, zur richtigen Zeit starten, Stream in eine Datei speichern.
 * Alle Aufnahmen stehen als JSON-Liste in den SharedPreferences.
 */
object Recorder {
    private const val PREFS = "recordings"
    private const val KEY = "list"
    const val USER_AGENT = "ImperumTV/1.0 (Android)"
    private val lock = Any()

    // ---------- Liste speichern / laden ----------

    fun all(ctx: Context): JSONArray = synchronized(lock) {
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "[]") ?: "[]"
        try { JSONArray(raw) } catch (e: Exception) { JSONArray() }
    }

    private fun save(ctx: Context, list: JSONArray) = synchronized(lock) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, list.toString()).apply()
    }

    fun find(ctx: Context, id: String): JSONObject? {
        val list = all(ctx)
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            if (o.optString("id") == id) return o
        }
        return null
    }

    fun update(ctx: Context, id: String, change: (JSONObject) -> Unit) = synchronized(lock) {
        val list = all(ctx)
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            if (o.optString("id") == id) { change(o); break }
        }
        save(ctx, list)
    }

    private fun remove(ctx: Context, id: String) = synchronized(lock) {
        val list = all(ctx)
        val out = JSONArray()
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            if (o.optString("id") != id) out.put(o)
        }
        save(ctx, out)
    }

    // ---------- Planen, abbrechen, löschen ----------

    /** Neue Aufnahme planen. Rückgabe: Nummer der Aufnahme oder "!Fehlertext" */
    fun schedule(ctx: Context, json: String): String {
        val input = try { JSONObject(json) } catch (e: Exception) { return "!Ungültige Angaben" }
        val start = input.optLong("start")
        val end = input.optLong("end")
        val url = input.optString("url")
        if (url.isBlank() || end <= start || end <= System.currentTimeMillis()) return "!Die Sendung ist schon vorbei."
        if (end - start > 6 * 3600_000L) return "!Eine Aufnahme darf höchstens 6 Stunden lang sein."

        // Gleiche Sendung schon geplant?
        val list = all(ctx)
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            if (o.optString("url") == url && o.optLong("start") == start &&
                (o.optString("status") == "scheduled" || o.optString("status") == "recording")) {
                return o.optString("id")
            }
        }
        val id = "r" + System.currentTimeMillis()
        val item = JSONObject()
        item.put("id", id)
        item.put("channelId", input.optLong("channelId"))
        item.put("channel", input.optString("channel"))
        item.put("title", input.optString("title").ifBlank { input.optString("channel") })
        item.put("url", url)
        item.put("start", start)
        item.put("end", end)
        // Beginn/Ende der Sendung laut Programm (zum Markieren im EPG)
        item.put("progStart", input.optLong("progStart", start))
        item.put("progEnd", input.optLong("progEnd", end))
        item.put("status", "scheduled")
        item.put("size", 0L)
        synchronized(lock) {
            val fresh = all(ctx)
            fresh.put(item)
            save(ctx, fresh)
        }
        arm(ctx, item)
        return id
    }

    /** Geplante Aufnahme absagen, laufende stoppen */
    fun cancel(ctx: Context, id: String) {
        val item = find(ctx, id) ?: return
        when (item.optString("status")) {
            "scheduled" -> { disarm(ctx, id); remove(ctx, id) }
            "recording" -> RecordingService.stop(ctx, id)
        }
    }

    /** Fertige Aufnahme samt Datei löschen */
    fun delete(ctx: Context, id: String) {
        val item = find(ctx, id) ?: return
        if (item.optString("status") == "recording") RecordingService.stop(ctx, id)
        disarm(ctx, id)
        val path = item.optString("file")
        if (path.isNotBlank()) try { File(path).delete() } catch (e: Exception) { }
        remove(ctx, id)
    }

    // ---------- Speicherort ----------

    /** Ordner mit dem meisten freien Platz (interner Speicher, SD-Karte oder USB-Stick) */
    fun storageDir(ctx: Context): File {
        val candidates = ctx.getExternalFilesDirs(Environment.DIRECTORY_MOVIES).filterNotNull().filter {
            try { Environment.getExternalStorageState(it) == Environment.MEDIA_MOUNTED } catch (e: Exception) { false }
        }
        val best = candidates.maxByOrNull { it.usableSpace }
        val dir = best ?: File(ctx.filesDir, "recordings")
        dir.mkdirs()
        return dir
    }

    fun storageJson(ctx: Context): String {
        val dir = storageDir(ctx)
        val o = JSONObject()
        o.put("free", dir.usableSpace)
        o.put("total", dir.totalSpace)
        o.put("path", dir.absolutePath)
        o.put("removable", ctx.getExternalFilesDirs(Environment.DIRECTORY_MOVIES).filterNotNull().indexOf(dir) > 0)
        return o.toString()
    }

    fun fileFor(ctx: Context, item: JSONObject): File {
        val stamp = SimpleDateFormat("yyyy-MM-dd_HHmm", Locale.GERMANY).format(Date(item.optLong("start")))
        val name = (item.optString("channel") + "_" + item.optString("title"))
            .replace(Regex("[^A-Za-z0-9ÄÖÜäöüß _.-]"), "").replace(' ', '_').take(60)
        return File(storageDir(ctx), "${stamp}_$name.ts")
    }

    // ---------- Wecker ----------

    private fun pendingIntent(ctx: Context, id: String): PendingIntent {
        val intent = Intent(ctx, RecordingAlarmReceiver::class.java).putExtra("id", id)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= 23) flags = flags or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(ctx, id.hashCode(), intent, flags)
    }

    private fun arm(ctx: Context, item: JSONObject) {
        val id = item.optString("id")
        val start = item.optLong("start")
        val now = System.currentTimeMillis()
        if (start <= now) {
            // Sendung läuft schon: sofort aufnehmen
            RecordingService.start(ctx, id)
            return
        }
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = pendingIntent(ctx, id)
        val exactAllowed = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()
        when {
            Build.VERSION.SDK_INT >= 23 && exactAllowed -> am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, start, pi)
            Build.VERSION.SDK_INT >= 23 -> am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, start, pi)
            else -> am.setExact(AlarmManager.RTC_WAKEUP, start, pi)
        }
    }

    private fun disarm(ctx: Context, id: String) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.cancel(pendingIntent(ctx, id))
    }

    /** Nach dem Einschalten oder App-Start: alle Wecker neu stellen, verpasste Starts nachholen */
    fun armAll(ctx: Context) {
        val list = all(ctx)
        val now = System.currentTimeMillis()
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            val status = o.optString("status")
            val id = o.optString("id")
            if (status == "scheduled") {
                if (o.optLong("end") <= now) update(ctx, id) { it.put("status", "missed") }
                else arm(ctx, o)
            } else if (status == "recording" && !RecordingService.isRunning(id)) {
                // App wurde während der Aufnahme beendet: weiter aufnehmen oder abschließen
                if (o.optLong("end") > now) RecordingService.start(ctx, id)
                else update(ctx, id) { it.put("status", if (o.optLong("size") > 0) "done" else "failed") }
            }
        }
    }
}

/** Wecker: Aufnahme startet */
class RecordingAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra("id") ?: return
        RecordingService.start(context, id)
    }
}

/** Nach dem Einschalten des Geräts oder einem App-Update die Wecker neu stellen */
class RecordingBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Recorder.armAll(context)
    }
}

/** Läuft im Vordergrund (mit Benachrichtigung), solange aufgenommen wird */
class RecordingService : Service() {

    companion object {
        private const val CHANNEL = "recordings"
        private const val NOTIFICATION_ID = 4711
        private val running = ConcurrentHashMap<String, Thread>()
        private val stopRequested = ConcurrentHashMap<String, Boolean>()

        fun isRunning(id: String) = running.containsKey(id)

        fun start(ctx: Context, id: String) {
            val i = Intent(ctx, RecordingService::class.java).setAction("start").putExtra("id", id)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context, id: String) {
            stopRequested[id] = true
            val i = Intent(ctx, RecordingService::class.java).setAction("stop").putExtra("id", id)
            try { ctx.startService(i) } catch (e: Exception) { }
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        goForeground("Aufnahme wird vorbereitet …")
        val id = intent?.getStringExtra("id")
        if (id == null) { stopIfIdle(); return START_NOT_STICKY }
        if (intent?.action == "stop") {
            stopRequested[id] = true
            if (!running.containsKey(id)) stopIfIdle()
            return START_NOT_STICKY
        }
        if (running.containsKey(id)) return START_NOT_STICKY
        val item = Recorder.find(this, id)
        if (item == null || item.optLong("end") <= System.currentTimeMillis()) {
            if (item != null) Recorder.update(this, id) { it.put("status", "missed") }
            stopIfIdle()
            return START_NOT_STICKY
        }
        acquireLocks()
        stopRequested.remove(id)
        val thread = Thread({ record(id) }, "Aufnahme-$id")
        running[id] = thread
        thread.start()
        updateNotification()
        return START_NOT_STICKY
    }

    private fun record(id: String) {
        val item = Recorder.find(this, id) ?: return finish(id)
        val end = item.optLong("end")
        val url = item.optString("url")
        val file = item.optString("file").takeIf { it.isNotBlank() }?.let { File(it) } ?: Recorder.fileFor(this, item)
        Recorder.update(this, id) { it.put("status", "recording"); it.put("file", file.absolutePath) }

        var written = if (file.exists()) file.length() else 0L
        var lastSave = 0L
        var error = ""
        try {
            FileOutputStream(file, true).use { out ->
                val buffer = ByteArray(64 * 1024)
                while (stopRequested[id] != true && System.currentTimeMillis() < end) {
                    try {
                        openStream(url).use { input ->
                            while (stopRequested[id] != true && System.currentTimeMillis() < end) {
                                val n = input.read(buffer)
                                if (n < 0) break
                                out.write(buffer, 0, n)
                                written += n
                                val now = System.currentTimeMillis()
                                if (now - lastSave > 10_000) {
                                    lastSave = now
                                    val size = written
                                    Recorder.update(this, id) { it.put("size", size) }
                                    if ((file.parentFile?.usableSpace ?: Long.MAX_VALUE) < 200L * 1024 * 1024) {
                                        error = "Speicher voll"
                                        stopRequested[id] = true
                                    }
                                }
                            }
                        }
                    } catch (e: Exception) {
                        error = e.message ?: "Verbindung unterbrochen"
                    }
                    // Verbindung abgebrochen: kurz warten und neu verbinden
                    if (stopRequested[id] != true && System.currentTimeMillis() < end) Thread.sleep(3000)
                }
            }
        } catch (e: Exception) {
            error = e.message ?: "Datei konnte nicht geschrieben werden"
        }
        val size = written
        val err = error
        Recorder.update(this, id) {
            it.put("size", size)
            it.put("status", if (size > 512 * 1024) "done" else "failed")
            if (size <= 512 * 1024 && err.isNotBlank()) it.put("error", err)
            if (stopRequested[id] == true && err != "Speicher voll") it.put("stoppedEarly", true)
            if (err == "Speicher voll") it.put("error", err)
        }
        if (size <= 512 * 1024) try { file.delete() } catch (e: Exception) { }
        finish(id)
    }

    /** Verbindung zum Sender öffnen (folgt auch Umleitungen von http zu https) */
    private fun openStream(start: String): InputStream {
        var url = start
        for (i in 0 until 6) {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 15_000
            conn.readTimeout = 20_000
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("User-Agent", Recorder.USER_AGENT)
            val code = conn.responseCode
            if (code in 300..399) {
                val location = conn.getHeaderField("Location") ?: throw IllegalStateException("Umleitung ohne Ziel")
                url = URL(URL(url), location).toString()
                conn.disconnect()
                continue
            }
            if (code !in 200..299) { conn.disconnect(); throw IllegalStateException("Server antwortet mit HTTP $code") }
            return conn.inputStream
        }
        throw IllegalStateException("Zu viele Umleitungen")
    }

    private fun finish(id: String) {
        running.remove(id)
        stopRequested.remove(id)
        stopIfIdle()
    }

    private fun stopIfIdle() {
        if (running.isEmpty()) {
            releaseLocks()
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else stopForeground(true)
            stopSelf()
        } else {
            updateNotification()
        }
    }

    // ---------- Benachrichtigung ----------

    private fun buildNotification(text: String): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Aufnahmen", NotificationManager.IMPORTANCE_LOW))
        }
        val open = packageManager.getLaunchIntentForPackage(packageName)
        var piFlags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= 23) piFlags = piFlags or PendingIntent.FLAG_IMMUTABLE
        val pi = if (open != null) PendingIntent.getActivity(this, 1, open, piFlags) else null
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        builder.setContentTitle("ImperumTV nimmt auf")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
        if (pi != null) builder.setContentIntent(pi)
        return builder.build()
    }

    private fun goForeground(text: String) {
        val n = buildNotification(text)
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(NOTIFICATION_ID, n)
    }

    private fun updateNotification() {
        val titles = running.keys.mapNotNull { Recorder.find(this, it)?.optString("title") }
        val text = if (titles.isEmpty()) "Aufnahme wird vorbereitet …" else titles.joinToString(", ")
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    // ---------- Gerät wach und WLAN an lassen ----------

    @Suppress("DEPRECATION")
    private fun acquireLocks() {
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ImperumTV:Aufnahme").apply {
                setReferenceCounted(false)
                acquire(7 * 3600_000L)
            }
        }
        if (wifiLock == null) {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "ImperumTV:Aufnahme").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    private fun releaseLocks() {
        try { wakeLock?.release() } catch (e: Exception) { }
        try { wifiLock?.release() } catch (e: Exception) { }
        wakeLock = null
        wifiLock = null
    }

    override fun onDestroy() {
        releaseLocks()
        super.onDestroy()
    }
}
