import { rtdb } from "../config/firebase";

export class HistoryService {
  private static COLLECTION = "chat_history";

  static async getHistory(userId: string, limit: number = 20) {
    try {
      // Shorten timeout to 3 seconds for better UX
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Database timeout")), 3000)
      );

      const snapshotPromise = rtdb
        .ref(`${this.COLLECTION}/${userId}/messages`)
        .orderByChild("timestamp")
        .limitToLast(limit)
        .once("value");

      const snapshot = await Promise.race([snapshotPromise, timeoutPromise]) as any;

      const val = snapshot.val();
      if (!val) return [];

      return Object.values(val)
        .sort((a: any, b: any) => a.timestamp - b.timestamp);
    } catch (error) {
      console.warn("History Service Get Warning (continuing without history):", error.message);
      return []; // Return empty history on error/timeout to allow analysis to continue
    }
  }

  static async addMessage(userId: string, role: "user" | "assistant", content: string) {
    try {
      // Also add a timeout to adding messages so it doesn't hang the whole request
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Database timeout")), 3000)
      );

      const pushPromise = rtdb
        .ref(`${this.COLLECTION}/${userId}/messages`)
        .push({
          role,
          content,
          timestamp: Date.now(),
        });

      await Promise.race([pushPromise, timeoutPromise]);
    } catch (error) {
      console.warn("History Service Add Warning:", error.message);
    }
  }
}
