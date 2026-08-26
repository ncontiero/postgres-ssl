import { generateMatrix } from "../commands/generate-matrix";
import { runCommand } from "./run-command";

if (Bun.main === import.meta.path) {
  void runCommand("Failed to generate matrix", generateMatrix);
}
