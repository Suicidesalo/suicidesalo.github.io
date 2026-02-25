import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

export const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

export const AI_MODEL = process.env.AI_MODEL || "llama-3.3-70b-versatile";
