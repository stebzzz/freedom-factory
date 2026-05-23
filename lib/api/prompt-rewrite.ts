// Thin wrapper around Claude that takes an existing video prompt and rewrites
// it according to a user instruction (or applies safe defaults).
import { getConfig } from "@/lib/config";

const DEFAULT_INSTRUCTION = `Tu reçois un prompt vidéo pour Veo3. Réécris-le pour:
- garder la même intention narrative
- améliorer le détail visuel et l'ancrage temporel
- s'assurer qu'il passe la modération (éviter noms propres sensibles, violence explicite, exécutions, déshabillage)
- garder le format du prompt original (location/main subject/camera/action/dialogue/mood/style/avoid)
Renvoie UNIQUEMENT le prompt réécrit, sans préambule ni explication.`;

interface ClaudeContent {
  type: string;
  text?: string;
}

export async function rewritePrompt(originalPrompt: string, userInstruction?: string): Promise<string> {
  const config = await getConfig();
  const apiKey = config.anthropicKey;
  if (!apiKey) throw new Error("Pas de clé API Anthropic — vérifie config/settings.json");

  const instruction = userInstruction && userInstruction.trim().length > 0
    ? `${DEFAULT_INSTRUCTION}\n\nInstruction supplémentaire de l'utilisateur:\n${userInstruction.trim()}`
    : DEFAULT_INSTRUCTION;

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `${instruction}\n\n--- PROMPT ORIGINAL ---\n${originalPrompt}\n--- FIN ---`,
      },
    ],
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = (await res.json()) as { content?: ClaudeContent[] };
  const text = (data.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n")
    .trim();
  if (!text) throw new Error("Claude a renvoyé une réponse vide");
  return text;
}
