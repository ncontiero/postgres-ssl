import { logger } from "dkcutter/utils";

export async function runCommand(
  errorMessage: string,
  command: () => Promise<void>,
): Promise<void> {
  try {
    await command();
  } catch (error) {
    logger.error(
      `${errorMessage}: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  }
}
