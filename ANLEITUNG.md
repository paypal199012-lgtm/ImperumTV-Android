# ImperumTV für Android – Anleitung

Läuft auf Android-Handys, Tablets, Android TV, Google TV, Fire TV und Hisense mit Google TV.
Die Wiedergabelisten trägst du auf deiner Website ein (MAC-Adresse + Geräte-Schlüssel), genau wie bei Smarters.

---

## Teil 1: App bei GitHub bauen lassen (einmalig)

1. Auf github.com oben rechts **+ → New repository**.
   Name: `ImperumTV-Android`, **Public**, Haken bei **Add a README file**, dann **Create repository**.
2. Im neuen Repository: **Add file → Upload files**.
   Lade **alle Dateien aus dem Ordner `ImperumTV-Android` hoch, außer `build-apk.yml`**. Das sind:
   `MainActivity.kt`, `Recorder.kt`, `AndroidManifest.xml`, `app.build.gradle.kts`, `build.gradle.kts`, `settings.gradle.kts`,
   `gradle.properties`, `setup-android.sh`, `imperum.keystore`, `index.html`, `style.css`, `app.js`, `qrcode.js`,
   `logo.png`, `ic_launcher.png`, `banner.png`, `banner-2x.png` (zusammen 18 Dateien).
   Unten auf **Commit changes** tippen.
3. **Add file → Create new file**. Als Dateiname genau das eintippen (mit den Schrägstrichen):
   `.github/workflows/build-apk.yml`
   Den Inhalt von `build-apk.yml` hineinkopieren und **Commit changes** tippen.
4. Oben auf **Actions** gehen. Der Build startet von selbst und dauert ca. 5 Minuten (gelb = läuft, grün = fertig).

**Wichtig:** Die Datei `imperum.keystore` immer drin lassen. Sie sorgt dafür, dass Updates über die alte
App installiert werden und das Gerät seine MAC-Adresse behält.

## Teil 2: APK herunterladen

Wenn der Build grün ist, liegt die App immer unter diesem Link:

`https://holy-mode-e130.imperumtv.workers.dev/apk`

(Er leitet auf die neueste Version bei GitHub weiter. Heißt dein Repository anders als `ImperumTV-Android`,
passe die Datei `_redirects` der Website an.)

## Teil 3: Installieren

**Android-Handy / Tablet**
1. Link oben im Handy-Browser öffnen, die APK wird geladen.
2. Antippen → **Installieren**. Fragt das Handy nach „Unbekannte Apps installieren“, für den Browser erlauben.

**Fire TV (Stick, Cube, Fire-TV-Fernseher)**
1. Im Amazon-Store die App **Downloader** (von AFTVnews) installieren.
2. **Einstellungen → Mein Fire TV → Entwickleroptionen → Apps unbekannter Herkunft → Downloader: AN**.
   (Fehlen die Entwickleroptionen: **Einstellungen → Mein Fire TV → Info** und 7× auf den Gerätenamen klicken.)
3. Downloader öffnen, `holy-mode-e130.imperumtv.workers.dev/apk` eingeben, **Go** → **Installieren**.

**Google TV / Android TV / Hisense mit Google TV**
1. Im Play Store **Downloader** installieren.
2. **Einstellungen → System → Info → Android TV OS-Build** 7× anklicken (Entwicklermodus).
3. **Einstellungen → Apps → Sicherheit und Einschränkungen → Unbekannte Quellen → Downloader: AN**.
4. In Downloader `holy-mode-e130.imperumtv.workers.dev/apk` eingeben und installieren.

ImperumTV erscheint danach in der App-Liste. Auf dem Fernseher ggf. unter **Apps → Alle Apps** suchen
und mit langem Druck auf OK zu den Favoriten hinzufügen.

## Teil 4: Wiedergabeliste hinzufügen

1. ImperumTV öffnen. Rechts stehen **QR-Code, MAC-Adresse und Geräte-Schlüssel**.
2. QR-Code mit dem Handy scannen (oder die Website öffnen und beide Werte eintippen).
3. Name und Zugangsdaten eintragen → **Hinzufügen**.
4. Nach ein paar Sekunden erscheint die Liste in der App. Anklicken und los geht's.

Jedes Gerät kann ImperumTV 7 Tage kostenlos testen. Danach erscheint ein Hinweis mit QR-Code:
auf der Website für 9,99 € einmalig aktivieren, dann geht es von selbst weiter.
   Beim nächsten Start verbindet sich die App automatisch mit der zuletzt genutzten Liste.

Wiedergabeliste wechseln: Startseite → **LISTEN**, oder **Konto → Wiedergabelisten**.

## Bedienung

| Taste | Funktion |
|---|---|
| OK | Auswählen; im Live-TV erst Vorschau, nochmal OK = Vollbild |
| ▲ ▼ / CH+ CH− | Sender wechseln (Vollbild) |
| ◀ ▶ | 10 Sekunden spulen (Filme/Serien) |
| Zurück | Zurück; im Vollbild erst Steuerung ausblenden |
| Menü (≡) / Gelb | Favorit |
| Grün / Blau | Tonspur / Untertitel |
| Play/Pause | Pause |

Auf dem Handy funktioniert alles per Antippen und Wischen.

## Wenn etwas nicht klappt

- **Build rot**: In Actions auf den roten Build → **build** → den roten Schritt aufklappen und mir einen Screenshot schicken.
- **„Keine Verbindung zur Website“** in der App: Prüfe, ob du `supabase-setup.sql` in Supabase ausgeführt hast (siehe Website-Anleitung).
- **Sender startet nicht**: **Konto → Live-Format** auf M3U8 umstellen und nochmal probieren.
