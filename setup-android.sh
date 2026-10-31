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

JAVA_DIR="$OUT/app/src/main/java/tv/imperum/app"

# OpenVPN (eigene .ovpn-Datei, Verbinden/Trennen in der App).
# Die Bibliothek wird aus ihrem Quellcode mitgebaut. Klappt das nicht, baut der Workflow mit OPENVPN=0 ohne OpenVPN.
OVPN_REPO=https://github.com/pia-foss/mobile-android-openvpn-tunnel
OVPN_COMMIT=4235a8412fc2dc9ebff58f008a5f75e0ab38b9cd
if [ "${OPENVPN:-1}" != "0" ] && git clone -q "$OVPN_REPO" "$OUT/openvpn" 2>/dev/null \
   && (cd "$OUT/openvpn" && git checkout -q "$OVPN_COMMIT" && (git submodule update --init --depth 1 -q || git submodule update --init -q)); then
    rm -f "$OUT/openvpn/build.gradle"
    cp openvpn.build.gradle.kts "$OUT/openvpn/build.gradle.kts"
    # Neuere Gradle-Version: Paketname kommt aus build.gradle.kts, nicht mehr aus dem Manifest
    sed -i 's| package="de.blinkt.openvpn"||' "$OUT/openvpn/src/main/AndroidManifest.xml"
    echo 'include(":openvpn")' >> "$OUT/settings.gradle.kts"
    sed -i 's|// OPENVPN.*|implementation(project(":openvpn"))|' "$OUT/app/build.gradle.kts"
    cp OVpn.kt "$JAVA_DIR/OVpn.kt"
    sed -i 's|<uses-permission android:name="android.permission.INTERNET" />|<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_SYSTEM_EXEMPTED" />|' "$OUT/app/src/main/AndroidManifest.xml"
    echo "OpenVPN-Bibliothek eingebunden"
else
    cp OVpnStub.kt "$JAVA_DIR/OVpn.kt"
    echo "Build ohne OpenVPN"
fi
cp App.kt "$JAVA_DIR/App.kt"

echo "Projekt liegt in $OUT"
