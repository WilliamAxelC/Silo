package expo.modules.receiptnormalize

import android.content.Intent
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ReceiptNormalizeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ReceiptNormalize")

    // Runs off the JS thread: decodes, uprights (EXIF), flattens lighting and writes a grayscale "scan" JPEG.
    AsyncFunction("normalize") { uri: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      ReceiptNormalizer.normalize(context, Uri.parse(uri)).toString()
    }

    // Starts or updates the "Reading receipts" foreground service (keeps processing alive in the background).
    Function("startBackgroundWork") { text: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val intent = Intent(context, ReceiptWorkService::class.java).putExtra(ReceiptWorkService.EXTRA_TEXT, text)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        true
      } catch (error: Exception) {
        // E.g. Android 12+ refuses to start foreground services while the app is in the background.
        false
      }
    }

    Function("stopBackgroundWork") {
      val context = appContext.reactContext ?: return@Function false
      try {
        context.startService(Intent(context, ReceiptWorkService::class.java).setAction(ReceiptWorkService.ACTION_STOP))
      } catch (_: Exception) {
        context.stopService(Intent(context, ReceiptWorkService::class.java))
      }
      true
    }
  }
}
