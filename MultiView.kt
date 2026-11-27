package tv.imperum.app

import android.content.Context
import android.graphics.Color
import android.view.View
import android.widget.FrameLayout
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import org.json.JSONObject

/**
 * Multi-View (Beta): bis zu 4 Live-Sender gleichzeitig, jeder mit eigenem kleinen Player.
 * Ton kommt nur aus einem Fenster (die anderen sind stumm). Alle Aufrufe auf dem Haupt-Thread.
 * Die Bildflächen liegen hinter der Oberfläche (WebView) – genau wie der normale Player.
 */
@UnstableApi
class MultiView(
    private val ctx: Context,
    private val root: FrameLayout,
    private val http: DefaultHttpDataSource.Factory,
    /** Die Bildflächen kommen unter diese Ansicht (die Oberfläche) */
    private val below: () -> View?,
    /** Ereignis an die Oberfläche: {"i":0,"ev":"ready","info":""} */
    private val send: (String) -> Unit
) {
    private class Slot(val player: ExoPlayer, val view: PlayerView) { var url = "" }

    private val slots = arrayOfNulls<Slot>(4)
    private var audio = 0

    val active: Boolean get() = slots.any { it != null && it.url.isNotEmpty() }

    private fun event(i: Int, ev: String, info: String = "") {
        try { send(JSONObject().put("i", i).put("ev", ev).put("info", info).toString()) } catch (e: Throwable) { }
    }

    private fun slot(i: Int): Slot {
        slots[i]?.let { return it }
        // Gerät zuerst, klappt der Decoder nicht (z. B. alle Hardware-Decoder belegt): nächsten nehmen
        val renderers = DefaultRenderersFactory(ctx)
            .setEnableDecoderFallback(true)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
        // Kleiner Vorrat je Fenster (4 Sender gleichzeitig brauchen sonst zu viel Speicher)
        val load = DefaultLoadControl.Builder()
            .setBufferDurationsMs(8_000, 20_000, 1_500, 3_000)
            .setTargetBufferBytes(12 * 1024 * 1024)
            .build()
        val sel = DefaultTrackSelector(ctx)
        sel.setParameters(sel.buildUponParameters().setMaxVideoSize(1920, 1080))
        val sources = DefaultMediaSourceFactory(DefaultDataSource.Factory(ctx, http), DefaultExtractorsFactory())
            .setLoadErrorHandlingPolicy(DefaultLoadErrorHandlingPolicy(6))
        val p = ExoPlayer.Builder(ctx, renderers)
            .setTrackSelector(sel)
            .setMediaSourceFactory(sources)
            .setLoadControl(load)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        val v = PlayerView(ctx).apply {
            useController = false
            resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
            setShutterBackgroundColor(Color.BLACK)
            setKeepContentOnPlayerReset(false)
            player = p
            isFocusable = false
            visibility = View.GONE
        }
        val idx = below()?.let { root.indexOfChild(it) } ?: -1
        if (idx >= 0) root.addView(v, idx, FrameLayout.LayoutParams(1, 1)) else root.addView(v, FrameLayout.LayoutParams(1, 1))
        p.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                when (state) {
                    Player.STATE_BUFFERING -> event(i, "buffer")
                    Player.STATE_READY -> event(i, "ready")
                    Player.STATE_ENDED -> event(i, "end")
                    else -> {}
                }
            }
            override fun onRenderedFirstFrame() { event(i, "frame") }
            override fun onPlayerError(error: PlaybackException) {
                if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                    p.seekToDefaultPosition(); p.prepare(); return
                }
                event(i, "error", error.errorCodeName)
            }
        })
        val s = Slot(p, v)
        slots[i] = s
        return s
    }

    private fun place(view: View, x: Double, y: Double, w: Double, h: Double) {
        val width = root.width.takeIf { it > 0 } ?: ctx.resources.displayMetrics.widthPixels
        val height = root.height.takeIf { it > 0 } ?: ctx.resources.displayMetrics.heightPixels
        val lp = FrameLayout.LayoutParams((w * width).toInt().coerceAtLeast(1), (h * height).toInt().coerceAtLeast(1))
        lp.leftMargin = (x * width).toInt()
        lp.topMargin = (y * height).toInt()
        view.layoutParams = lp
        view.visibility = View.VISIBLE
    }

    fun open(i: Int, url: String, x: Double, y: Double, w: Double, h: Double) {
        if (i !in 0..3) return
        val s = slot(i)
        place(s.view, x, y, w, h)
        s.url = url
        s.player.volume = if (i == audio) 1f else 0f
        s.player.setMediaItem(MediaItem.fromUri(url))
        s.player.prepare()
        s.player.playWhenReady = true
    }

    fun rect(i: Int, x: Double, y: Double, w: Double, h: Double) {
        val s = slots.getOrNull(i) ?: return
        if (s.url.isNotEmpty()) place(s.view, x, y, w, h)
    }

    fun close(i: Int) {
        val s = slots.getOrNull(i) ?: return
        s.url = ""
        try { s.player.stop(); s.player.clearMediaItems() } catch (e: Throwable) { }
        s.view.visibility = View.GONE
    }

    fun setAudio(i: Int) {
        audio = i
        for (k in 0..3) slots[k]?.player?.volume = if (k == i) 1f else 0f
    }

    /** Multi-View verlassen: alle Player freigeben (der normale Player braucht die Decoder wieder) */
    fun closeAll() {
        for (k in 0..3) {
            val s = slots[k] ?: continue
            slots[k] = null
            try { s.view.player = null } catch (e: Throwable) { }
            try { s.player.release() } catch (e: Throwable) { }
            try { root.removeView(s.view) } catch (e: Throwable) { }
        }
    }

    /** App im Hintergrund */
    fun pause() {
        for (s in slots) if (s != null && s.url.isNotEmpty()) s.player.playWhenReady = false
    }

    /** App wieder vorne: Live-Sender neu am aktuellen Live-Bild starten */
    fun resume() {
        for (s in slots) if (s != null && s.url.isNotEmpty()) {
            try { s.player.seekToDefaultPosition(); s.player.prepare(); s.player.playWhenReady = true } catch (e: Throwable) { }
        }
    }
}
