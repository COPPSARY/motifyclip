# Motify Clip frontend

The Svelte frontend for Motify Clip. The rendering API now lives in the sibling `motifyclip-backend` project so the two services can be deployed independently.

## Local setup

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Set `VITE_API_BASE_URL` in `.env.local` to the backend origin. For local development it defaults to `http://localhost:8787` in the example file.

## Deploy

```powershell
npm run build
```

Deploy `dist-web` as a static site and configure `VITE_API_BASE_URL` at build time with the public backend URL. API keys never belong in this project.
