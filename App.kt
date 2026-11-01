package tv.imperum.app

import android.app.Application
import android.os.Handler
import android.os.Looper

/** Läuft in jedem Prozess der App (auch im VPN-Prozess) – richtet OpenVPN ein, falls eingebaut */
class ImperumApp : Application() {
    override fun onCreate() {
        super.onCreate()
        try { ImperumOVpn.initLibrary(this) } catch (e: Throwable) { }
        guardMainLoop()
    }

    /**
     * Android 12/13 (v. a. Google Pixel) wirft manchmal „CannotDeliverBroadcastException: can't deliver broadcast“.
     * Das ist ein Fehler im System (die App war kurz eingefroren), nicht in ImperumTV – führte aber zum Absturz.
     * Nur genau diesen Fehler abfangen und normal weiterlaufen; alle anderen Fehler stürzen wie bisher ab
     * (und landen im Fehlerbericht).
     */
    private fun guardMainLoop() {
        Handler(Looper.getMainLooper()).post {
            while (true) {
                try {
                    Looper.loop()
                    return@post
                } catch (e: Throwable) {
                    if (!isSystemBroadcastGlitch(e)) throw e
                }
            }
        }
    }

    private fun isSystemBroadcastGlitch(e: Throwable): Boolean {
        var t: Throwable? = e
        while (t != null) {
            val n = t.javaClass.name
            if (n.endsWith("CannotDeliverBroadcastException")) return true
            if (n == "android.app.RemoteServiceException" && (t.message ?: "").contains("can't deliver broadcast", true)) return true
            t = t.cause
        }
        return false
    }
}
