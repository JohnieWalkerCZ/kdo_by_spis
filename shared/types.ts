// Types shared by server and browser clients. Type-only: erased at runtime, never imported as values.

export type Phase = 'lobby' | 'question' | 'results' | 'final';

/** Errors a game transition can return (also sent to clients as `error.code`). */
export type GameError = 'bad_phase' | 'unknown_player' | 'vote_closed' | 'bad_person';
export type ErrorCode = GameError | 'game_over' | 'bad_pin' | 'rate_limited' | 'unauthorized';

// ---------- data (data.json / admin panel) ----------

export interface Settings {
  defaultTime: number;
  shuffleQuestions: boolean;
  resultsTop: number;
  autoEndWhenAllVoted: boolean;
}
export interface DataQuestion {
  text: string;
  time?: number;
}
export interface GameData {
  people: string[];
  questions: DataQuestion[];
  settings: Settings;
}

// ---------- game state (persisted in state.json) ----------

export interface Question {
  text: string;
  time: number;
}
export interface Player {
  animal: string;
  name: string;
  emoji: string;
  color: string;
  joinedAt: number;
}
export interface TallyRow {
  person: string;
  votes: number;
  rank: number;
}
/** playerId -> person voted for */
export type Votes = Record<string, string>;

export interface Game {
  id: string;
  pin: string;
  createdAt: number;
  phase: Phase;
  people: string[];
  questions: Question[];
  settings: Settings;
  /** index into questions, -1 before the first one */
  pos: number;
  startedAt: number | null;
  endsAt: number | null;
  players: Record<string, Player>;
  votes: Record<number, Votes>;
  /** frozen when a question closes */
  results: Record<number, TallyRow[]>;
  skipped: number[];
  /** archive file name once saved */
  archived?: string;
}
export interface State {
  game: Game | null;
}

export interface QuestionSummary {
  text: string;
  results: TallyRow[];
  winners: string[];
}
export interface Summary {
  questions: QuestionSummary[];
  champions: string[];
  championWins: number;
}
export interface ArchivedGame extends Summary {
  pin: string;
  createdAt: number;
  finishedAt: number;
  players: number;
}
export type GameListing =
  | { name: string; broken: true }
  | { name: string; broken?: false; createdAt: number; players: number; questions: number; champions: string[] };

// ---------- WebSocket protocol ----------

export type SimpleAction = 'next' | 'endNow' | 'skip' | 'repeat' | 'finish';
export type HostActionMsg =
  | { t: 'action'; action: 'newGame' }
  | { t: 'action'; action: 'closeGame' }
  | { t: 'action'; action: SimpleAction }
  | { t: 'action'; action: 'addTime'; seconds?: number }
  | { t: 'action'; action: 'settings'; autoEndWhenAllVoted?: boolean };

export type ClientMsg =
  | { t: 'join'; pin: string; playerId?: string }
  | { t: 'vote'; pos: number; person: string }
  | { t: 'host'; key: string }
  | { t: 'history' }
  | HostActionMsg;

export interface PlayerLook {
  name: string;
  emoji: string;
  color: string;
}

export interface HostGame {
  pin: string;
  phase: Phase;
  pos: number;
  total: number;
  question: Question | null;
  nextQuestion: Question | null;
  endsAt: number | null;
  startedAt: number | null;
  /** seconds */
  duration: number | null;
  players: PlayerLook[];
  online: number;
  voted: number;
  results: TallyRow[] | null;
  summary: Summary | null;
  settings: Settings;
}
export interface HostView {
  t: 'state';
  role: 'host';
  serverNow: number;
  publicUrl: string;
  game: HostGame | null;
}
export interface PlayerView {
  t: 'state';
  role: 'player';
  serverNow: number;
  me: PlayerLook;
  phase: Phase;
  pos: number;
  total: number;
  question: string | null;
  endsAt: number | null;
  startedAt: number | null;
  duration: number | null;
  people: string[];
  players: number;
  voted: number;
  myVote: string | null;
  results: TallyRow[] | null;
  final: { hits: number; answered: number; champions: string[] } | null;
}

export type ServerMsg =
  | { t: 'hello'; serverNow: number }
  | { t: 'joined'; playerId: string; pin: string }
  | { t: 'hostOk' }
  | { t: 'history'; games: GameListing[] }
  | { t: 'error'; code: ErrorCode; msg: string }
  | HostView
  | PlayerView;
