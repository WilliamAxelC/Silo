package expo.modules.receiptnormalize

import android.net.Uri
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
  }
}
