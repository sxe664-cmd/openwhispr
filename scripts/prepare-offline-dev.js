#!/usr/bin/env node

/**
 * Verify the local assets needed by the offline development app.
 *
 * Deliberately does not run download or release-check scripts. Those scripts
 * are useful for preparing a fresh checkout, but they make network requests
 * every time the normal dev lifecycle runs.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const binDir = path.join(projectRoot, "resources", "bin");
const modelDir = path.join(os.homedir(), ".cache", "openwhispr", "whisper-models");

const requiredFiles = [
  path.join(binDir, "whisper-server-win32-x64.exe"),
  path.join(binDir, "qdrant-win32-x64.exe"),
  path.join(binDir, "sherpa-onnx-ws-win32-x64.exe"),
  path.join(binDir, "sherpa-onnx-diarize-win32-x64.exe"),
  path.join(modelDir, "ggml-base.bin"),
];

const diarizationDir = path.join(os.homedir(), ".cache", "openwhispr", "diarization-models");
requiredFiles.push(
  path.join(diarizationDir, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"),
  path.join(diarizationDir, "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx"),
  path.join(diarizationDir, "silero_vad.onnx")
);

const missingFiles = requiredFiles.filter((filePath) => !fs.existsSync(filePath));

if (missingFiles.length > 0) {
  console.error("[offline-dev] Missing local assets:");
  for (const filePath of missingFiles) {
    console.error(`  - ${filePath}`);
  }
  console.error(
    "[offline-dev] Run the relevant download command once while online, then run npm run dev again."
  );
  process.exitCode = 1;
} else {
  console.log("[offline-dev] Local assets found; skipping all network downloads.");
}
