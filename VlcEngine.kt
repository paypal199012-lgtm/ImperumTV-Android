package tv.imperum.app

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
import org.json.JSONArray
import org.json.JSONObject
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout

/**
 * Zweiter Player für Live TV: VLC (libVLC). Wird nur benutzt, wenn in den Einstellungen
 * „Player Live TV: VLC“ gewählt ist. Alle Aufrufe kommen auf dem Haupt-Thread.
 * (setup-android.sh nimmt stattdessen VlcStub.kt, falls libVLC beim Bauen nicht zu finden ist.)
 */
class VlcEngine(private val ctx: Context, private val emit: (String, Any?) -> Unit) {
    val available = true

    private var lib: LibVLC? = null
    private var mp: MediaPlayer? = null
    private var layout: VLCVideoLayout? = null
    private var attached = false
    private val handler = Handler(Looper.getMainLooper())

    private var url = ""
    private var live = false
    private var cacheMs = 2500
    private var readySent = false
    private var buffering = false
    private var reconnects = 0
    private var playingSince = 0L
    private var scale = "fit"

    /** Läuft (oder lädt) gerade etwas in VLC? */
    var active = false
        private set

    /** Fläche für das Bild (liegt wie das normale Bild hinter der Oberfläche) */
    fun view(root: FrameLayout): View {
        layout?.let { return it }
        val l = VLCVideoLayout(ctx)
        l.isFocusable = false
        l.visibility = View.GONE
        root.addView(l, 0, FrameLayout.LayoutParams(1, 1))
        layout = l
        return l
    }

    private fun player(): MediaPlayer {
        mp?.let { return it }
        val options = arrayListOf(
            "--http-reconnect",
            "--network-caching=$cacheMs",
            "--audio-time-stretch",
            "--avcodec-skiploopfilter=1"
        )
        val l = LibVLC(ctx, options)
        lib = l
        val p = MediaPlayer(l)
        p.setEventListener { e -> onEvent(e) }
        mp = p
        return p
    }

    private fun setBuffering(b: Boolean) {
        if (b == buffering) return
        buffering = b
        emit("buffer", b)
    }

    private fun sendReady() {
        setBuffering(false)
        if (!readySent) {
            readySent = true
            emit("ready", null)
        }
    }

    private fun onEvent(e: MediaPlayer.Event) {
        when (e.type) {
            MediaPlayer.Event.Opening -> setBuffering(true)
            MediaPlayer.Event.Buffering -> if (e.buffering >= 100f) { if (readySent) setBuffering(false) } else setBuffering(true)
            MediaPlayer.Event.Playing -> { playingSince = System.currentTimeMillis(); sendReady() }
            MediaPlayer.Event.Vout -> if (e.voutCount > 0) sendReady()
            MediaPlayer.Event.EndReached -> {
                if (live && active) reconnect() else emit("end", null)
            }
            MediaPlayer.Event.EncounteredError -> {
                if (live && active && reconnects < 2 && readySent) reconnect()
                else emit("error", "VLC: Sender ließ sich nicht abspielen")
            }
            else -> {}
        }
    }

    /** Live-Sender bricht ab (Server schließt die Verbindung): ohne Rückfrage neu verbinden */
    private fun reconnect() {
        // Lief der Sender eine Weile, zählt ein Abbruch wieder als erster
        if (System.currentTimeMillis() - playingSince > 60_000) reconnects = 0
        if (reconnects >= 3) { emit("error", "VLC: Verbindung zum Sender abgebrochen"); return }
        reconnects++
        emit("stall", "VLC: Verbindung abgebrochen – neu verbunden")
        setBuffering(true)
        handler.postDelayed({ if (active) play(url) }, 800)
    }

    private fun play(u: String) {
        val p = player()
        val l = layout ?: return
        if (!attached) {
            p.attachViews(l, null, false, false)
            attached = true
        }
        val m = Media(lib ?: return, Uri.parse(u))
        m.setHWDecoderEnabled(true, false)
        m.addOption(":network-caching=$cacheMs")
        m.addOption(":http-user-agent=ImperumTV/1.0 (Android)")
        p.setMedia(m)
        m.release()
        applyScale()
        p.play()
    }

    fun open(u: String, isLive: Boolean, bufferMode: String) {
        url = u
        live = isLive
        cacheMs = when (bufferMode) { "small" -> 1000; "large" -> 5000; else -> 2500 }
        readySent = false
        buffering = false
        reconnects = 0
        active = true
        layout?.visibility = View.VISIBLE
        play(u)
    }

    fun stop() {
        handler.removeCallbacksAndMessages(null)
        if (!active && !attached) return
        active = false
        try { mp?.stop() } catch (e: Throwable) { }
        try { if (attached) mp?.detachViews() } catch (e: Throwable) { }
        attached = false
        layout?.visibility = View.GONE
    }

    fun pause() { try { if (mp?.isPlaying == true) mp?.pause() } catch (e: Throwable) { } }

    fun toggle() {
        val p = mp ?: return
        if (p.isPlaying) p.pause() else p.play()
    }

    fun isPlaying(): Boolean = active && (mp?.isPlaying == true || buffering)

    fun position(): Double = if (!active) 0.0 else ((mp?.time ?: 0L).coerceAtLeast(0L) / 1000.0)

    fun duration(): Double {
        if (!active || live) return 0.0
        val d = mp?.length ?: 0L
        return if (d > 0) d / 1000.0 else 0.0
    }

    fun playingNow(): Boolean = active && mp?.isPlaying == true

    /** Datenrate in Bit/s (für die Verbindungsanzeige) */
    fun bitrate(): Long {
        val p = mp ?: return 0L
        val m = p.media ?: return 0L
        return try {
            val s = m.stats ?: return 0L
            (s.inputBitrate * 8_000_000f).toLong()
        } catch (e: Throwable) { 0L } finally { m.release() }
    }

    fun setResize(mode: String) {
        scale = mode
        applyScale()
    }

    private fun applyScale() {
        val p = mp ?: return
        p.setVideoScale(when (scale) {
            "zoom" -> MediaPlayer.ScaleType.SURFACE_FIT_SCREEN
            "fill" -> MediaPlayer.ScaleType.SURFACE_FILL
            else -> MediaPlayer.ScaleType.SURFACE_BEST_FIT
        })
    }

    fun seekTo(seconds: Double) {
        val p = mp ?: return
        if (p.isSeekable) p.setTime((seconds * 1000).toLong().coerceAtLeast(0))
    }

    fun seekBy(seconds: Double) {
        val p = mp ?: return
        if (p.isSeekable) p.setTime((p.time + (seconds * 1000).toLong()).coerceAtLeast(0))
    }

    // ---------- Ton und Untertitel ----------

    private fun list(kind: String): List<MediaPlayer.TrackDescription> {
        val p = mp ?: return emptyList()
        val arr = (if (kind == "text") p.spuTracks else p.audioTracks) ?: return emptyList()
        return arr.filter { it.id >= 0 }
    }

    private fun current(kind: String): Int {
        val p = mp ?: return -1
        return if (kind == "text") p.spuTrack else p.audioTrack
    }

    private fun name(t: MediaPlayer.TrackDescription, fallback: String): String {
        val n = (t.name ?: "").replace(Regex("^Track \\d+ - "), "").replace(Regex("^Spur \\d+ - "), "").trim()
        return n.ifBlank { fallback }
    }

    fun tracks(kind: String): String {
        val out = JSONArray()
        val cur = current(kind)
        list(kind).forEachIndexed { i, t ->
            out.put(JSONObject()
                .put("i", i)
                .put("name", name(t, (if (kind == "text") "Untertitel " else "Tonspur ") + (i + 1)))
                .put("detail", "")
                .put("selected", t.id == cur))
        }
        return out.toString()
    }

    fun selectTrack(kind: String, index: Int): Boolean {
        val p = mp ?: return false
        if (kind == "text" && index < 0) { p.setSpuTrack(-1); return true }
        val l = list(kind)
        if (index < 0 || index >= l.size) return false
        return if (kind == "text") p.setSpuTrack(l[index].id) else p.setAudioTrack(l[index].id)
    }

    fun nextAudio(): String {
        val l = list("audio")
        if (l.isEmpty()) return ""
        if (l.size == 1) return "=" + name(l[0], "Tonspur 1")
        val i = l.indexOfFirst { it.id == current("audio") }.coerceAtLeast(0)
        val n = (i + 1) % l.size
        mp?.setAudioTrack(l[n].id)
        return name(l[n], "Tonspur ${n + 1}")
    }

    fun nextSubtitle(): String {
        val l = list("text")
        if (l.isEmpty()) return ""
        val i = l.indexOfFirst { it.id == current("text") }
        if (i + 1 >= l.size) { mp?.setSpuTrack(-1); return "Aus" }
        mp?.setSpuTrack(l[i + 1].id)
        return name(l[i + 1], "Untertitel ${i + 2}")
    }

    fun release() {
        stop()
        try { mp?.release() } catch (e: Throwable) { }
        try { lib?.release() } catch (e: Throwable) { }
        mp = null
        lib = null
    }
}
