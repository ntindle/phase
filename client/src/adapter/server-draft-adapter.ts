import type {
  EngineAdapter,
  GameAction,
  GameEvent,
  GameLogEntry,
  GameState,
  LegalActionsResult,
  ManaCost,
  PlayerId,
  SubmitResult,
} from "./types";
import { AdapterError, AdapterErrorCode } from "./types";
import type { BracketDeckRequest, BracketEstimate } from "../types/bracketEstimate";
import {
  HandshakeError,
  openPhaseSocket,
  type PhaseSocket,
} from "../services/openPhaseSocket";
import {
  clearServerDraftSession,
  saveServerDraftSession,
  type ServerDraftSessionData,
} from "../services/serverDraftSession";
import { isValidWebSocketUrl } from "../services/serverDetection";
import type {
  DraftPlayerView,
  StandingEntry,
  TournamentFormat,
  PodPolicy,
} from "./draft-adapter";
import type { ServerInfo } from "./ws-adapter";

const DRAFT_RECONNECT_BACKOFF_CAP_MS = 5000;
// Server draft reconnect grace is phase-specific and can be up to 30 minutes
// in lobby. Keep the client retry window long enough to cover that maximum.
const MAX_DRAFT_RECONNECT_ATTEMPTS = 360;

// ── Types ───────────────────────────────────────────────────────────────

export type DraftPhase =
  | "lobby"
  | "drafting"
  | "deckbuilding"
  | "match"
  | "between_rounds"
  | "complete";

/** Settings for creating a new server-hosted draft pod. */
export interface CreateDraftSettings {
  displayName: string;
  setCode: string;
  kind: "Premier" | "Traditional";
  public: boolean;
  password?: string;
  timerSeconds?: number;
  tournamentFormat: TournamentFormat;
  podPolicy: PodPolicy;
  podSize: number;
}

/** Events emitted by ServerDraftAdapter for UI state updates. */
export type ServerDraftAdapterEvent =
  | { type: "serverHello"; info: ServerInfo; compatible: boolean }
  | { type: "waitingForPlayers" }
  | { type: "draftViewUpdated"; view: DraftPlayerView }
  | { type: "matchStarting"; matchId: string; round: number; opponentName: string; gameCode: string }
  | { type: "timerSync"; remainingMs: number }
  | { type: "draftOver"; standings: StandingEntry[] }
  | { type: "draftActionRejected"; reason: string }
  | { type: "gameStateUpdated"; state: GameState; events: GameEvent[]; legalResult: LegalActionsResult }
  | { type: "gameOver"; winner: PlayerId | null; reason: string }
  | { type: "actionPendingChanged"; pending: boolean }
  | { type: "disconnected" }
  | { type: "reconnected" }
  | { type: "error"; message: string };

type ServerDraftAdapterEventListener = (event: ServerDraftAdapterEvent) => void;

// ── ServerDraftAdapter ──────────────────────────────────────────────────

/**
 * WebSocket-backed adapter that handles the full server-hosted draft
 * lifecycle: lobby, picking, deckbuilding, match play (via EngineAdapter),
 * between-rounds, and completion — all over a single WebSocket connection.
 *
 * Follows the WebSocketAdapter pattern (openPhaseSocket handshake, phase-
 * gated handleMessage dispatch, promise-based submitAction). Draft-specific
 * messages (DraftCreated, DraftStateUpdate, DraftMatchStart, etc.) are
 * handled alongside the standard game messages (GameStarted, StateUpdate,
 * GameOver, etc.) based on the current `phase`.
 *
 * Per D-05: single adapter, single socket, full lifecycle.
 * Per T-59-09: does NOT send ReportMatchResult on GameOver — server
 * handles match result reporting automatically.
 */
export class ServerDraftAdapter implements EngineAdapter {
  // ── Draft-phase state ──────────────────────────────────────────────
  private phase: DraftPhase = "lobby";
  private draftCode: string | null = null;
  private draftToken: string | null = null;
  private seatIndex: number | null = null;
  private draftView: DraftPlayerView | null = null;

  // ── Game-phase state ───────────────────────────────────────────────
  private gameState: GameState | null = null;
  private _playerId: PlayerId | null = null;
  private _legalActions: LegalActionsResult = { actions: [], autoPassRecommended: false };
  private activeMatchId: string | null = null;
  private _gameCode: string | null = null;

  // ── Infrastructure ─────────────────────────────────────────────────
  private ws: WebSocket | null = null;
  private pendingResolve: ((result: SubmitResult) => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private draftResolve: ((view: DraftPlayerView) => void) | null = null;
  private draftReject: ((error: Error) => void) | null = null;
  private initResolve: (() => void) | null = null;
  private initReject: ((error: Error) => void) | null = null;
  private listeners: ServerDraftAdapterEventListener[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectInFlight = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private lifecycleReconnectHandlersInstalled = false;
  private disposed = false;
  private _serverInfo: ServerInfo | null = null;

  constructor(
    private readonly serverUrl: string,
    initialSession?: ServerDraftSessionData,
  ) {
    if (initialSession) {
      this.draftCode = initialSession.draftCode;
      this.draftToken = initialSession.playerToken;
      this.seatIndex = initialSession.seatIndex;
    }
    this.installLifecycleReconnectHandlers();
  }

  // ── Public accessors ───────────────────────────────────────────────

  get currentPhase(): DraftPhase {
    return this.phase;
  }

  get playerId(): PlayerId | null {
    return this._playerId;
  }

  get gameCode(): string | null {
    return this._gameCode;
  }

  get currentDraftView(): DraftPlayerView | null {
    return this.draftView;
  }

  get currentDraftCode(): string | null {
    return this.draftCode;
  }

  get currentSeatIndex(): number | null {
    return this.seatIndex;
  }

  get currentMatchId(): string | null {
    return this.activeMatchId;
  }

  getServerInfo(): ServerInfo | null {
    return this._serverInfo;
  }

  // ── Event subscription ─────────────────────────────────────────────

  onEvent(listener: ServerDraftAdapterEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: ServerDraftAdapterEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // ── EngineAdapter interface ────────────────────────────────────────

  async initialize(): Promise<void> {
    // No-op — draft lifecycle is driven by createDraft / joinDraft.
    return Promise.resolve();
  }

  async initializeGame(): Promise<SubmitResult> {
    // Server handles game initialization during DraftMatchStart.
    return { events: [] };
  }

  async submitAction(action: GameAction, _actor: PlayerId): Promise<SubmitResult> {
    if (this.phase !== "match") {
      throw new AdapterError("PHASE_ERROR", "Not in a match phase", false);
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new AdapterError("WS_ERROR", "WebSocket not connected", false);
    }

    this.emit({ type: "actionPendingChanged", pending: true });
    return new Promise<SubmitResult>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      if (!this.send({ type: "Action", data: { action } })) {
        this.pendingResolve = null;
        this.pendingReject = null;
        this.emit({ type: "actionPendingChanged", pending: false });
        reject(new AdapterError("WS_CLOSED", "Failed to send action", true));
      }
    });
  }

  async getState(): Promise<GameState> {
    if (!this.gameState) {
      throw new AdapterError("WS_ERROR", "No game state available", false);
    }
    return this.gameState;
  }

  getAiAction(): GameAction | null {
    return null;
  }

  async getLegalActions(): Promise<LegalActionsResult> {
    return this._legalActions;
  }

  restoreState(): void {
    throw new AdapterError("WASM_ERROR", "Undo not supported in server draft", false);
  }

  estimateBracket(_deck: BracketDeckRequest): Promise<BracketEstimate | null> {
    throw new AdapterError(
      AdapterErrorCode.BRACKET_ESTIMATION_UNSUPPORTED,
      "Bracket estimation is a local feature; not available in server draft sessions.",
      false,
    );
  }

  // ── Draft lifecycle methods ────────────────────────────────────────

  async createDraft(settings: CreateDraftSettings): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;

      if (!isValidWebSocketUrl(this.serverUrl)) {
        reject(new AdapterError("WS_ERROR", "Invalid WebSocket URL", false));
        this.initResolve = null;
        this.initReject = null;
        return;
      }

      this.attachSocket({
        type: "CreateDraftWithSettings",
        data: {
          display_name: settings.displayName,
          set_code: settings.setCode,
          kind: settings.kind,
          public: settings.public,
          password: settings.password ?? null,
          timer_seconds: settings.timerSeconds ?? null,
          tournament_format: settings.tournamentFormat,
          pod_policy: settings.podPolicy,
          pod_size: settings.podSize,
        },
      }).catch(() => {
        // attachSocket handles rejection via initReject; swallow here.
      });
    });
  }

  async joinDraft(
    draftCode: string,
    displayName: string,
    password?: string,
  ): Promise<DraftPlayerView> {
    return new Promise<DraftPlayerView>((resolve, reject) => {
      this.draftResolve = resolve;
      this.draftReject = reject;

      if (!isValidWebSocketUrl(this.serverUrl)) {
        reject(new AdapterError("WS_ERROR", "Invalid WebSocket URL", false));
        this.draftResolve = null;
        this.draftReject = null;
        return;
      }

      this.attachSocket({
        type: "JoinDraftWithPassword",
        data: {
          draft_code: draftCode,
          display_name: displayName,
          password: password ?? null,
        },
      }).catch(() => {
        // attachSocket handles rejection via draftReject; swallow here.
      });
    });
  }

  async submitPick(cardInstanceId: string): Promise<DraftPlayerView> {
    if (this.seatIndex === null || this.draftCode === null) {
      throw new AdapterError("PHASE_ERROR", "Not in a draft session", false);
    }
    return new Promise<DraftPlayerView>((resolve, reject) => {
      this.draftResolve = resolve;
      this.draftReject = reject;
      const sent = this.send({
        type: "DraftAction",
        data: {
          draft_code: this.draftCode,
          action: {
            type: "Pick",
            data: { seat: this.seatIndex, card_instance_id: cardInstanceId },
          },
        },
      });
      if (!sent) {
        this.draftResolve = null;
        this.draftReject = null;
        reject(new AdapterError("WS_CLOSED", "Failed to send draft action", true));
      }
    });
  }

  async submitDeck(mainDeck: string[]): Promise<DraftPlayerView> {
    if (this.seatIndex === null || this.draftCode === null) {
      throw new AdapterError("PHASE_ERROR", "Not in a draft session", false);
    }
    return new Promise<DraftPlayerView>((resolve, reject) => {
      this.draftResolve = resolve;
      this.draftReject = reject;
      const sent = this.send({
        type: "DraftAction",
        data: {
          draft_code: this.draftCode,
          action: {
            type: "SubmitDeck",
            data: { seat: this.seatIndex, main_deck: mainDeck },
          },
        },
      });
      if (!sent) {
        this.draftResolve = null;
        this.draftReject = null;
        reject(new AdapterError("WS_CLOSED", "Failed to send draft action", true));
      }
    });
  }

  // ── Socket management ──────────────────────────────────────────────

  /**
   * Opens a PhaseSocket via the shared handshake helper, caches the
   * ServerInfo, wires the post-handshake message/close handlers, and
   * sends setupFrame. Mirrors WebSocketAdapter.attachSocket.
   */
  private async attachSocket(setupFrame: unknown): Promise<void> {
    let socket: PhaseSocket;
    try {
      socket = await openPhaseSocket(this.serverUrl);
    } catch (err) {
      if (err instanceof HandshakeError) {
        const retryable = err.kind !== "protocol_mismatch" && err.kind !== "invalid_url";
        const adapterErr = new AdapterError("WS_ERROR", err.message, retryable);
        if (this.initReject) {
          this.initReject(adapterErr);
          this.initResolve = null;
          this.initReject = null;
        }
        if (this.draftReject) {
          this.draftReject(adapterErr);
          this.draftResolve = null;
          this.draftReject = null;
        }
        if (err.kind === "protocol_mismatch" && err.serverInfo) {
          this._serverInfo = err.serverInfo;
          this.emit({
            type: "serverHello",
            info: err.serverInfo,
            compatible: false,
          });
        }
        throw err;
      }
      const adapterErr = new AdapterError("WS_ERROR", String(err), true);
      if (this.initReject) {
        this.initReject(adapterErr);
        this.initResolve = null;
        this.initReject = null;
      }
      if (this.draftReject) {
        this.draftReject(adapterErr);
        this.draftResolve = null;
        this.draftReject = null;
      }
      throw err;
    }

    this.ws = socket.ws;
    this._serverInfo = socket.serverInfo;
    this.emit({ type: "serverHello", info: socket.serverInfo, compatible: true });
    this.startPing();

    socket.ws.onmessage = (event) => {
      this.handleMessage(JSON.parse(event.data as string));
    };

    socket.ws.onerror = () => {
      const err = new AdapterError("WS_ERROR", "WebSocket connection failed", true);
      if (this.initReject) {
        this.initReject(err);
        this.initResolve = null;
        this.initReject = null;
      }
      if (this.draftReject) {
        this.draftReject(err);
        this.draftResolve = null;
        this.draftReject = null;
      }
    };

    socket.ws.onclose = () => {
      if (this.ws === socket.ws) {
        this.ws = null;
      }
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
      if (this.pendingReject) {
        this.emit({ type: "actionPendingChanged", pending: false });
        this.pendingReject(
          new AdapterError("WS_CLOSED", "Connection closed during action", true),
        );
        this.pendingResolve = null;
        this.pendingReject = null;
      }
      if (this.draftReject) {
        this.draftReject(
          new AdapterError("WS_CLOSED", "Connection closed during draft operation", true),
        );
        this.draftResolve = null;
        this.draftReject = null;
      }
      if (this.initReject) {
        this.initReject(
          new AdapterError("WS_CLOSED", "Connection closed before draft started", true),
        );
        this.initResolve = null;
        this.initReject = null;
      } else if (this.draftToken && !this.disposed) {
        this.emit({ type: "disconnected" });
        this.attemptDraftReconnect();
      }
    };

    if (!this.send(setupFrame)) {
      socket.close();
      const err = new AdapterError("WS_CLOSED", "Failed to send setup frame", true);
      if (this.initReject) {
        this.initReject(err);
        this.initResolve = null;
        this.initReject = null;
      }
      if (this.draftReject) {
        this.draftReject(err);
        this.draftResolve = null;
        this.draftReject = null;
      }
    }
  }

  // ── Message handling ───────────────────────────────────────────────

  private handleMessage(msg: { type: string; data?: unknown }): void {
    switch (msg.type) {
      // ── Draft-phase messages ──────────────────────────────────────
      case "DraftCreated": {
        const data = msg.data as {
          draft_code: string;
          player_token: string;
          seat_index: number;
        };
        this.draftCode = data.draft_code;
        this.draftToken = data.player_token;
        this.seatIndex = data.seat_index;
        this.persistDraftSession();
        this.emit({ type: "waitingForPlayers" });
        if (this.initResolve) {
          this.initResolve();
          this.initResolve = null;
          this.initReject = null;
        }
        break;
      }

      case "DraftJoined": {
        const data = msg.data as {
          draft_code: string;
          player_token: string;
          seat_index: number;
          view: DraftPlayerView;
        };
        this.draftCode = data.draft_code;
        this.draftToken = data.player_token;
        this.seatIndex = data.seat_index;
        this.draftView = data.view;
        this.updatePhaseFromView(data.view);
        this.persistDraftSession();
        if (this.draftResolve) {
          this.draftResolve(data.view);
          this.draftResolve = null;
          this.draftReject = null;
        }
        break;
      }

      case "DraftStateUpdate": {
        const data = msg.data as { view: DraftPlayerView };
        this.draftView = data.view;
        this.updatePhaseFromView(data.view);
        this.persistDraftSession();
        if (this.reconnectInFlight) {
          this.reconnectInFlight = false;
          this.reconnectAttempt = 0;
          this.emit({ type: "reconnected" });
          if (this.initResolve) {
            this.initResolve();
            this.initResolve = null;
            this.initReject = null;
          }
        }
        this.emit({ type: "draftViewUpdated", view: data.view });
        if (this.draftResolve) {
          this.draftResolve(data.view);
          this.draftResolve = null;
          this.draftReject = null;
        }
        break;
      }

      case "DraftMatchStart": {
        const data = msg.data as {
          match_id: string;
          round: number;
          game_code: string;
          player_token: string;
          your_player: PlayerId;
          opponent_name: string;
        };
        this.phase = "match";
        this.activeMatchId = data.match_id;
        this._playerId = data.your_player;
        this._gameCode = data.game_code;
        this.persistDraftSession();
        this.emit({
          type: "matchStarting",
          matchId: data.match_id,
          round: data.round,
          opponentName: data.opponent_name,
          gameCode: data.game_code,
        });
        this.send({
          type: "Reconnect",
          data: {
            game_code: data.game_code,
            player_token: data.player_token,
          },
        });
        break;
      }

      case "DraftTimerSync": {
        const data = msg.data as { remaining_ms: number };
        this.emit({ type: "timerSync", remainingMs: data.remaining_ms });
        break;
      }

      case "DraftActionRejected": {
        const data = msg.data as { reason: string };
        this.emit({ type: "draftActionRejected", reason: data.reason });
        if (this.reconnectInFlight) {
          clearServerDraftSession();
          this.draftCode = null;
          this.draftToken = null;
        }
        if (this.draftReject) {
          this.draftReject(
            new AdapterError("ACTION_REJECTED", data.reason, true),
          );
          this.draftResolve = null;
          this.draftReject = null;
        }
        if (this.initReject) {
          this.reconnectInFlight = false;
          this.initReject(
            new AdapterError("ACTION_REJECTED", data.reason, true),
          );
          this.initResolve = null;
          this.initReject = null;
        }
        break;
      }

      case "DraftOver": {
        this.phase = "complete";
        clearServerDraftSession();
        const data = msg.data as { standings: StandingEntry[] };
        this.emit({ type: "draftOver", standings: data.standings });
        break;
      }

      // ── Game-phase messages (mirrors WebSocketAdapter) ─────────────
      case "GameStarted": {
        const data = msg.data as {
          state: GameState;
          your_player: PlayerId;
          legal_actions?: GameAction[];
          auto_pass_recommended?: boolean;
          spell_costs?: Record<string, ManaCost>;
          legal_actions_by_object?: Record<string, GameAction[]>;
          derived?: GameState["derived"];
        };
        this.gameState = { ...data.state, derived: data.derived ?? data.state.derived };
        this._playerId = data.your_player;
        this._legalActions = {
          actions: data.legal_actions ?? [],
          autoPassRecommended: data.auto_pass_recommended ?? false,
          spellCosts: data.spell_costs,
          legalActionsByObject: data.legal_actions_by_object,
        };
        this.emit({
          type: "gameStateUpdated",
          state: this.gameState,
          events: [],
          legalResult: this._legalActions,
        });
        break;
      }

      case "StateUpdate": {
        const data = msg.data as {
          state: GameState;
          events: GameEvent[];
          legal_actions?: GameAction[];
          auto_pass_recommended?: boolean;
          spell_costs?: Record<string, ManaCost>;
          legal_actions_by_object?: Record<string, GameAction[]>;
          log_entries?: GameLogEntry[];
          derived?: GameState["derived"];
        };
        this.gameState = { ...data.state, derived: data.derived ?? data.state.derived };
        this._legalActions = {
          actions: data.legal_actions ?? [],
          autoPassRecommended: data.auto_pass_recommended ?? false,
          spellCosts: data.spell_costs,
          legalActionsByObject: data.legal_actions_by_object,
        };
        if (this.pendingResolve) {
          this.emit({ type: "actionPendingChanged", pending: false });
          this.pendingResolve({ events: data.events, log_entries: data.log_entries });
          this.pendingResolve = null;
          this.pendingReject = null;
        } else {
          this.emit({
            type: "gameStateUpdated",
            state: this.gameState,
            events: data.events,
            legalResult: this._legalActions,
          });
        }
        break;
      }

      case "ActionRejected": {
        const data = msg.data as { reason: string };
        this.emit({ type: "actionPendingChanged", pending: false });
        if (this.pendingReject) {
          this.pendingReject(
            new AdapterError("ACTION_REJECTED", data.reason, true),
          );
          this.pendingResolve = null;
          this.pendingReject = null;
        }
        break;
      }

      case "GameOver": {
        const data = msg.data as { winner: PlayerId | null; reason: string };
        // Transition back to between_rounds — server auto-reports the
        // match result. Per T-59-09: adapter does NOT send ReportMatchResult.
        this.phase = "between_rounds";
        this.activeMatchId = null;
        this._gameCode = null;
        this.gameState = null;
        this.emit({ type: "actionPendingChanged", pending: false });
        this.emit({
          type: "gameOver",
          winner: data.winner,
          reason: data.reason,
        });
        break;
      }

      case "Pong": {
        // Silently consumed — latency tracking not needed for draft adapter.
        break;
      }

      case "Error": {
        const data = msg.data as { message: string };
        this.emit({ type: "error", message: data.message });
        break;
      }
    }
  }

  /**
   * Maps DraftPlayerView.status to the adapter's internal phase.
   * Called after receiving DraftJoined and DraftStateUpdate.
   */
  private updatePhaseFromView(view: DraftPlayerView): void {
    switch (view.status) {
      case "Lobby":
        this.phase = "lobby";
        break;
      case "Drafting":
        this.phase = "drafting";
        break;
      case "Deckbuilding":
        this.phase = "deckbuilding";
        break;
      case "Pairing":
      case "RoundComplete":
        this.phase = "between_rounds";
        break;
      case "MatchInProgress":
        // Don't override "match" — DraftMatchStart sets it with game details.
        if (this.phase !== "match") {
          this.phase = "between_rounds";
        }
        break;
      case "Complete":
      case "Abandoned":
        this.phase = "complete";
        break;
      case "Paused":
        // Keep current phase during pause.
        break;
    }
  }

  // ── Reconnect ──────────────────────────────────────────────────────

  async reconnectDraft(): Promise<void> {
    if (!this.draftCode || !this.draftToken) {
      throw new AdapterError("WS_ERROR", "No draft session to reconnect to", false);
    }

    this.clearReconnectTimer();
    this.reconnectInFlight = true;
    return new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
      this.attachSocket({
        type: "ReconnectDraft",
        data: {
          draft_code: this.draftCode,
          player_token: this.draftToken,
        },
      }).catch(() => {
        // attachSocket handles rejection via initReject.
      });
    });
  }

  private attemptDraftReconnect(): void {
    if (this.disposed || this.reconnectInFlight) return;
    if (!this.draftCode || !this.draftToken) return;
    if (this.reconnectAttempt >= MAX_DRAFT_RECONNECT_ATTEMPTS) {
      this.emit({ type: "error", message: "Draft reconnect window expired." });
      return;
    }

    this.reconnectAttempt++;
    const delay = Math.min(
      Math.pow(2, this.reconnectAttempt - 1) * 1000,
      DRAFT_RECONNECT_BACKOFF_CAP_MS,
    );
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectDraft().catch(() => {
        if (!this.disposed) {
          this.reconnectInFlight = false;
          this.attemptDraftReconnect();
        }
      });
    }, delay);
  }

  private readonly handleLifecycleResume = (): void => {
    this.probeReconnectOnResume();
  };

  private readonly handleVisibilityChange = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    this.probeReconnectOnResume();
  };

  private installLifecycleReconnectHandlers(): void {
    if (this.lifecycleReconnectHandlersInstalled || typeof window === "undefined") {
      return;
    }
    window.addEventListener("online", this.handleLifecycleResume);
    window.addEventListener("pageshow", this.handleLifecycleResume);
    window.addEventListener("focus", this.handleLifecycleResume);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
    }
    this.lifecycleReconnectHandlersInstalled = true;
  }

  private removeLifecycleReconnectHandlers(): void {
    if (!this.lifecycleReconnectHandlersInstalled || typeof window === "undefined") {
      return;
    }
    window.removeEventListener("online", this.handleLifecycleResume);
    window.removeEventListener("pageshow", this.handleLifecycleResume);
    window.removeEventListener("focus", this.handleLifecycleResume);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }
    this.lifecycleReconnectHandlersInstalled = false;
  }

  private probeReconnectOnResume(): void {
    if (this.disposed || this.reconnectInFlight) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: "Ping", data: { timestamp: Date.now() } });
      return;
    }
    if (this.ws?.readyState === 0) {
      return;
    }
    if (!this.draftCode || !this.draftToken) return;
    this.clearReconnectTimer();
    void this.reconnectDraft().catch(() => {
      if (!this.disposed) {
        this.reconnectInFlight = false;
        this.attemptDraftReconnect();
      }
    });
  }

  // ── Utilities ──────────────────────────────────────────────────────

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private persistDraftSession(): void {
    if (!this.draftCode || !this.draftToken) return;
    saveServerDraftSession({
      draftCode: this.draftCode,
      playerToken: this.draftToken,
      serverUrl: this.serverUrl,
      seatIndex: this.seatIndex,
      timestamp: Date.now(),
    });
  }

  private startPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    this.pingInterval = setInterval(() => {
      this.send({ type: "Ping", data: { timestamp: Date.now() } });
    }, 5000);
  }

  private send(msg: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.emit({
        type: "error",
        message: "Cannot send message: WebSocket is not open.",
      });
      return false;
    }
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this.emit({
        type: "error",
        message: `Failed to send message: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    clearServerDraftSession();
    this.removeLifecycleReconnectHandlers();
    this.clearReconnectTimer();
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.gameState = null;
    this._playerId = null;
    this._gameCode = null;
    this.draftCode = null;
    this.draftToken = null;
    this.draftView = null;
    this.seatIndex = null;
    this.activeMatchId = null;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.draftResolve = null;
    this.draftReject = null;
    this.initResolve = null;
    this.initReject = null;
    this.reconnectInFlight = false;
    this._serverInfo = null;
    this.emit({ type: "actionPendingChanged", pending: false });
    this.listeners = [];
  }
}
