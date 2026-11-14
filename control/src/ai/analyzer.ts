// Santralio: görüşme sonrası analiz için Claude istemcisi (yapay zekâ servisinde çalışır).
// Sıcaklık vb. örnekleme ayarı ve zorunlu araç kullanımı yoktur (Fable 5.2 bunları desteklemez).

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { analysisPrompt, OUTCOMES, SENTIMENTS, type AnalysisInput, type AnalysisResult, type Analyzer } from "../analysis.ts";

const Schema = z.object({
  summary: z.string(),
  topic: z.string(),
  sentiment: z.enum(SENTIMENTS),
  outcome: z.enum(OUTCOMES),
  followUp: z.string().nullable(),
});

export class ClaudeAnalyzer implements Analyzer {
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
  }

  async analyze(model: string, input: AnalysisInput): Promise<AnalysisResult> {
    const { system, user } = analysisPrompt(input);
    const response = await this.client.messages.parse({
      model,
      max_tokens: 2048,
      output_config: { effort: "medium", format: zodOutputFormat(Schema) },
      system,
      messages: [{ role: "user", content: user }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error(`model yanıt vermedi (${response.stop_reason})`);
    return { ...response.parsed_output, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  }
}
