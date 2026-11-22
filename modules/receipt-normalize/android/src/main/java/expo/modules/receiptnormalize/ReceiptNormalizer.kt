package expo.modules.receiptnormalize

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * Turns a gallery photo of a receipt into a document-scanner style black-and-white image:
 * EXIF-upright, the receipt found (brightest large paper-shaped region), cropped and perspective-corrected,
 * at most [MAX_SIDE] px, grayscale, uneven lighting/shadows divided out against an
 * estimated paper background, then a levels stretch so ink is near black and paper is white.
 * It is a soft (grayscale) result rather than a hard threshold, so thin thermal-printer strokes survive.
 */
object ReceiptNormalizer {
  private const val MAX_SIDE = 2048
  private const val BLOCK = 24
  private const val DETECT_SIDE = 640

  fun normalize(context: Context, uri: Uri): Uri =
    try {
      normalizeOrThrow(context, uri)
    } catch (error: OutOfMemoryError) {
      // Surface as a normal rejection so JS falls back to OCR on the original photo.
      throw IllegalStateException("Not enough memory to normalize receipt image", error)
    }

  private fun normalizeOrThrow(context: Context, uri: Uri): Uri {
    val upright = decodeUpright(context, uri)
    val quad = detectDocumentQuad(upright)
    val source = if (quad != null) warpToRectangle(upright, quad) else upright
    if (source !== upright) upright.recycle()
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
    FileOutputStream(file).use { output.compress(Bitmap.CompressFormat.JPEG, 85, it) }
    output.recycle()
    return Uri.fromFile(file)
  }

  /**
   * Finds the receipt as the largest bright region (Otsu threshold on a blurred, downscaled grayscale
   * image, gaps from printed text closed), and returns its corners [tl, tr, br, bl] in full-size pixels.
   * Returns null when no convincing paper-shaped region is found, so the photo is used uncropped.
   */
  private fun detectDocumentQuad(bitmap: Bitmap): FloatArray? {
    val scale = min(1f, DETECT_SIDE.toFloat() / max(bitmap.width, bitmap.height))
    val w = max(8, (bitmap.width * scale).roundToInt())
    val h = max(8, (bitmap.height * scale).roundToInt())
    val small = Bitmap.createScaledBitmap(bitmap, w, h, true)
    val px = IntArray(w * h)
    small.getPixels(px, 0, w, 0, 0, w, h)
    if (small !== bitmap) small.recycle()

    // Grayscale + 5x5 box blur through an integral image.
    val integral = LongArray((w + 1) * (h + 1))
    for (y in 0 until h) {
      var rowSum = 0L
      for (x in 0 until w) {
        val p = px[y * w + x]
        rowSum += (((p shr 16) and 0xFF) * 299 + ((p shr 8) and 0xFF) * 587 + (p and 0xFF) * 114) / 1000
        integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + rowSum
      }
    }
    val blurred = IntArray(w * h)
    val histogram = IntArray(256)
    for (y in 0 until h) {
      val y0 = max(0, y - 2); val y1 = min(h, y + 3)
      for (x in 0 until w) {
        val x0 = max(0, x - 2); val x1 = min(w, x + 3)
        val sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0]
        val v = (sum / ((y1 - y0) * (x1 - x0))).toInt().coerceIn(0, 255)
        blurred[y * w + x] = v
        histogram[v]++
      }
    }

    // Otsu threshold: receipts are bright paper.
    val total = w * h
    var sumAll = 0.0
    for (i in 0..255) sumAll += i.toDouble() * histogram[i]
    var sumB = 0.0; var weightB = 0; var bestVar = -1.0; var threshold = 128
    for (t in 0..255) {
      weightB += histogram[t]
      if (weightB == 0) continue
      val weightF = total - weightB
      if (weightF == 0) break
      sumB += t.toDouble() * histogram[t]
      val meanB = sumB / weightB
      val meanF = (sumAll - sumB) / weightF
      val between = weightB.toDouble() * weightF * (meanB - meanF) * (meanB - meanF)
      if (between > bestVar) { bestVar = between; threshold = t }
    }
    var mask = BooleanArray(total) { blurred[it] > threshold }
    val radius = max(2, w / 60)
    mask = erode(dilate(mask, w, h, radius), w, h, radius)

    // Largest 4-connected bright component, tracking its extreme corners.
    val seen = BooleanArray(total)
    val stack = IntArray(total)
    var bestCount = 0
    var bestEdges = 0
    var best = FloatArray(0)
    for (start in 0 until total) {
      if (!mask[start] || seen[start]) continue
      var top = 0; stack[top++] = start; seen[start] = true
      var count = 0
      var minSum = Int.MAX_VALUE; var maxSum = Int.MIN_VALUE; var minDiff = Int.MAX_VALUE; var maxDiff = Int.MIN_VALUE
      var tl = 0; var br = 0; var tr = 0; var bl = 0
      var minX = w; var minY = h; var maxX = 0; var maxY = 0
      while (top > 0) {
        val i = stack[--top]
        count++
        val x = i % w; val y = i / w
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        val sum = x + y; val diff = x - y
        if (sum < minSum) { minSum = sum; tl = i }
        if (sum > maxSum) { maxSum = sum; br = i }
        if (diff > maxDiff) { maxDiff = diff; tr = i }
        if (diff < minDiff) { minDiff = diff; bl = i }
        if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = true; stack[top++] = i - 1 }
        if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = true; stack[top++] = i + 1 }
        if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = true; stack[top++] = i - w }
        if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = true; stack[top++] = i + w }
      }
      if (count > bestCount) {
        bestCount = count
        // Paper touching two or more image edges already fills the frame (or isn't separable): don't crop.
        val mx = 0.02f * w; val my = 0.02f * h
        bestEdges = (if (minX <= mx) 1 else 0) + (if (minY <= my) 1 else 0) +
          (if (maxX >= w - 1 - mx) 1 else 0) + (if (maxY >= h - 1 - my) 1 else 0)
        best = floatArrayOf(
          (tl % w).toFloat(), (tl / w).toFloat(), (tr % w).toFloat(), (tr / w).toFloat(),
          (br % w).toFloat(), (br / w).toFloat(), (bl % w).toFloat(), (bl / w).toFloat(),
        )
      }
    }
    val areaRatio = bestCount.toFloat() / total
    if (best.isEmpty() || areaRatio < 0.12f || areaRatio > 0.92f || bestEdges >= 2) return null
    // The four extremes must describe the region: a paper-shaped quad covers about the same area.
    val quadArea = abs(
      (best[0] * best[3] - best[2] * best[1]) + (best[2] * best[5] - best[4] * best[3]) +
        (best[4] * best[7] - best[6] * best[5]) + (best[6] * best[1] - best[0] * best[7])
    ) / 2f
    val fit = quadArea / bestCount
    if (fit < 0.8f || fit > 1.25f) return null
    val inv = 1f / scale
    return FloatArray(8) { best[it] * inv }
  }

  private fun dilate(mask: BooleanArray, w: Int, h: Int, r: Int): BooleanArray = morph(mask, w, h, r, true)
  private fun erode(mask: BooleanArray, w: Int, h: Int, r: Int): BooleanArray = morph(mask, w, h, r, false)

  /** Separable square max (dilate) / min (erode) filter on a binary mask using running counts. */
  private fun morph(mask: BooleanArray, w: Int, h: Int, r: Int, grow: Boolean): BooleanArray {
    val horizontal = BooleanArray(mask.size)
    for (y in 0 until h) {
      var count = 0
      val row = y * w
      for (x in -r until w + r) {
        val add = x + r
        if (add < w && mask[row + add] == grow) count++
        val drop = x - r - 1
        if (drop >= 0 && mask[row + drop] == grow) count--
        if (x in 0 until w) horizontal[row + x] = if (grow) count > 0 else count == 0
      }
    }
    val out = BooleanArray(mask.size)
    for (x in 0 until w) {
      var count = 0
      for (y in -r until h + r) {
        val add = y + r
        if (add < h && horizontal[add * w + x] == grow) count++
        val drop = y - r - 1
        if (drop >= 0 && horizontal[drop * w + x] == grow) count--
        if (y in 0 until h) out[y * w + x] = if (grow) count > 0 else count == 0
      }
    }
    return out
  }

  /** Perspective-corrects the quad [tl, tr, br, bl] into an upright rectangle (at most MAX_SIDE). */
  private fun warpToRectangle(source: Bitmap, q: FloatArray): Bitmap {
    var outW = max(hypot(q[2] - q[0], q[3] - q[1]), hypot(q[4] - q[6], q[5] - q[7]))
    var outH = max(hypot(q[6] - q[0], q[7] - q[1]), hypot(q[4] - q[2], q[5] - q[3]))
    val longest = max(outW, outH)
    if (longest > MAX_SIDE) {
      outW *= MAX_SIDE / longest
      outH *= MAX_SIDE / longest
    }
    val width = max(16, outW.roundToInt())
    val height = max(16, outH.roundToInt())
    val matrix = Matrix()
    val ok = matrix.setPolyToPoly(
      q, 0,
      floatArrayOf(0f, 0f, width.toFloat(), 0f, width.toFloat(), height.toFloat(), 0f, height.toFloat()), 0,
      4,
    )
    if (!ok) return source
    val out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    Canvas(out).drawBitmap(source, matrix, Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
    return out
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
