package tv.imperum.app

import android.app.Application

/** Läuft in jedem Prozess der App (auch im VPN-Prozess) – richtet OpenVPN ein, falls eingebaut */
class ImperumApp : Application() {
    override fun onCreate() {
        super.onCreate()
        try { ImperumOVpn.initLibrary(this) } catch (e: Throwable) { }
    }
}
