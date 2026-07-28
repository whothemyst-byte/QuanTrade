// Reuse the agent's own parser rather than re-implementing it here. A second
// parser would drift from the renderer that writes the file.
export { parseAgentDoc } from "@quantrade/agent";
export type { AgentDoc, Rule } from "@quantrade/agent";
