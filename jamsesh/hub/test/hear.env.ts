// Imported first by transcription.test.ts: the hub's home (models, team) is a throwaway folder.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JAMSESH_HOME = mkdtempSync(join(tmpdir(), "jam-hear-home-"));
process.env.JAMSESH_DATA ??= join(process.env.JAMSESH_HOME, "data");
process.env.JAMSESH_SILENT = "1";
process.env.JAMSESH_OFFLINE = "1";
