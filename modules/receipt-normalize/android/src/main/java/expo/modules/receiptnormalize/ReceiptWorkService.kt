package expo.modules.receiptnormalize

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Foreground service that keeps Silo running while the Receipt Inbox reads receipts, so the app can be
 * put away or the screen turned off. Shows an ongoing "Reading receipts" notification and holds a
 * partial wake lock (bounded, renewed on each progress update) until JS stops it.
 */
class ReceiptWorkService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      releaseWakeLock()
      stopForegroundCompat()
      stopSelf()
      return START_NOT_STICKY
    }
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Reading receipts"
    val notification = buildNotification(this, text)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    acquireWakeLock()
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseWakeLock()
    super.onDestroy()
  }

  private fun acquireWakeLock() {
    val lock = wakeLock ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "silo:receipt-work")
      .also { it.setReferenceCounted(false); wakeLock = it }
    // Bounded so a forgotten stop can't drain the battery; each progress update renews it.
    lock.acquire(WAKE_LOCK_TIMEOUT_MS)
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
    else @Suppress("DEPRECATION") stopForeground(true)
  }

  companion object {
    const val ACTION_STOP = "silo.receipt-work.stop"
    const val EXTRA_TEXT = "text"
    private const val CHANNEL_ID = "receipt-work"
    private const val NOTIFICATION_ID = 4107
    private const val WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000L

    fun buildNotification(context: Context, text: String): Notification {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Receipt reading", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while Silo reads receipts in the background"
          }
        )
      }
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val contentIntent = launch?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(context, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION") Notification.Builder(context)
      }
      return builder
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle("Silo")
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(contentIntent)
        .build()
    }
  }
}
