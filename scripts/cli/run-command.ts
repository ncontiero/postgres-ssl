import { logger } from "dkcutter/utils";

export async function runCommand(
  errorMessage: string,
  command: () => Promise<void>,
  logError: (message: string) => void = logger.error,
): Promise<void> {
  try {
    await command();
  } catch (error) {
    logError(
      `${errorMessage}: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  }
}
