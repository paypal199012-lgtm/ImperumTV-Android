package tv.imperum.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.VpnService
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import com.privateinternetaccess.android.PIACallbacks
import com.privateinternetaccess.android.PIAOpenVPNTunnelLibrary
import de.blinkt.openvpn.VpnProfile
import de.blinkt.openvpn.core.ConfigParser
import de.blinkt.openvpn.core.ConnectionStatus
import de.blinkt.openvpn.core.DeviceStateReceiver
import de.blinkt.openvpn.core.LogItem
import de.blinkt.openvpn.core.OpenVPNService
import de.blinkt.openvpn.core.ProfileManager
import de.blinkt.openvpn.core.VPNLaunchHelper
import de.blinkt.openvpn.core.VPNNotifications
import de.blinkt.openvpn.core.VpnStatus
import java.io.StringReader

/**
 * OpenVPN mit EIGENER .ovpn-Datei (z. B. von Surfshark, NordVPN …).
 * Jeder entscheidet selbst: „Verbinden“ / „Trennen“ in den Einstellungen, auf Wunsch automatisch beim Start.
 * Über das VPN läuft nur ImperumTV.
 */
object ImperumOVpn {
    const val REQUEST = 7312
    private const val PREFS = "ovpn"

    @Volatile var state: String = "aus"
        private set
    @Volatile var lastError: String = ""
        private set
    var listener: ((String, String) -> Unit)? = null
    private var inited = false
    private var appCtx: Context? = null
    private val logLines = ArrayDeque<String>()
    private val main = Handler(Looper.getMainLooper())
    private var attempt = 0
    @Volatile private var startedAt = 0L
    private const val TIMEOUT_MS = 45_000L

    /** Letzte Meldungen der OpenVPN-Bibliothek (für Fehlerberichte, ohne Passwort) */
    fun log(): String = synchronized(logLines) { logLines.joinToString("\n") }

    private val logListener = object : VpnStatus.LogListener {
        override fun newLog(logItem: LogItem) {
            val c = appCtx ?: return
            val text = try { logItem.getString(c) } catch (e: Throwable) { return } ?: return
            if (text.isBlank()) return
            val error = try { logItem.logLevel == VpnStatus.LogLevel.ERROR } catch (e: Throwable) { false }
            synchronized(logLines) {
                logLines.addLast((if (error) "FEHLER: " else "") + text.take(300))
                while (logLines.size > 40) logLines.removeFirst()
            }
        }
    }

    /** Verständlicher Grund aus dem Protokoll */
    private fun reason(): String {
        val l = log()
        return when {
            Regex("execut|execul|minivpn|Cannot run program|error=8|error=13|No such file", RegexOption.IGNORE_CASE).containsMatchIn(l) ->
                "Das OpenVPN-Programm startet auf diesem Gerät nicht"
            Regex("AUTH_FAILED|auth.?fail", RegexOption.IGNORE_CASE).containsMatchIn(l) -> "Benutzername oder Passwort falsch"
            Regex("TLS key negotiation failed|TLS handshake failed|Connection timed out|Network is unreachable", RegexOption.IGNORE_CASE).containsMatchIn(l) ->
                "Der VPN-Server antwortet nicht – andere .ovpn-Datei probieren (UDP statt TCP oder anderer Standort)"
            Regex("Options error|Unrecognized option|parse", RegexOption.IGNORE_CASE).containsMatchIn(l) -> "Die .ovpn-Datei passt nicht"
            else -> "Keine Verbindung nach 45 Sekunden"
        }
    }

    fun available(): Boolean = true

    private val notifications = object : VPNNotifications {
        override fun addPiaNotificationExtra(nbuilder: NotificationCompat.Builder, context: Context, receiver: DeviceStateReceiver?) { }
        override fun showKillSwitchNotification(context: Context) { }
        override fun stopKillSwitchNotification(context: Context) { }
        override fun showRevokeNotification(context: Context) { }
        override fun getIconByConnectionStatus(level: ConnectionStatus?): Int = R.drawable.ic_launcher
        override fun getColorByConnectionStatus(context: Context, level: ConnectionStatus?): Int = Color.rgb(217, 176, 102)
    }

    private val callbacks = object : PIACallbacks {
        override fun isKillSwitchEnabled(c: Context): Boolean = false
        override fun getAlwaysOnProfile(): VpnProfile? = null
        override fun getMainClass(): Class<out Activity> = MainActivity::class.java
    }

    private val stateListener = object : VpnStatus.StateListener {
        override fun updateState(st: String?, logmessage: String?, localizedResId: Int, level: ConnectionStatus?) {
            when (level) {
                ConnectionStatus.LEVEL_CONNECTED -> { attempt++; update("an", "") }
                ConnectionStatus.LEVEL_NOTCONNECTED -> {
                    // Prozess ist während des Verbindens beendet worden: Fehler statt still „aus“
                    if (state == "verbindet" && st == "NOPROCESS" && System.currentTimeMillis() - startedAt > 4000) { attempt++; update("fehler", reason()) } else update("aus", "")
                }
                ConnectionStatus.LEVEL_AUTH_FAILED -> update("fehler", "Benutzername oder Passwort falsch")
                ConnectionStatus.LEVEL_NONETWORK -> update("verbindet", "Kein Netz")
                null, ConnectionStatus.UNKNOWN_LEVEL -> { }
                else -> update("verbindet", "")
            }
        }
        override fun setConnectedVPN(uuid: String?) { }
    }

    /** Beim App-Start in jedem Prozess aufrufen */
    fun initLibrary(c: Context) {
        if (inited) return
        inited = true
        appCtx = c.applicationContext
        PIAOpenVPNTunnelLibrary.init(c.applicationContext, notifications, callbacks)
        VpnStatus.addStateListener(stateListener)
        try { VpnStatus.addLogListener(logListener) } catch (e: Throwable) { }
    }

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun config(c: Context): String = prefs(c).getString("conf", "") ?: ""
    fun user(c: Context): String = prefs(c).getString("user", "") ?: ""
    fun autoStart(c: Context): Boolean = prefs(c).getBoolean("auto", false)

    /** Eigene .ovpn-Datei + Zugangsdaten übernehmen ("" = entfernen). Läuft gerade ein VPN, wird es getrennt. */
    fun setProfile(a: Activity, conf: String, user: String, pass: String) {
        val changed = conf.trim() != config(a) || user != user(a)
        prefs(a).edit().putString("conf", conf.trim()).putString("user", user).putString("pass", pass).apply()
        if ((conf.isBlank() || changed) && state != "aus") disconnect(a)
    }

    fun setAutoStart(c: Context, on: Boolean) { prefs(c).edit().putBoolean("auto", on).apply() }

    /** Beim Start nur verbinden, wenn man das so eingestellt hat */
    fun startIfWanted(a: Activity) {
        if (config(a).isNotBlank() && autoStart(a)) connect(a)
    }

    fun connect(a: Activity) {
        if (config(a).isBlank()) { update("kein Zugang", ""); return }
        val ask = try { VpnService.prepare(a) } catch (e: Throwable) { null }
        if (ask != null) {
            try { a.startActivityForResult(ask, REQUEST) } catch (e: Throwable) { update("fehler", "VPN-Erlaubnis lässt sich nicht anzeigen") }
            return
        }
        start(a.applicationContext)
    }

    fun onPermission(a: Activity, ok: Boolean) {
        if (ok) start(a.applicationContext) else update("fehler", "VPN-Erlaubnis wurde abgelehnt")
    }

    private fun start(c: Context) {
        synchronized(logLines) { logLines.clear() }
        update("verbindet", "")
        val myAttempt = ++attempt
        startedAt = System.currentTimeMillis()
        // Hängt es (z. B. „Konfiguration wird erstellt …“ ohne Ende): abbrechen und den Grund zeigen
        main.postDelayed({
            if (myAttempt == attempt && state == "verbindet") {
                val why = reason()
                try { c.startService(Intent(c, OpenVPNService::class.java).setAction(OpenVPNService.DISCONNECT_VPN)) } catch (e: Throwable) { }
                update("fehler", why)
            }
        }, TIMEOUT_MS)
        try {
            val cp = ConfigParser()
            cp.parseConfig(StringReader(config(c)))
            val p = cp.convertProfile()
            p.mName = "ImperumTV"
            val u = user(c)
            if (u.isNotBlank()) {
                p.mUsername = u
                p.mPassword = prefs(c).getString("pass", "") ?: ""
            }
            // Nur ImperumTV durch das VPN
            p.mAllowedAppsVpn = HashSet(listOf(c.packageName))
            p.mAllowedAppsVpnAreDisallowed = false
            val pm = ProfileManager.getInstance(c)
            // Altes Profil der App aufräumen
            prefs(c).getString("uuid", null)?.let { old -> ProfileManager.get(c, old)?.let { pm.removeProfile(c, it, false) } }
            pm.addProfile(p)
            pm.saveProfile(c, p)
            pm.saveProfileList(c)
            prefs(c).edit().putString("uuid", p.getUUIDString()).apply()
            VPNLaunchHelper.startOpenVpn(p, c)
        } catch (e: Throwable) {
            update("fehler", "Die .ovpn-Datei lässt sich nicht lesen: " + (e.message ?: e.javaClass.simpleName))
        }
    }

    fun disconnect(c: Context) {
        attempt++
        try {
            val i = Intent(c, OpenVPNService::class.java).setAction(OpenVPNService.DISCONNECT_VPN)
            c.startService(i)
        } catch (e: Throwable) { }
        update("aus", "")
    }

    private fun update(s: String, err: String) {
        state = s
        lastError = err
        listener?.invoke(s, err)
    }
}
