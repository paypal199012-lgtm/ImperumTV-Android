// OpenVPN-Bibliothek (PIA „mobile-android-openvpn-tunnel“, basiert auf „OpenVPN for Android“, Lizenz GPL-2.0).
// Wird von setup-android.sh als openvpn/build.gradle.kts eingesetzt – ersetzt die alte Gradle-Datei der Bibliothek.
plugins {
    id("com.android.library")
}

android {
    namespace = "de.blinkt.openvpn"
    compileSdk = 35

    defaultConfig {
        minSdk = 21
        buildConfigField("boolean", "openvpn3", "false")
        externalNativeBuild {
            cmake {
                arguments += listOf("-DANDROID_TOOLCHAIN=clang", "-DANDROID_STL=c++_static")
            }
        }
        // Fire TV & Handys: nur ARM (spart viel Bauzeit)
        ndk { abiFilters += listOf("armeabi-v7a", "arm64-v8a") }
    }

    sourceSets {
        getByName("main") {
            assets.srcDirs("src/main/assets", "build/ovpnassets")
            jniLibs.srcDirs("ovpnlibs/jniLibs")
        }
    }

    externalNativeBuild {
        cmake { path = file("cpp/CMakeLists.txt") }
    }

    buildFeatures {
        aidl = true
        buildConfig = true
    }

    buildTypes {
        getByName("release") { isMinifyEnabled = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.annotation:annotation:1.8.2")
    implementation("androidx.core:core:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.madgag.spongycastle:core:1.54.0.0")
    implementation("junit:junit:4.13.2")
}

// Das OpenVPN-Programm wird beim nativen Bauen als Datei abgelegt – erst danach die Assets zusammenstellen
afterEvaluate {
    tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach {
        dependsOn(tasks.matching { it.name.startsWith("externalNativeBuild") || it.name.startsWith("buildCMake") })
    }
}
