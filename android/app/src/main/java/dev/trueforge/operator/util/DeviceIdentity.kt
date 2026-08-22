package dev.trueforge.operator.util

import android.annotation.SuppressLint
import android.os.Build
import android.provider.Settings

object DeviceIdentity {

    @SuppressLint("HardwareIds")
    fun deviceId(context: android.content.Context): String {
        val model = Build.MODEL.lowercase()
            .replace(Regex("[^a-z0-9]+"), "-")
            .trim('-')
            .ifEmpty { "android-device" }
        val suffix = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ANDROID_ID,
        )?.takeLast(4) ?: "0000"
        return "$model-$suffix"
    }
}
