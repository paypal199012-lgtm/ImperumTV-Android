package tv.imperum.app

import android.content.Context
import android.view.View
import android.widget.FrameLayout

/**
 * Ersatz, falls libVLC beim Bauen nicht zu finden war (setup-android.sh kopiert dann diese Datei als VlcEngine.kt).
 * VLC steht dann in den Einstellungen nicht zur Auswahl; Live TV läuft wie immer mit dem eingebauten Player.
 */
class VlcEngine(private val ctx: Context, @Suppress("UNUSED_PARAMETER") emit: (String, Any?) -> Unit) {
    val available = false
    val active = false
    private var layout: View? = null
    fun view(root: FrameLayout): View = layout ?: View(ctx).also { it.visibility = View.GONE; root.addView(it, 0, FrameLayout.LayoutParams(1, 1)); layout = it }
    fun open(u: String, isLive: Boolean, bufferMode: String) {}
    fun stop() {}
    fun pause() {}
    fun toggle() {}
    fun isPlaying(): Boolean = false
    fun playingNow(): Boolean = false
    fun position(): Double = 0.0
    fun duration(): Double = 0.0
    fun bitrate(): Long = 0L
    fun setResize(mode: String) {}
    fun seekTo(seconds: Double) {}
    fun seekBy(seconds: Double) {}
    fun tracks(kind: String): String = "[]"
    fun selectTrack(kind: String, index: Int): Boolean = false
    fun nextAudio(): String = ""
    fun nextSubtitle(): String = ""
    fun release() {}
}
