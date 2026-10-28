package tv.imperum.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/**
 * ImperumTV für Android (Handy, Tablet, Android TV, Google TV, Fire TV).
 * Die Oberfläche ist eine Web-Seite (assets/www), das Video läuft über ExoPlayer
 * und liegt unter der durchsichtigen Web-Ansicht.
 */
@UnstableApi
class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var playerView: PlayerView
    private lateinit var player: ExoPlayer
    private val handler = Handler(Looper.getMainLooper())

    // Werte, die die Web-Seite jederzeit abfragen darf (werden auf dem Haupt-Thread aktualisiert)
    @Volatile private var cachedPlaying = false
    @Volatile private var cachedPosition = 0.0
    @Volatile private var cachedDuration = 0.0
    private var subtitleIndex = -1
    private var readySent = false

    private val ticker = object : Runnable {
        override fun run() {
            updateCache()
            if (player.playbackState == Player.STATE_READY && player.isPlaying) {
                emit("time", cachedPosition)
            }
            handler.postDelayed(this, 500)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemBars()

        root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)

        // ---------- Video ----------
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("ImperumTV/1.0 (Android)")
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(20_000)
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(http))
            .build()
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                when (state) {
                    Player.STATE_BUFFERING -> emit("buffer", true)
                    Player.STATE_READY -> {
                        emit("buffer", false)
                        if (!readySent) {
                            readySent = true
                            emit("ready", null)
                        }
                    }
                    Player.STATE_ENDED -> emit("end", null)
                    else -> {}
                }
                updateCache()
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                updateCache()
            }

            override fun onPlayerError(error: PlaybackException) {
                if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                    player.seekToDefaultPosition()
                    player.prepare()
                    return
                }
                emit("error", error.errorCodeName)
            }
        })

        playerView = PlayerView(this).apply {
            useController = false
            resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
            setShutterBackgroundColor(Color.BLACK)
            setKeepContentOnPlayerReset(false)
            player = this@MainActivity.player
            visibility = View.GONE
            isFocusable = false
        }
        root.addView(playerView, FrameLayout.LayoutParams(0, 0))

        // ---------- Oberfläche ----------
        webView = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            @Suppress("DEPRECATION")
            settings.allowUniversalAccessFromFileURLs = true
            @Suppress("DEPRECATION")
            settings.allowFileAccessFromFileURLs = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.useWideViewPort = false
            settings.loadWithOverviewMode = false
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            isFocusable = true
            isFocusableInTouchMode = true
            webViewClient = WebViewClient()
            webChromeClient = WebChromeClient()
            addJavascriptInterface(Bridge(), "AndroidBridge")
        }
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        setContentView(root)
        webView.loadUrl("file:///android_asset/www/index.html")
        webView.requestFocus()
        handler.post(ticker)
    }

    // ---------- Tasten der Fernbedienung ----------

    private val keyMap = mapOf(
        KeyEvent.KEYCODE_BACK to 10009,
        KeyEvent.KEYCODE_ESCAPE to 10009,
        KeyEvent.KEYCODE_DPAD_CENTER to 13,
        KeyEvent.KEYCODE_ENTER to 13,
        KeyEvent.KEYCODE_NUMPAD_ENTER to 13,
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to 10252,
        KeyEvent.KEYCODE_HEADSETHOOK to 10252,
        KeyEvent.KEYCODE_MEDIA_PLAY to 415,
        KeyEvent.KEYCODE_MEDIA_PAUSE to 19,
        KeyEvent.KEYCODE_MEDIA_STOP to 413,
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD to 417,
        KeyEvent.KEYCODE_MEDIA_REWIND to 412,
        KeyEvent.KEYCODE_CHANNEL_UP to 427,
        KeyEvent.KEYCODE_PAGE_UP to 427,
        KeyEvent.KEYCODE_CHANNEL_DOWN to 428,
        KeyEvent.KEYCODE_PAGE_DOWN to 428,
        KeyEvent.KEYCODE_PROG_RED to 403,
        KeyEvent.KEYCODE_PROG_GREEN to 404,
        KeyEvent.KEYCODE_PROG_YELLOW to 405,
        KeyEvent.KEYCODE_PROG_BLUE to 406,
        KeyEvent.KEYCODE_MENU to 405          // Menü-Taste (z. B. Fire TV ≡) = Favorit
    )

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = keyMap[event.keyCode]
        if (code != null) {
            // Ist die Bildschirmtastatur offen, darf sie Zurück/Enter selbst verarbeiten
            val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            val keyboardOpen = imm.isAcceptingText && (event.keyCode == KeyEvent.KEYCODE_ENTER)
            if (!keyboardOpen) {
                if (event.action == KeyEvent.ACTION_DOWN) sendKey(code)
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    @Deprecated("Wird für ältere Geräte und die Zurück-Geste gebraucht")
    override fun onBackPressed() {
        sendKey(10009)
    }

    private fun sendKey(code: Int) {
        webView.evaluateJavascript("window.__androidKey && window.__androidKey($code)", null)
    }

    // ---------- Lebenszyklus ----------

    override fun onStart() {
        super.onStart()
        hideSystemBars()
        webView.onResume()
        webView.evaluateJavascript("window.__androidLifecycle && window.__androidLifecycle('visible')", null)
    }

    override fun onStop() {
        webView.evaluateJavascript("window.__androidLifecycle && window.__androidLifecycle('hidden')", null)
        player.pause()
        webView.onPause()
        super.onStop()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        player.release()
        webView.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
        }
    }

    // ---------- Hilfen für den Player ----------

    private fun updateCache() {
        cachedPlaying = player.playWhenReady && player.playbackState != Player.STATE_ENDED &&
            player.playbackState != Player.STATE_IDLE
        cachedPosition = player.currentPosition / 1000.0
        val d = player.duration
        cachedDuration = if (d == C.TIME_UNSET || d <= 0 || player.isCurrentMediaItemLive) 0.0 else d / 1000.0
    }

    private fun emit(name: String, value: Any?) {
        val js = when (value) {
            null -> "null"
            is Boolean, is Number -> value.toString()
            else -> JSONObject.quote(value.toString())
        }
        handler.post {
            webView.evaluateJavascript("window.__androidPlayerEvent && window.__androidPlayerEvent('$name', $js)", null)
        }
    }

    private fun placeVideo(x: Double, y: Double, w: Double, h: Double) {
        val width = root.width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels
        val height = root.height.takeIf { it > 0 } ?: resources.displayMetrics.heightPixels
        val lp = FrameLayout.LayoutParams((w * width).toInt().coerceAtLeast(1), (h * height).toInt().coerceAtLeast(1))
        lp.leftMargin = (x * width).toInt()
        lp.topMargin = (y * height).toInt()
        playerView.layoutParams = lp
        playerView.visibility = View.VISIBLE
    }

    private fun trackName(format: Format, fallback: String): String {
        format.label?.takeIf { it.isNotBlank() }?.let { return it }
        val lang = format.language
        if (!lang.isNullOrBlank() && lang != "und") {
            val name = Locale(lang).getDisplayLanguage(Locale.GERMAN)
            if (name.isNotBlank()) return name.replaceFirstChar { it.uppercase() }
        }
        return fallback
    }

    private fun groups(type: Int): List<Tracks.Group> =
        player.currentTracks.groups.filter { it.type == type && it.isSupported }

    private fun select(group: Tracks.Group) {
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(group.type, false)
            .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0))
            .build()
    }

    private fun <T> onMain(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val task = FutureTask(Callable { block() })
        handler.post(task)
        return task.get(3, TimeUnit.SECONDS)
    }

    // ---------- Schnittstelle für die Web-Seite ----------

    inner class Bridge {

        @JavascriptInterface
        fun open(url: String, x: Double, y: Double, w: Double, h: Double) {
            handler.post {
                readySent = false
                subtitleIndex = -1
                // Untertitel zunächst aus, Tonspur automatisch
                player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                    .clearOverrides()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                    .build()
                placeVideo(x, y, w, h)
                player.setMediaItem(MediaItem.fromUri(url))
                player.prepare()
                player.playWhenReady = true
                updateCache()
            }
        }

        @JavascriptInterface
        fun setRect(x: Double, y: Double, w: Double, h: Double) {
            handler.post { placeVideo(x, y, w, h) }
        }

        @JavascriptInterface
        fun stop() {
            handler.post {
                player.stop()
                player.clearMediaItems()
                playerView.visibility = View.GONE
                updateCache()
            }
        }

        @JavascriptInterface
        fun toggle() {
            handler.post {
                player.playWhenReady = !player.playWhenReady
                updateCache()
            }
        }

        @JavascriptInterface
        fun isPlaying(): Boolean = cachedPlaying

        @JavascriptInterface
        fun position(): Double = cachedPosition

        @JavascriptInterface
        fun duration(): Double = cachedDuration

        @JavascriptInterface
        fun seekBy(seconds: Double) {
            handler.post {
                if (!player.isCurrentMediaItemLive || player.isCurrentMediaItemSeekable) {
                    val target = (player.currentPosition + (seconds * 1000).toLong()).coerceAtLeast(0)
                    player.seekTo(target)
                }
            }
        }

        /** Nächste Tonspur. Rückgabe: Name, "=Name" bei nur einer Spur, "" wenn keine */
        @JavascriptInterface
        fun nextAudio(): String = onMain {
            val list = groups(C.TRACK_TYPE_AUDIO)
            when {
                list.isEmpty() -> ""
                list.size == 1 -> "=" + trackName(list[0].getTrackFormat(0), "Tonspur 1")
                else -> {
                    val current = list.indexOfFirst { it.isSelected }.coerceAtLeast(0)
                    val nextIndex = (current + 1) % list.size
                    select(list[nextIndex])
                    trackName(list[nextIndex].getTrackFormat(0), "Tonspur ${nextIndex + 1}")
                }
            }
        }

        /** Untertitel durchschalten: Aus → 1 → 2 → … → Aus. Rückgabe: Name, "Aus" oder "" */
        @JavascriptInterface
        fun nextSubtitle(): String = onMain {
            val list = groups(C.TRACK_TYPE_TEXT)
            if (list.isEmpty()) return@onMain ""
            subtitleIndex++
            if (subtitleIndex >= list.size) {
                subtitleIndex = -1
                player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                    .build()
                "Aus"
            } else {
                select(list[subtitleIndex])
                trackName(list[subtitleIndex].getTrackFormat(0), "Untertitel ${subtitleIndex + 1}")
            }
        }

        /** Zuletzt gewählte Sprache und Untertitel wieder nehmen (z. B. Deutsch) */
        @JavascriptInterface
        fun applyPrefs(audio: String, subtitle: String) {
            handler.postDelayed({
                if (audio.isNotBlank()) {
                    groups(C.TRACK_TYPE_AUDIO).firstOrNull { trackName(it.getTrackFormat(0), "") == audio }?.let { select(it) }
                }
                if (subtitle.isNotBlank() && subtitle != "Aus") {
                    val subs = groups(C.TRACK_TYPE_TEXT)
                    val i = subs.indexOfFirst { trackName(it.getTrackFormat(0), "") == subtitle }
                    if (i >= 0) {
                        subtitleIndex = i
                        select(subs[i])
                    }
                }
            }, 300)
        }

        @JavascriptInterface
        fun showKeyboard() {
            handler.post {
                webView.requestFocus()
                val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
                imm.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT)
            }
        }

        /** Feste Kennung dieses Geräts (daraus macht die App MAC-Adresse und Geräte-Schlüssel) */
        @JavascriptInterface
        fun deviceId(): String =
            Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: ""

        /** Website im Browser öffnen (Handy/Tablet) */
        @JavascriptInterface
        fun openUrl(url: String) {
            handler.post {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: Exception) {
                    // Kein Browser auf dem Gerät (z. B. manche Fire-TV-Sticks): einfach nichts tun
                }
            }
        }

        @JavascriptInterface
        fun exit() {
            handler.post { finish() }
        }
    }
}
