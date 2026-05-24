// Thin wrapper around Claude that takes an existing video prompt and rewrites
// it according to a user instruction (or applies safe defaults).
import { callClaudeRetry } from "./claude-wrapper-client";

const DEFAULT_INSTRUCTION = `Tu reçois un prompt vidéo pour Veo3. Réécris-le pour:
- garder la même intention narrative
- améliorer le détail visuel et l'ancrage temporel
- s'assurer qu'il passe la modération (éviter noms propres sensibles, violence explicite, exécutions, déshabillage)
- garder le format du prompt original (location/main subject/camera/action/dialogue/mood/style/avoid)
Renvoie UNIQUEMENT le prompt réécrit, sans préambule ni explication.`;

export async function rewritePrompt(originalPrompt: string, userInstruction?: string): Promise<string> {
  const instruction = userInstruction && userInstruction.trim().length > 0
    ? `${DEFAULT_INSTRUCTION}\n\nInstruction supplémentaire de l'utilisateur:\n${userInstruction.trim()}`
    : DEFAULT_INSTRUCTION;

  const response = await callClaudeRetry(
    "claude-sonnet-4-6",
    4096,
    [{ role: "user", content: `${instruction}\n\n--- PROMPT ORIGINAL ---\n${originalPrompt}\n--- FIN ---` }],
    "Claude Prompt Rewrite",
  );

  const text = (response.content[0]?.text ?? "").trim();
  if (!text) throw new Error("Claude a renvoyé une réponse vide");
  return text;
}
