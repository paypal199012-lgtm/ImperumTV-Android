package tv.imperum.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
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
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
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
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.ExoPlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.extractor.DefaultExtractorsFactory
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
        /** Erfundene Adresse: Anfragen dorthin beantwortet die App selbst mit verkleinerten Postern */
        const val THUMB_HOST = "thumbs.imperum.local"
    }

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var playerView: PlayerView
    private lateinit var player: ExoPlayer
    private lateinit var httpFactory: DefaultHttpDataSource.Factory
    /** Oberfläche schon aufgebaut? (Während der Fehlerbericht offen ist, noch nicht) */
    private val uiReady: Boolean get() = ::webView.isInitialized && ::player.isInitialized

    private val handler = Handler(Looper.getMainLooper())

    // Werte, die die Web-Seite jederzeit abfragen darf (werden auf dem Haupt-Thread aktualisiert)
    @Volatile private var cachedPlaying = false
    @Volatile private var cachedPosition = 0.0
    @Volatile private var cachedDuration = 0.0
    private var subtitleIndex = -1
    private var readySent = false

    // Standbild-Erkennung: läuft der Sender, aber es kommen keine neuen Bilder, wird neu geladen (max. 2× je Sender)
    private var lastFrames = -1
    private var frozenSince = 0L
    private var freezeFixes = 0
    private var audioWarned = false

    private fun checkFrozen() {
        if (!player.isPlaying || player.videoFormat == null) { frozenSince = System.currentTimeMillis(); return }
        val counters = player.videoDecoderCounters ?: return
        counters.ensureUpdated()
        val n = counters.renderedOutputBufferCount
        val now = System.currentTimeMillis()
        if (n != lastFrames) { lastFrames = n; frozenSince = now; return }
        if (now - frozenSince > 8_000 && freezeFixes < 1) {
            freezeFixes++
            frozenSince = now
            if (player.isCurrentMediaItemLive) player.seekToDefaultPosition()
            player.prepare()
            player.playWhenReady = true
            emit("notice", "Bild hing – Sender wird neu geladen …")
        }
    }

    /** Ist der FFmpeg-Ton-Decoder in dieser Version eingebaut? */
    private fun ffmpegAvailable(): Boolean = try {
        Class.forName("androidx.media3.decoder.ffmpeg.FfmpegLibrary").getMethod("isAvailable").invoke(null) as Boolean
    } catch (e: Throwable) { false }

    private val ticker = object : Runnable {
        override fun run() {
            try { checkFrozen() } catch (e: Throwable) { }
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
        // Absturz-Bericht: Fehler merken und beim nächsten Start anzeigen (zum Abfotografieren)
        installCrashReporter()
        val report = takeCrashReport()
        // Gab es beim letzten Start einen Absturz: erst den Bericht zeigen, dann die App aufbauen
        if (report != null) showCrashReport(report) { buildUi() } else buildUi()
    }

    private fun buildUi() {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)

        // ---------- Video ----------
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("ImperumTV/1.0 (Android)")
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(20_000)
        httpFactory = http
        // Ton, den das Gerät selbst nicht kann (MP2 vieler TV-Sender, Dolby, DTS …): FFmpeg springt ein, falls eingebaut.
        // Bild: klappt der eingebaute Decoder nicht, nimmt der Player den nächsten.
        // Ton immer selbst entschlüsseln und als PCM ausgeben: kein „Durchreichen“ von Dolby an den Fernseher
        // (kann der Fernseher das Format nicht, bleibt es sonst stumm – ohne Fehlermeldung).
        // Decoder des Geräts zuerst; FFmpeg nur für Ton, den das Gerät nicht kann (MP2, DTS …).
        val renderers = object : DefaultRenderersFactory(this) {
            override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink? {
                @Suppress("DEPRECATION")
                return DefaultAudioSink.Builder(context)
                    .setAudioCapabilities(AudioCapabilities.DEFAULT_AUDIO_CAPABILITIES)
                    .setEnableFloatOutput(enableFloatOutput)
                    .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                    .build()
            }
        }
            .setEnableDecoderFallback(true)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
        // Standard-Einstellungen für TS-Sender (Sonder-Flags ließen auf manchen Fire-TV-Chips das Bild hängen)
        val extractors = DefaultExtractorsFactory()
        player = ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(this, http), extractors))
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

            override fun onTracksChanged(tracks: Tracks) {
                if (audioWarned) return
                val audio = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
                if (audio.isEmpty()) return
                val anyOk = audio.any { g -> (0 until g.length).any { g.isTrackSupported(it) } }
                if (anyOk) return
                audioWarned = true
                val names = audio.map { codecName(it.getTrackFormat(0).sampleMimeType ?: "") }.distinct().joinToString(", ")
                emit("notice", "Der Ton ($names) wird auf diesem Gerät nicht unterstützt" + (if (ffmpegAvailable()) "." else " (FFmpeg-Ton fehlt in dieser Version)."))
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
                emit("error", error.errorCodeName + formatInfo(error))
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
            // Wie eine IPTV-App auftreten, nicht wie ein Browser: manche Anbieter-Server sperren Browser-Anfragen (HTTP 403)
            settings.userAgentString = "ImperumTV/1.0 (Linux; Android " + Build.VERSION.RELEASE + ")"
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            // Die Oberfläche ist für 1920 x 1080 gebaut: so groß anlegen und aufs Display einpassen
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.textZoom = 100
            // Flüssigeres Scrollen: Bereiche knapp außerhalb des Bildes schon vorzeichnen (ab Android 6)
            // (Vorab-Zeichnen außerhalb des Bildes ist aus: kostet auf Fire TV zu viel Grafikspeicher)
            // Bilder aus dem Zwischenspeicher nehmen, wenn sie schon einmal geladen wurden
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            isFocusable = true
            isFocusableInTouchMode = true
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    fitToScreen()
                }

                // Oberfläche abgestürzt (meist Speicher voll): App NICHT beenden lassen,
                // sondern neu aufbauen. Die Oberfläche startet dann im Sparmodus.
                @android.annotation.TargetApi(26)
                override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                    val prefs = getSharedPreferences("imptv_native", Context.MODE_PRIVATE)
                    val now = System.currentTimeMillis()
                    val last = prefs.getLong("renderGone", 0L)
                    val count = if (now - last < 60_000) prefs.getInt("renderGoneCount", 0) + 1 else 1
                    prefs.edit().putLong("renderGone", now).putInt("renderGoneCount", count).apply()
                    try { (view.parent as? ViewGroup)?.removeView(view) } catch (e: Throwable) { }
                    try { view.destroy() } catch (e: Throwable) { }
                    val why = if (detail.didCrash()) "Oberfläche abgestürzt" else "Oberfläche wegen Speichermangel beendet"
                    saveCrashReport("$why (${count}x in 1 Min.)\nWebView: ${webViewVersion()}")
                    handler.post {
                        // Dreimal in einer Minute: aufgeben statt endlos neu zu starten
                        if (count >= 3) finish() else recreate()
                    }
                    return true
                }

                // Poster verkleinert liefern (läuft im Hintergrund, nicht auf dem Haupt-Thread)
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    val uri = request.url
                    if (uri.host != THUMB_HOST) return null
                    return thumbResponse(uri)
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
        // Leisten erst ausblenden, wenn das Fenster steht (sonst Absturz auf Fire OS 8 / Android 11)
        hideSystemBars()
        webView.loadUrl("file:///android_asset/www/index.html")
        trimThumbs()
        epgLoadSaved()

        // OpenVPN mit eigener .ovpn-Datei: nur verbinden, wenn man „beim Start verbinden“ gewählt hat
        ImperumOVpn.listener = { s, e ->
            handler.post {
                if (uiReady) webView.evaluateJavascript("window.__androidOvpn && window.__androidOvpn(${JSONObject.quote(s)}, ${JSONObject.quote(e)})", null)
            }
        }
        try { ImperumOVpn.startIfWanted(this) } catch (e: Throwable) { }

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
        if (!uiReady) return super.dispatchKeyEvent(event)
        if (handleVolumeKey(event)) return true
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
        if (!uiReady) { super.onBackPressed(); return }
        sendKey(10009)
    }

    /**
     * Laut/Leiser selbst regeln und den eigenen Gold-Balken zeigen statt des System-Balkens.
     * Kommt die Taste gar nicht in der App an (Fernbedienung steuert den Fernseher direkt per IR/CEC)
     * oder ist die Lautstärke fest (HDMI), bleibt alles wie vorher beim System.
     */
    private fun handleVolumeKey(event: KeyEvent): Boolean {
        val key = event.keyCode
        if (key != KeyEvent.KEYCODE_VOLUME_UP && key != KeyEvent.KEYCODE_VOLUME_DOWN && key != KeyEvent.KEYCODE_VOLUME_MUTE) return false
        return try {
            val am = getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
            if (am.isVolumeFixed) return false
            if (event.action == KeyEvent.ACTION_DOWN) {
                val stream = android.media.AudioManager.STREAM_MUSIC
                when (key) {
                    KeyEvent.KEYCODE_VOLUME_UP -> am.adjustStreamVolume(stream, android.media.AudioManager.ADJUST_RAISE, 0)
                    KeyEvent.KEYCODE_VOLUME_DOWN -> am.adjustStreamVolume(stream, android.media.AudioManager.ADJUST_LOWER, 0)
                    else -> if (event.repeatCount == 0) am.adjustStreamVolume(stream, android.media.AudioManager.ADJUST_TOGGLE_MUTE, 0)
                }
                val max = am.getStreamMaxVolume(stream).coerceAtLeast(1)
                val cur = am.getStreamVolume(stream)
                val muted = if (Build.VERSION.SDK_INT >= 23) am.isStreamMute(stream) else cur == 0
                webView.evaluateJavascript("window.__androidVolume && window.__androidVolume($cur, $max, $muted)", null)
            }
            true
        } catch (e: Throwable) { false }
    }

    private fun sendKey(code: Int, repeat: Boolean = false) {
        if (!uiReady) return
        webView.evaluateJavascript("window.__androidKey && window.__androidKey($code, $repeat)", null)
    }

    // ---------- Lebenszyklus ----------

    override fun onStart() {
        super.onStart()
        hideSystemBars()
        if (!uiReady) return
        webView.onResume()
        webView.evaluateJavascript("window.__androidLifecycle && window.__androidLifecycle('visible')", null)
    }

    override fun onStop() {
        if (!uiReady) { super.onStop(); return }
        webView.evaluateJavascript("window.__androidLifecycle && window.__androidLifecycle('hidden')", null)
        player.pause()
        webView.onPause()
        super.onStop()
    }

    // ---------- Externer Player (VLC, MX Player …) kommt zurück ----------

    @Deprecated("Einfachster Weg, die Position vom externen Player zurückzubekommen")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == ImperumOVpn.REQUEST) {
            try { ImperumOVpn.onPermission(this, resultCode == RESULT_OK) } catch (e: Throwable) { }
            return
        }
        if (requestCode != REQ_EXTERNAL || !uiReady) return
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

    // ---------- Programm (EPG): einmal am Tag komplett laden und auf dem Gerät speichern ----------
    // Format der Datei: 1. Zeile Infos (JSON), danach je Sender eine Zeile  epg-id <TAB> [[start,ende,"Titel","Text"],…]

    @Volatile private var epgMap: HashMap<String, String> = HashMap()
    @Volatile private var epgMeta: String = "{}"
    @Volatile private var epgBusy = false
    private val epgFile: File get() = File(filesDir, "epg.txt")

    private class Prog(val start: Long, val stop: Long, val title: String, val desc: String)

    /** Gespeichertes Programm beim Start einlesen (im Hintergrund) */
    private fun epgLoadSaved() {
        Thread {
            try {
                val f = epgFile
                if (!f.exists()) return@Thread
                val map = HashMap<String, String>()
                var meta = "{}"
                f.bufferedReader().useLines { lines ->
                    var first = true
                    for (line in lines) {
                        if (first) { meta = line; first = false; continue }
                        val tab = line.indexOf('\t')
                        if (tab > 0) map[line.substring(0, tab)] = line.substring(tab + 1)
                    }
                }
                epgMap = map
                epgMeta = meta
            } catch (e: Throwable) { }
        }.start()
    }

    private fun emitEpg(state: String, info: String) {
        handler.post {
            if (uiReady) webView.evaluateJavascript("window.__androidEpg && window.__androidEpg(${JSONObject.quote(state)}, $info)", null)
        }
    }

    /** XMLTV-Zeit "20261030170000 +0100" in Millisekunden */
    private fun xmltvTime(v: String?): Long {
        if (v == null || v.length < 14) return 0L
        return try {
            val cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"))
            cal.clear()
            cal.set(v.substring(0, 4).toInt(), v.substring(4, 6).toInt() - 1, v.substring(6, 8).toInt(),
                v.substring(8, 10).toInt(), v.substring(10, 12).toInt(), v.substring(12, 14).toInt())
            var ms = cal.timeInMillis
            val m = Regex("([+-])(\\d{2}):?(\\d{2})").find(v.substring(14))
            if (m != null) {
                val sign = if (m.groupValues[1] == "-") -1 else 1
                val off = (m.groupValues[2].toInt() * 60 + m.groupValues[3].toInt()) * 60_000L
                ms -= sign * off
            }
            ms
        } catch (e: Throwable) { 0L }
    }

    /** XMLTV laden, nur die nächsten 36 Stunden der eigenen Sender behalten, als Datei speichern */
    private fun epgDownload(address: String, account: String, wanted: Set<String>) {
        if (epgBusy) return
        epgBusy = true
        Thread {
            try {
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND)
                val now = System.currentTimeMillis()
                val from = now - 3 * 3600_000L
                val until = now + 36 * 3600_000L
                var conn = URL(address).openConnection() as HttpURLConnection
                var redirects = 0
                while (true) {
                    conn.instanceFollowRedirects = false
                    conn.connectTimeout = 20_000
                    conn.readTimeout = 90_000
                    conn.setRequestProperty("User-Agent", "ImperumTV/1.0 (Android)")
                    val code = conn.responseCode
                    if (code in 300..399 && redirects < 5) {
                        val next = URL(conn.url, conn.getHeaderField("Location") ?: throw Exception("Weiterleitung ohne Ziel"))
                        conn.disconnect(); conn = next.openConnection() as HttpURLConnection; redirects++; continue
                    }
                    if (code != 200) throw Exception("HTTP $code")
                    break
                }
                val progs = HashMap<String, ArrayList<Prog>>()
                var count = 0
                val counter = object : java.io.FilterInputStream(conn.inputStream) {
                    var bytes = 0L
                    var lastMb = 0L
                    override fun read(b: ByteArray, off: Int, len: Int): Int {
                        val n = super.read(b, off, len)
                        if (n > 0) {
                            bytes += n
                            val mb = bytes / (1024 * 1024)
                            if (mb >= lastMb + 5) { lastMb = mb; emitEpg("progress", "{\"mb\":$mb}") }
                        }
                        return n
                    }
                }
                counter.use { input ->
                    val parser = android.util.Xml.newPullParser()
                    parser.setInput(input, null)
                    var ev = parser.eventType
                    var chan: String? = null
                    var start = 0L
                    var stop = 0L
                    var title = ""
                    var desc = ""
                    var keep = false
                    while (ev != org.xmlpull.v1.XmlPullParser.END_DOCUMENT) {
                        if (ev == org.xmlpull.v1.XmlPullParser.START_TAG) {
                            when (parser.name) {
                                "programme" -> {
                                    chan = parser.getAttributeValue(null, "channel")
                                    start = xmltvTime(parser.getAttributeValue(null, "start"))
                                    stop = xmltvTime(parser.getAttributeValue(null, "stop"))
                                    title = ""; desc = ""
                                    keep = chan != null && (wanted.isEmpty() || wanted.contains(chan)) && stop > from && start < until && start > 0
                                }
                                "title" -> if (keep && title.isEmpty()) title = parser.nextText().trim()
                                "desc" -> if (keep && desc.isEmpty()) desc = parser.nextText().trim().take(400)
                            }
                        } else if (ev == org.xmlpull.v1.XmlPullParser.END_TAG && parser.name == "programme") {
                            if (keep && title.isNotEmpty() && chan != null) {
                                progs.getOrPut(chan) { ArrayList() }.add(Prog(start, stop, title, desc))
                                count++
                            }
                            keep = false
                        }
                        ev = parser.next()
                    }
                }
                conn.disconnect()
                if (count == 0) throw Exception("Anbieter liefert kein Programm")
                val map = HashMap<String, String>()
                for ((id, list) in progs) {
                    list.sortBy { it.start }
                    val arr = JSONArray()
                    for (p in list) arr.put(JSONArray().put(p.start).put(p.stop).put(p.title).put(p.desc))
                    map[id] = arr.toString()
                }
                val meta = JSONObject().put("at", now).put("account", account).put("channels", map.size).put("count", count).toString()
                val tmp = File(filesDir, "epg.tmp")
                tmp.bufferedWriter().use { w ->
                    w.write(meta); w.write("\n")
                    for ((id, json) in map) {
                        if (id.contains('\t') || id.contains('\n')) continue
                        w.write(id); w.write("\t"); w.write(json); w.write("\n")
                    }
                }
                if (!tmp.renameTo(epgFile)) { epgFile.delete(); tmp.renameTo(epgFile) }
                epgMap = map
                epgMeta = meta
                emitEpg("done", meta)
            } catch (e: Throwable) {
                emitEpg("error", JSONObject().put("message", (e.message ?: e.javaClass.simpleName)).toString())
            } finally {
                epgBusy = false
            }
        }.start()
    }

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

    // ---------- Absturz-Bericht ----------
    private fun installCrashReporter() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        if (previous is CrashCatcher) return
        Thread.setDefaultUncaughtExceptionHandler(CrashCatcher(applicationContext, previous))
    }

    private class CrashCatcher(val ctx: Context, val previous: Thread.UncaughtExceptionHandler?) : Thread.UncaughtExceptionHandler {
        override fun uncaughtException(t: Thread, e: Throwable) {
            try {
                val sw = java.io.StringWriter()
                e.printStackTrace(java.io.PrintWriter(sw))
                val lines = sw.toString().lines().filter { it.isNotBlank() }.take(14).joinToString("\n")
                val text = "Absturz (${t.name}):\n$lines"
                ctx.getSharedPreferences("imptv_native", Context.MODE_PRIVATE).edit()
                    .putString("crashReport", text)
                    .putLong("crashReportAt", System.currentTimeMillis())
                    .putString("crashSend", text)                  // wird beim nächsten Start an die Website geschickt
                    .putLong("crashSendAt", System.currentTimeMillis())
                    .commit()
            } catch (x: Throwable) { }
            previous?.uncaughtException(t, e)
        }
    }

    private fun saveCrashReport(text: String) {
        getSharedPreferences("imptv_native", Context.MODE_PRIVATE).edit()
            .putString("crashReport", text).putLong("crashReportAt", System.currentTimeMillis())
            .putString("crashSend", text).putLong("crashSendAt", System.currentTimeMillis())
            .commit()
    }

    /** Bericht vom letzten Absturz (nur wenn jünger als 30 Minuten) – wird danach gelöscht */
    private fun takeCrashReport(): String? {
        val prefs = getSharedPreferences("imptv_native", Context.MODE_PRIVATE)
        val text = prefs.getString("crashReport", null) ?: return null
        val at = prefs.getLong("crashReportAt", 0L)
        prefs.edit().remove("crashReport").remove("crashReportAt").apply()
        return if (System.currentTimeMillis() - at < 30 * 60_000) text else null
    }

    private fun webViewVersion(): String = try {
        if (Build.VERSION.SDK_INT >= 26) WebView.getCurrentWebViewPackage()?.let { it.packageName + " " + it.versionName } ?: "?" else "?"
    } catch (e: Throwable) { "?" }

    private fun showCrashReport(text: String, then: () -> Unit) {
        try {
            android.app.AlertDialog.Builder(this)
                .setTitle("ImperumTV – Fehlerbericht")
                .setMessage(text + "\n\nAndroid " + Build.VERSION.RELEASE + " · " + Build.MODEL + "\nBitte abfotografieren und schicken.")
                .setCancelable(false)
                .setPositiveButton("Weiter") { _, _ -> then() }
                .show()
        } catch (e: Throwable) { then() }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        try { if (::player.isInitialized) player.release() } catch (e: Throwable) { }
        try { webView.destroy() } catch (e: Throwable) { }
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        @Suppress("DEPRECATION")
        val legacy = (View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
        try {
            // Fensterinhalt sicher anlegen, bevor nach dem Controller gefragt wird
            val decor = window.decorView
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                window.setDecorFitsSystemWindows(false)
                val controller = decor.windowInsetsController
                if (controller != null) {
                    controller.hide(WindowInsets.Type.systemBars())
                    controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                } else {
                    @Suppress("DEPRECATION")
                    decor.systemUiVisibility = legacy
                }
            } else {
                @Suppress("DEPRECATION")
                decor.systemUiVisibility = legacy
            }
        } catch (e: Throwable) {
            // Manche Fire-OS-Versionen: alte Methode, und wenn auch die nicht geht, eben nicht ausblenden
            try {
                @Suppress("DEPRECATION")
                window.decorView.systemUiVisibility = legacy
            } catch (x: Throwable) { }
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

    // ---------- Poster verkleinern und auf dem Gerät aufheben ----------
    // Anbieter liefern Poster oft in voller Größe (1000–2000 px). Angezeigt werden ~200 px.
    // Hier wird jedes Bild einmal geladen, klein gerechnet und als kleines JPEG im Zwischenspeicher abgelegt.

    private val thumbDir: File by lazy { File(cacheDir, "thumbs").apply { mkdirs() } }

    private fun thumbResponse(uri: Uri): WebResourceResponse {
        val src = uri.getQueryParameter("u")
        val width = (uri.getQueryParameter("w")?.toIntOrNull() ?: 260).coerceIn(80, 800)
        if (src.isNullOrBlank()) return notFound()
        val name = Integer.toHexString(src.hashCode()) + "_" + Integer.toHexString(src.length) + "_" + width + ".jpg"
        val file = File(thumbDir, name)
        try {
            if (!file.exists() || file.length() == 0L) {
                val bytes = downloadBytes(src) ?: return notFound()
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                if (bounds.outWidth <= 0) return notFound()
                var sample = 1
                while (bounds.outWidth / (sample * 2) >= width) sample *= 2
                val opts = BitmapFactory.Options().apply {
                    inSampleSize = sample
                    inPreferredConfig = Bitmap.Config.RGB_565
                }
                val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return notFound()
                val scaled = if (decoded.width > width * 5 / 4) {
                    Bitmap.createScaledBitmap(decoded, width, (decoded.height.toLong() * width / decoded.width).toInt().coerceAtLeast(1), true)
                } else decoded
                val tmp = File(thumbDir, "$name.tmp${Thread.currentThread().id}")
                FileOutputStream(tmp).use { scaled.compress(Bitmap.CompressFormat.JPEG, 82, it) }
                if (scaled !== decoded) scaled.recycle()
                decoded.recycle()
                if (!tmp.renameTo(file)) tmp.delete()
            }
            if (!file.exists()) return notFound()
            val headers = mapOf("Cache-Control" to "max-age=2592000", "Access-Control-Allow-Origin" to "*")
            return WebResourceResponse("image/jpeg", null, 200, "OK", headers, file.inputStream())
        } catch (e: Throwable) {
            return notFound()
        }
    }

    private fun notFound(): WebResourceResponse =
        WebResourceResponse("text/plain", "utf-8", 404, "Not Found", mapOf("Access-Control-Allow-Origin" to "*"), java.io.ByteArrayInputStream(ByteArray(0)))

    /** Bild laden, Weiterleitungen (auch http↔https) selbst folgen */
    private fun downloadBytes(start: String): ByteArray? {
        var url = start
        repeat(5) {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 12_000
            conn.readTimeout = 15_000
            conn.setRequestProperty("User-Agent", "ImperumTV/1.0 (Android)")
            try {
                val code = conn.responseCode
                if (code in 300..399) {
                    val next = conn.getHeaderField("Location") ?: return null
                    url = URL(URL(url), next).toString()
                    return@repeat
                }
                if (code !in 200..299) return null
                val len = conn.contentLength
                if (len > 15_000_000) return null
                return conn.inputStream.use { it.readBytes() }
            } finally {
                conn.disconnect()
            }
        }
        return null
    }

    /** Zwischenspeicher klein halten (älteste Bilder zuerst weg) */
    private fun trimThumbs() {
        Thread {
            try {
                val files = thumbDir.listFiles() ?: return@Thread
                var total = files.sumOf { it.length() }
                val limit = 120L * 1024 * 1024
                if (total <= limit) return@Thread
                for (f in files.sortedBy { it.lastModified() }) {
                    total -= f.length()
                    f.delete()
                    if (total <= limit * 3 / 4) break
                }
            } catch (e: Exception) { }
        }.start()
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

    /** Ton ließ sich nicht abspielen → Bild ohne Ton weiterlaufen lassen (einmal je Sender) */
    private var audioOffRetry = false

    private fun handleCodecError(error: PlaybackException): Boolean {
        val code = error.errorCode
        val renderer = (error as? ExoPlaybackException)?.takeIf { it.type == ExoPlaybackException.TYPE_RENDERER }
        val mime = renderer?.rendererFormat?.sampleMimeType ?: ""
        val audioProblem = mime.startsWith("audio/") || code == PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED ||
            code == PlaybackException.ERROR_CODE_AUDIO_TRACK_WRITE_FAILED
        if (!audioProblem || audioOffRetry) return false
        audioOffRetry = true
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true)
            .build()
        player.prepare()
        player.playWhenReady = true
        emit("notice", "Der Ton (${codecName(mime)}) läuft auf diesem Gerät nicht – das Bild läuft ohne Ton.")
        return true
    }

    /** Für Fehlermeldungen: welches Format machte Probleme (ohne Adresse/Zugangsdaten) */
    private fun formatInfo(error: PlaybackException): String {
        val f = (error as? ExoPlaybackException)?.takeIf { it.type == ExoPlaybackException.TYPE_RENDERER }?.rendererFormat
        val parts = ArrayList<String>()
        if (f != null) {
            parts.add(codecName(f.sampleMimeType ?: ""))
            if (f.width > 0) parts.add("${f.width}x${f.height}")
            if (f.frameRate > 0) parts.add("${f.frameRate.toInt()} fps")
        }
        val msg = (error.cause?.message ?: error.message ?: "").take(120)
        if (msg.isNotBlank()) parts.add(msg)
        return if (parts.isEmpty()) "" else " · " + parts.joinToString(" · ")
    }

    private fun codecName(mime: String): String = when {
        mime.contains("hevc") || mime.contains("h265") -> "HEVC/H.265"
        mime.contains("avc") -> "H.264"
        mime.contains("mpeg2") -> "MPEG-2"
        mime.contains("av01") -> "AV1"
        mime.contains("vp9") -> "VP9"
        mime.contains("eac3") -> "Dolby Digital Plus"
        mime.contains("ac3") -> "Dolby Digital"
        mime.contains("ac4") -> "Dolby AC-4"
        mime.contains("true-hd") || mime.contains("truehd") -> "Dolby TrueHD"
        mime.contains("dts") -> "DTS"
        mime.contains("mpeg-l2") -> "MP2"
        mime.contains("opus") -> "Opus"
        mime.isEmpty() -> "unbekannt"
        else -> mime.substringAfter('/').uppercase()
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

        /** Noch nicht gesendeter Absturzbericht: {"text":"…","at":…,"device":"…","android":"…"} oder "" */
        @JavascriptInterface
        fun pendingCrash(): String {
            val prefs = getSharedPreferences("imptv_native", Context.MODE_PRIVATE)
            val text = prefs.getString("crashSend", null) ?: return ""
            return JSONObject().put("text", text).put("at", prefs.getLong("crashSendAt", 0L))
                .put("device", Build.MANUFACTURER + " " + Build.MODEL).put("android", Build.VERSION.RELEASE)
                .put("webview", webViewVersion()).toString()
        }

        /** Bericht ist angekommen: nicht noch einmal schicken */
        @JavascriptInterface
        fun clearPendingCrash() {
            getSharedPreferences("imptv_native", Context.MODE_PRIVATE).edit().remove("crashSend").remove("crashSendAt").apply()
        }

        /**
         * „Cache leeren“: verkleinerte Poster, Programm (EPG), alte Update-Dateien und den Browser-Zwischenspeicher löschen.
         * Favoriten, Weiterschauen und Einstellungen bleiben erhalten. Gibt die freigegebenen Bytes zurück.
         */
        @JavascriptInterface
        fun clearCache(): String {
            var freed = 0L
            fun wipe(dir: File?) {
                dir?.listFiles()?.forEach { f ->
                    if (f.isDirectory) wipe(f)
                    freed += f.length()
                    f.delete()
                }
            }
            try { wipe(thumbDir) } catch (e: Throwable) { }
            try { wipe(File(cacheDir, "updates")) } catch (e: Throwable) { }
            try { externalCacheDir?.let { wipe(File(it, "updates")) } } catch (e: Throwable) { }
            try {
                if (epgFile.exists()) { freed += epgFile.length(); epgFile.delete() }
                epgMap = HashMap()
                epgMeta = "{}"
            } catch (e: Throwable) { }
            handler.post { try { if (uiReady) webView.clearCache(true) } catch (e: Throwable) { } }
            return freed.toString()
        }

        /** OpenVPN: in dieser Version eingebaut? */
        @JavascriptInterface
        fun ovpnAvailable(): Boolean = ImperumOVpn.available()

        /** OpenVPN-Stand: {"state":"an|aus|verbindet|fehler","error":"…","has":true,"user":"…","auto":false} */
        @JavascriptInterface
        fun ovpnInfo(): String = try {
            JSONObject().put("state", ImperumOVpn.state).put("error", ImperumOVpn.lastError)
                .put("has", ImperumOVpn.config(this@MainActivity).isNotBlank())
                .put("user", ImperumOVpn.user(this@MainActivity))
                .put("auto", ImperumOVpn.autoStart(this@MainActivity)).toString()
        } catch (e: Throwable) { "{}" }

        /** Eigene .ovpn-Datei + Zugangsdaten (kommen von der Website) */
        @JavascriptInterface
        fun ovpnSetProfile(conf: String, user: String, pass: String) {
            handler.post { try { ImperumOVpn.setProfile(this@MainActivity, conf, user, pass) } catch (e: Throwable) { } }
        }

        @JavascriptInterface
        fun ovpnConnect(on: Boolean) {
            handler.post {
                try { if (on) ImperumOVpn.connect(this@MainActivity) else ImperumOVpn.disconnect(this@MainActivity) } catch (e: Throwable) { }
            }
        }

        @JavascriptInterface
        fun ovpnSetAutoStart(on: Boolean) { try { ImperumOVpn.setAutoStart(this@MainActivity, on) } catch (e: Throwable) { } }

        /** Gerätename für Fehlerberichte */
        @JavascriptInterface
        fun deviceName(): String = Build.MANUFACTURER + " " + Build.MODEL + " · Android " + Build.VERSION.RELEASE +
            (if (ffmpegAvailable()) " · FFmpeg-Ton" else " · ohne FFmpeg") +
            (if (ImperumOVpn.available()) " · OpenVPN" else "")

        /** Infos zum gespeicherten Programm: {"at":…, "account":"…", "channels":…, "busy":true/false} */
        @JavascriptInterface
        fun epgInfo(): String = try {
            JSONObject(epgMeta).put("busy", epgBusy).put("loaded", epgMap.size).toString()
        } catch (e: Throwable) { "{}" }

        /** Programm eines Senders: [[start,ende,"Titel","Text"],…] oder "" */
        @JavascriptInterface
        fun epgFor(id: String): String = epgMap[id] ?: ""

        /** Was läuft gerade? Für viele Sender auf einmal: ids = JSON-Liste, Antwort {"id":"Titel",…} */
        @JavascriptInterface
        fun epgNow(ids: String): String {
            val out = JSONObject()
            try {
                val now = System.currentTimeMillis()
                val a = JSONArray(ids)
                val map = epgMap
                for (i in 0 until a.length()) {
                    val id = a.getString(i)
                    val raw = map[id] ?: continue
                    val list = JSONArray(raw)
                    for (j in 0 until list.length()) {
                        val e = list.getJSONArray(j)
                        if (e.getLong(0) <= now && e.getLong(1) > now) { out.put(id, e.getString(2)); break }
                        if (e.getLong(0) > now) break
                    }
                }
            } catch (e: Throwable) { }
            return out.toString()
        }

        /** Programm komplett neu laden (XMLTV des Anbieters). ids: JSON-Liste der benötigten Sender */
        @JavascriptInterface
        fun epgSync(url: String, account: String, ids: String) {
            val wanted = HashSet<String>()
            try { val a = JSONArray(ids); for (i in 0 until a.length()) wanted.add(a.getString(i)) } catch (e: Throwable) { }
            epgDownload(url, account, wanted)
        }

        /** Zeitpunkt des letzten Absturzes der Oberfläche (ms seit 1970, 0 = nie) */
        @JavascriptInterface
        fun lastCrash(): Double =
            getSharedPreferences("imptv_native", Context.MODE_PRIVATE).getLong("renderGone", 0L).toDouble()

        @JavascriptInterface
        fun open(url: String, x: Double, y: Double, w: Double, h: Double) {
            handler.post {
                readySent = false
                subtitleIndex = -1
                // Untertitel zunächst aus, Tonspur automatisch (Ton bei jedem Sender wieder an)
                audioOffRetry = false
                audioWarned = false
                lastFrames = -1
                freezeFixes = 0
                frozenSince = System.currentTimeMillis()
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

        /**
         * Neueste Version bei GitHub nachsehen – ohne GitHub-API (kein Abfrage-Limit, keine CORS-Sperre):
         * github.com/<repo>/releases/latest leitet auf …/releases/tag/v1.0.N weiter.
         * Antwort kommt über window.__androidLatest({tag, error})
         */
        @JavascriptInterface
        fun checkLatest(repo: String) {
            val safeRepo = repo.filter { it.isLetterOrDigit() || it == '-' || it == '_' || it == '/' || it == '.' }
            Thread {
                var tag = ""
                var err = ""
                // Bis zu 3 Versuche: direkt nach dem Einschalten ist das Netz oft noch nicht bereit
                for (attempt in 0 until 3) {
                if (attempt > 0) { try { Thread.sleep(if (attempt == 1) 2_000L else 5_000L) } catch (x: InterruptedException) { } }
                tag = ""
                err = ""
                try {
                    var address = "https://github.com/$safeRepo/releases/latest"
                    for (i in 0 until 4) {
                        val conn = URL(address).openConnection() as HttpURLConnection
                        conn.instanceFollowRedirects = false
                        conn.connectTimeout = 12_000
                        conn.readTimeout = 12_000
                        conn.setRequestProperty("User-Agent", "ImperumTV-Update")
                        val code = conn.responseCode
                        val location = conn.getHeaderField("Location") ?: ""
                        conn.disconnect()
                        val found = Regex("/releases/tag/([^/?#]+)").find(location)?.groupValues?.get(1)
                        if (found != null) { tag = found; break }
                        if (code in 300..399 && location.isNotEmpty()) { address = URL(URL(address), location).toString(); continue }
                        err = "HTTP $code"
                        break
                    }
                    if (tag.isEmpty() && err.isEmpty()) err = "keine Version gefunden"
                } catch (e: Throwable) {
                    err = e.javaClass.simpleName + (e.message?.let { ": $it" } ?: "")
                }
                if (tag.isNotEmpty()) break
                }
                val json = JSONObject().put("tag", tag).put("error", err).toString()
                handler.post {
                    if (uiReady) webView.evaluateJavascript("window.__androidLatest && window.__androidLatest($json)", null)
                }
            }.start()
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
        /** Die Oberfläche fragt, ob Poster über die Verkleinerung geladen werden können */
        @JavascriptInterface
        fun thumbHost(): String = THUMB_HOST

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
