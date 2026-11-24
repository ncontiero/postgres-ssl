import { logger } from "dkcutter/utils";

const postgresVersion: string = "{{ dkcutter.postgresVersion }}";
const postgresMajorVersion = Number("{{ dkcutter._postgresMajorVersion }}");

if (
  postgresVersion !== "latest" &&
  (postgresMajorVersion < 15 || postgresMajorVersion > 19)
) {
  logger.error(`Unsupported postgres version: ${postgresMajorVersion}`);
  process.exit(1);
}
