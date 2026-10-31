package tv.imperum.app

import android.app.Activity
import android.content.Context
import android.net.VpnService
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import java.io.ByteArrayInputStream

/**
 * VPN (WireGuard) nur für eigene Geräte.
 * Der Zugang (WireGuard-Datei von Surfshark & Co.) kommt pro Gerät von der Website (Admin) –
 * er steckt nie in der APK, und E-Mail/Passwort des VPN-Kontos werden nirgends gebraucht.
 * Über das VPN läuft nur ImperumTV, die anderen Apps auf dem Stick nicht.
 */
object ImperumVpn {
    const val REQUEST = 7311
    private const val PREFS = "vpn"

    @Volatile var state: String = "aus"
        private set
    @Volatile var lastError: String = ""
        private set
    var listener: ((String, String) -> Unit)? = null

    private var backend: GoBackend? = null
    private val tunnel = object : Tunnel {
        override fun getName(): String = "imperumtv"
        override fun onStateChange(newState: Tunnel.State) {
            update(if (newState == Tunnel.State.UP) "an" else "aus", "")
        }
    }

    fun available(): Boolean = true

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun config(c: Context): String = prefs(c).getString("conf", "") ?: ""
    fun enabled(c: Context): Boolean = prefs(c).getBoolean("on", true)

    /** Zugang speichern; "" = entfernen und trennen. Neuer Zugang bei laufendem VPN: neu verbinden. */
    fun setConfig(a: Activity, conf: String) {
        val old = config(a)
        prefs(a).edit().putString("conf", conf.trim()).apply()
        if (conf.isBlank()) { disconnect(a); return }
        if (conf.trim() != old && enabled(a)) connect(a)
    }

    fun setEnabled(a: Activity, on: Boolean) {
        prefs(a).edit().putBoolean("on", on).apply()
        if (on) connect(a) else disconnect(a)
    }

    /** Beim Start: verbinden, wenn eingerichtet und eingeschaltet */
    fun autoStart(a: Activity) {
        if (config(a).isNotBlank() && enabled(a)) connect(a)
    }

    fun connect(a: Activity) {
        val conf = config(a)
        if (conf.isBlank()) { update("kein Zugang", ""); return }
        // Beim ersten Mal fragt Android/Fire OS einmal nach der VPN-Erlaubnis
        val ask = try { VpnService.prepare(a) } catch (e: Throwable) { null }
        if (ask != null) {
            try { a.startActivityForResult(ask, REQUEST) } catch (e: Throwable) { update("fehler", "VPN-Erlaubnis lässt sich nicht anzeigen") }
            return
        }
        start(a.applicationContext, conf)
    }

    fun onPermission(a: Activity, ok: Boolean) {
        if (ok) start(a.applicationContext, config(a)) else update("fehler", "VPN-Erlaubnis wurde abgelehnt")
    }

    private fun start(c: Context, conf: String) {
        update("verbindet", "")
        Thread {
            try {
                val cfg = Config.parse(ByteArrayInputStream(onlyThisApp(conf, c.packageName).toByteArray()))
                val b = backend ?: GoBackend(c).also { backend = it }
                b.setState(tunnel, Tunnel.State.UP, cfg)
                update("an", "")
            } catch (e: Throwable) {
                update("fehler", e.message ?: e.javaClass.simpleName)
            }
        }.start()
    }

    fun disconnect(c: Context) {
        val b = backend
        if (b == null) { update("aus", ""); return }
        Thread {
            try { b.setState(tunnel, Tunnel.State.DOWN, null) } catch (e: Throwable) { }
            update("aus", "")
        }.start()
    }

    /** Nur ImperumTV über das VPN leiten (andere Apps auf dem Stick bleiben normal im Netz) */
    private fun onlyThisApp(conf: String, pkg: String): String {
        if (conf.contains("IncludedApplications", true) || conf.contains("ExcludedApplications", true)) return conf
        val idx = conf.indexOf("[Interface]", ignoreCase = true)
        if (idx < 0) return conf
        val end = conf.indexOf('\n', idx)
        if (end < 0) return conf + "\nIncludedApplications = $pkg\n"
        return conf.substring(0, end + 1) + "IncludedApplications = $pkg\n" + conf.substring(end + 1)
    }

    private fun update(s: String, err: String) {
        state = s
        lastError = err
        listener?.invoke(s, err)
    }
}
