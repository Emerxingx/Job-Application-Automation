import type { CompletionRequest, ExternalModelProvider } from './types';

/**
 * Claude-backed external model provider.
 *
 * Enabled with AI_PROVIDER=anthropic and an ANTHROPIC_API_KEY. Each request
 * constrains the model to a JSON schema via `output_config.format`, so the
 * response parses deterministically instead of being scraped out of prose.
 *
 * Stage 03 removed everything else that used to live here. The prompts moved
 * to the governed `PromptVersion` registry (the exact version used is recorded
 * on every `AiRun`); the deterministic-engine grounding and the per-section
 * fallback moved to `src/lib/ai/gateway.ts`, where the tenant's AI processing
 * policy is resolved BEFORE this class is ever reached. This adapter is a
 * transport: rendered prompt in, parsed JSON (or null) out. It is never
 * imported outside the gateway and the provider registry.
 *
 * Status: IMPLEMENTED-NOT-VALIDATED (INTEGRATION_REGISTER.md). No request has
 * been made with a live key from this codebase.
 */
export class AnthropicModelProvider implements ExternalModelProvider {
  readonly name = 'anthropic';

  private async client() {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    // Resolves ANTHROPIC_API_KEY (or an `ant auth login` profile) from the env.
    return new Anthropic();
  }

  /**
   * Returns parsed JSON matching `schema`, or null. Null covers a transport
   * error, a refusal and an empty response alike: the gateway does not need
   * to know which, only that no usable external result exists. The cause is
   * logged here without the request body.
   */
  async complete<T>(input: CompletionRequest): Promise<T | null> {
    try {
      const client = await this.client();

      const message = await client.messages.create({
        model: input.model,
        max_tokens: input.maxTokens ?? 16000,
        system: input.system,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        output_config: {
          effort: input.effort ?? 'high',
          format: { type: 'json_schema', schema: input.schema },
        },
        messages: [{ role: 'user', content: input.prompt }],
      });

      // Safety classifiers can decline with HTTP 200 — check before reading content.
      if (message.stop_reason === 'refusal') {
        console.warn('[anthropic] request refused by the model');
        return null;
      }

      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return text ? (JSON.parse(text) as T) : null;
    } catch (error) {
      console.error('[anthropic] request failed:', error instanceof Error ? error.message : error);
      return null;
    }
  }
}
