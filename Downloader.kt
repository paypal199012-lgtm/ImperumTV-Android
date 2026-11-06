package tv.imperum.app

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.os.StatFs
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Downloads: Filme und Folgen aufs Gerät laden und offline schauen.
 * Das Laden übernimmt der Download-Manager von Android (läuft im Hintergrund weiter, auch nach einem Neustart).
 * Die Dateien liegen im App-Ordner (Android/data/…/files/Movies) – dafür braucht es keine Speicher-Berechtigung.
 * Die Liste steht als JSON in den SharedPreferences.
 */
object Downloader {
    private const val PREFS = "downloads"
    private const val KEY = "list"
    private val lock = Any()

    private fun raw(ctx: Context): JSONArray = synchronized(lock) {
        val s = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "[]") ?: "[]"
        try { JSONArray(s) } catch (e: Exception) { JSONArray() }
    }

    private fun save(ctx: Context, list: JSONArray) = synchronized(lock) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, list.toString()).apply()
    }

    private fun dm(ctx: Context) = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

    private fun dir(ctx: Context): File? =
        ctx.getExternalFilesDir(Environment.DIRECTORY_MOVIES)?.apply { mkdirs() }

    private fun safe(id: String) = id.replace(Regex("[^A-Za-z0-9_-]"), "_")

    private fun find(list: JSONArray, id: String): JSONObject? {
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            if (o.optString("id") == id) return o
        }
        return null
    }

    // ---------- Befehle aus der Oberfläche ----------

    /** Neuen Download starten. Rückgabe: Nummer oder "!Fehlertext" */
    fun start(ctx: Context, json: String): String {
        val o = try { JSONObject(json) } catch (e: Exception) { return "!Ungültige Angaben" }
        val id = o.optString("id")
        if (id.isBlank() || o.optString("url").isBlank()) return "!Ungültige Angaben"
        val d = dir(ctx) ?: return "!Kein Speicher für Downloads gefunden."
        synchronized(lock) {
            val list = raw(ctx)
            val old = find(list, id)
            if (old != null) {
                if (old.optString("status") == "failed") { enqueue(ctx, old); save(ctx, list) }
                return id
            }
            val ext = o.optString("ext", "mp4").lowercase().replace(Regex("[^a-z0-9]"), "").ifBlank { "mp4" }
            o.put("file", File(d, safe(id) + "." + ext).absolutePath)
            o.put("bytes", 0L)
            o.put("total", 0L)
            if (!o.has("at")) o.put("at", System.currentTimeMillis())
            try { enqueue(ctx, o) } catch (e: Exception) { return "!" + (e.message ?: "Download konnte nicht gestartet werden.") }
            list.put(o)
            save(ctx, list)
        }
        return id
    }

    private fun enqueue(ctx: Context, o: JSONObject) {
        val f = File(o.getString("file"))
        try { f.delete() } catch (e: Exception) { }
        val req = DownloadManager.Request(Uri.parse(o.getString("url")))
            .addRequestHeader("User-Agent", Recorder.USER_AGENT)
            .setTitle(o.optString("title", "ImperumTV"))
            .setDescription("ImperumTV")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationUri(Uri.fromFile(f))
            .setAllowedOverMetered(true)
            .setAllowedOverRoaming(true)
        o.put("dm", dm(ctx).enqueue(req))
        o.put("status", "queued")
        o.remove("error")
    }

    fun retry(ctx: Context, id: String) {
        synchronized(lock) {
            val list = raw(ctx)
            val o = find(list, id) ?: return
            if (o.optString("status") != "failed") return
            try { enqueue(ctx, o) } catch (e: Exception) { o.put("error", e.message ?: "Fehler") }
            save(ctx, list)
        }
    }

    fun delete(ctx: Context, id: String) { synchronized(lock) {
        val list = raw(ctx)
        val out = JSONArray()
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            if (o.optString("id") != id) { out.put(o); continue }
            val dmId = o.optLong("dm", -1L)
            if (dmId >= 0) try { dm(ctx).remove(dmId) } catch (e: Exception) { }
            try { File(o.optString("file")).delete() } catch (e: Exception) { }
        }
        save(ctx, out)
    } }

    /** Liste mit aktuellem Stand vom Download-Manager */
    fun all(ctx: Context): JSONArray = synchronized(lock) {
        val list = raw(ctx)
        var dirty = false
        val ids = ArrayList<Long>()
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            val st = o.optString("status")
            if ((st == "queued" || st == "loading") && o.optLong("dm", -1L) >= 0) ids.add(o.optLong("dm"))
        }
        if (ids.isNotEmpty()) {
            val rows = HashMap<Long, JSONObject>()
            try {
                dm(ctx).query(DownloadManager.Query().setFilterById(*ids.toLongArray()))?.use { c ->
                    val cId = c.getColumnIndex(DownloadManager.COLUMN_ID)
                    val cSt = c.getColumnIndex(DownloadManager.COLUMN_STATUS)
                    val cSo = c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)
                    val cTo = c.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)
                    val cRe = c.getColumnIndex(DownloadManager.COLUMN_REASON)
                    val cMt = c.getColumnIndex(DownloadManager.COLUMN_MEDIA_TYPE)
                    while (c.moveToNext()) {
                        val r = JSONObject()
                        r.put("st", c.getInt(cSt)); r.put("so", c.getLong(cSo)); r.put("to", c.getLong(cTo))
                        r.put("re", c.getInt(cRe)); r.put("mt", if (cMt >= 0) (c.getString(cMt) ?: "") else "")
                        rows[c.getLong(cId)] = r
                    }
                }
            } catch (e: Exception) { }
            for (i in 0 until list.length()) {
                val o = list.optJSONObject(i) ?: continue
                val st = o.optString("status")
                if (st != "queued" && st != "loading") continue
                val r = rows[o.optLong("dm", -1L)]
                if (r == null) { o.put("status", "failed"); o.put("error", "Download wurde abgebrochen"); dirty = true; continue }
                o.put("bytes", r.optLong("so"))
                if (r.optLong("to") > 0) o.put("total", r.optLong("to"))
                when (r.optInt("st")) {
                    DownloadManager.STATUS_RUNNING -> o.put("status", "loading")
                    DownloadManager.STATUS_PENDING, DownloadManager.STATUS_PAUSED -> o.put("status", if (r.optLong("so") > 0) "loading" else "queued")
                    DownloadManager.STATUS_SUCCESSFUL -> {
                        val f = File(o.optString("file"))
                        val mt = r.optString("mt").lowercase()
                        if (!f.exists() || f.length() < 200_000L || mt.startsWith("text/") || mt.contains("json")) {
                            o.put("status", "failed"); o.put("error", "Der Anbieter hat keine Videodatei geliefert")
                            try { f.delete() } catch (e: Exception) { }
                        } else {
                            o.put("status", "done"); o.put("bytes", f.length()); o.put("total", f.length())
                        }
                        dirty = true
                    }
                    DownloadManager.STATUS_FAILED -> {
                        val re = r.optInt("re")
                        o.put("status", "failed")
                        o.put("error", when {
                            re == DownloadManager.ERROR_INSUFFICIENT_SPACE -> "Nicht genug Speicher frei"
                            re == DownloadManager.ERROR_DEVICE_NOT_FOUND -> "Speicher nicht gefunden"
                            re in 400..599 -> "Server meldet HTTP $re"
                            re == DownloadManager.ERROR_HTTP_DATA_ERROR || re == DownloadManager.ERROR_CANNOT_RESUME -> "Verbindung abgebrochen"
                            else -> "Download fehlgeschlagen ($re)"
                        })
                        dirty = true
                    }
                }
            }
        }
        if (dirty) save(ctx, list)
        // Für die Oberfläche: ohne Zugangsdaten in der Adresse
        val out = JSONArray()
        for (i in 0 until list.length()) {
            val o = JSONObject(list.optJSONObject(i)?.toString() ?: continue)
            o.remove("url")
            if (o.optString("status") != "done") o.remove("file")
            out.put(o)
        }
        out
    }

    /** Adresse der fertigen Datei zum Abspielen */
    fun fileUrl(ctx: Context, id: String): String {
        val o = find(raw(ctx), id) ?: return ""
        if (o.optString("status") != "done") return ""
        val f = File(o.optString("file"))
        return if (f.exists()) Uri.fromFile(f).toString() else ""
    }

    fun storageJson(ctx: Context): String = try {
        val s = StatFs((dir(ctx) ?: ctx.filesDir).absolutePath)
        "{\"free\":" + s.availableBytes + ",\"total\":" + s.totalBytes + "}"
    } catch (e: Exception) { "null" }
}
