package tv.imperum.app

import android.app.Activity
import android.content.Context

/** Ersatz, falls die WireGuard-Bibliothek beim Bauen nicht zu finden war: App läuft, nur ohne VPN. */
object ImperumVpn {
    const val REQUEST = 7311
    var state: String = "nicht verfügbar"
        private set
    var lastError: String = ""
        private set
    var listener: ((String, String) -> Unit)? = null
    fun available(): Boolean = false
    fun config(c: Context): String = ""
    fun enabled(c: Context): Boolean = false
    fun setConfig(a: Activity, conf: String) { }
    fun setEnabled(a: Activity, on: Boolean) { }
    fun autoStart(a: Activity) { }
    fun connect(a: Activity) { }
    fun onPermission(a: Activity, ok: Boolean) { }
    fun disconnect(c: Context) { }
}
