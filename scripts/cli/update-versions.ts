import { updateVersions } from "../commands/update-versions";
import { runCommand } from "./run-command";

if (Bun.main === import.meta.path) {
  void runCommand("Could not update versions", updateVersions);
}
