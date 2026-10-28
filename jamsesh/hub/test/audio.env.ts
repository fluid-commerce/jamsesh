// Import this first in audio tests: it points the hub's data dir at a throwaway folder
// before src/config.ts is evaluated (config creates its data dir on import).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JAMSESH_DATA ??= mkdtempSync(join(tmpdir(), "jam-audio-data-"));
process.env.JAMSESH_SILENT = "1";
