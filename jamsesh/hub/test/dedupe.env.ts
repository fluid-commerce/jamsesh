// No speaker model: voice matching is off for dedupe.test.ts. Imported first, before config is read.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JAMSESH_HOME = mkdtempSync(join(tmpdir(), "jam-dedupe-home-"));
process.env.JAMSESH_DATA = mkdtempSync(join(tmpdir(), "jam-dedupe-data-"));
process.env.JAMSESH_SILENT = "1";
process.env.JAMSESH_OFFLINE = "1";
