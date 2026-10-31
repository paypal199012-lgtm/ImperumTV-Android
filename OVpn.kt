package tv.imperum.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.VpnService
import androidx.core.app.NotificationCompat
import com.privateinternetaccess.android.PIACallbacks
import com.privateinternetaccess.android.PIAOpenVPNTunnelLibrary
import de.blinkt.openvpn.VpnProfile
import de.blinkt.openvpn.core.ConfigParser
import de.blinkt.openvpn.core.ConnectionStatus
import de.blinkt.openvpn.core.DeviceStateReceiver
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
                ConnectionStatus.LEVEL_CONNECTED -> update("an", "")
                ConnectionStatus.LEVEL_NOTCONNECTED -> update("aus", "")
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
        PIAOpenVPNTunnelLibrary.init(c.applicationContext, notifications, callbacks)
        VpnStatus.addStateListener(stateListener)
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
        update("verbindet", "")
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
