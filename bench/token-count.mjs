// Local estimate only. UTF-16 character count / 4 is not a model tokenizer.
// Provider credentials must never cause benchmark text to leave this process.
export const COUNT_MODE = 'chars/4 (approximate, local only)';

export function countTokens(text) {
  return Math.ceil((text ?? '').length / 4);
}
