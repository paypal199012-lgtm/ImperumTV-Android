package tv.imperum.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
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
import androidx.core.content.FileProvider
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import org.json.JSONArray
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
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

    companion object {
        private const val REQ_EXTERNAL = 4711
    }

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var playerView: PlayerView
    private lateinit var player: ExoPlayer
    private lateinit var httpFactory: DefaultHttpDataSource.Factory

    private val handler = Handler(Looper.getMainLooper())

    // Werte, die die Web-Seite jederzeit abfragen darf (werden auf dem Haupt-Thread aktualisiert)
    @Volatile private var cachedPlaying = false
    @Volatile private var cachedPosition = 0.0
    @Volatile private var cachedDuration = 0.0
    private var subtitleIndex = -1
    private var readySent = false
    /** Ton ließ sich nicht abspielen → einmal ohne Ton weiterprobiert */
    private var audioOffRetry = false
    /** Bild-Decoder ging nicht → einmal mit anderem Decoder probiert */
    private var videoRetry = false

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
        httpFactory = http
        // 4K/HEVC & Co.: notfalls anderen Decoder nehmen, FFmpeg für Ton (DTS, Dolby, TrueHD …), Grenzen des Geräts nicht blind glauben
        val renderers = DefaultRenderersFactory(this)
            .setEnableDecoderFallback(true)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
        val selector = DefaultTrackSelector(this)
        selector.setParameters(
            selector.buildUponParameters()
                .setExceedRendererCapabilitiesIfNecessary(true)
                .setExceedVideoConstraintsIfNecessary(true)
                .setExceedAudioConstraintsIfNecessary(true)
                .setAllowVideoMixedMimeTypeAdaptiveness(true)
                .setAllowVideoNonSeamlessAdaptiveness(true)
        )
        player = ExoPlayer.Builder(this, renderers)
            .setTrackSelector(selector)
            .setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(DefaultDataSource.Factory(this, http)))
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
                if (handleCodecError(error)) return
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
            // Die Oberfläche ist für 1920 x 1080 gebaut: so groß anlegen und aufs Display einpassen
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.textZoom = 100
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            isFocusable = true
            isFocusableInTouchMode = true
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    fitToScreen()
                }
            }
            webChromeClient = WebChromeClient()
            addJavascriptInterface(Bridge(), "AndroidBridge")
        }
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // Bildschirmgröße ändert sich (Start, Drehen, Fernseher meldet die Größe erst später): neu einpassen
        root.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) fitToScreen()
        }

        setContentView(root)
        webView.loadUrl("file:///android_asset/www/index.html")

        // Geplante Aufnahmen: Wecker neu stellen, verpasste Starts nachholen
        try { Recorder.armAll(this) } catch (e: Exception) { }
        // Android 13+: Erlaubnis für die Benachrichtigung während einer Aufnahme
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            try { requestPermissions(arrayOf("android.permission.POST_NOTIFICATIONS"), 7) } catch (e: Exception) { }
        }
        webView.requestFocus()
        handler.post(ticker)
    }

    /** Oberfläche neu an die Displaygröße anpassen */
    private fun fitToScreen() {
        handler.postDelayed({
            webView.evaluateJavascript("window.dispatchEvent(new Event('resize'))", null)
        }, 100)
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
                if (event.action == KeyEvent.ACTION_DOWN) {
                    sendKey(code, event.repeatCount > 0)
                } else if (event.action == KeyEvent.ACTION_UP && code == 13) {
                    // Loslassen von OK melden (für „lange drücken = Favorit“)
                    webView.evaluateJavascript("window.__androidKeyUp && window.__androidKeyUp(13)", null)
                }
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    @Deprecated("Wird für ältere Geräte und die Zurück-Geste gebraucht")
    override fun onBackPressed() {
        sendKey(10009)
    }

    private fun sendKey(code: Int, repeat: Boolean = false) {
        webView.evaluateJavascript("window.__androidKey && window.__androidKey($code, $repeat)", null)
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

    // ---------- Externer Player (VLC, MX Player …) kommt zurück ----------

    @Deprecated("Einfachster Weg, die Position vom externen Player zurückzubekommen")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_EXTERNAL) return
        val extras = data?.extras
        fun num(vararg keys: String): Long {
            for (k in keys) {
                val v = try { extras?.get(k) } catch (e: Exception) { null }
                if (v is Number) return v.toLong()
            }
            return -1L
        }
        val pos = num("extra_position", "position")
        val dur = num("extra_duration", "duration")
        val done = data?.getStringExtra("end_by") == "playback_completion"
        webView.evaluateJavascript("window.__androidExternal && window.__androidExternal($pos, $dur, $done)", null)
    }

    // ---------- Update aus der App heraus ----------

    private fun emitUpdate(state: String, pct: Int, msg: String = "") {
        handler.post {
            webView.evaluateJavascript(
                "window.__androidUpdate && window.__androidUpdate(${JSONObject.quote(state)}, $pct, ${JSONObject.quote(msg)})", null
            )
        }
    }

    /** Ordner für die heruntergeladene APK (ab Android 7 über FileProvider, davor muss der Installer sie lesen können) */
    private fun updateDir(): File {
        val base = if (Build.VERSION.SDK_INT >= 24) cacheDir else (externalCacheDir ?: cacheDir)
        return File(base, "updates").apply { mkdirs() }
    }

    private fun installApk(file: File) {
        try {
            val uri = if (Build.VERSION.SDK_INT >= 24) {
                FileProvider.getUriForFile(this, "$packageName.updates", file)
            } else {
                file.setReadable(true, false)
                Uri.fromFile(file)
            }
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            emitUpdate("installing", 100)
        } catch (e: Exception) {
            emitUpdate("error", 0, e.message ?: "Installation ließ sich nicht starten")
        }
    }

    private fun downloadApk(address: String) {
        Thread {
            try {
                val file = File(updateDir(), "ImperumTV.apk")
                if (file.exists()) file.delete()
                var conn = URL(address).openConnection() as HttpURLConnection
                var redirects = 0
                while (true) {
                    conn.instanceFollowRedirects = false
                    conn.connectTimeout = 15_000
                    conn.readTimeout = 30_000
                    conn.setRequestProperty("User-Agent", "ImperumTV-Update")
                    val code = conn.responseCode
                    if (code in 300..399 && redirects < 8) {
                        val location = conn.getHeaderField("Location") ?: throw Exception("Weiterleitung ohne Ziel")
                        val next = URL(conn.url, location)
                        conn.disconnect()
                        conn = next.openConnection() as HttpURLConnection
                        redirects++
                        continue
                    }
                    if (code != 200) throw Exception("Server antwortet mit HTTP $code")
                    break
                }
                val total = conn.getHeaderField("Content-Length")?.toLongOrNull() ?: -1L
                var done = 0L
                var last = -1
                conn.inputStream.use { input ->
                    FileOutputStream(file).use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            done += n
                            if (total > 0) {
                                val pct = (done * 100 / total).toInt()
                                if (pct != last) {
                                    last = pct
                                    emitUpdate("progress", pct)
                                }
                            }
                        }
                    }
                }
                conn.disconnect()
                if (done < 100_000) throw Exception("Die Datei ist unvollständig")
                handler.post { installApk(file) }
            } catch (e: Exception) {
                emitUpdate("error", 0, e.message ?: "Download fehlgeschlagen")
            }
        }.start()
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

    /** Bild oder Ton kann das Gerät nicht: erst selbst retten, sonst der Oberfläche Bescheid geben */
    private fun handleCodecError(error: PlaybackException): Boolean {
        val code = error.errorCode
        val decoderProblem = code in 4001..4005 || code == PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED ||
            code == PlaybackException.ERROR_CODE_AUDIO_TRACK_WRITE_FAILED
        if (!decoderProblem) return false
        val renderer = (error as? ExoPlaybackException)?.takeIf { it.type == ExoPlaybackException.TYPE_RENDERER }
        val format = renderer?.rendererFormat
        val mime = format?.sampleMimeType ?: ""
        val isAudio = mime.startsWith("audio/") || code == PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED ||
            code == PlaybackException.ERROR_CODE_AUDIO_TRACK_WRITE_FAILED
        if (isAudio && !audioOffRetry) {
            // Ton geht nicht → Bild ohne Ton weiterlaufen lassen
            audioOffRetry = true
            player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true)
                .build()
            player.prepare()
            player.playWhenReady = true
            emit("notice", "Der Ton (${codecName(mime)}) läuft auf diesem Gerät nicht – das Bild läuft ohne Ton. Mit VLC gibt es Ton.")
            return true
        }
        if (!isAudio && !videoRetry) {
            // Einmal neu starten: mit Decoder-Ausweiche nimmt ExoPlayer dann z. B. den Software-Decoder
            videoRetry = true
            player.prepare()
            player.playWhenReady = true
            return true
        }
        val info = JSONObject()
        info.put("kind", if (isAudio) "audio" else "video")
        info.put("codec", codecName(mime))
        info.put("width", format?.width ?: player.videoFormat?.width ?: 0)
        info.put("height", format?.height ?: player.videoFormat?.height ?: 0)
        info.put("code", error.errorCodeName)
        handler.post {
            webView.evaluateJavascript("window.__androidPlayerEvent && window.__androidPlayerEvent('codec', $info)", null)
        }
        return true
    }

    private fun codecName(mime: String): String = when {
        mime.contains("hevc") || mime.contains("h265") -> "HEVC / H.265"
        mime.contains("avc") -> "H.264"
        mime.contains("av01") -> "AV1"
        mime.contains("vp9") -> "VP9"
        mime.contains("dolby-vision") -> "Dolby Vision"
        mime.contains("eac3") -> "Dolby Digital Plus"
        mime.contains("ac3") -> "Dolby Digital"
        mime.contains("ac4") -> "Dolby AC-4"
        mime.contains("true-hd") || mime.contains("truehd") -> "Dolby TrueHD"
        mime.contains("dts") -> "DTS"
        mime.contains("opus") -> "Opus"
        mime.isEmpty() -> "unbekannt"
        else -> mime.substringAfter('/').uppercase()
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
        placeView(playerView, x, y, w, h)
    }

    private fun placeView(view: View, x: Double, y: Double, w: Double, h: Double) {
        val width = root.width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels
        val height = root.height.takeIf { it > 0 } ?: resources.displayMetrics.heightPixels
        val lp = FrameLayout.LayoutParams((w * width).toInt().coerceAtLeast(1), (h * height).toInt().coerceAtLeast(1))
        lp.leftMargin = (x * width).toInt()
        lp.topMargin = (y * height).toInt()
        view.layoutParams = lp
        view.visibility = View.VISIBLE
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

    /** Zusatzinfo zur Spur, z. B. "Dolby Digital · 5.1" */
    private fun trackDetail(f: Format): String {
        val parts = ArrayList<String>()
        when (f.sampleMimeType) {
            "audio/ac3" -> parts.add("Dolby Digital")
            "audio/eac3", "audio/eac3-joc" -> parts.add("Dolby Digital Plus")
            "audio/true-hd" -> parts.add("Dolby TrueHD")
            "audio/vnd.dts", "audio/vnd.dts.hd" -> parts.add("DTS")
            "audio/mp4a-latm" -> parts.add("AAC")
            "audio/mpeg", "audio/mpeg-L2" -> parts.add("MP3")
            "audio/opus" -> parts.add("Opus")
        }
        when (f.channelCount) {
            1 -> parts.add("Mono")
            2 -> parts.add("Stereo")
            6 -> parts.add("5.1")
            8 -> parts.add("7.1")
        }
        if ((f.selectionFlags and C.SELECTION_FLAG_FORCED) != 0) parts.add("Nur fremdsprachige Stellen")
        if ((f.roleFlags and C.ROLE_FLAG_DESCRIBES_VIDEO) != 0) parts.add("Hörfilm")
        if ((f.roleFlags and C.ROLE_FLAG_DESCRIBES_MUSIC_AND_SOUND) != 0) parts.add("Für Hörgeschädigte")
        return parts.joinToString(" · ")
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
                audioOffRetry = false
                videoRetry = false
                // Untertitel zunächst aus, Tonspur automatisch
                player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                    .clearOverrides()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                    .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, false)
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

        /** Bildformat: fit = ganzes Bild, zoom = Bildschirm füllen, fill = strecken */
        @JavascriptInterface
        fun setResize(mode: String) {
            handler.post {
                playerView.resizeMode = when (mode) {
                    "zoom" -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                    "fill" -> AspectRatioFrameLayout.RESIZE_MODE_FILL
                    else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
                }
            }
        }

        /** Zu einer festen Stelle springen (für "Weiterschauen") */
        @JavascriptInterface
        fun seekTo(seconds: Double) {
            handler.post {
                if (!player.isCurrentMediaItemLive || player.isCurrentMediaItemSeekable) {
                    player.seekTo((seconds * 1000).toLong().coerceAtLeast(0))
                }
            }
        }

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

        /** Alle Ton- bzw. Untertitelspuren als JSON-Liste: [{"i":0,"name":"Deutsch","detail":"5.1","selected":true}] */
        @JavascriptInterface
        fun tracks(kind: String): String = onMain {
            val type = if (kind == "text") C.TRACK_TYPE_TEXT else C.TRACK_TYPE_AUDIO
            val out = JSONArray()
            groups(type).forEachIndexed { i, g ->
                val f = g.getTrackFormat(0)
                val fallback = (if (type == C.TRACK_TYPE_TEXT) "Untertitel " else "Tonspur ") + (i + 1)
                out.put(JSONObject()
                    .put("i", i)
                    .put("name", trackName(f, fallback))
                    .put("detail", trackDetail(f))
                    .put("selected", g.isSelected))
            }
            out.toString()
        }

        /** Spur auswählen. Untertitel mit index -1 = aus */
        @JavascriptInterface
        fun selectTrack(kind: String, index: Int): Boolean = onMain {
            val type = if (kind == "text") C.TRACK_TYPE_TEXT else C.TRACK_TYPE_AUDIO
            if (type == C.TRACK_TYPE_TEXT && index < 0) {
                subtitleIndex = -1
                player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                    .build()
                return@onMain true
            }
            val list = groups(type)
            if (index < 0 || index >= list.size) return@onMain false
            if (type == C.TRACK_TYPE_TEXT) subtitleIndex = index
            select(list[index])
            true
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
                if (!imm.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT)) {
                    // Manche Fernseher (Fire TV) brauchen einen zweiten, kräftigeren Versuch
                    handler.postDelayed({ imm.showSoftInput(webView, InputMethodManager.SHOW_FORCED) }, 200)
                }
            }
        }

        /** Feste Kennung dieses Geräts (daraus macht die App MAC-Adresse und Geräte-Schlüssel) */
        @JavascriptInterface
        fun deviceId(): String =
            Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: ""

        /** Installierte Video-Player als JSON: [{"pkg":"org.videolan.vlc","name":"VLC"}] */
        @JavascriptInterface
        fun externalPlayers(): String {
            val out = JSONArray()
            try {
                val probe = Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse("http://example.com/film.mkv"), "video/*")
                val seen = HashSet<String>()
                for (info in packageManager.queryIntentActivities(probe, PackageManager.MATCH_DEFAULT_ONLY)) {
                    val pkg = info.activityInfo?.packageName ?: continue
                    if (pkg == packageName || !seen.add(pkg)) continue
                    val name = info.loadLabel(packageManager).toString().ifEmpty { pkg }
                    out.put(JSONObject().put("pkg", pkg).put("name", name))
                }
            } catch (e: Exception) {
                // keine Liste möglich
            }
            return out.toString()
        }

        /** Film/Folge im externen Player öffnen. pkg leer = Android fragt selbst. */
        @JavascriptInterface
        fun openExternal(url: String, pkg: String, title: String, positionSec: Double) {
            handler.post {
                val ms = (positionSec * 1000).toLong().coerceAtLeast(0L)
                val intent = Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(url), "video/*")
                intent.putExtra("title", title)
                intent.putExtra("return_result", true)
                if (pkg.startsWith("org.videolan")) {
                    intent.putExtra("position", ms)
                    intent.putExtra("from_start", ms == 0L)
                } else {
                    intent.putExtra("position", ms.toInt())
                }
                if (pkg.isNotEmpty()) intent.setPackage(pkg)
                try {
                    player.stop()
                    val start = if (pkg.isEmpty()) Intent.createChooser(intent, "Player wählen") else intent
                    startActivityForResult(start, REQ_EXTERNAL)
                } catch (e: Exception) {
                    webView.evaluateJavascript("window.__androidExternal && window.__androidExternal(-1, -1, false, true)", null)
                }
            }
        }

        /** Versionsnummer der installierten App (= Nummer des GitHub-Builds) */
        @JavascriptInterface
        fun appVersion(): Int {
            return try {
                val info = packageManager.getPackageInfo(packageName, 0)
                if (Build.VERSION.SDK_INT >= 28) info.longVersionCode.toInt() else info.versionCode
            } catch (e: Exception) {
                0
            }
        }

        /** Darf die App Updates installieren? (ab Android 8 muss man das einmal erlauben) */
        @JavascriptInterface
        fun canInstall(): Boolean =
            Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls()

        @JavascriptInterface
        fun openInstallSettings() {
            handler.post {
                try {
                    if (Build.VERSION.SDK_INT >= 26) {
                        startActivity(
                            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        )
                    }
                } catch (e: Exception) {
                    emitUpdate("nosettings", 0)
                }
            }
        }

        /** Neue APK laden und den Installer öffnen. Fortschritt kommt über window.__androidUpdate */
        @JavascriptInterface
        fun downloadUpdate(url: String) {
            downloadApk(url)
        }

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

        /** Trailer: zuerst die YouTube-App, sonst Browser. false = nichts gefunden (dann zeigt die App ihn selbst) */
        @JavascriptInterface
        fun openYoutube(id: String): Boolean {
            val clean = id.filter { it.isLetterOrDigit() || it == '-' || it == '_' }
            if (clean.isEmpty()) return false
            val tries = listOf(
                Intent(Intent.ACTION_VIEW, Uri.parse("vnd.youtube:$clean")),
                Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/watch?v=$clean"))
            )
            for (intent in tries) {
                try {
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(intent)
                    return true
                } catch (e: Exception) {
                    // nächste Möglichkeit
                }
            }
            return false
        }

        // ---------- Aufnahmen ----------

        /** Aufnahme planen. Rückgabe: Nummer oder "!Fehlertext" */
        @JavascriptInterface
        fun recSchedule(json: String): String =
            try { Recorder.schedule(this@MainActivity, json) } catch (e: Exception) { "!" + (e.message ?: "Fehler") }

        /** Alle Aufnahmen als JSON-Liste */
        @JavascriptInterface
        fun recList(): String = Recorder.all(this@MainActivity).toString()

        /** Geplante Aufnahme absagen bzw. laufende stoppen */
        @JavascriptInterface
        fun recCancel(id: String) { Recorder.cancel(this@MainActivity, id) }

        /** Aufnahme samt Datei löschen */
        @JavascriptInterface
        fun recDelete(id: String) { Recorder.delete(this@MainActivity, id) }

        /** Freier Speicher für Aufnahmen */
        @JavascriptInterface
        fun recStorage(): String = Recorder.storageJson(this@MainActivity)

        /** Adresse zum Abspielen einer fertigen Aufnahme */
        @JavascriptInterface
        fun recFileUrl(id: String): String {
            val path = Recorder.find(this@MainActivity, id)?.optString("file") ?: return ""
            return if (path.isBlank()) "" else Uri.fromFile(java.io.File(path)).toString()
        }

        @JavascriptInterface
        fun exit() {
            handler.post { finish() }
        }
    }
}
