package expo.modules.receiptnormalize

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Downloads Silo AI model files in a foreground service, so the download keeps going with Silo in the background,
 * the screen off or the app swiped away. The notification shows a progress bar with Pause / Cancel (Resume / Cancel
 * while paused). Downloads resume from the partial file with an HTTP Range request: after a pause, a lost connection
 * or Silo being killed. When the last byte arrives the file is checked against its SHA-256 before it is reported done.
 *
 * One download at a time. State is kept in SharedPreferences so JS can pick it up after Silo was killed, and is sent
 * to JS as "onModelDownload" events while the app is running.
 */
class ModelDownloadService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  @Volatile private var worker: Thread? = null
  @Volatile private var job: Job? = null
  /** Set by pause/cancel/timeout; the worker stops at the next buffer and reports it. */
  @Volatile private var stopRequest: String? = null
  @Volatile private var stopReason: String? = null
  /** The open transfer, closed on pause/cancel so a read stuck on a stalled connection returns at once. */
  @Volatile private var activeConnection: HttpURLConnection? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START, ACTION_RESUME -> {
        val next = (if (intent.action == ACTION_RESUME) loadJob(this, intent.getStringExtra(EXTRA_ID)) else Job.fromIntent(intent))
        if (next == null) {
          // Started as a foreground service (Resume tap): Android requires startForeground even to stop at once.
          if (worker?.isAlive != true) {
            startForegroundCompat(checkingNotification(Job("unknown", "", "", "Silo", null, null, null, false, false)))
            stopForegroundCompat(removeNotification = true)
            notificationManager(this).cancel(NOTIFICATION_ID)
          }
          stopIfIdle()
          return START_NOT_STICKY
        }
        val running = job
        if (running != null && worker?.isAlive == true) {
          // Already downloading this file (JS re-attaching after a relaunch): nothing to do.
          if (running.id != next.id) publish(next, STATUS_FAILED, error = "Another download is running.")
          return START_NOT_STICKY
        }
        begin(next, restart = intent.getBooleanExtra(EXTRA_RESTART, false))
      }
      ACTION_PAUSE -> {
        requestStop(intent.getStringExtra(EXTRA_ID), STATUS_PAUSED, intent.getStringExtra(EXTRA_REASON) ?: DEFAULT_PAUSE_REASON)
        stopIfIdle()
      }
      ACTION_CANCEL -> {
        val id = intent.getStringExtra(EXTRA_ID)
        if (job?.id == id && worker?.isAlive == true) {
          requestStop(id, STATUS_CANCELLED, null)
        } else {
          // Paused or finished: drop the partial file and the notification without starting a download.
          loadJob(this, id)?.let { cancelStopped(it) }
          stopIfIdle()
        }
      }
      ACTION_DISMISS -> {
        notificationManager(this).cancel(NOTIFICATION_ID)
        stopIfIdle()
      }
      else -> stopIfIdle()
    }
    return START_NOT_STICKY
  }

  /** Android 15+: dataSync services get about 6 hours a day. Pause instead of being stopped mid-write. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    requestStop(job?.id, STATUS_PAUSED, "Paused by Android after a long download. Tap Resume to continue.")
  }

  override fun onDestroy() {
    stopRequest = stopRequest ?: STATUS_PAUSED
    releaseWakeLock()
    super.onDestroy()
  }

  private fun begin(next: Job, restart: Boolean) {
    job = next
    stopRequest = null
    stopReason = null
    saveJob(this, next)
    val existing = if (restart) 0L else File(next.path).length()
    startForegroundCompat(progressNotification(next, existing, next.totalBytes, null, waiting = null))
    acquireWakeLock()
    worker = Thread({ runDownload(next, restart) }, "silo-model-download").also { it.start() }
  }

  private fun startForegroundCompat(notification: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun requestStop(id: String?, kind: String, reason: String?) {
    if (id == null || job?.id != id || worker?.isAlive != true) return
    stopReason = reason
    stopRequest = kind
    // A stalled read would otherwise only notice after the 30 s read timeout. Closing the socket can do network
    // I/O (TLS close), so not on the main thread.
    activeConnection?.let { connection -> Thread { runCatching { connection.disconnect() } }.start() }
  }

  private fun stopIfIdle() {
    if (worker?.isAlive == true) return
    stopForegroundCompat(removeNotification = false)
    stopSelf()
  }

  // ---- The download ------------------------------------------------------------------------------

  private fun runDownload(job: Job, restart: Boolean) {
    val file = File(job.path)
    file.parentFile?.mkdirs()
    if (restart) file.delete()
    var total = job.totalBytes
    var waitingSince = 0L
    var attempt = 0
    publish(job, STATUS_DOWNLOADING, downloaded = file.length(), total = total)

    while (true) {
      if (stopRequest != null) return finishStopped(job, file)

      val waitingFor = when {
        !isOnline() -> "Waiting for a connection"
        job.wifiOnly && isMetered() -> "Waiting for Wi-Fi"
        else -> null
      }
      if (waitingFor != null) {
        if (waitingSince == 0L) waitingSince = System.currentTimeMillis()
        if (System.currentTimeMillis() - waitingSince > MAX_WAIT_MS) {
          stopReason = if (waitingFor == "Waiting for Wi-Fi") "Paused: no Wi-Fi. Tap Resume to continue." else "Paused: no connection. Tap Resume to continue."
          stopRequest = STATUS_PAUSED
          continue
        }
        updateNotification(progressNotification(job, file.length(), total, null, waiting = waitingFor))
        acquireWakeLock()
        publish(job, STATUS_WAITING, downloaded = file.length(), total = total, error = waitingFor)
        sleepQuietly(3_000)
        continue
      }

      val before = file.length()
      val retryMessage: String = try {
        total = transfer(job, file, total)
        // A pause/cancel that closed the socket can look like a clean end of stream.
        if (stopRequest != null) return finishStopped(job, file)
        val expected = total
        if (expected == null || expected <= 0 || file.length() >= expected) break
        "Connection lost, retrying"
      } catch (error: HttpStatusException) {
        if (error.status == 416 && file.length() > 0) {
          // The partial file already has every byte (finished while Silo was away).
          total = file.length()
          break
        }
        if (error.status < 500 && error.status != 408 && error.status != 429) {
          return fail(job, file, "The download server answered ${error.status}.", deletePartial = error.status != 416)
        }
        "Server busy, retrying"
      } catch (error: StoppedException) {
        return finishStopped(job, file)
      } catch (error: IOException) {
        if (stopRequest != null) return finishStopped(job, file)
        "Connection lost, retrying"
      }
      // Dropped connection or a busy server: wait and resume from where the file ends.
      if (file.length() > before) {
        // Bytes arrived before the drop: the wait limit counts from now.
        waitingSince = 0L
        attempt = 0
      }
      attempt += 1
      if (waitingSince == 0L) waitingSince = System.currentTimeMillis()
      if (System.currentTimeMillis() - waitingSince > MAX_WAIT_MS) {
        stopReason = "Paused: the connection kept dropping. Tap Resume to continue."
        stopRequest = STATUS_PAUSED
        continue
      }
      updateNotification(progressNotification(job, file.length(), total, null, waiting = retryMessage))
      publish(job, STATUS_WAITING, downloaded = file.length(), total = total, error = retryMessage)
      sleepQuietly(minOf(30_000L, 2_000L * attempt))
    }

    // Every byte is here: check size and checksum before calling it done.
    if (total != null && total > 0 && file.length() != total) {
      return fail(job, file, "The download ended early (${file.length()} of $total bytes).", deletePartial = file.length() > total)
    }
    if (!job.sha256.isNullOrBlank()) {
      updateNotification(checkingNotification(job))
      publish(job, STATUS_VERIFYING, downloaded = file.length(), total = total)
      val actual = try { sha256(file) } catch (error: StoppedException) { return finishStopped(job, file) }
      if (!actual.equals(job.sha256, ignoreCase = true)) {
        return fail(job, file, "The downloaded file is damaged. Download it again.", deletePartial = true)
      }
    }
    publish(job, STATUS_DONE, downloaded = file.length(), total = file.length())
    releaseWakeLock()
    stopForegroundCompat(removeNotification = true)
    if (!ModelDownloadEvents.appInForeground) {
      notificationManager(this).notify(NOTIFICATION_ID, doneNotification(job))
    }
    worker = null
    stopSelf()
  }

  /** Downloads the rest of the file. Returns the total size. */
  private fun transfer(job: Job, file: File, knownTotal: Long?): Long? {
    var offset = file.length()
    if (knownTotal != null && knownTotal > 0 && offset >= knownTotal) throw HttpStatusException(416)
    val connection = open(job.url, offset)
    activeConnection = connection
    try {
      val status = connection.responseCode
      if (status == 416) throw HttpStatusException(416)
      if (status !in 200..299) throw HttpStatusException(status)
      if (status == 200 && offset > 0) {
        // The server ignored the Range header: start over.
        offset = 0
      }
      val length = connection.getHeaderField("Content-Length")?.toLongOrNull()
      val rangeTotal = connection.getHeaderField("Content-Range")?.substringAfter('/')?.toLongOrNull()
      val total = rangeTotal ?: length?.let { offset + it } ?: knownTotal

      RandomAccessFile(file, "rw").use { out ->
        out.setLength(offset)
        out.seek(offset)
        connection.inputStream.use { input ->
          val buffer = ByteArray(1 shl 16)
          var written = offset
          var lastUpdate = 0L
          var speedBytes = written
          var speedAt = System.currentTimeMillis()
          var bytesPerSecond: Double? = null
          while (true) {
            if (stopRequest != null) throw StoppedException()
            val read = input.read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
            written += read
            val now = System.currentTimeMillis()
            if (now - speedAt >= 2_000) {
              bytesPerSecond = (written - speedBytes) * 1000.0 / (now - speedAt)
              speedBytes = written
              speedAt = now
            }
            if (now - lastUpdate >= PROGRESS_INTERVAL_MS) {
              lastUpdate = now
              acquireWakeLock()
              updateNotification(progressNotification(job, written, total, bytesPerSecond, waiting = null))
              publish(job, STATUS_DOWNLOADING, downloaded = written, total = total, bytesPerSecond = bytesPerSecond, persist = false)
            }
          }
        }
      }
      return total
    } finally {
      activeConnection = null
      connection.disconnect()
    }
  }

  /** Follows redirects by hand so the Range header goes to the final host too. */
  private fun open(url: String, offset: Long): HttpURLConnection {
    var current = URL(url)
    repeat(MAX_REDIRECTS) {
      val connection = current.openConnection() as HttpURLConnection
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 20_000
      connection.readTimeout = 30_000
      connection.setRequestProperty("User-Agent", "Silo-Android")
      connection.setRequestProperty("Accept-Encoding", "identity")
      if (offset > 0) connection.setRequestProperty("Range", "bytes=$offset-")
      val status = connection.responseCode
      if (status in 300..399 && status != 304) {
        val location = connection.getHeaderField("Location") ?: throw IOException("Redirect without a location")
        connection.disconnect()
        val next = URL(current, location)
        if (next.protocol != "https") throw IOException("Refusing a non-HTTPS redirect")
        current = next
        return@repeat
      }
      return connection
    }
    throw IOException("Too many redirects")
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(1 shl 20)
      while (true) {
        if (stopRequest != null) throw StoppedException()
        val read = input.read(buffer)
        if (read <= 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun finishStopped(job: Job, file: File) {
    val kind = stopRequest ?: STATUS_PAUSED
    releaseWakeLock()
    if (kind == STATUS_CANCELLED) {
      file.delete()
      publish(job, STATUS_CANCELLED, downloaded = 0, total = job.totalBytes)
      stopForegroundCompat(removeNotification = true)
    } else {
      publish(job, STATUS_PAUSED, downloaded = file.length(), total = job.totalBytes, error = stopReason)
      stopForegroundCompat(removeNotification = true)
      notificationManager(this).notify(NOTIFICATION_ID, pausedNotification(job, file.length(), stopReason))
    }
    worker = null
    stopSelf()
  }

  private fun cancelStopped(job: Job) {
    File(job.path).delete()
    notificationManager(this).cancel(NOTIFICATION_ID)
    publish(job, STATUS_CANCELLED, downloaded = 0, total = job.totalBytes)
  }

  private fun fail(job: Job, file: File, message: String, deletePartial: Boolean) {
    if (deletePartial) file.delete()
    releaseWakeLock()
    publish(job, STATUS_FAILED, downloaded = file.length(), total = job.totalBytes, error = message)
    stopForegroundCompat(removeNotification = true)
    notificationManager(this).notify(NOTIFICATION_ID, failedNotification(job, message))
    worker = null
    stopSelf()
  }

  // ---- State and events ---------------------------------------------------------------------------

  private fun publish(
    job: Job,
    status: String,
    downloaded: Long = 0,
    total: Long? = null,
    bytesPerSecond: Double? = null,
    error: String? = null,
    persist: Boolean = true,
  ) {
    val state = mapOf(
      "id" to job.id,
      "status" to status,
      "path" to job.path,
      "downloadedBytes" to downloaded.toDouble(),
      "totalBytes" to total?.toDouble(),
      "bytesPerSecond" to bytesPerSecond,
      "message" to error,
    )
    if (status == STATUS_PAUSED || status == STATUS_DONE || status == STATUS_FAILED || status == STATUS_CANCELLED) {
      if (ModelDownloadEvents.activeId == job.id) ModelDownloadEvents.activeId = null
    } else {
      ModelDownloadEvents.activeId = job.id
    }
    if (persist) saveState(this, job.id, state)
    ModelDownloadEvents.emit(state)
  }

  private fun isOnline(): Boolean {
    val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
      return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
    @Suppress("DEPRECATION")
    return manager.activeNetworkInfo?.isConnected == true
  }

  private fun isMetered(): Boolean =
    (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).isActiveNetworkMetered

  // ---- Notifications ------------------------------------------------------------------------------

  private fun updateNotification(notification: Notification) {
    notificationManager(this).notify(NOTIFICATION_ID, notification)
  }

  private fun baseBuilder(job: Job): NotificationCompat.Builder {
    ensureChannel(this)
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(job.title)
      .setContentIntent(contentIntent)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
  }

  private fun progressNotification(job: Job, downloaded: Long, total: Long?, bytesPerSecond: Double?, waiting: String?): Notification {
    val percent = if (total != null && total > 0) ((downloaded * 100) / total).toInt().coerceIn(0, 100) else 0
    val sizeText = if (total != null && total > 0) "${megabytes(downloaded)} of ${megabytes(total)} MB" else "${megabytes(downloaded)} MB"
    val detail = waiting ?: bytesPerSecond?.takeIf { it > 0 }?.let { "%.1f MB/s".format(it / 1_000_000.0) }
    val builder = baseBuilder(job)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentText(if (detail != null) "$sizeText · $detail" else sizeText)
      .setSubText("$percent%")
      .setProgress(100, percent, total == null || total <= 0)
      .setOngoing(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    if (job.pausable) builder.addAction(0, "Pause", serviceIntent(ACTION_PAUSE, job.id, 1))
    builder.addAction(0, "Cancel", serviceIntent(ACTION_CANCEL, job.id, 2))
    return builder.build()
  }

  private fun checkingNotification(job: Job): Notification =
    baseBuilder(job)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentText("Checking the download")
      .setProgress(0, 0, true)
      .setOngoing(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()

  private fun pausedNotification(job: Job, downloaded: Long, reason: String?): Notification {
    val total = job.totalBytes
    val percent = if (total != null && total > 0) ((downloaded * 100) / total).toInt().coerceIn(0, 100) else 0
    val sizeText = if (total != null && total > 0) "${megabytes(downloaded)} of ${megabytes(total)} MB" else "${megabytes(downloaded)} MB"
    // "Downloading X" -> "X paused"; the reason (no Wi-Fi, Android's time limit, ...) goes under the size.
    val title = job.title.removePrefix("Downloading ").let { name -> "${name.replaceFirstChar { it.uppercase() }} paused" }
    val detail = reason?.takeIf { it != DEFAULT_PAUSE_REASON }
    val text = if (detail != null) "$sizeText · $detail" else "$sizeText · Tap Resume to continue."
    return baseBuilder(job)
      .setContentTitle(title)
      .setSmallIcon(android.R.drawable.stat_sys_download_done)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setSubText("$percent%")
      .setProgress(100, percent, false)
      .setOngoing(false)
      .setDeleteIntent(serviceIntent(ACTION_DISMISS, job.id, 5))
      .addAction(0, "Resume", serviceIntent(ACTION_RESUME, job.id, 3))
      .addAction(0, "Cancel", serviceIntent(ACTION_CANCEL, job.id, 4))
      .build()
  }

  private fun doneNotification(job: Job): Notification =
    baseBuilder(job)
      .setSmallIcon(android.R.drawable.stat_sys_download_done)
      .setContentTitle(job.doneTitle ?: "Download complete")
      .setContentText("Open Silo to finish setting it up.")
      .setAutoCancel(true)
      .build()

  private fun failedNotification(job: Job, message: String): Notification =
    baseBuilder(job)
      .setSmallIcon(android.R.drawable.stat_notify_error)
      .setContentText(message)
      .setStyle(NotificationCompat.BigTextStyle().bigText(message))
      .setAutoCancel(true)
      .build()

  private fun serviceIntent(action: String, id: String, requestCode: Int): PendingIntent {
    val intent = Intent(this, ModelDownloadService::class.java).setAction(action).putExtra(EXTRA_ID, id)
    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    // Resume starts a download, so Android needs it as a foreground-service start (allowed from a notification tap).
    return if (action == ACTION_RESUME && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      PendingIntent.getForegroundService(this, requestCode, intent, flags)
    } else {
      PendingIntent.getService(this, requestCode, intent, flags)
    }
  }

  // ---- Wake lock / foreground -----------------------------------------------------------------------

  private fun acquireWakeLock() {
    val lock = wakeLock ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "silo:model-download")
      .also { it.setReferenceCounted(false); wakeLock = it }
    // Bounded; renewed with each progress update while bytes keep arriving.
    lock.acquire(WAKE_LOCK_TIMEOUT_MS)
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  private fun stopForegroundCompat(removeNotification: Boolean) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(if (removeNotification) STOP_FOREGROUND_REMOVE else STOP_FOREGROUND_DETACH)
    } else {
      @Suppress("DEPRECATION") stopForeground(removeNotification)
    }
  }

  private fun sleepQuietly(ms: Long) {
    val until = System.currentTimeMillis() + ms
    while (System.currentTimeMillis() < until && stopRequest == null) {
      try { Thread.sleep(250) } catch (_: InterruptedException) { return }
    }
  }

  private class HttpStatusException(val status: Int) : IOException("HTTP $status")
  private class StoppedException : IOException("stopped")

  data class Job(
    val id: String,
    val url: String,
    val path: String,
    val title: String,
    val doneTitle: String?,
    val totalBytes: Long?,
    val sha256: String?,
    val wifiOnly: Boolean,
    val pausable: Boolean,
  ) {
    fun toJson(): String = JSONObject()
      .put("id", id).put("url", url).put("path", path).put("title", title).put("doneTitle", doneTitle)
      .put("totalBytes", totalBytes ?: -1L).put("sha256", sha256).put("wifiOnly", wifiOnly).put("pausable", pausable)
      .toString()

    companion object {
      fun fromJson(text: String): Job? = try {
        val o = JSONObject(text)
        Job(
          id = o.getString("id"),
          url = o.getString("url"),
          path = o.getString("path"),
          title = o.optString("title", "Downloading"),
          doneTitle = o.optString("doneTitle").takeIf { it.isNotBlank() && it != "null" },
          totalBytes = o.optLong("totalBytes", -1L).takeIf { it > 0 },
          sha256 = o.optString("sha256").takeIf { it.isNotBlank() && it != "null" },
          wifiOnly = o.optBoolean("wifiOnly", false),
          pausable = o.optBoolean("pausable", true),
        )
      } catch (_: Exception) {
        null
      }

      fun fromIntent(intent: Intent): Job? = intent.getStringExtra(EXTRA_JOB)?.let { fromJson(it) }
    }
  }

  companion object {
    const val ACTION_START = "silo.model-download.start"
    const val ACTION_RESUME = "silo.model-download.resume"
    const val ACTION_PAUSE = "silo.model-download.pause"
    const val ACTION_CANCEL = "silo.model-download.cancel"
    const val ACTION_DISMISS = "silo.model-download.dismiss"
    const val EXTRA_ID = "id"
    const val EXTRA_JOB = "job"
    const val EXTRA_RESTART = "restart"
    const val EXTRA_REASON = "reason"
    private const val DEFAULT_PAUSE_REASON = "Paused."

    const val STATUS_DOWNLOADING = "downloading"
    const val STATUS_WAITING = "waiting"
    const val STATUS_VERIFYING = "verifying"
    const val STATUS_PAUSED = "paused"
    const val STATUS_DONE = "done"
    const val STATUS_FAILED = "failed"
    const val STATUS_CANCELLED = "cancelled"

    private const val CHANNEL_ID = "model-download"
    const val NOTIFICATION_ID = 4108
    private const val PREFS = "silo-model-download"
    private const val WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000L
    private const val PROGRESS_INTERVAL_MS = 1_000L
    private const val MAX_WAIT_MS = 10 * 60 * 1000L
    private const val MAX_REDIRECTS = 6

    private fun megabytes(bytes: Long): String = (bytes / 1_000_000L).toString()

    fun notificationManager(context: Context) = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = notificationManager(context)
      if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "AI model downloads", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Progress of Silo AI model downloads"
          },
        )
      }
    }

    fun saveJob(context: Context, job: Job) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("job:${job.id}", job.toJson()).apply()
    }

    fun loadJob(context: Context, id: String?): Job? {
      if (id == null) return null
      return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("job:$id", null)?.let { Job.fromJson(it) }
    }

    private fun saveState(context: Context, id: String, state: Map<String, Any?>) {
      val json = JSONObject()
      state.forEach { (key, value) -> json.put(key, value ?: JSONObject.NULL) }
      json.put("updatedAt", System.currentTimeMillis().toDouble())
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("state:$id", json.toString()).apply()
    }

    /** Last known state of a download (also after Silo was killed), with the partial file's real size. */
    fun readState(context: Context, id: String): Map<String, Any?>? {
      val text = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("state:$id", null) ?: return null
      return try {
        val o = JSONObject(text)
        val path = o.optString("path")
        val size = File(path).takeIf { it.isFile }?.length() ?: 0L
        mapOf(
          "id" to id,
          "status" to o.optString("status"),
          "path" to path,
          "downloadedBytes" to size.toDouble(),
          "totalBytes" to o.optDouble("totalBytes").takeIf { !it.isNaN() },
          "message" to o.optString("message").takeIf { it.isNotBlank() && it != "null" },
          "updatedAt" to o.optDouble("updatedAt"),
        )
      } catch (_: Exception) {
        null
      }
    }
  }
}

/** Hands service events to the Expo module while the app is running. */
object ModelDownloadEvents {
  /** Id of the download whose bytes are moving in this process, if any. */
  @Volatile var activeId: String? = null
  @Volatile var listener: ((Map<String, Any?>) -> Unit)? = null
  @Volatile var appInForeground: Boolean = false

  fun emit(state: Map<String, Any?>) {
    try {
      listener?.invoke(state)
    } catch (_: Exception) {
      // JS not ready; the state is also saved for getModelDownload.
    }
  }
}
