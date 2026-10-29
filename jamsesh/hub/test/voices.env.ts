// Import first in voice tests. Points the hub at throwaway dirs and links the speaker model
// (read-only, from ~/.jamsesh/models) into a temp home, so nothing under ~/.jamsesh is touched.
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const model = join(homedir(), ".jamsesh", "models", "wespeaker_en.onnx");
const home = mkdtempSync(join(tmpdir(), "jam-voices-home-"));
if (existsSync(model)) {
  mkdirSync(join(home, "models"));
  symlinkSync(model, join(home, "models", "wespeaker_en.onnx"));
}
process.env.JAMSESH_HOME ??= home;
process.env.JAMSESH_DATA ??= mkdtempSync(join(tmpdir(), "jam-voices-data-"));
process.env.JAMSESH_SILENT = "1";
process.env.JAMSESH_OFFLINE = "1";
