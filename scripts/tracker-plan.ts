/**
 * Prints the Drive steps the agent must do after a weekly run (node can't reach the Drive
 * connector). Reads /workspace/midnight/config.json, which holds no secrets.
 */
import { existsSync, readFileSync } from "node:fs";

const OUT_DIR = process.env.CLAIM_OUT_DIR ?? "/workspace/midnight";
const cfgPath = `${OUT_DIR}/config.json`;
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
const p = cfg.pendingUpload;
if (!p) {
  console.log("Nothing to upload: run `npm run weekly` (or weekly:live) first.");
  process.exit(0);
}
console.log(`Agent steps (connector: ${cfg.driveConnection ?? "user-Google-drive"}, personal Drive, never share, never delete):
1. UploadFile ${p.path}
     destination: { name: "${p.title}", convertToGoogleFormat: true }
2. ${cfg.archiveFolderId
  ? `Archive folder exists: ${cfg.archiveFolderId}`
  : `Create the folder once: create_file { title: "NIGHT Claims Archive", contentMimeType: "application/vnd.google-apps.folder" } and save its id as archiveFolderId`}
3. ${p.previousSheetFileId
  ? `Move the previous Sheet: update_file { fileId: "${p.previousSheetFileId}", parentId: "${cfg.archiveFolderId ?? "<archiveFolderId>"}" }`
  : "No previous Sheet to archive."}
4. Write back to ${cfgPath}: sheetFileId = <new id>, sheetUrl = <new link>, sheetTitle = "${p.title}", remove pendingUpload.`);
