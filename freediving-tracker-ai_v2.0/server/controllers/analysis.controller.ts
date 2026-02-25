import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { AIService } from "../services/ai.service";
import { HistoryService } from "../services/history.service";
import { z } from "zod";

const AnalysisSchema = z.object({
  week: z.number(),
  session: z.object({
    feeling: z.string().optional(),
    staticTime: z.string().optional(),
    dynamicDist: z.string().optional(),
    notes: z.string().optional(),
  }).passthrough(),
  fitStats: z.object({
    hr: z.object({ avg: z.number(), max: z.number(), min: z.number() }),
    depth: z.object({ max: z.number(), avg: z.number() }),
    temp: z.object({ avg: z.number(), max: z.number(), min: z.number() }),
    speed: z.object({ max: z.number(), avg: z.number() }),
    diveCount: z.number(),
    diveDurations: z.array(z.number()),
    diveMaxDepths: z.array(z.number()),
    dur: z.number(),
    n: z.number(),
  }).nullable(),
  manualDepths: z.array(z.object({ min: z.number(), max: z.number() })).nullable().optional(),
  planBlocks: z.array(z.any()),
  planGoals: z.any(),
  blockNotes: z.record(z.string(), z.any()),
  timerRecords: z.array(z.any()).optional(),
  allSessions: z.union([z.record(z.string(), z.any()), z.array(z.any())]),
}).passthrough();

export class AnalysisController {
  static async analyze(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user!.uid;
      const body = AnalysisSchema.parse(req.body);

      const systemPrompt = `Ти — Старший Тренер (Senior Coach) з фрідайвінгу з багаторічним досвідом, сертифікований за стандартами AIDA та Molchanovs. 
Твоя роль: провести глибоку ретроспективу тренування та надати експертний аналіз, спираючись на фізіологію фрідайвінгу.

Ти аналізуєш:
1) Самопочуття користувача (це пріоритет №1).
2) Детальні дані з .fit файлу: пульс (avg, max, min), глибина басейну (max, avg), температура води, швидкість занурення/спливання, тривалість.
3) Виконання плану (статику, динаміку, нотатки до блоків).
4) Попередню історію тренувань.
5) Ручні дані про глибину занурень (якщо вони були введені користувачем).

Твої знання про пульс у фрідайвінгу (Mammalian Dive Reflex - MDR):
- Брадикардія: Це нормальна реакція організму на занурення та затримку дихання. Пульс МАЄ падати. 
- Норми: У досвідчених фрідайверів пульс може падати до 30-40 уд/хв під час занурення. Якщо пульс під час занурення вищий за спокійний стан (наприклад, 80-100 уд/хв на глибині), це ознака стресу, поганого розслаблення або недостатнього продування.
- Відновлення: Після спливання пульс має швидко повертатися до норми. Затяжна тахікардія після занурення може свідчити про перевтому.
- Ризики: Якщо пульс аномально високий при низькій швидкості, це сигнал до зменшення інтенсивності.
- Ссилайся на принципи AIDA/Molchanovs та фізіологічні дослідження (наприклад, праці Умберто Пеліццарі "Manual of Freediving").

Твої завдання:
- Зробити ретроспективу: що було добре, а де є ризики (перевтома, застій, занадто швидкий прогрес, занадто агресивні глибини).
- Звертай увагу на безпеку: швидкість спливання, відновлення між зануреннями, реакція пульсу на глибину.
- Максимальна глибина басейну — це ліміт, який не можна перевищувати. Якщо користувач наближається до нього, проаналізуй техніку та розслаблення.
- Давай чіткі рамки: "Твій пульс 45 на глибині — це чудова брадикардія" або "Пульс 95 на глибині 3.8м свідчить про стрес, зверни увагу на розслаблення обличчя та плечей".
- Якщо ти бачиш, що план на НАСТУПНИЙ тиждень потребує корективів, запропонуй зміни.
- Твій аналіз має бути професійним, підтримуючим, але строгим щодо безпеки.

Поверни JSON:
{
  "verdict": "ok|warning|critical",
  "analysis": "Твій детальний текст ретроспективи та аналізу українською мовою. Звертайся до користувача як Старший Тренер.",
  "suggestions": [
    {
      "blockIndex": 0, 
      "field": "reps|t|d", 
      "original": "значення з поточного плану", 
      "proposed": "нове значення для НАСТУПНОГО тижня", 
      "reason": "чому ти це пропонуєш"
    }
  ],
  "goalSuggestions": [
    {
      "field": "s|d|g", 
      "original": "поточна ціль", 
      "proposed": "нова ціль для НАСТУПНОГО тижня", 
      "reason": "пояснення"
    }
  ]
}

Важливо: 
- Пропозиції (suggestions/goalSuggestions) стосуються саме НАСТУПНОГО тижня (Week ${body.week + 1}).
- Якщо все ідеально, залиш масиви suggestions порожніми.
- Аналіз має бути глибоким, враховуй динаміку пульсу якщо вона є.`;

      const userPrompt = `
Дані тренування (Тиждень ${body.week}):
- Самопочуття: ${body.session.feeling || "не вказано"}
- Пульс (FIT): ${body.fitStats ? `Avg: ${body.fitStats.hr.avg ?? '—'}, Max: ${body.fitStats.hr.max ?? '—'}, Min: ${body.fitStats.hr.min ?? '—'}` : "немає даних"}
- Максимальна глибина басейну (FIT): ${body.fitStats ? `${body.fitStats.depth.max ?? '—'}м` : "немає даних"} (Це глибина чаші басейну, а не занурення користувача)
- Фактична глибина занурень (введено вручну): ${body.manualDepths ? JSON.stringify(body.manualDepths) : "немає (використовуй дані з FIT як орієнтир глибини басейну)"}
- Температура (FIT): ${body.fitStats ? `${body.fitStats.temp.min ?? '—'}°C` : "немає даних"}
- Швидкість (FIT): ${body.fitStats ? `Max: ${body.fitStats.speed.max ?? '—'}м/с` : "немає даних"}
- Кількість занурень (FIT): ${body.fitStats?.diveCount || "немає даних"}
- Тривалість (FIT): ${body.fitStats?.dur || "немає даних"} хв
- Статика: ${body.session.staticTime || "не вказано"}
- Динаміка: ${body.session.dynamicDist || "не вказано"}
- Нотатки: ${body.session.notes || "немає"}
- Нотатки до блоків: ${JSON.stringify(body.blockNotes || {})}

Поточний план:
- Цілі: ${JSON.stringify(body.planGoals || {})}
- Блоки: ${JSON.stringify(body.planBlocks || [])}

Попередня історія:
${JSON.stringify(body.allSessions || {})}
`;

      console.log(`[Analysis] Starting analysis for user ${userId}, week ${body.week}`);
      
      // Get history from RTDB
      console.log("[Analysis] Fetching history...");
      const history = await HistoryService.getHistory(userId);
      console.log(`[Analysis] History fetched: ${history.length} messages`);
 
      // Call AI Service
      console.log("[Analysis] Calling AI Service...");
      const result = await AIService.analyzeTraining(systemPrompt, userPrompt, history);
      console.log("[Analysis] AI Service responded");
 
      // Save to history
      console.log("[Analysis] Saving messages to history...");
      await HistoryService.addMessage(userId, "user", userPrompt);
      await HistoryService.addMessage(userId, "assistant", result.analysis);
      console.log("[Analysis] History updated");
 
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid request data", details: error.issues });
      }
      throw error; // Let error middleware handle it
    }
  }
}
