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
for d in drawable drawable-mdpi drawable-hdpi drawable-xhdpi; do cp banner.png "$RES/$d/banner.png"; done
for d in drawable-xxhdpi drawable-xxxhdpi; do cp banner-2x.png "$RES/$d/banner.png"; done
for d in drawable drawable-mdpi drawable-hdpi drawable-xhdpi drawable-xxhdpi drawable-xxxhdpi; do cp ic_launcher.png "$RES/$d/ic_launcher.png"; done

cp index.html "$OUT/app/src/main/assets/www/index.html"
cp style.css "$OUT/app/src/main/assets/www/css/style.css"
cp app.js qrcode.js "$OUT/app/src/main/assets/www/js/"
cp logo.png "$OUT/app/src/main/assets/www/img/icon.png"

echo "Projekt liegt in $OUT"
