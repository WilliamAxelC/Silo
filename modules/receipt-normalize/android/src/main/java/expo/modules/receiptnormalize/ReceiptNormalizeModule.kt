package expo.modules.receiptnormalize

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Parcelable
import java.io.File
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ReceiptNormalizeModule : Module() {
  /** A share that arrived while Silo was already open (onNewIntent), waiting for JS to take it. */
  private var pendingShare: Intent? = null

  override fun definition() = ModuleDefinition {
    Name("ReceiptNormalize")

    Events("onShareReceived")

    OnNewIntent { intent ->
      if (isImageShare(intent)) {
        pendingShare = intent
        sendEvent("onShareReceived", mapOf("count" to sharedUris(intent).size))
      }
    }

    // Images shared to Silo from another app (Gallery's Share button), copied into the cache right away
    // because the read permission Android grants for them is temporary. Each share is handed out once.
    AsyncFunction("takeSharedImages") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val activity = appContext.currentActivity
      val intent = pendingShare ?: activity?.intent
      pendingShare = null
      if (intent == null || !isImageShare(intent)) return@AsyncFunction emptyList<String>()
      if (activity != null && activity.intent === intent) activity.intent = Intent(Intent.ACTION_MAIN)
      sharedUris(intent).mapIndexedNotNull { index, uri -> copyToCache(context, uri, index) }
    }

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

  private fun isImageShare(intent: Intent): Boolean =
    (intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE) &&
      (intent.type?.startsWith("image/") == true || sharedUris(intent).isNotEmpty())

  private fun sharedUris(intent: Intent): List<Uri> {
    val uris = mutableListOf<Uri>()
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      @Suppress("DEPRECATION")
      val list: ArrayList<Parcelable>? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Parcelable::class.java)
        else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
      list?.forEach { (it as? Uri)?.let(uris::add) }
    } else if (intent.action == Intent.ACTION_SEND) {
      @Suppress("DEPRECATION")
      val single: Uri? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_STREAM)
      single?.let(uris::add)
    }
    if (uris.isEmpty()) {
      intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(uris::add) }
    }
    return uris.distinct()
  }

  private fun copyToCache(context: Context, uri: Uri, index: Int): String? {
    return try {
      val type = context.contentResolver.getType(uri) ?: "image/jpeg"
      val extension = when {
        type.contains("png") -> "png"
        type.contains("webp") -> "webp"
        type.contains("heic") || type.contains("heif") -> "heic"
        else -> "jpg"
      }
      val file = File(context.cacheDir, "shared-receipt-${System.currentTimeMillis()}-$index.$extension")
      val input = context.contentResolver.openInputStream(uri) ?: return null
      input.use { stream -> file.outputStream().use { stream.copyTo(it) } }
      Uri.fromFile(file).toString()
    } catch (_: Exception) {
      null
    }
  }
}
