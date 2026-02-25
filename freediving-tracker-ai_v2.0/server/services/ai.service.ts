import { groq, AI_MODEL } from "../config/groq";

export interface AIAnalysisResponse {
  verdict: "ok" | "warning" | "critical";
  analysis: string;
  suggestions: Array<{
    blockIndex: number;
    field: string;
    original: string;
    proposed: string;
    reason: string;
  }>;
  goalSuggestions: Array<{
    field: string;
    original: string;
    proposed: string;
    reason: string;
  }>;
}

export class AIService {
  static async analyzeTraining(
    systemPrompt: string,
    userPrompt: string,
    history: any[] = []
  ): Promise<AIAnalysisResponse> {
    try {
      const messages = [
        { role: "system", content: systemPrompt },
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user", content: userPrompt },
      ];

      const response = await groq.chat.completions.create({
        model: AI_MODEL,
        messages: messages as any,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0].message.content;
      if (!content) {
        throw new Error("AI returned empty response");
      }

      return JSON.parse(content) as AIAnalysisResponse;
    } catch (error) {
      console.error("AI Service Error:", error);
      // Fallback response to prevent breaking the frontend
      return {
        verdict: "ok",
        analysis: "Вибачте, сталася помилка при аналізі даних. Будь ласка, продовжуйте за планом або зверніться до тренера.",
        suggestions: [],
        goalSuggestions: [],
      };
    }
  }
}
