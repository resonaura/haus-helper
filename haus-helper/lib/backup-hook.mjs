import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, rm, rename } from "node:fs/promises";
import { join } from "node:path";
const root = process.env.HAUS_DATA || "/data",
  directory = join(root, "restore");
if (process.argv[2] === "post")
  await rm(directory, { recursive: true, force: true });
else {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(root, "haus.sqlite"), {
    readOnly: true,
  });
  try {
    const temporary = join(directory, "haus.partial.sqlite");
    await rm(temporary, { force: true });
    await backup(database, temporary);
    await rename(temporary, join(directory, "haus.sqlite"));
  } finally {
    database.close();
  }
}
