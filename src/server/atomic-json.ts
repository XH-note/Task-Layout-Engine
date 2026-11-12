import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function writeJsonAtomically(
  dataDir: string,
  fileName: string,
  payload: unknown,
): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });

  const targetPath = path.join(dataDir, fileName);
  const temporaryPath = path.join(
    dataDir,
    `.${fileName}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });

    try {
      await fs.rename(temporaryPath, targetPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;

      await fs.rm(targetPath, { force: true });
      await fs.rename(temporaryPath, targetPath);
    }
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}
