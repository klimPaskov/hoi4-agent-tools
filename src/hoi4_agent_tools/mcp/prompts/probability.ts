import { z } from 'zod/v4';

export const probabilityPromptArguments = z.object({
  objective: z.string().min(1).max(4096),
  sourceHint: z.string().max(1024).optional(),
});
export const probabilityPromptDefinition = {
  name: 'hoi4.probability_analysis',
  title: 'Analyze HOI4 weighted logic',
  description:
    'Plan one source-linked AI, MTTH, random, or declared-pool analysis and return to the owning modding workflow.',
};

/** One prompt body for both protocol generations; it does not run an analysis. */
export function probabilityPrompt(input: unknown) {
  const { objective, sourceHint } = probabilityPromptArguments.parse(input);
  return {
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Analyze this HOI4 weighted-logic task: ${objective}${sourceHint === undefined ? '' : `\nSource hint: ${sourceHint}`}\nIdentify the exact weighted surface and adapter, declare representative world-state scenarios and every required candidate or external factor, inspect first, run the narrowest useful evaluate/sweep/simulate/sequence/compare operation, review linked uncertainty and provenance, then return the findings to the normal owning modding workflow. Do not infer missing state, execute effects, or edit source through probability tools.`,
        },
      },
    ],
  };
}
