package dev.silo.bench;

import android.app.Activity;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.io.File;
import java.io.FileWriter;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Runs ML Kit text recognition (same path as @react-native-ml-kit/text-recognition: InputImage.fromFilePath,
 * Latin recognizer, per-line frames) over every image in files/in and writes files/out/<id>.json in the
 * bench OCR cache format: {boxes:[{text, box:[[x,y]x4], score}], ms}. Logs "BENCH_DONE" when finished.
 */
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        new Thread(this::runBench).start();
    }

    private void runBench() {
        File in = new File(getExternalFilesDir(null), "in");
        File out = new File(getExternalFilesDir(null), "out");
        out.mkdirs();
        TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        File[] images = in.listFiles();
        if (images == null) images = new File[0];
        Arrays.sort(images);
        for (File image : images) {
            String id = image.getName().replaceFirst("\\.[^.]+$", "");
            File target = new File(out, id + ".json");
            if (target.exists()) continue;
            try {
                long t0 = System.nanoTime();
                InputImage input = InputImage.fromFilePath(this, Uri.fromFile(image));
                Text result = Tasks.await(recognizer.process(input));
                long ms = (System.nanoTime() - t0) / 1_000_000;
                JSONArray boxes = new JSONArray();
                for (Text.TextBlock block : result.getTextBlocks()) {
                    for (Text.Line line : block.getLines()) {
                        Rect r = line.getBoundingBox();
                        if (r == null) continue;
                        JSONArray box = new JSONArray()
                            .put(new JSONArray().put(r.left).put(r.top))
                            .put(new JSONArray().put(r.right).put(r.top))
                            .put(new JSONArray().put(r.right).put(r.bottom))
                            .put(new JSONArray().put(r.left).put(r.bottom));
                        boxes.put(new JSONObject().put("text", line.getText()).put("box", box).put("score", line.getConfidence()));
                    }
                }
                try (FileWriter w = new FileWriter(target)) {
                    w.write(new JSONObject().put("boxes", boxes).put("ms", ms).toString());
                }
                Log.i("BENCH", id + " " + ms + "ms " + boxes.length());
            } catch (Exception e) {
                Log.e("BENCH", id + " failed", e);
            }
        }
        Log.i("BENCH", "BENCH_DONE");
    }
}
