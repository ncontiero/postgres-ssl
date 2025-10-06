import { logger } from "./utils/logger";

const postgresVersion: string = "{{ dkcutter.postgresVersion }}";
const postgresMajorVersion = Number("{{ dkcutter._postgresMajorVersion }}");

if (postgresVersion !== "latest") {
  if (postgresMajorVersion < 13 || postgresMajorVersion > 18) {
    logger.break();
    logger.error(`Unsupported postgres version: ${postgresMajorVersion}`);
    process.exit(1);
  }
}
