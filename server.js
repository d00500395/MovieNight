const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { ChatOllama } = require('@langchain/ollama');
const path = require('path');

// ─── Express + HTTP server ────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
app.use('/movienight', express.static(path.join(__dirname, 'public')));

// ─── Ollama LLM ───────────────────────────────────────────────────────────────
const llm = new ChatOllama({
    baseUrl: 'http://golem:11434',
    model: 'qwen3.6:35b-a3b-coding-nvfp4',
    temperature: 0.7,
    httpOptions: {
        timeout: 120000,
        keepAliveTimeout: 60000,
        headersTimeout: 120000
    }
});

// ─── Session store ────────────────────────────────────────────────────────────
// sessions = { code: { maxLength, users: { id: { ws, name, answers, votes } }, phase, movies, creatorId } }
const sessions = {};

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return sessions[code] ? generateCode() : code;
}

// ─── Question definitions ─────────────────────────────────────────────────────
const QUESTIONS = [
    {
        id: 'maturity',
        text: 'What is the highest maturity rating you are comfortable with?',
        options: ['PG', 'PG-13', 'R'],
        allowCustom: false
    },
    {
        id: 'age',
        text: 'What age of movie are you interested in?',
        options: ['Last 0-5 years', '6-15 years', 'Last 16-25 years', '25+', 'No preference'],
        allowCustom: true
    },
    {
        id: 'language',
        text: 'What language do you want to watch in?',
        options: ['English'],
        allowCustom: true
    },
    {
        id: 'brainpower',
        text: "The \"Friday Night\" Scale: On a scale of 1 to 10, how much 'brain power' do we want to use? (1 = turn my brain off; 10 = complex psychological puzzle)",
        options: ['1','2','3','4','5','6','7','8','9','10'],
        allowCustom: false,
        isScale: true
    },
    {
        id: 'emotional_goal',
        text: "Emotional Goal: What's the goal for the night?",
        options: ['To laugh until it hurts', 'To be on the edge of our seats', 'To be inspired', 'To be genuinely terrified'],
        allowCustom: true
    },
    {
        id: 'pacing',
        text: 'Pacing: Do we want a slow-burn character study or a fast-paced rollercoaster movie?',
        options: ['Slow-burn character study', 'Fast-paced rollercoaster'],
        allowCustom: true
    },
    {
        id: 'story_type',
        text: 'Story type: What kind of story are you in the mood for?',
        options: ['Plot-driven', 'Character-driven', 'Visual spectacle'],
        allowCustom: true
    },
    {
        id: 'last_great_watch',
        text: "The \"Last Great Watch\": What is one movie you've seen recently that you absolutely loved?",
        options: [],
        allowCustom: true,
        freeformOnly: true
    },
    {
        id: 'gateway_movie',
        text: "The \"Gateway\" Movie: Name a movie you've seen 5+ times that you never get tired of.",
        options: [],
        allowCustom: true,
        freeformOnly: true
    },
    {
        id: 'anti_pick',
        text: "The Anti-Pick: What is a popular movie that everyone seems to like, but you actually dislike?",
        options: [],
        allowCustom: true,
        freeformOnly: true
    },
    {
        id: 'veto',
        text: "The Veto: Is there any specific genre or trope that is an immediate dealbreaker for you tonight? (e.g., No musicals, No body horror, No sad endings)",
        options: [],
        allowCustom: true,
        freeformOnly: true
    },
    {
        id: 'wildcard',
        text: 'The Wildcard: Are you feeling adventurous or do you want a safe bet?',
        options: ['Adventurous (experimental/indie)', 'Safe bet (blockbuster/mainstream)'],
        allowCustom: false
    }
];

const SHORT_IDS = ['maturity', 'age', 'language', 'brainpower', 'emotional_goal', 'pacing', 'story_type', 'wildcard'];

function getSessionQuestions(mode) {
    return mode === 'short'
        ? QUESTIONS.filter(q => SHORT_IDS.includes(q.id))
        : QUESTIONS;
}

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/movienight/' });

// Keep WebSocket connections alive through Cloudflare's 100s timeout
const PING_INTERVAL = 30000; // ping every 30 seconds

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // ... rest of your existing connection handler
});

// Heartbeat interval
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, PING_INTERVAL);

wss.on('connection', (ws) => {
    let userId = null;
    let sessionCode = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case 'create_session': handleCreate(ws, msg); break;
            case 'join_session':   handleJoin(ws, msg);   break;
            case 'submit_answer':  handleAnswer(ws, msg);  break;
            case 'submit_vote':    handleVote(ws, msg);    break;
            case 'start_session':  handleStart(ws, msg);   break;
            default: break;
        }
    });

    ws.on('close', () => {
        if (sessionCode && sessions[sessionCode]) {
            const session = sessions[sessionCode];
            if (session.users[userId]) {
                delete session.users[userId];
                broadcastLobby(sessionCode);
                // Clean up empty sessions
                if (Object.keys(session.users).length === 0) {
                    delete sessions[sessionCode];
                }
            }
        }
    });

    // ── Handlers ──────────────────────────────────────────────────────────────
    function handleCreate(ws, msg) {
        const code = generateCode();
        userId = crypto.randomUUID();
        sessionCode = code;

        const questionMode = msg.questionMode === 'short' ? 'short' : 'full';
        const questions = getSessionQuestions(questionMode);

        sessions[code] = {
            maxLength: msg.maxLength || 180,
            questionMode,
            questions,
            users: {
                [userId]: { ws, name: msg.name || 'Host', answers: {}, votes: {} }
            },
            phase: 'lobby',   // lobby → questions → waiting → voting → results
            movies: [],
            creatorId: userId
        };

        send(ws, {
            type: 'session_created',
            code,
            userId,
            questions
        });
        broadcastLobby(code);
    }

    function handleJoin(ws, msg) {
        const code = (msg.code || '').toUpperCase().trim();
        const session = sessions[code];

        if (!session) {
            return send(ws, { type: 'error', message: 'Session not found' });
        }
        if (session.phase !== 'lobby') {
            return send(ws, { type: 'error', message: 'Session already in progress' });
        }

        userId = crypto.randomUUID();
        sessionCode = code;
        session.users[userId] = { ws, name: msg.name || 'Guest', answers: {}, votes: {} };

        send(ws, {
            type: 'session_joined',
            code,
            userId,
            questions: session.questions
        });
        broadcastLobby(code);
    }

    function handleStart(ws, msg) {
        const session = sessions[sessionCode];
        if (!session || session.creatorId !== userId) return;
        if (Object.keys(session.users).length < 1) return;

        session.phase = 'questions';
        broadcast(sessionCode, { type: 'phase_change', phase: 'questions' });
    }

    function handleAnswer(ws, msg) {
        const session = sessions[sessionCode];
        if (!session) return;

        const user = session.users[userId];
        if (!user) return;

        user.answers[msg.questionId] = msg.answer;
        send(ws, { type: 'answer_accepted', questionId: msg.questionId });

        // Check if this user has answered all questions
        const totalQuestions = session.questions.length;
        const answeredCount = Object.keys(user.answers).length;

        if (answeredCount >= totalQuestions) {
            send(ws, { type: 'phase_change', phase: 'waiting' });
        }

        // Check if ALL users have answered all questions
        const allDone = Object.values(session.users).every(
            u => Object.keys(u.answers).length >= session.questions.length
        );

        if (allDone && session.phase === 'questions') {
            session.phase = 'generating';
            broadcast(sessionCode, { type: 'phase_change', phase: 'generating' });
            generateMovies(sessionCode);
        }
    }

    function handleVote(ws, msg) {
        const session = sessions[sessionCode];
        if (!session || session.phase !== 'voting') return;

        const user = session.users[userId];
        if (!user) return;

        // msg.movieIndex, msg.liked (boolean)
        user.votes[msg.movieIndex] = msg.liked;
        send(ws, { type: 'vote_accepted', movieIndex: msg.movieIndex });

        // Check if this user has voted on all movies
        if (Object.keys(user.votes).length >= session.movies.length) {
            send(ws, { type: 'phase_change', phase: 'waiting_votes' });
        }

        // Check if ALL users have voted on all movies
        const allVoted = Object.values(session.users).every(
            u => Object.keys(u.votes).length >= session.movies.length
        );

        if (allVoted) {
            tallyAndBroadcastResults(sessionCode);
        }
    }
});

// ─── Broadcast helpers ────────────────────────────────────────────────────────
function send(ws, data) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcast(code, data) {
    const session = sessions[code];
    if (!session) return;
    for (const u of Object.values(session.users)) {
        send(u.ws, data);
    }
}

function broadcastLobby(code) {
    const session = sessions[code];
    if (!session) return;
    const players = Object.entries(session.users).map(([id, u]) => ({
        id, name: u.name, isCreator: id === session.creatorId
    }));
    broadcast(code, { type: 'lobby_update', players, code });
}

// ─── LLM movie generation ────────────────────────────────────────────────────
async function generateMovies(code) {
    const session = sessions[code];
    if (!session) return;

    const startTime = Date.now();
    const allResponses = {};
    for (const [uid, user] of Object.entries(session.users)) {
        allResponses[user.name] = user.answers;
    }

    const prompt = buildMoviePrompt(allResponses, session.maxLength);
    console.log(`[${code}] Prompt built in ${Date.now() - startTime}ms`);

    try {
        const systemPrompt = `You are a movie recommendation assistant. You MUST respond with ONLY a JSON array — no explanation, no markdown, no code fences. The array must contain exactly 5 objects with these keys: title, year, genre, rating, runtime, description, whyItFits.

        Example format (respond using this EXACT format, no other text. Use only the format in this example, not the content in the example.):
        [{"title":"The Grand Budapest Hotel","year":"2014","genre":"Comedy/Drama","rating":"R","runtime":"100 min","description":"A concierge and his lobby boy navigate adventures in a famous European hotel.","whyItFits":"Visually stunning with dry humor."},{"title":"...","year":"...","genre":"...","rating":"...","runtime":"...","description":"...","whyItFits":"..."}]`;

        const llmStartTime = Date.now();

        const response = await llm.invoke([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
        ]);

        const llmTime = Date.now() - llmStartTime;
        console.log(`[${code}] LLM inference took ${llmTime}ms`);
        
        let content = typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content);

        console.log('LLM raw response (first 500 chars):', content.slice(0, 500));

        // Strip markdown code fences if present
        content = content.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '');

        // Try to find a JSON array
        let movies;
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            movies = JSON.parse(jsonMatch[0]);
        } else {
            // Try parsing the whole content as JSON
            const trimmed = content.trim();
            if (trimmed.startsWith('[')) {
                movies = JSON.parse(trimmed);
            } else if (trimmed.startsWith('{')) {
                // Single object — wrap in array
                movies = [JSON.parse(trimmed)];
            } else {
                throw new Error('No JSON array found in LLM response');
            }
        }

        // Validate we got an array of objects with at least title
        if (!Array.isArray(movies) || movies.length === 0) {
            throw new Error('LLM returned empty or invalid array');
        }

        // Normalize: ensure each movie has required fields
        session.movies = movies.slice(0, 5).map(m => ({
            title: m.title || 'Unknown',
            year: m.year || '???',
            genre: m.genre || 'Unknown',
            rating: m.rating || 'NR',
            runtime: m.runtime || '??? min',
            description: m.description || '',
            whyItFits: m.whyItFits || m.why_it_fits || m.reason || ''
        }));

        session.phase = 'voting';
        broadcast(code, {
            type: 'movies_ready',
            movies: session.movies
        });
        broadcast(code, { type: 'phase_change', phase: 'voting' });

    } catch (err) {
        const errorCode = err.cause?.code || err.code;
        const isTimeout = errorCode === 'UND_ERR_HEADERS_TIMEOUT' || 
                         errorCode === 'ETIMEDOUT' ||
                         err.message?.includes('timeout');
        
        console.error(`[${code}] LLM generation failed (${isTimeout ? 'TIMEOUT' : 'ERROR'}):`, {
            code: errorCode,
            message: err.message,
            cause: err.cause?.message
        });
        
        const message = isTimeout
            ? 'LLM inference took too long. Ollama might be busy. Please try again.'
            : 'Failed to generate movie recommendations. Please try again.';
        
        broadcast(code, {
            type: 'error',
            message,
            isTimeout
        });
        session.phase = 'questions';
        broadcast(code, { type: 'phase_change', phase: 'questions' });
    }
}

function buildMoviePrompt(allResponses, maxLength) {
    const parts = [`The group has a maximum movie length of ${maxLength} minutes.\n`];
    parts.push(`There are ${Object.keys(allResponses).length} people in this group.\n`);
    parts.push('Here are each person\'s preferences:\n');

    for (const [name, answers] of Object.entries(allResponses)) {
        parts.push(`--- ${name} ---`);
        for (const q of QUESTIONS) {
            const answer = answers[q.id];
            if (answer) {
                parts.push(`${q.text}`);
                parts.push(`Answer: ${answer}\n`);
            }
        }
        parts.push('');
    }

    parts.push('Based on ALL of these responses, recommend exactly 5 movies that would be the best compromise for the entire group.');
    parts.push(`All movies must be ${maxLength} minutes or shorter.`);
    parts.push('Prioritize finding movies that satisfy the most important preferences from each person while avoiding everyone\'s dealbreakers.');

    return parts.join('\n');
}

// ─── Tally votes & broadcast results ─────────────────────────────────────────
function tallyAndBroadcastResults(code) {
    const session = sessions[code];
    if (!session) return;

    const scores = session.movies.map((movie, i) => {
        let likes = 0;
        for (const u of Object.values(session.users)) {
            if (u.votes[i]) likes++;
        }
        return { movie, likes, index: i };
    });

    scores.sort((a, b) => b.likes - a.likes);

    session.phase = 'results';
    broadcast(code, {
        type: 'results',
        winner: scores[0],
        runnerUp: scores[1] || null,
        allScores: scores
    });
    broadcast(code, { type: 'phase_change', phase: 'results' });
}

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Movie Night server running on http://localhost:${PORT}`);
});
