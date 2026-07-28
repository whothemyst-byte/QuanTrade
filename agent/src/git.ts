import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Commit AGENT.md as the agent, not as the human. The distinct identity is
 * what makes `git log AGENT.md` readable as the agent's intellectual history
 * rather than a mix of yours and its edits.
 */
export async function commitAgentMd(message: string, body: string): Promise<string> {
  await run("git", ["config", "user.name", "quantrade-agent"]);
  await run("git", ["config", "user.email", "agent@quantrade.local"]);
  await run("git", ["add", "AGENT.md"]);

  const status = await run("git", ["status", "--porcelain", "AGENT.md"]);
  if (status.stdout.trim() === "") {
    throw new Error("AGENT.md is unchanged; nothing to commit");
  }

  await run("git", ["commit", "-m", message, "-m", body]);
  const { stdout } = await run("git", ["rev-parse", "HEAD"]);
  return stdout.trim();
}
