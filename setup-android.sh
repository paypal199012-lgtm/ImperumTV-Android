#!/bin/sh
# Ordnet die flachen Dateien aus dem Repository in die Android-Projektstruktur ein.
# Wird automatisch von GitHub Actions ausgeführt.
set -e
OUT=build-project
rm -rf "$OUT"
mkdir -p "$OUT/app/src/main/java/tv/imperum/app" \
         "$OUT/app/src/main/res/drawable" \
         "$OUT/app/src/main/assets/www/css" \
         "$OUT/app/src/main/assets/www/js" \
         "$OUT/app/src/main/assets/www/img"

cp settings.gradle.kts build.gradle.kts gradle.properties imperum.keystore "$OUT/"
cp app.build.gradle.kts "$OUT/app/build.gradle.kts"
cp AndroidManifest.xml "$OUT/app/src/main/AndroidManifest.xml"
cp MainActivity.kt "$OUT/app/src/main/java/tv/imperum/app/MainActivity.kt"
cp ic_launcher.png banner.png "$OUT/app/src/main/res/drawable/"

cp index.html "$OUT/app/src/main/assets/www/index.html"
cp style.css "$OUT/app/src/main/assets/www/css/style.css"
cp app.js qrcode.js "$OUT/app/src/main/assets/www/js/"
cp logo.png "$OUT/app/src/main/assets/www/img/icon.png"

echo "Projekt liegt in $OUT"
