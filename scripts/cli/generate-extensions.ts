import { generateExtensions } from "../commands/generate-extensions";
import { runCommand } from "./run-command";

if (Bun.main === import.meta.path) {
  void runCommand("Failed to generate extension templates", generateExtensions);
}
