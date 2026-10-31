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
        jniLibs { useLegacyPackaging = true }
    }
}

dependencies {
    implementation("androidx.core:core:1.13.1")
    implementation("androidx.media3:media3-exoplayer:1.5.0")
    implementation("androidx.media3:media3-exoplayer-hls:1.5.0")
    implementation("androidx.media3:media3-ui:1.5.0")
    implementation("androidx.media3:media3-extractor:1.5.0")
    // FFMPEG_DECODER (setup-android.sh trägt hier den FFmpeg-Ton-Decoder ein, wenn er bei Maven Central zu finden ist)
    // OPENVPN (setup-android.sh trägt hier die OpenVPN-Bibliothek ein, wenn sie gebaut werden soll)
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.2")
}
