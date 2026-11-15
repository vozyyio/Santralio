// Santralio: görüşme sonrası analiz için Claude istemcisi (yapay zekâ servisinde çalışır).
// Sıcaklık vb. örnekleme ayarı ve zorunlu araç kullanımı yoktur (Fable 5.2 bunları desteklemez).

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { analysisPrompt, OUTCOMES, SENTIMENTS, weeklyPrompt, type AnalysisInput, type AnalysisResult, type Analyzer, type Reporter, type WeeklyInput, type WeeklyReport } from "../analysis.ts";

const Schema = z.object({
  summary: z.string(),
  topic: z.string(),
  sentiment: z.enum(SENTIMENTS),
  outcome: z.enum(OUTCOMES),
  followUp: z.string().nullable(),
});

const ReportSchema = z.object({
  headline: z.string(),
  highlights: z.array(z.string()),
  problems: z.array(z.string()),
  suggestions: z.array(z.string()),
});

export class ClaudeAnalyzer implements Analyzer, Reporter {
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

  async weekly(model: string, input: WeeklyInput): Promise<WeeklyReport & { inputTokens: number; outputTokens: number }> {
    const { system, user } = weeklyPrompt(input);
    const response = await this.client.messages.parse({
      model,
      max_tokens: 4096,
      output_config: { effort: "medium", format: zodOutputFormat(ReportSchema) },
      system,
      messages: [{ role: "user", content: user }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error(`model yanıt vermedi (${response.stop_reason})`);
    return { ...response.parsed_output, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  }
}
