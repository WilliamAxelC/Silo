# Local CPU rig for bench/eval. Models: https://huggingface.co/unsloth/Qwen3.5-2B-GGUF, https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF
# llama.cpp: prebuilt ubuntu-x64 release from github.com/ggml-org/llama.cpp/releases
export LLAMA_BIN_DIR=/home/agent/.cache/silo-bench/llama
export MODEL_TEXT_2B=/home/agent/.cache/silo-bench/models/Qwen3.5-2B-Q4_K_M.gguf      # what the app ships; sha256 aaf42c8b...9223
export MODEL_TEXT_SMALL=/home/agent/.cache/silo-bench/models/Qwen3.5-0.8B-Q4_K_M.gguf
export MMPROJ_2B=/home/agent/.cache/silo-bench/models/mmproj-2B-F16.gguf
export MMPROJ_SMALL=/home/agent/.cache/silo-bench/models/mmproj-0.8B-F16.gguf
export OCR_VENV=/home/agent/.cache/silo-bench/venv                                     # rapidocr_onnxruntime (PP-OCR ONNX)
export LD_LIBRARY_PATH=$LLAMA_BIN_DIR:${LD_LIBRARY_PATH:-}
