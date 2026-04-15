import {
  InternalSession,
  InternalParticipant,
  VotingScale,
  SessionMode,
  SessionState,
  Story,
  Vote,
  RoundResult,
} from './types';
import { generateId, generateSessionId } from './utils';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

class SessionStore {
  private sessions = new Map<string, InternalSession>();
  private socketToParticipant = new Map<string, { session_id: string; participant_id: string }>();

  constructor() {
    // Clean up expired sessions every 30 minutes.
    setInterval(() => this.cleanup(), 30 * 60 * 1000).unref();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.last_activity > SESSION_TTL_MS) {
        this.sessions.delete(id);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  createSession(name: string, scale: VotingScale, mode: SessionMode = 'stories'): InternalSession {
    let id: string;
    do {
      id = generateSessionId();
    } while (this.sessions.has(id));

    const session: InternalSession = {
      id,
      name,
      moderator_id: '',
      voting_scale: scale,
      session_mode: mode,
      round_number: 1,
      status: mode === 'free' ? 'voting' : 'waiting',
      current_story_id: null,
      stories: new Map(),
      participants: new Map(),
      votes: new Map(),
      created_at: new Date().toISOString(),
      last_activity: Date.now(),
    };

    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): InternalSession | undefined {
    const session = this.sessions.get(id);
    if (session) session.last_activity = Date.now();
    return session;
  }

  /** Serialize a session for transmission to clients (no vote values). */
  toClientState(session: InternalSession): SessionState {
    return {
      id: session.id,
      name: session.name,
      moderator_id: session.moderator_id,
      voting_scale: session.voting_scale,
      session_mode: session.session_mode,
      round_number: session.round_number,
      status: session.status,
      current_story_id: session.current_story_id,
      stories: Array.from(session.stories.values()),
      participants: Array.from(session.participants.values()).map(p => ({
        id: p.id,
        display_name: p.display_name,
        role: p.role,
        is_connected: p.is_connected,
        has_voted: p.has_voted,
      })),
      created_at: session.created_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Participant management
  // ---------------------------------------------------------------------------

  addParticipant(session: InternalSession, participant: InternalParticipant): void {
    session.participants.set(participant.id, participant);
    if (participant.socket_id) {
      this.socketToParticipant.set(participant.socket_id, {
        session_id: session.id,
        participant_id: participant.id,
      });
    }
    session.last_activity = Date.now();
  }

  /** Update the socket binding for a reconnecting participant. */
  updateSocket(session: InternalSession, participant_id: string, socket_id: string): void {
    const participant = session.participants.get(participant_id);
    if (!participant) return;
    if (participant.socket_id) {
      this.socketToParticipant.delete(participant.socket_id);
    }
    participant.socket_id = socket_id;
    participant.is_connected = true;
    this.socketToParticipant.set(socket_id, { session_id: session.id, participant_id });
    session.last_activity = Date.now();
  }

  /** Mark a participant as disconnected and remove the socket mapping. */
  disconnectSocket(socket_id: string): { session_id: string; participant_id: string } | undefined {
    const mapping = this.socketToParticipant.get(socket_id);
    if (!mapping) return undefined;
    this.socketToParticipant.delete(socket_id);
    const session = this.sessions.get(mapping.session_id);
    if (session) {
      const participant = session.participants.get(mapping.participant_id);
      if (participant) {
        participant.is_connected = false;
        participant.socket_id = null;
      }
    }
    return mapping;
  }

  getParticipantBySocket(socket_id: string):
    | { session: InternalSession; participant: InternalParticipant }
    | undefined {
    const mapping = this.socketToParticipant.get(socket_id);
    if (!mapping) return undefined;
    const session = this.sessions.get(mapping.session_id);
    if (!session) return undefined;
    const participant = session.participants.get(mapping.participant_id);
    if (!participant) return undefined;
    return { session, participant };
  }

  transferSM(session: InternalSession, new_sm_id: string): boolean {
    const newSM = session.participants.get(new_sm_id);
    if (!newSM) return false;
    const oldSM = session.participants.get(session.moderator_id);
    if (oldSM) oldSM.role = 'team_member';
    newSM.role = 'moderator';
    session.moderator_id = new_sm_id;
    session.last_activity = Date.now();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Voting
  // ---------------------------------------------------------------------------

  castVote(session: InternalSession, participant_id: string, card_value: string): boolean {
    const participant = session.participants.get(participant_id);
    if (!participant || participant.role === 'observer') return false;
    if (session.status !== 'voting') return false;

    session.votes.set(participant_id, {
      participant_id,
      card_value,
      submitted_at: new Date().toISOString(),
    });
    participant.has_voted = true;
    session.last_activity = Date.now();
    return true;
  }

  revealVotes(session: InternalSession): RoundResult | null {
    if (session.status !== 'voting') return null;

    const votes = Array.from(session.votes.entries()).map(([participant_id, vote]) => ({
      participant_id,
      display_name: session.participants.get(participant_id)?.display_name ?? 'Unknown',
      card_value: vote.card_value,
    }));

    const uniqueValues = new Set(votes.map(v => v.card_value));
    const consensus = uniqueValues.size === 1 && votes.length > 0;

    session.status = 'revealed';
    session.last_activity = Date.now();

    return {
      votes,
      consensus,
      consensus_value: consensus ? votes[0].card_value : null,
    };
  }

  resetRound(session: InternalSession): number {
    session.votes.clear();
    session.round_number += 1;
    session.status = 'voting';
    for (const participant of session.participants.values()) {
      participant.has_voted = false;
    }
    session.last_activity = Date.now();
    return session.round_number;
  }

  private startVoting(session: InternalSession): void {
    session.votes.clear();
    session.status = 'voting';
    for (const participant of session.participants.values()) {
      participant.has_voted = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Story management
  // ---------------------------------------------------------------------------

  addStory(session: InternalSession, title: string, description?: string): Story {
    const story: Story = {
      id: generateId(),
      title,
      description,
      status: 'pending',
    };
    session.stories.set(story.id, story);
    session.last_activity = Date.now();
    return story;
  }

  setActiveStory(session: InternalSession, story_id: string): boolean {
    const story = session.stories.get(story_id);
    if (!story) return false;
    if (session.current_story_id) {
      const prev = session.stories.get(session.current_story_id);
      if (prev?.status === 'active') prev.status = 'pending';
    }
    story.status = 'active';
    session.current_story_id = story_id;
    this.startVoting(session);
    session.last_activity = Date.now();
    return true;
  }

  finalizeStory(
    session: InternalSession,
    story_id: string,
    final_estimate: string
  ): Story | null {
    const story = session.stories.get(story_id);
    if (!story) return null;
    story.status = 'estimated';
    story.final_estimate = final_estimate;
    if (session.current_story_id === story_id) {
      session.current_story_id = null;
      session.status = 'waiting';
    }
    session.last_activity = Date.now();
    return story;
  }
}

export const sessionStore = new SessionStore();
