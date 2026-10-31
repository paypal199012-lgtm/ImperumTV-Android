package tv.imperum.app

import android.app.Activity
import android.content.Context

/** Ersatz, wenn die OpenVPN-Bibliothek nicht mitgebaut wurde: App läuft, nur ohne OpenVPN. */
object ImperumOVpn {
    const val REQUEST = 7312
    var state: String = "nicht verfügbar"
        private set
    var lastError: String = ""
        private set
    var listener: ((String, String) -> Unit)? = null
    fun available(): Boolean = false
    fun initLibrary(c: Context) { }
    fun config(c: Context): String = ""
    fun user(c: Context): String = ""
    fun autoStart(c: Context): Boolean = false
    fun setProfile(a: Activity, conf: String, user: String, pass: String) { }
    fun setAutoStart(c: Context, on: Boolean) { }
    fun startIfWanted(a: Activity) { }
    fun connect(a: Activity) { }
    fun onPermission(a: Activity, ok: Boolean) { }
    fun disconnect(c: Context) { }
}
