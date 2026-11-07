// Wird vom Einrichtungs-Skript nach app/build.gradle.kts kopiert
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "tv.imperum.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "tv.imperum.app"
        minSdk = 21
        targetSdk = 35
        // Jeder GitHub-Build bekommt eine höhere Nummer, damit Updates sauber installiert werden
        val build = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionCode = build
        versionName = "1.0.$build"
        // Nur diese Prozessor-Arten einpacken (Fire TV/Android-Boxen, Handys, BlueStacks): hält die APK mit VLC kleiner
        ndk { abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86_64") }
    }

    // Immer mit demselben Schlüssel signieren, damit Updates über die alte App installiert werden können
    signingConfigs {
        create("imperum") {
            storeFile = rootProject.file("imperum.keystore")
            storePassword = "imperumtv"
            keyAlias = "imperum"
            keyPassword = "imperumtv"
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("imperum")
        }
        getByName("debug") {
            signingConfig = signingConfigs.getByName("imperum")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // Neuere Java-Funktionen auch auf älteren Geräten
        isCoreLibraryDesugaringEnabled = true
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
    // OpenVPN startet ein eigenes Programm aus den nativen Bibliotheken: die müssen entpackt auf dem Gerät liegen
    packaging {
        jniLibs {
            useLegacyPackaging = true
            // Dieselbe C++-Bibliothek kann aus mehreren Paketen kommen (VLC, FFmpeg, OpenVPN)
            pickFirsts += listOf("lib/*/libc++_shared.so")
        }
    }
}

dependencies {
    implementation("androidx.core:core:1.13.1")
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-exoplayer-hls:1.8.0")
    implementation("androidx.media3:media3-ui:1.8.0")
    implementation("androidx.media3:media3-extractor:1.8.0")
    // FFMPEG_DECODER (setup-android.sh trägt hier den FFmpeg-Ton-Decoder ein, wenn er bei Maven Central zu finden ist)
    // VLC_PLAYER (setup-android.sh trägt hier libVLC ein, den zweiten Player für Live TV)
    // OPENVPN (setup-android.sh trägt hier die OpenVPN-Bibliothek ein, wenn sie gebaut werden soll)
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.2")
}
