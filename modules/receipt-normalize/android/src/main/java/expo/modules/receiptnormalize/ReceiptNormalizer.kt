package expo.modules.receiptnormalize

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Turns a gallery photo of a receipt into a document-scanner style black-and-white image:
 * EXIF-upright, at most [MAX_SIDE] px, grayscale, uneven lighting/shadows divided out against an
 * estimated paper background, then a levels stretch so ink is near black and paper is white.
 * It is a soft (grayscale) result rather than a hard threshold, so thin thermal-printer strokes survive.
 */
object ReceiptNormalizer {
  private const val MAX_SIDE = 2048
  private const val BLOCK = 24

  fun normalize(context: Context, uri: Uri): Uri =
    try {
      normalizeOrThrow(context, uri)
    } catch (error: OutOfMemoryError) {
      // Surface as a normal rejection so JS falls back to OCR on the original photo.
      throw IllegalStateException("Not enough memory to normalize receipt image", error)
    }

  private fun normalizeOrThrow(context: Context, uri: Uri): Uri {
    val source = decodeUpright(context, uri)
    val width = source.width
    val height = source.height
    val pixels = IntArray(width * height)
    source.getPixels(pixels, 0, width, 0, 0, width, height)
    source.recycle()

    val gray = IntArray(pixels.size)
    for (i in pixels.indices) {
      val p = pixels[i]
      gray[i] = (((p shr 16) and 0xFF) * 299 + ((p shr 8) and 0xFF) * 587 + (p and 0xFF) * 114) / 1000
    }

    val background = estimateBackground(gray, width, height)

    // Divide by the local paper brightness: shadows and gradients become flat white paper (in place).
    val flat = gray
    val histogram = IntArray(256)
    for (i in gray.indices) {
      val v = min(255, gray[i] * 255 / max(1, background[i]))
      flat[i] = v
      histogram[v]++
    }

    // Levels: ink (darkest ~1.5%, capped) to black, anything within ~8% of paper to white.
    var black = 0
    var seen = 0
    val darkTarget = (flat.size * 0.015).toInt()
    while (black < 255 && seen + histogram[black] < darkTarget) {
      seen += histogram[black]
      black++
    }
    black = min(black, 140)
    val white = 235
    val range = max(1, white - black)
    for (i in flat.indices) {
      val v = ((flat[i] - black) * 255 / range).coerceIn(0, 255)
      pixels[i] = (0xFF shl 24) or (v shl 16) or (v shl 8) or v
    }

    val output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    output.setPixels(pixels, 0, width, 0, 0, width, height)
    val file = File(context.cacheDir, "receipt-normalized-${System.currentTimeMillis()}.jpg")
    FileOutputStream(file).use { output.compress(Bitmap.CompressFormat.JPEG, 92, it) }
    output.recycle()
    return Uri.fromFile(file)
  }

  /** Paper brightness per pixel: per-block maximum (ignores dark text), smoothed, bilinearly upsampled. */
  private fun estimateBackground(gray: IntArray, width: Int, height: Int): IntArray {
    val cols = (width + BLOCK - 1) / BLOCK
    val rows = (height + BLOCK - 1) / BLOCK
    val blocks = IntArray(cols * rows)
    for (y in 0 until height) {
      val by = y / BLOCK
      for (x in 0 until width) {
        val idx = by * cols + x / BLOCK
        val v = gray[y * width + x]
        if (v > blocks[idx]) blocks[idx] = v
      }
    }

    // 3x3 mean smoothing on the block grid so single bright specks do not create halos.
    val smooth = IntArray(blocks.size)
    for (by in 0 until rows) {
      for (bx in 0 until cols) {
        var sum = 0
        var n = 0
        for (dy in -1..1) for (dx in -1..1) {
          val yy = by + dy
          val xx = bx + dx
          if (yy in 0 until rows && xx in 0 until cols) {
            sum += blocks[yy * cols + xx]
            n++
          }
        }
        smooth[by * cols + bx] = sum / n
      }
    }

    val out = IntArray(width * height)
    for (y in 0 until height) {
      val fy = ((y + 0.5f) / BLOCK - 0.5f).coerceIn(0f, (rows - 1).toFloat())
      val y0 = fy.toInt()
      val y1 = min(y0 + 1, rows - 1)
      val ty = fy - y0
      for (x in 0 until width) {
        val fx = ((x + 0.5f) / BLOCK - 0.5f).coerceIn(0f, (cols - 1).toFloat())
        val x0 = fx.toInt()
        val x1 = min(x0 + 1, cols - 1)
        val tx = fx - x0
        val top = smooth[y0 * cols + x0] * (1 - tx) + smooth[y0 * cols + x1] * tx
        val bottom = smooth[y1 * cols + x0] * (1 - tx) + smooth[y1 * cols + x1] * tx
        out[y * width + x] = (top * (1 - ty) + bottom * ty).roundToInt()
      }
    }
    return out
  }

  private fun open(context: Context, uri: Uri): InputStream =
    context.contentResolver.openInputStream(uri) ?: throw IllegalArgumentException("Cannot open $uri")

  private fun decodeUpright(context: Context, uri: Uri): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    open(context, uri).use { BitmapFactory.decodeStream(it, null, bounds) }
    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Not an image: $uri" }

    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_SIDE) sample *= 2
    val decoded = open(context, uri).use {
      BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
    } ?: throw IllegalArgumentException("Cannot decode $uri")

    val orientation = try {
      open(context, uri).use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
    } catch (_: Exception) {
      ExifInterface.ORIENTATION_NORMAL
    }

    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.postRotate(90f); matrix.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.postRotate(270f); matrix.postScale(-1f, 1f) }
    }
    val longest = max(decoded.width, decoded.height)
    if (longest > MAX_SIDE) {
      val scale = MAX_SIDE.toFloat() / longest
      matrix.postScale(scale, scale)
    }
    if (matrix.isIdentity) return decoded
    val upright = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
    if (upright !== decoded) decoded.recycle()
    return upright
  }
}
