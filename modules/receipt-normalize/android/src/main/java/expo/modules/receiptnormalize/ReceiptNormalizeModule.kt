package expo.modules.receiptnormalize

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Parcelable
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.security.MessageDigest
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

    // ---- In-app updates (sideloaded APK) ----------------------------------------------------------

    // SHA-256 of a downloaded file, hex. Runs off the JS thread (a 40 MB APK takes well under a second).
    AsyncFunction("sha256File") { uri: String ->
      val file = fileFromUri(uri) ?: throw IllegalArgumentException("not a local file")
      val digest = MessageDigest.getInstance("SHA-256")
      file.inputStream().use { input ->
        val buffer = ByteArray(1 shl 16)
        while (true) {
          val read = input.read(buffer)
          if (read <= 0) break
          digest.update(buffer, 0, read)
        }
      }
      digest.digest().joinToString("") { "%02x".format(it) }
    }

    // Whether Android lets Silo open the package installer ("Install unknown apps" for Silo).
    Function("canInstallPackages") {
      val context = appContext.reactContext ?: return@Function false
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.packageManager.canRequestPackageInstalls() else true
    }

    Function("openInstallPermissionSettings") {
      val context = appContext.reactContext ?: return@Function false
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
      else Intent(Settings.ACTION_SECURITY_SETTINGS)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      true
    }

    // Reads the APK's package name and version without installing it.
    Function("inspectApk") { uri: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val file = fileFromUri(uri) ?: return@Function null
      @Suppress("DEPRECATION")
      val info = context.packageManager.getPackageArchiveInfo(file.absolutePath, 0) ?: return@Function null
      val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
      mapOf("packageName" to info.packageName, "versionCode" to code.toDouble(), "versionName" to (info.versionName ?: ""))
    }

    // Hands a verified APK in Silo's cache to Android's package installer (the user confirms there).
    Function("installApk") { uri: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val file = fileFromUri(uri) ?: throw IllegalArgumentException("not a local file")
      val cacheRoot = context.cacheDir.canonicalPath
      if (!file.canonicalPath.startsWith(cacheRoot)) throw IllegalArgumentException("APK must be in Silo's cache")
      val contentUri = FileProvider.getUriForFile(context, "${context.packageName}.FileSystemFileProvider", file)
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(contentUri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      true
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

  private fun fileFromUri(uri: String): File? {
    val parsed = Uri.parse(uri)
    val path = if (parsed.scheme == "file") parsed.path else if (parsed.scheme == null) uri else null
    return path?.let { File(it) }?.takeIf { it.isFile }
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

  /**
   * Only content:// shares from other apps. file:// URIs, and content:// URIs served by Silo's own
   * providers, could point at Silo's private files (its database, for example), so they are refused.
   */
  private fun isAcceptableShare(context: Context, uri: Uri): Boolean {
    if (uri.scheme != "content") return false
    val authority = uri.authority ?: return false
    val ownPackage = context.packageName
    if (authority == ownPackage || authority.startsWith("$ownPackage.")) return false
    return try {
      val provider = context.packageManager.resolveContentProvider(authority, 0)
      provider?.packageName != ownPackage
    } catch (_: Exception) {
      true
    }
  }

  /** True when the file decodes as an image (reads only the header). */
  private fun isDecodableImage(file: File): Boolean {
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, options)
    return options.outWidth > 0 && options.outHeight > 0
  }

  private fun copyToCache(context: Context, uri: Uri, index: Int): String? {
    if (!isAcceptableShare(context, uri)) return null
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
      if (!isDecodableImage(file)) {
        file.delete()
        return null
      }
      Uri.fromFile(file).toString()
    } catch (_: Exception) {
      null
    }
  }
}
