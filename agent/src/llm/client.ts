import { AgentResponseSchema, type AgentResponse } from "@quantrade/core";
import type { ZodSchema } from "zod";

export interface LlmProvider {
  readonly name: string;
  complete(system: string, user: string): Promise<{ text: string; tokens: number }>;
}

/** Models wrap JSON in prose or fences no matter how firmly you ask them not to. */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text.trim();
}

export interface AskResult<T> {
  response: T;
  model: string;
  tokens: number;
}

/**
 * Ask each provider in turn, allowing one corrective retry per provider.
 *
 * The second attempt carries the validation error, which models correct
 * reliably. A third attempt is throwing tokens at a model that has
 * misunderstood the task.
 */
export async function askValidated<T>(
  providers: LlmProvider[],
  schema: ZodSchema<T>,
  system: string,
  user: string,
): Promise<AskResult<T>> {
  const failures: string[] = [];

  for (const provider of providers) {
    let prompt = user;

    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string;
      let tokens: number;
      try {
        ({ text, tokens } = await provider.complete(system, prompt));
      } catch (err) {
        // A thrown error is transport-level; re-prompting will not help.
        failures.push(`${provider.name} attempt ${attempt + 1}: ${(err as Error).message}`);
        break;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(extractJson(text));
      } catch {
        failures.push(`${provider.name} attempt ${attempt + 1}: response was not JSON`);
        prompt = `${user}\n\nYour previous response was not valid JSON. Return only a JSON object.`;
        continue;
      }

      const parsed = schema.safeParse(parsedJson);
      if (parsed.success) {
        return { response: parsed.data, model: provider.name, tokens };
      }

      prompt =
        `${user}\n\nYour previous response was rejected by the validator:\n` +
        `${parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n")}\n` +
        `Return only valid JSON matching the schema.`;
      failures.push(`${provider.name} attempt ${attempt + 1}: schema rejection`);
    }
  }

  throw new Error(`All providers failed:\n${failures.join("\n")}`);
}

export function askForProposals(
  providers: LlmProvider[],
  system: string,
  user: string,
): Promise<AskResult<AgentResponse>> {
  return askValidated(providers, AgentResponseSchema, system, user);
}

export class GroqProvider implements LlmProvider {
  readonly name = "groq";
  constructor(
    private readonly key: string,
    private readonly model = "llama-3.3-70b-versatile",
  ) {}

  async complete(system: string, user: string) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Groq responded ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as any;
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      tokens: body.usage?.total_tokens ?? 0,
    };
  }
}

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  constructor(
    private readonly key: string,
    private readonly model = "gemini-2.0-flash",
  ) {}

  async complete(system: string, user: string) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
      }),
    });
    if (!res.ok) throw new Error(`Gemini responded ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as any;
    return {
      text: body.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
      tokens: body.usageMetadata?.totalTokenCount ?? 0,
    };
  }
}

/** Build the provider chain from the environment. Groq first, Gemini as failover. */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider[] {
  const providers: LlmProvider[] = [];
  if (env.GROQ_API_KEY) providers.push(new GroqProvider(env.GROQ_API_KEY));
  if (env.GEMINI_API_KEY) providers.push(new GeminiProvider(env.GEMINI_API_KEY));
  if (providers.length === 0) {
    throw new Error("No LLM provider configured: set GROQ_API_KEY or GEMINI_API_KEY");
  }
  return providers;
}
