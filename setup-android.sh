#!/bin/sh
# Ordnet die flachen Dateien aus dem Repository in die Android-Projektstruktur ein.
# Wird automatisch von GitHub Actions ausgeführt.
set -e
OUT=build-project
rm -rf "$OUT"
mkdir -p "$OUT/app/src/main/java/tv/imperum/app" \
         "$OUT/app/src/main/res/drawable" \
         "$OUT/app/src/main/res/drawable-mdpi" \
         "$OUT/app/src/main/res/drawable-hdpi" \
         "$OUT/app/src/main/res/drawable-xhdpi" \
         "$OUT/app/src/main/res/drawable-xxhdpi" \
         "$OUT/app/src/main/res/drawable-xxxhdpi" \
         "$OUT/app/src/main/assets/www/css" \
         "$OUT/app/src/main/assets/www/js" \
         "$OUT/app/src/main/assets/www/img"

cp settings.gradle.kts build.gradle.kts gradle.properties imperum.keystore "$OUT/"
cp app.build.gradle.kts "$OUT/app/build.gradle.kts"
cp AndroidManifest.xml "$OUT/app/src/main/AndroidManifest.xml"
cp MainActivity.kt "$OUT/app/src/main/java/tv/imperum/app/MainActivity.kt"
cp Recorder.kt "$OUT/app/src/main/java/tv/imperum/app/Recorder.kt"
# Bilder in der richtigen Auflösung, damit sie auf dem Fernseher scharf und mittig sind
# (Fire TV nimmt je nach Modell eine andere Größe, deshalb liegt das Logo in allen Ordnern)
RES="$OUT/app/src/main/res"
# Freigabe-Ordner für Updates aus der App
mkdir -p "$RES/xml"
cat > "$RES/xml/update_paths.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<paths>
    <cache-path name="updates" path="updates/" />
    <external-cache-path name="updates_ext" path="updates/" />
</paths>
XML
for d in drawable drawable-mdpi drawable-hdpi drawable-xhdpi; do cp banner.png "$RES/$d/banner.png"; done
for d in drawable-xxhdpi drawable-xxxhdpi; do cp banner-2x.png "$RES/$d/banner.png"; done
for d in drawable drawable-mdpi drawable-hdpi drawable-xhdpi drawable-xxhdpi drawable-xxxhdpi; do cp ic_launcher.png "$RES/$d/ic_launcher.png"; done

cp index.html "$OUT/app/src/main/assets/www/index.html"
cp style.css "$OUT/app/src/main/assets/www/css/style.css"
cp app.js qrcode.js "$OUT/app/src/main/assets/www/js/"
cp logo.png "$OUT/app/src/main/assets/www/img/icon.png"
cp logo-frei.png "$OUT/app/src/main/assets/www/img/logo-frei.png"

# FFmpeg-Ton-Decoder (MP2 vieler TV-Sender, Dolby, DTS …) – nur eintragen, wenn es die passende Version gibt,
# damit der Build sonst trotzdem klappt
MEDIA3=1.5.0
BASE=https://repo1.maven.org/maven2/org/jellyfin/media3/media3-ffmpeg-decoder
FFV=$(curl -fsSL --max-time 20 "$BASE/maven-metadata.xml" 2>/dev/null | grep -o "<version>$MEDIA3+[0-9]*</version>" | sed 's/<[^>]*>//g' | sort -t+ -k2 -n | tail -1 || true)
if [ -n "$FFV" ] && curl -fsI --max-time 20 "$BASE/$FFV/media3-ffmpeg-decoder-$FFV.pom" >/dev/null 2>&1; then
    sed -i "s|// FFMPEG_DECODER.*|implementation(\"org.jellyfin.media3:media3-ffmpeg-decoder:$FFV\")|" "$OUT/app/build.gradle.kts"
    echo "FFmpeg-Ton-Decoder $FFV eingebunden"
else
    echo "Kein passender FFmpeg-Ton-Decoder für Media3 $MEDIA3 gefunden – Build ohne FFmpeg"
fi

# VPN (WireGuard) – nur eintragen, wenn die Bibliothek bei Maven Central liegt; sonst Ersatz ohne VPN
WGBASE=https://repo1.maven.org/maven2/com/wireguard/android/tunnel
WGV=""
for v in 1.0.20230706 1.0.20231018 1.0.20230427; do
    if curl -fsI --max-time 20 "$WGBASE/$v/tunnel-$v.pom" >/dev/null 2>&1; then WGV=$v; break; fi
done
JAVA_DIR="$OUT/app/src/main/java/tv/imperum/app"
if [ -n "$WGV" ]; then
    sed -i "s|// WIREGUARD.*|implementation(\"com.wireguard.android:tunnel:$WGV\")|" "$OUT/app/build.gradle.kts"
    cp Vpn.kt "$JAVA_DIR/Vpn.kt"
    # VPN-Dienst der Bibliothek ausdrücklich anmelden
    sed -i 's|</application>|    <service android:name="com.wireguard.android.backend.GoBackend$VpnService" android:exported="false" android:permission="android.permission.BIND_VPN_SERVICE"><intent-filter><action android:name="android.net.VpnService" /></intent-filter></service>\n    </application>|' "$OUT/app/src/main/AndroidManifest.xml"
    echo "WireGuard-VPN $WGV eingebunden"
else
    cp VpnStub.kt "$JAVA_DIR/Vpn.kt"
    echo "WireGuard nicht gefunden – Build ohne VPN"
fi

echo "Projekt liegt in $OUT"
