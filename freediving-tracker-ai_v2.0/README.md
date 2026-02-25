## 🛠 Tech Stack
    Frontend: React 19, Vite, Tailwind CSS 4, Motion (Framer Motion), Lucide Icons.
    Backend: Node.js, Express, TypeScript (tsx).
    AI: Groq API (Llama 3.3) for training retrospective and physiological analysis.
    Database & Auth: Firebase (Realtime Database + Google Auth).
    Validation & Security: Zod, Helmet, Express Rate Limit.

## 🚀 How to Launch (Local)
    Clone the repository:
        git clone <your-repo-url>
        cd freediving-tracker-ai
    Install dependencies:
        npm install
    Configure Environment Variables:
        Create a .env file in the root directory (use .env.example as a template) and add your Firebase and Groq API keys.
    Start the development server:
        npm run dev
      The application will be available at http://localhost:3000.

## 🌐 Deployment (Vercel & Render)
    Since the project uses an Express + Vite Middleware architecture, the best option for a full-stack deployment is Render:
      Render (Full-stack):
        Create a new Web Service.
        Build Command: npm run build
        Start Command: node server.ts
        Add all variables from your .env file in the Environment Variables section of the Render dashboard.
      Vercel (Frontend only):
        Vercel is ideal for serving the static files from the dist folder after running npm run build.
        Note: To keep the AI analysis (backend) working on Vercel, you would need to adapt the server to Vercel Serverless Functions. For this specific architecture, Render is the more straightforward choice.
    Pro-tip: Ensure your package.json has the "start": "node server.ts" script so that Render knows how to execute the application after the
