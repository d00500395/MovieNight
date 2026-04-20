# Movie Night

Real-time collaborative movie picker using WebSockets and LLM.

## How it works

1. **Create or Join** — One person creates a session (sets max movie length) and shares the 5-character code. Others join with the code.
2. **Answer Questions** — Each person individually answers 12 preference questions (maturity rating, mood, pacing, favorites, dealbreakers, etc.).
3. **AI Picks** — Once everyone finishes, the server sends all responses to an LLM (Ollama) which recommends 5 movies that best fit the group.
4. **Swipe to Vote** — Each person swipes right (like) or left (dislike) on each movie card, Tinder-style.
5. **Results** — The movie with the most likes is displayed as the group's pick, with the runner-up shown below.

## Tech Stack

- **Server:** Node.js, Express, `ws` (WebSocket library)
- **Client:** Vue.js 3 (CDN), native WebSocket API
- **LLM:** LangChain + Ollama (`gpt-oss:20b` on golem)
- **Design:** Mobile-first, dark theme

## Running locally

```bash
npm install
npm start            # default port 3000
# or
PORT=3002 npm start  # custom port
```

Open `http://localhost:3000` on your phone or browser.

## Deployment

Both the server and client are served from the same Node.js process. Deploy to any platform that supports Node.js + WebSocket (Render, Railway, Fly.io, etc.).
