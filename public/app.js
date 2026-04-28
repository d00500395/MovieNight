/* global Vue */

const wsUrl = window.location.protocol === 'file:'
    ? 'ws://localhost:3001'
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/movienight/`;

Vue.createApp({
    data() {
        return {
            // Connection
            ws: null,
            userId: null,
            sessionCode: '',
            isCreator: false,

            // Phase: landing | lobby | questions | waiting | generating | voting | waiting_votes | results
            phase: 'landing',

            // Landing
            playerName: '',
            showCreate: false,
            showJoin: false,
            maxLength: 120,
            questionMode: 'short',
            joinCode: '',

            // Lobby
            players: [],

            // Questions
            questions: [],
            currentQuestionIdx: 0,
            currentAnswer: '',
            customAnswer: '',

            // Movies / Voting
            movies: [],
            currentMovieIdx: 0,

            // Swipe state
            startX: 0,
            currentX: 0,
            swiping: false,

            // Results
            winner: null,
            runnerUp: null,
            allScores: [],

            // Error
            errorMsg: ''
        };
    },

    computed: {
        currentQuestion() {
            return this.questions[this.currentQuestionIdx] || {};
        },
        questionProgress() {
            if (!this.questions.length) return 0;
            return ((this.currentQuestionIdx) / this.questions.length) * 100;
        },
        currentMovie() {
            return this.movies[this.currentMovieIdx] || {};
        },
        swipeDelta() {
            return this.swiping ? this.currentX - this.startX : 0;
        },
        likeOpacity() {
            return Math.max(0, Math.min(1, this.swipeDelta / 120));
        },
        nopeOpacity() {
            return Math.max(0, Math.min(1, -this.swipeDelta / 120));
        },
        swipeClass() {
            if (!this.swiping) return '';
            if (this.swipeDelta > 40) return 'swiping-right';
            if (this.swipeDelta < -40) return 'swiping-left';
            return '';
        },
        cardStyle() {
            if (!this.swiping) return {};
            const rotate = this.swipeDelta * 0.08;
            return {
                transform: `translateX(${this.swipeDelta}px) rotate(${rotate}deg)`
            };
        }
    },

    methods: {
        // ── WebSocket ─────────────────────────────────────────────
        connect() {
            return new Promise((resolve, reject) => {
                this.ws = new WebSocket(wsUrl);
                this.ws.onopen = () => resolve();
                this.ws.onerror = () => {
                    this.errorMsg = 'Connection failed';
                    reject();
                };
                this.ws.onclose = () => {
                    if (this.phase !== 'landing' && this.phase !== 'results') {
                        this.errorMsg = 'Disconnected from server';
                    }
                };
                this.ws.onmessage = (e) => this.handleMessage(JSON.parse(e.data));
            });
        },

        wsSend(data) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify(data));
            }
        },

        handleMessage(msg) {
            switch (msg.type) {
                case 'session_created':
                    this.sessionCode = msg.code;
                    this.userId = msg.userId;
                    this.questions = msg.questions;
                    this.isCreator = true;
                    this.phase = 'lobby';
                    break;

                case 'session_joined':
                    this.sessionCode = msg.code;
                    this.userId = msg.userId;
                    this.questions = msg.questions;
                    this.isCreator = false;
                    this.phase = 'lobby';
                    break;

                case 'lobby_update':
                    this.players = msg.players;
                    // Check if we are the creator
                    const me = msg.players.find(p => p.id === this.userId);
                    if (me) this.isCreator = me.isCreator;
                    break;

                case 'phase_change':
                    this.phase = msg.phase;
                    break;

                case 'answer_accepted':
                    // Move to next question
                    if (this.currentQuestionIdx < this.questions.length - 1) {
                        this.currentQuestionIdx++;
                        this.currentAnswer = '';
                        this.customAnswer = '';
                    }
                    break;

                case 'movies_ready':
                    this.movies = msg.movies;
                    this.currentMovieIdx = 0;
                    break;

                case 'vote_accepted':
                    if (this.currentMovieIdx < this.movies.length - 1) {
                        this.currentMovieIdx++;
                    }
                    break;

                case 'results':
                    this.winner = msg.winner;
                    this.runnerUp = msg.runnerUp;
                    this.allScores = msg.allScores;
                    this.phase = 'results';
                    break;

                case 'error':
                    this.errorMsg = msg.message;
                    setTimeout(() => { this.errorMsg = ''; }, 4000);
                    break;
            }
        },

        // ── Actions ───────────────────────────────────────────────
        async createSession() {
            this.showCreate = false;
            await this.connect();
            this.wsSend({
                type: 'create_session',
                name: this.playerName.trim(),
                maxLength: this.maxLength,
                questionMode: this.questionMode
            });
        },

        async joinSession() {
            this.showJoin = false;
            await this.connect();
            this.wsSend({
                type: 'join_session',
                name: this.playerName.trim(),
                code: this.joinCode.trim()
            });
        },

        startSession() {
            this.wsSend({ type: 'start_session' });
        },

        submitAnswer() {
            const answer = this.customAnswer.trim() || this.currentAnswer;
            if (!answer) return;

            this.wsSend({
                type: 'submit_answer',
                questionId: this.currentQuestion.id,
                answer
            });
        },

        vote(liked) {
            this.wsSend({
                type: 'submit_vote',
                movieIndex: this.currentMovieIdx,
                liked
            });
        },

        reset() {
            if (this.ws) this.ws.close();
            Object.assign(this.$data, this.$options.data());
        },

        // ── Swipe gestures ────────────────────────────────────────
        onTouchStart(e) {
            this.startX = e.touches[0].clientX;
            this.currentX = this.startX;
            this.swiping = true;
        },

        onTouchMove(e) {
            if (!this.swiping) return;
            this.currentX = e.touches[0].clientX;
        },

        onTouchEnd() {
            if (!this.swiping) return;
            const delta = this.currentX - this.startX;
            this.swiping = false;

            if (delta > 100) {
                this.vote(true);
            } else if (delta < -100) {
                this.vote(false);
            }

            this.startX = 0;
            this.currentX = 0;
        },

        onMouseDown(e) {
            this.startX = e.clientX;
            this.currentX = this.startX;
            this.swiping = true;

            const onMove = (ev) => {
                if (!this.swiping) return;
                this.currentX = ev.clientX;
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                this.onTouchEnd();
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }
    }
}).mount('#app');
